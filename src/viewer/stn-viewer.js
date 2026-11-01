/* Archipelago STN viewer — WebGL2, no libraries.
 *
 * Draws one run's search trajectory network: density rendering into an
 * RGBA16F target, weighted-mean hue composite, one control rail, a cluster
 * inspector and migration arcs.
 *
 *   ingest -> aggregate (levers 1,2) -> geometry -> render (4 draws, RGBA16F)
 *          -> composite (weighted-mean hue + tone map) -> DOM overlays
 *
 * A dataset is:
 *   {tag, runs, isl, rx, ry, rf, gOff, gLen, gRun, gIsl, migEvents,
 *    [parentPtr, parentIdx], [cluster, clusterCount], [islandIds], [fitSign],
 *    [hashes], [shapeNote]}
 * ``cluster`` is one pipeline cluster id per sample; when present a node is a
 * (group, cluster) pair and its position is the centroid of its members.
 * with samples laid out group-major: sample s of group g is rx[gOff[g] + s].
 * Coordinates are in [-1, 1]; fitness is oriented so LOWER IS BETTER.
 */

/* ═══ 2. SHADERS ══════════════════ */
const MAXG = 32;
const SI = 0.30, SR = 0.34, RING_I = 0.86, RING_R = 0.95, PLANE_GAP = 0.62;

const PLACE = `
vec2 placeXY(vec2 b, vec2 oi, vec2 orr, float ei, float er){
  vec2 p = mix(b, b*${SI} + oi, ei);
  return mix(p, p*${SR} + orr, er);
}`;

const VS_GRAPH = `
in vec2 aXY; in vec2 aOffI; in vec2 aOffR; in vec3 aZ; in vec3 aZ2;
in float aGrp; in float aSize; in float aShared;
uniform mat4 uVP; uniform vec3 uZMix; uniform vec3 uZMix2; uniform float uPScale;
uniform float uExI; uniform float uExR;
uniform vec3 uCol[${MAXG}]; uniform float uAlpha[${MAXG}];
uniform float uBase; uniform float uFogN; uniform float uFogF;
uniform float uContest; uniform float uFlat; uniform float uHS; uniform float uByFit;
out vec3 vC; out float vA; out float vS;
` + PLACE + `
void main(){
  vec2 q = placeXY(aXY, aOffI, aOffR, uExI, uExR);
  vec3 p = vec3(q.x, (dot(aZ, uZMix) + dot(aZ2, uZMix2)) * (1.0 - uFlat) * uHS, q.y);
  vec4 cp = uVP * vec4(p, 1.0);
  gl_Position = cp;
  int k = int(aGrp + 0.5);
  float rank = clamp((aZ.x + 0.9) / 1.8, 0.0, 1.0);          // 0 is the best fitness
  vec3 ramp = rank < 0.5 ? mix(vec3(0.99, 0.91, 0.14), vec3(0.13, 0.66, 0.53), rank * 2.0)
                         : mix(vec3(0.13, 0.66, 0.53), vec3(0.27, 0.12, 0.47), rank * 2.0 - 1.0);
  vC = mix(uCol[k], ramp, uByFit);
  float d = max(cp.w, 1e-6);
  float fog = 1.0 - clamp((d - uFogN)/(uFogF - uFogN), 0.0, 1.0);
  float hot = smoothstep(0.24, 0.55, aShared);
  float mute = mix(1.0, mix(0.10, 1.0, hot), uContest);
  vA = uBase * uAlpha[k] * mute * (0.30 + 0.70*fog);
  vS = hot * uContest;
  gl_PointSize = clamp(uPScale * aSize / d, 1.0, 96.0);
}`;

// .rgb accumulates density-weighted COLOUR, .a accumulates density; the
// composite divides one by the other. Summing hues would turn every overlap
// white, which is exactly where the answer lives.
const EMIT = `
out vec4 o0;
void emit(vec3 col, float dens, float mark){
  vec3 c = mix(col, vec3(1.0), min(mark*3.0, 1.0));
  float w = max(dens, mark);
#ifdef HDR
  o0 = vec4(c * w, w);
#else
  o0 = vec4(c, w);
#endif
}`;

const FS_POINT = `
precision highp float;
in vec3 vC; in float vA; in float vS;
` + EMIT + `
void main(){
  vec2 c = gl_PointCoord - 0.5;
  float r = length(c)*2.0;
  float a = smoothstep(1.0, 0.15, r); a *= a;
  float ring = smoothstep(0.50, 0.72, r) * smoothstep(1.0, 0.80, r) * vS;
  emit(vC, a * vA, ring * vA * 2.2);
}`;

const FS_LINE = `
precision highp float;
in vec3 vC; in float vA; in float vS;
` + EMIT + `
void main(){ emit(vC, vA, 0.0); }`;

const VS_ARC = `
in vec2 aA; in vec2 aAI; in vec2 aAR; in vec3 aAZ; in vec3 aAZ2;
in vec2 aB; in vec2 aBI; in vec2 aBR; in vec3 aBZ; in vec3 aBZ2;
in float aT; in float aSide; in float aRoute;
uniform mat4 uVP; uniform vec3 uZMix; uniform vec3 uZMix2; uniform vec3 uMig;
uniform float uRoute[${MAXG * 2}];
uniform float uBase; uniform float uExI; uniform float uExR;
uniform float uAspect; uniform float uHalfW;
uniform float uFlat; uniform float uLift; uniform float uRainbow; uniform float uHS;
uniform vec3 uRSrc[${MAXG * 2}]; uniform vec3 uRDst[${MAXG * 2}];
out vec3 vC; out float vA; out float vS;
` + PLACE + `
vec3 bez(float t, vec3 p0, vec3 p1, vec3 ctrl){
  float u = 1.0 - t;
  return u*u*p0 + 2.0*u*t*ctrl + t*t*p1;
}
void main(){
  vec2 qa = placeXY(aA, aAI, aAR, uExI, uExR);
  vec2 qb = placeXY(aB, aBI, aBR, uExI, uExR);
  vec3 p0 = vec3(qa.x, (dot(aAZ, uZMix) + dot(aAZ2, uZMix2)) * (1.0 - uFlat) * uHS, qa.y);
  vec3 p1 = vec3(qb.x, (dot(aBZ, uZMix) + dot(aBZ2, uZMix2)) * (1.0 - uFlat) * uHS, qb.y);
  vec3 mid = (p0 + p1) * 0.5;
  vec2 dg = p1.xz - p0.xz;
  vec2 dir = length(dg) > 0.02 ? normalize(vec2(-dg.y, dg.x))
                               : normalize(mid.xz + vec2(1e-4, 1e-4));
  if(dot(dir, mid.xz) < 0.0) dir = -dir;
  float len = max(distance(p0, p1), 0.05);
  // Grouped: the arc stands up out of the ground plane like a rainbow. A
  // quadratic Bezier peaks at half its control offset, hence the 2.0.
  float arch = uLift * (0.16 + 0.50*len) * (0.5 + 0.5*uHS);
  float side = 0.26*len*(1.0 - uLift);
  vec3 ctrl = vec3(mid.x + dir.x*side, mid.y + 2.0*arch, mid.z + dir.y*side);

  vec4 c0 = uVP * vec4(bez(aT, p0, p1, ctrl), 1.0);
  vec4 c1 = uVP * vec4(bez(min(aT + 0.04, 1.0), p0, p1, ctrl), 1.0);
  vec2 s0 = c0.xy / c0.w, s1 = c1.xy / c1.w;
  vec2 d = s1 - s0;
  d = (length(d) < 1e-6) ? vec2(1.0, 0.0) : normalize(d * vec2(uAspect, 1.0));
  vec2 nrm = vec2(-d.y, d.x) / vec2(uAspect, 1.0);
  gl_Position = vec4(c0.xy + nrm * aSide * uHalfW * c0.w, c0.z, c0.w);

  int rk = int(aRoute + 0.5);
  vC = mix(uMig, mix(uRSrc[rk], uRDst[rk], aT), uRainbow);
  vA = uBase * uRoute[rk] * (0.25 + 0.75*sin(3.14159*aT));
  vS = 0.0;
}`;

const VS_FULL = `
out vec2 vUV;
void main(){
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vUV = p;
  gl_Position = vec4(p*2.0 - 1.0, 0.0, 1.0);
}`;
const FS_TONE = `
precision highp float;
uniform sampler2D uT0;
uniform float uExp; uniform float uSat;
uniform vec3 uBg;
in vec2 vUV; out vec4 o;
void main(){
  vec4 A = texture(uT0, vUV);
  float tot = A.a;
  vec3 col = tot > 1e-6 ? A.rgb / tot : vec3(0.0);
  float l = dot(col, vec3(0.299, 0.587, 0.114));
  col = clamp(vec3(l) + (col - vec3(l)) * uSat, 0.0, 1.0);
  o = vec4(uBg + col * (1.0 - exp(-uExp * tot)), 1.0);
}`;

/* ═══ 3. COLOUR ═════════════════════════════════════════════════ */
// Validated categorical set: all-pairs CVD dE 8.5 deutan, 20.0 normal vision.
const PAL5 = [[.494, .784, 1], [.949, .380, .361], [.094, .639, .478], [.957, .839, .310], [.753, .478, .910]];

function hsl(h, s, l) {
  const f = n => {
    const k = (n + h * 12) % 12;
    return l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(Math.min(k - 3, 9 - k), 1));
  };
  return [f(0), f(8), f(4)];
}
const hex = c => "#" + c.map(v => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, "0")).join("");

/* ═══ 4. MAT4 ═══════════════════════════════════════════════════ */
function perspective(fovy, aspect, near, far) {
  const f = 1 / Math.tan(fovy / 2), nf = 1 / (near - far);
  return new Float32Array([f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0]);
}
function lookAt(eye, ctr, up) {
  let zx = eye[0] - ctr[0], zy = eye[1] - ctr[1], zz = eye[2] - ctr[2];
  let l = 1 / (Math.hypot(zx, zy, zz) || 1); zx *= l; zy *= l; zz *= l;
  let xx = up[1] * zz - up[2] * zy, xy = up[2] * zx - up[0] * zz, xz = up[0] * zy - up[1] * zx;
  l = 1 / (Math.hypot(xx, xy, xz) || 1); xx *= l; xy *= l; xz *= l;
  const yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx;
  return new Float32Array([
    xx, yx, zx, 0, xy, yy, zy, 0, xz, yz, zz, 0,
    -(xx * eye[0] + xy * eye[1] + xz * eye[2]),
    -(yx * eye[0] + yy * eye[1] + yz * eye[2]),
    -(zx * eye[0] + zy * eye[1] + zz * eye[2]), 1
  ]);
}
function mul(a, b) {
  const o = new Float32Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++)
    o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
  return o;
}

/* ═══ 5. THE VIEWER ═════════════════════════════════════════════ */
const GRIDS = [18, 34, 70, 150, 280];
const GRID_NAMES = ["coarse", "low", "medium", "fine", "finest"];

const TEMPLATE = `
<div class="wrap">
  <div class="mast-meta">
    <span id="meta-run"></span>
    <span id="meta-level" class="lvl"></span>
    <span id="meta-shape">building&hellip;</span>
    <span id="meta-edges">building&hellip;</span>
  </div>
  <div class="viewer">
    <div class="stage">
      <canvas id="gl"></canvas>
      <div class="stage-note" id="note">LOADING&hellip;</div>

      <div class="rail" id="rail">
        <div class="rail-h"><span>View controls</span><label class="help"><input type="checkbox" id="rail-help">Notes</label></div>

        <details class="sec" name="controls"><summary>Islands</summary>
          <div class="sec-body">
          <div class="grp">
            <button class="btn-wide" id="b-group" aria-pressed="false">Group by island</button>
            <p class="hint">Each island on its own flat patch of ground, side by side, with migration lifted into arcs between them.</p>
          </div>
          <div class="grp" id="grp-runs" hidden>
            <div class="grp-h"><span>Runs</span></div>
            <div class="chips" id="runs"></div>
          </div>
          <div class="grp">
            <div class="grp-h"><span id="islands-h">Islands</span></div>
            <div class="chips" id="islands"></div>
            <p class="hint">One chip per island &mdash; per run, when there is more than one. Click to mute, shift-click to solo just that one.</p>
          </div>
          <div class="grp" id="grp-colour">
            <div class="grp-h"><span>Colour by</span></div>
            <div class="seg" role="group" aria-label="Colour by">
              <button id="c-isl" aria-pressed="true">ISLAND</button>
              <button id="c-run" aria-pressed="false">RUN</button>
              <button id="c-fit" aria-pressed="false">FITNESS</button>
            </div>
            <p class="hint">Two facets, two channels: whichever one colour carries, position carries the other.</p>
          </div>
          </div>
        </details>

        <details class="sec" name="controls"><summary>Layers</summary>
          <div class="sec-body">
          <div class="grp layers">
            <button class="btn-wide" id="t-edges" aria-pressed="true">Trajectory edges</button>
            <button class="btn-wide" id="mig-all" aria-pressed="true">Migration routes</button>
            <button class="btn-wide" id="b-isl" aria-pressed="true">Island bests</button>
            <button class="btn-wide" id="b-run" aria-pressed="true">Run bests</button>
            <button class="btn-wide" id="contest" aria-pressed="false">Contested clusters</button>
            <button class="btn-wide" id="b-sel" aria-pressed="true">Selection marker</button>
            <p class="hint">Turn trajectory edges off to leave only the clusters and the migration arcs &mdash; the exchange skeleton on its own.</p>
          </div>
          </div>
        </details>

        <details class="sec" name="controls"><summary>Filter &amp; detail</summary>
          <div class="sec-body">
          <div class="grp" id="grp-agg">
            <div class="grp-h"><span>Node detail</span><b id="v-res">medium</b></div>
            <input type="range" id="s-res" min="0" max="4" step="1" value="2" aria-label="Cluster resolution">
            <div class="ends"><span>COARSE</span><span>FINEST</span></div>
          </div>
          <div class="grp">
            <div class="grp-h"><span>Hide rare paths</span><b id="v-wt">&ge; 2 visits</b></div>
            <input type="range" id="s-wt" min="1" max="12" step="1" value="2" aria-label="Minimum edge traversal count">
            <div class="ends"><span>SHOW ALL</span><span>COMMON ONLY</span></div>
          </div>
          <div class="grp">
            <div class="grp-h"><span>Separate islands</span><b id="v-exi">0.00</b></div>
            <input type="range" id="s-exi" min="0" max="100" step="1" value="0" aria-label="Island separation">
            <div class="ends"><span>MERGED</span><span>SEPARATE</span></div>
            <div id="grp-exr" hidden>
              <div class="grp-h" style="margin-top:10px"><span>Separate runs</span><b id="v-exr">0.00</b></div>
              <input type="range" id="s-exr" min="0" max="100" step="1" value="0" aria-label="Run separation">
            </div>
            <p class="hint">A cluster that splits as you drag was contested; one that slides intact belonged to a single group.</p>
          </div>
          </div>
        </details>

        <details class="sec" name="controls"><summary>Height</summary>
          <div class="sec-body">
          <div class="grp">
            <div class="grp-h"><span>Height shows</span><b id="v-height">fitness</b></div>
            <div class="seg" role="group" aria-label="Height axis">
              <button id="z-fit" aria-pressed="true">FITNESS</button>
              <button id="z-time" aria-pressed="false">TIME</button>
              <button id="z-isle" aria-pressed="false">ISLAND</button>
            </div>
            <div class="seg" role="group" aria-label="More height metrics" style="margin-top:3px">
              <button id="z-vis" aria-pressed="false">EVALS</button>
              <button id="z-deg" aria-pressed="false">LINKS</button>
              <button id="z-shr" aria-pressed="false">SHARED</button>
              <button id="z-flat" aria-pressed="false">FLAT</button>
            </div>
            <div class="grp-h" style="margin-top:10px"><span>Height scale</span><b id="v-hs">1.00</b></div>
            <input type="range" id="s-hs" min="5" max="150" step="5" value="100" aria-label="Height scale">
            <div class="ends"><span>SHORT</span><span>TALL</span></div>
            <p class="hint">What lifts a cluster. Fitness: better sits lower. Time: later sits higher. Evals, links and shared: more sits higher. Flat lays everything on the ground.</p>
          </div>
          </div>
        </details>

        <details class="sec" name="controls"><summary>Migration routes <b id="routes-n"></b></summary>
          <div class="sec-body">
          <div class="grp">
            <div class="chips grid" id="routes"></div>
            <p class="hint">One chip per source&rarr;destination route. Shift-click solos a route to trace a single exchange.</p>
          </div>
          </div>
        </details>

        <details class="sec" name="controls"><summary>Jump to best</summary>
          <div class="sec-body">
          <div class="grp">
            <div class="chips" id="bests"></div>
            <p class="hint">Flies the camera to that cluster and opens it in the inspector. Rings are island bests, diamonds run bests.</p>
          </div>
          </div>
        </details>

        <details class="sec" name="controls"><summary>Appearance</summary>
          <div class="sec-body">
          <div class="grp">
            <div class="grp-h"><span>Brightness</span><b id="v-op">1.80</b></div>
            <input type="range" id="s-op" min="15" max="400" step="5" value="180" aria-label="Density exposure">
            <div class="grp-h" style="margin-top:10px"><span>Colour strength</span><b id="v-dom">1.40</b></div>
            <input type="range" id="s-dom" min="0" max="300" step="10" value="140" aria-label="Hue saturation">
            <div class="ends"><span>GREY</span><span>VIVID</span></div>
            <div class="grp-h" style="margin-top:10px"><span>Node size</span><b id="v-ns">1.00</b></div>
            <input type="range" id="s-ns" min="50" max="300" step="10" value="100" aria-label="Node size">
          </div>
          </div>
        </details>

        <div class="grp rail-foot">
          <button class="btn-wide" id="reset">Reset all</button>
          <button class="btn-wide" id="save-img" style="margin-top:6px">Save image</button>
          <p class="hint">Drag to orbit &middot; shift-drag or right-drag to pan &middot; wheel zooms toward the cursor. Keys: B best solution, R reset, S save image, Esc clear selection, ? notes.</p>
        </div>
      </div>

      <div class="axis" id="axis"><span id="ax-top">WORSE</span><div class="bar"></div><span id="ax-bot">BETTER</span></div>
      <div id="plabels"></div>
      <div id="marks"></div>
      <div class="hover-tip" id="hover-tip" hidden></div>
      <div class="selmark" id="selmark" hidden><i></i><i></i><i></i><i></i></div>
      <div class="inspect" id="inspect">
        <div class="ins-h"><b id="ins-title">Click a node to inspect it</b><button id="ins-x" aria-label="Clear selection" hidden>&times;</button></div>
        <div class="ins-body" id="ins-body"><p class="ins-empty">Click any node to inspect the cluster behind it &mdash; genome, fitness, how many evaluations landed there, and which islands share it.</p></div>
      </div>
    </div>

    <div class="legend-inline" id="legend"></div>

    <div class="strip">
      <div class="stat"><span class="k">Nodes</span><span class="v" id="k-nodes">&mdash;</span></div>
      <div class="stat"><span class="k">Search paths shown</span><span class="v" id="k-edges">&mdash;</span></div>
      <div class="stat"><span class="k">Of total</span><span class="v" id="k-pct">&mdash;</span></div>
      <div class="stat"><span class="k">Islands per node</span><span class="v" id="k-share">&mdash;</span></div>
      <div class="stat"><span class="k">Migrants arrived</span><span class="v" id="k-mig">&mdash;</span></div>
      <div class="stat"><span class="k">Frame</span><span class="v" id="k-fps">&mdash;</span></div>
    </div>
  </div>
  <p class="cap" id="cap"></p>
</div>`;

const CAP =
  "It opens <b>merged</b> &mdash; every island where the search actually put it. Click any node to read the cluster behind it. Pull <b>Separation</b> right to pull the islands into their own funnels; the clusters that split apart were the contested ones. Height is fitness on one pooled percentile scale; position is a shared 2D projection of the genome space, fitted once over the whole run. Trajectory edges are parent&rarr;child lineage within an island.";

/**
 * Mount the viewer into ``root``.
 * @param {HTMLElement} root
 * @param {{datasets: Array<object|{tag:string,load:Function}>, start?: number}} cfg
 * @returns {{destroy():void, loadDataset(i:number):void}}
 */
export function mountStnViewer(root, cfg) {
  root.innerHTML = TEMPLATE;
  const $ = id => root.querySelector("#" + id);
  const canvas = $("gl"), note = $("note");
  const gl = canvas.getContext("webgl2", { antialias: false, alpha: false });
  if (!gl) { note.textContent = "WEBGL2 UNAVAILABLE IN THIS BROWSER"; return { destroy() { }, loadDataset() { } }; }

  /* ── dataset-bound state ─────────────────────────────────────── */
  const entries = cfg.datasets;
  let DS = null;                       // the loaded dataset
  let NG = 0, RAW = 0;
  let rx = null, ry = null, rf = null, gOff = null, gLen = null, gRun = null, gIsl = null;
  let migEvents = [], fSorted = null;
  let G = null;
  let alive = true;
  // The base alphas are tuned for ~250k edges. A real run is often a
  // few thousand, so each line would accumulate almost no light. Scale the
  // density brightness by how far under that the run is; at >=200k edges the
  // gain is exactly 1, so the full-size datasets render exactly as designed.
  let edgeGain = 1, nodeGain = 1;

  function adopt(d) {
    DS = d;
    NG = d.runs * d.isl;
    rx = d.rx; ry = d.ry; rf = d.rf;
    gOff = d.gOff; gLen = d.gLen; gRun = d.gRun; gIsl = d.gIsl;
    migEvents = d.migEvents || [];
    RAW = rx.length;
    // Pooled fitness ranking, shared by every run so heights stay comparable.
    // Large logs are strided down to a 20,000 sample; a smaller log is
    // ranked exactly.
    let s;
    if (RAW <= 20000) { s = new Float32Array(rf); }
    else {
      s = new Float32Array(20000);
      for (let i = 0; i < s.length; i++) s[i] = rf[(i * 19 + 7) % RAW];
    }
    s.sort();
    fSorted = s;
  }
  function fitnessPct(v) {
    let lo = 0, hi = fSorted.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (fSorted[m] < v) lo = m + 1; else hi = m; }
    return lo / fSorted.length;
  }

  /* ── aggregation (levers 1 and 2) ────────────────────────────── */
  function aggregate(gi) {
    // With a pipeline result a node is (group, cluster); otherwise (group, grid
    // cell). A cluster id plays the part of the cell: it is what two islands
    // share when they visit the same region.
    const clustered = !!DS.cluster;
    const N = clustered ? 0 : GRIDS[gi];
    const cells = clustered ? DS.clusterCount : N * N;
    const map = clustered ? new Map() : new Int32Array(NG * cells).fill(-1);
    const pxS = clustered ? new Float64Array(Math.min(RAW, NG * cells)) : null;
    const pyS = clustered ? new Float64Array(Math.min(RAW, NG * cells)) : null;
    const cellLast = new Int32Array(cells).fill(-1);
    const cellGrp = new Uint8Array(cells);
    const cellRun = new Uint8Array(cells);
    const cap = Math.min(RAW, NG * cells);
    const px = new Float32Array(cap), py = new Float32Array(cap);
    const pfS = new Float64Array(cap), pgS = new Float64Array(cap);
    const pGrp = new Uint8Array(cap), pVis = new Float32Array(cap);
    const pCell = new Int32Array(cap), pBest = new Float32Array(cap);
    const pFirst = new Int32Array(cap), pLast = new Int32Array(cap);
    const pIn = new Int32Array(cap), pOut = new Int32Array(cap);
    const pSample = new Int32Array(cap);
    const maxE = Math.max(RAW, DS.parentIdx ? DS.parentIdx.length : 0);
    const e = new Int32Array(maxE * 2), ew = new Float32Array(maxE);
    const sampleNode = new Int32Array(RAW);
    const seen = new Map();
    // Packing two node ids as a*1e7 + b would silently merge
    // unrelated edges past ten million nodes. 2^25 per slot is exact in a
    // double up to 2^28 nodes, so pooled runs cannot collide.
    const KEY = 33554432;
    const parentPtr = DS.parentPtr, parentIdx = DS.parentIdx;
    sampleNode.fill(-1);
    let nc = 0, ec = 0, maxW = 1;

    for (let g = 0; g < NG; g++) {
      let prev = -1;
      const base = gOff[g], len = gLen[g], cbase = g * cells, runBit = 1 << gRun[g];
      for (let s = 0; s < len; s++) {
        const i = base + s;
        let ix = 0, iy = 0, xy;
        if (clustered) xy = DS.cluster[i];
        else {
          ix = ((rx[i] + 1) * .5 * N) | 0; if (ix < 0) ix = 0; else if (ix >= N) ix = N - 1;
          iy = ((ry[i] + 1) * .5 * N) | 0; if (iy < 0) iy = 0; else if (iy >= N) iy = N - 1;
          xy = iy * N + ix;
        }
        const cell = cbase + xy;
        if (cellLast[xy] !== g) { cellLast[xy] = g; cellGrp[xy]++; cellRun[xy] |= runBit; }
        let n = clustered ? (map.get(cell) ?? -1) : map[cell];
        if (n === -1) {
          n = nc++;
          if (clustered) map.set(cell, n); else map[cell] = n;
          if (!clustered) { px[n] = ((ix + .5) / N) * 2 - 1; py[n] = ((iy + .5) / N) * 2 - 1; }
          pGrp[n] = g; pCell[n] = xy; pBest[n] = rf[i]; pFirst[n] = s; pSample[n] = i;
        }
        pVis[n]++; pfS[n] += rf[i]; pgS[n] += s;
        if (clustered) { pxS[n] += rx[i]; pyS[n] += ry[i]; }
        if (rf[i] < pBest[n]) pBest[n] = rf[i];
        pLast[n] = s;
        sampleNode[i] = n;
        // An edge is a transition INTO this cluster. With a lineage it comes
        // from each parent's cluster; without one, from the previous sample.
        const lineage = parentPtr !== undefined;
        const nSrc = lineage ? parentPtr[i + 1] - parentPtr[i] : (prev !== -1 ? 1 : 0);
        for (let k = 0; k < nSrc; k++) {
          const src = lineage ? sampleNode[parentIdx[parentPtr[i] + k]] : prev;
          if (src < 0 || src === n) continue;
          const key = src * KEY + n;
          const idx = seen.get(key);
          if (idx === undefined) {
            seen.set(key, ec);
            e[ec * 2] = src; e[ec * 2 + 1] = n; ew[ec] = 1; ec++;
            pOut[src]++; pIn[n]++;
          } else {
            ew[idx]++; if (ew[idx] > maxW) maxW = ew[idx];
          }
        }
        prev = n;
      }
    }

    const pf = new Float32Array(nc), pg = new Float32Array(nc);
    const pShared = new Float32Array(nc), pRuns = new Uint8Array(nc);
    const counted = new Uint8Array(cells);
    let grpSum = 0, occupied = 0;
    const denom = Math.max(1, NG - 1);
    for (let n = 0; n < nc; n++) {
      pf[n] = pfS[n] / pVis[n]; pg[n] = pgS[n] / pVis[n];
      if (clustered) { px[n] = pxS[n] / pVis[n]; py[n] = pyS[n] / pVis[n]; }
      const c = pCell[n];
      pShared[n] = Math.min(1, (cellGrp[c] - 1) / denom);
      let m = cellRun[c], b = 0;
      while (m) { b += m & 1; m >>= 1; }
      pRuns[n] = b;
      if (!counted[c]) { counted[c] = 1; occupied++; grpSum += cellGrp[c]; }
    }

    // migration events -> node pairs, deduplicated into routes
    const routeKey = new Map(), routes = [];
    const mig = [];
    for (let i = 0; i < migEvents.length; i++) {
      const m = migEvents[i];
      const k = m.sg * 1000 + m.dg;
      let rid = routeKey.get(k);
      if (rid === undefined) {
        rid = routes.length; routeKey.set(k, rid);
        routes.push({ sg: m.sg, dg: m.dg, run: m.run, n: 0 });
      }
      routes[rid].n++;
      mig.push({ a: sampleNode[m.a], b: sampleNode[m.b], sg: m.sg, dg: m.dg, run: m.run, route: rid });
    }
    const migNodes = new Set();
    for (let i = 0; i < mig.length; i++) { migNodes.add(mig[i].a); migNodes.add(mig[i].b); }

    // best cluster per group, and per run
    const bestOfGroup = new Int32Array(NG).fill(-1);
    const bestOfRun = new Int32Array(DS.runs).fill(-1);
    for (let n = 0; n < nc; n++) {
      const g = pGrp[n], r = gRun[g];
      if (bestOfGroup[g] < 0 || pBest[n] < pBest[bestOfGroup[g]]) bestOfGroup[g] = n;
      if (bestOfRun[r] < 0 || pBest[n] < pBest[bestOfRun[r]]) bestOfRun[r] = n;
    }

    G = {
      nodeCount: nc, edgeCount: ec, px, py, pf, pg, pGrp, pVis, pShared, pRuns,
      pBest, pFirst, pLast, pIn, pOut, pCell, pSample, migNodes, routes,
      e: e.subarray(0, ec * 2), ew: ew.subarray(0, ec), maxW, mig,
      bestOfGroup, bestOfRun,
      overlap: occupied ? grpSum / occupied : 0
    };
    const full = 250000;
    edgeGain = ec >= 200000 ? 1 : Math.min(12, Math.sqrt(full / Math.max(ec, 1)));
    nodeGain = Math.min(4, edgeGain);
  }

  /* ── colour ──────────────────────────────────────────────────── */
  function islandHue(i) {
    const M = DS.isl;
    return M <= 5 ? PAL5[i] : hsl(i / M, 0.62, 0.66);
  }
  function groupColour(g) {
    if (state.colourBy === "run" && DS.runs > 1) return PAL5[gRun[g] % 5];
    const M = DS.isl, i = gIsl[g];
    if (M <= 5) return PAL5[i];
    return hsl(i / M, 0.62, 0.66);
  }
  const islLabel = i => (DS.islandIds ? DS.islandIds[i] : i);

  /* ── GL programs ─────────────────────────────────────────────── */
  function sh(type, src, defs) {
    const s = gl.createShader(type);
    gl.shaderSource(s, "#version 300 es\n" + (defs || "") + src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  }
  function prog(vs, fs, defs) {
    const p = gl.createProgram();
    gl.attachShader(p, sh(gl.VERTEX_SHADER, vs, defs));
    gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs, defs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    const u = {}, n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) {
      const info = gl.getActiveUniform(p, i);
      u[info.name.replace(/\[0\]$/, "")] = gl.getUniformLocation(p, info.name);
    }
    return { p, u };
  }

  const hdrOK = !!gl.getExtension("EXT_color_buffer_float");
  const HDRDEF = hdrOK ? "#define HDR 1\n" : "";
  const pPoint = prog(VS_GRAPH, FS_POINT, HDRDEF);
  const pLine = prog(VS_GRAPH, FS_LINE, HDRDEF);
  const pArc = prog(VS_ARC, FS_LINE, HDRDEF);
  const pTone = prog(VS_FULL, FS_TONE);

  const vaoEmpty = gl.createVertexArray();
  let fbo = null, fboT0 = null, fboW = 0, fboH = 0;
  function ensureFBO(W, H) {
    if (!hdrOK) return false;
    if (fbo && fboW === W && fboH === H) return true;
    if (fboT0) gl.deleteTexture(fboT0);
    if (fbo) gl.deleteFramebuffer(fbo);
    fboT0 = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, fboT0);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, W, H, 0, gl.RGBA, gl.HALF_FLOAT, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, fboT0, 0);
    const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (!ok) { fbo = null; return false; }
    fboW = W; fboH = H;
    return true;
  }

  const bNode = gl.createBuffer(), bIdx = gl.createBuffer(), bArc = gl.createBuffer();
  let vaoNodes = null, vaoArcs = null;
  let arcVerts = 0, drawnEdges = 0;
  let nodeData = null, lastVP = null;

  // xy(2) offI(2) offR(2) z(3) grp(1) size(1) shared(1) z2(3) = 15 floats.
  // z holds fitness / time / island plane, z2 holds evaluations / degree /
  // sharing: six height channels, selected by a one-hot eased in the frame.
  const NF = 15, NST = NF * 4;
  const NSPEC = [["aXY", 2, 0], ["aOffI", 2, 8], ["aOffR", 2, 16], ["aZ", 3, 24],
  ["aGrp", 1, 36], ["aSize", 1, 40], ["aShared", 1, 44], ["aZ2", 3, 48]];

  let offI = [], offR = [];
  function computeOffsets() {
    offI = []; offR = [];
    for (let g = 0; g < NG; g++) {
      const ai = (gIsl[g] / DS.isl) * Math.PI * 2 - Math.PI / 2;
      offI.push([Math.cos(ai) * RING_I, Math.sin(ai) * RING_I]);
      if (DS.runs > 1) {
        const ar = (gRun[g] / DS.runs) * Math.PI * 2 - Math.PI / 2;
        offR.push([Math.cos(ar) * RING_R, Math.sin(ar) * RING_R]);
      } else offR.push([0, 0]);
    }
  }

  function buildGeometry() {
    const n = G.nodeCount;
    const v = new Float32Array(n * NF);
    let maxVis = 1, maxDeg = 1;
    for (let i = 0; i < n; i++) {
      if (G.pVis[i] > maxVis) maxVis = G.pVis[i];
      const dg = G.pIn[i] + G.pOut[i]; if (dg > maxDeg) maxDeg = dg;
    }
    const lv = Math.log2(1 + maxVis);
    for (let i = 0; i < n; i++) {
      const g = G.pGrp[i], o = i * NF;
      v[o] = G.px[i]; v[o + 1] = G.py[i];
      v[o + 2] = offI[g][0]; v[o + 3] = offI[g][1];
      v[o + 4] = offR[g][0]; v[o + 5] = offR[g][1];
      v[o + 6] = fitnessPct(G.pf[i]) * 1.8 - 0.9;               // fitness rank
      v[o + 7] = (G.pg[i] / gLen[g]) * 1.8 - 0.9;               // elapsed time
      v[o + 8] = (gIsl[g] - (DS.isl - 1) / 2) * PLANE_GAP;       // island plane
      v[o + 9] = g;
      v[o + 10] = 1.0 + Math.log2(1 + G.pVis[i]) * 0.85;
      v[o + 11] = G.pShared[i];
      v[o + 12] = (Math.log2(1 + G.pVis[i]) / lv) * 1.8 - 0.9;          // evaluations
      v[o + 13] = ((G.pIn[i] + G.pOut[i]) / maxDeg) * 1.8 - 0.9;        // degree
      v[o + 14] = G.pShared[i] * 1.8 - 0.9;                             // islands sharing
    }
    nodeData = v;
    gl.bindBuffer(gl.ARRAY_BUFFER, bNode);
    gl.bufferData(gl.ARRAY_BUFFER, v, gl.STATIC_DRAW);
    if (vaoNodes) gl.deleteVertexArray(vaoNodes);
    vaoNodes = gl.createVertexArray();
    gl.bindVertexArray(vaoNodes);
    gl.bindBuffer(gl.ARRAY_BUFFER, bNode);
    for (let i = 0; i < NSPEC.length; i++) {
      const loc = gl.getAttribLocation(pPoint.p, NSPEC[i][0]);
      if (loc < 0) continue;
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, NSPEC[i][1], gl.FLOAT, false, NST, NSPEC[i][2]);
    }
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, bIdx);
    gl.bindVertexArray(null);

    // migration ribbons: 10 segments, 6 verts each, 27 floats per vertex.
    // The stride must equal the floats actually written, or every following
    // vertex shifts and the ribbons shred into shards.
    const SEG = 10, m = G.mig.length, ST = 27;
    const arc = new Float32Array(m * SEG * 6 * ST);
    const quad = [[0, -1], [0, 1], [1, -1], [1, -1], [0, 1], [1, 1]];
    let p = 0;
    for (let i = 0; i < m; i++) {
      const A = G.mig[i].a * NF, B = G.mig[i].b * NF, rid = G.mig[i].route;
      for (let s = 0; s < SEG; s++) {
        for (let j = 0; j < 6; j++) {
          const t = (s + quad[j][0]) / SEG;
          arc[p++] = v[A]; arc[p++] = v[A + 1]; arc[p++] = v[A + 2]; arc[p++] = v[A + 3];
          arc[p++] = v[A + 4]; arc[p++] = v[A + 5];
          arc[p++] = v[A + 6]; arc[p++] = v[A + 7]; arc[p++] = v[A + 8];
          arc[p++] = v[A + 12]; arc[p++] = v[A + 13]; arc[p++] = v[A + 14];
          arc[p++] = v[B]; arc[p++] = v[B + 1]; arc[p++] = v[B + 2]; arc[p++] = v[B + 3];
          arc[p++] = v[B + 4]; arc[p++] = v[B + 5];
          arc[p++] = v[B + 6]; arc[p++] = v[B + 7]; arc[p++] = v[B + 8];
          arc[p++] = v[B + 12]; arc[p++] = v[B + 13]; arc[p++] = v[B + 14];
          arc[p++] = t; arc[p++] = quad[j][1]; arc[p++] = rid;
        }
      }
    }
    arcVerts = m * SEG * 6;
    gl.bindBuffer(gl.ARRAY_BUFFER, bArc);
    gl.bufferData(gl.ARRAY_BUFFER, arc, gl.STATIC_DRAW);
    if (vaoArcs) gl.deleteVertexArray(vaoArcs);
    vaoArcs = gl.createVertexArray();
    gl.bindVertexArray(vaoArcs);
    const S = ST * 4;
    const ASPEC = [["aA", 2, 0], ["aAI", 2, 8], ["aAR", 2, 16], ["aAZ", 3, 24], ["aAZ2", 3, 36],
    ["aB", 2, 48], ["aBI", 2, 56], ["aBR", 2, 64], ["aBZ", 3, 72], ["aBZ2", 3, 84],
    ["aT", 1, 96], ["aSide", 1, 100], ["aRoute", 1, 104]];
    for (let i = 0; i < ASPEC.length; i++) {
      const loc = gl.getAttribLocation(pArc.p, ASPEC[i][0]);
      if (loc < 0) continue;
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, ASPEC[i][1], gl.FLOAT, false, S, ASPEC[i][2]);
    }
    gl.bindVertexArray(null);
  }

  function buildIndex() {
    const e = G.e, ew = G.ew, floor = state.wt;
    const idx = new Uint32Array(G.edgeCount * 2);
    let o = 0;
    for (let i = 0; i < G.edgeCount; i++)
      if (ew[i] >= floor) { idx[o++] = e[i * 2]; idx[o++] = e[i * 2 + 1]; }
    drawnEdges = o / 2;
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, bIdx);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx.subarray(0, o), gl.DYNAMIC_DRAW);
  }

  /* ── state + camera ──────────────────────────────────────────── */
  const state = {
    ds: 0, res: 2, wt: 2, ns: 100, zMode: 0, op: 180, dom: 140, exI: 0, exR: 0,
    colourBy: "island", grpOn: [], routesOn: [],
    contest: false, edges: true, selMark: true, bestIsl: true, bestRun: true,
    group: false, exIBefore: 0, flat: false, hs: 100, hsBefore: 100
  };
  let selected = -1;
  const cam = { az: 0.62, el: 0.30, dist: 3.15, tx: 0, ty: 0, tz: 0 };
  const zMix = new Float32Array([1, 0, 0, 0, 0, 0]);
  let zTarget = new Float32Array([1, 0, 0, 0, 0, 0]);
  let exIShown = 0, exRShown = 0, contestShown = 0, flatShown = 0, groupShown = 0, hsShown = 1;
  let camGoal = null;      // eased camera move set by Group by island
  let flyNode = -1, flyFrames = 0;
  const placed = [];
  let lastInteract = 0;

  const grpVisible = g => state.grpOn[g];
  const runAnyOn = r => {
    for (let g = 0; g < NG; g++) if (gRun[g] === r && state.grpOn[g]) return true;
    return false;
  };
  function setRun(r, on) { for (let g = 0; g < NG; g++) if (gRun[g] === r) state.grpOn[g] = on; }
  const noneOn = () => state.grpOn.every(v => !v);

  function camBasis() {
    const cz = [Math.sin(cam.az) * Math.cos(cam.el), Math.sin(cam.el), Math.cos(cam.az) * Math.cos(cam.el)];
    const fwd = [-cz[0], -cz[1], -cz[2]];
    let r = [-fwd[2], 0, fwd[0]];
    const rl = Math.hypot(r[0], r[1], r[2]) || 1;
    r = [r[0] / rl, r[1] / rl, r[2] / rl];
    const up = [r[1] * fwd[2] - r[2] * fwd[1], r[2] * fwd[0] - r[0] * fwd[2], r[0] * fwd[1] - r[1] * fwd[0]];
    return { fwd, right: r, up };
  }

  function dpr() { return Math.min(window.devicePixelRatio || 1, 2); }
  function resize() {
    const r = canvas.getBoundingClientRect(), d = dpr();
    const w = Math.max(1, (r.width * d) | 0), h = Math.max(1, (r.height * d) | 0);
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  }

  let dragging = 0, lx = 0, ly = 0, travel = 0;   // 1 = orbit, 2 = pan
  canvas.addEventListener("contextmenu", ev => ev.preventDefault());
  canvas.addEventListener("pointerdown", ev => {
    flyNode = -1; zoomTarget = 0; camGoal = null;
    dragging = (ev.button === 2 || ev.button === 1 || ev.shiftKey) ? 2 : 1;
    lx = ev.clientX; ly = ev.clientY; travel = 0;
    canvas.classList.add("dragging");
    canvas.setPointerCapture(ev.pointerId);
    lastInteract = performance.now();
  });
  let hoverAt = 0;
  function showHover(ev) {
    const now = performance.now(), tip = $("hover-tip");
    if (now - hoverAt < 60 || !G) return;
    hoverAt = now;
    const r = canvas.getBoundingClientRect(), x = ev.clientX - r.left, y = ev.clientY - r.top, i = pickAt(x, y);
    tip.hidden = i < 0;
    if (i < 0) return;
    tip.textContent = "Island " + islLabel(gIsl[G.pGrp[i]]) + " · fitness " + ((DS.fitSign || 1) * G.pf[i]).toFixed(4) + " · " + G.pVis[i] + (G.pVis[i] === 1 ? " evaluation" : " evaluations");
    tip.style.transform = "translate(" + Math.min(x + 14, r.width - 250) + "px," + (y + 14) + "px)";
  }
  canvas.addEventListener("pointerleave", () => { $("hover-tip").hidden = true; });
  canvas.addEventListener("pointermove", ev => {
    if (!dragging) return showHover(ev);
    const dx = ev.clientX - lx, dy = ev.clientY - ly;
    travel += Math.abs(dx) + Math.abs(dy);
    if (dragging === 1) {
      cam.az -= dx * 0.006;
      cam.el = Math.max(-1.45, Math.min(1.45, cam.el + dy * 0.005));
    } else {
      const b = camBasis();
      const k = cam.dist * 0.0022;
      cam.tx -= (b.right[0] * dx - b.up[0] * dy) * k;
      cam.ty -= (b.right[1] * dx - b.up[1] * dy) * k;
      cam.tz -= (b.right[2] * dx - b.up[2] * dy) * k;
    }
    lx = ev.clientX; ly = ev.clientY; lastInteract = performance.now();
  });
  const endDrag = () => { dragging = 0; canvas.classList.remove("dragging"); lastInteract = performance.now(); };
  canvas.addEventListener("pointerup", ev => {
    const wasDrag = travel > 5, wasPan = dragging === 2;
    endDrag();
    if (wasDrag || wasPan) return;
    const r = canvas.getBoundingClientRect();
    select(pickAt(ev.clientX - r.left, ev.clientY - r.top));
  });
  canvas.addEventListener("pointercancel", endDrag);

  // Zoom toward the cursor, not the centre: the point under the pointer stays
  // put, so you can drive into any part of the cloud instead of only the middle.
  //
  // The wheel only sets a TARGET distance. Every frame eases toward it in log
  // space and re-anchors on the cursor, so a notched mouse wheel glides instead
  // of stepping and a trackpad's fine deltas accumulate smoothly.
  const ZOOM_MIN = 0.0004, ZOOM_MAX = 16;
  let zoomTarget = 0, zoomNx = 0, zoomNy = 0, zoomAspect = 1;
  let zoomNode = -1;      // node under the cursor when the gesture began, or -1

  function zoomTo(nx, ny, aspect, nd) {
    const eff = nd / cam.dist;
    if (Math.abs(eff - 1) > 1e-6) {
      const b = camBasis();
      if (zoomNode >= 0 && zoomNode < G.nodeCount) {
        // Dolly toward the node itself. The camera orientation is fixed, so
        // scaling the eye-to-node vector keeps the node under the cursor at
        // EVERY depth. Anchoring on the focal plane instead drifts off any
        // node that is nearer or farther than it -- the best clusters sit at
        // the bottom of the funnel, well away from the plane.
        const P = worldOf(zoomNode);
        const ex = cam.tx - b.fwd[0] * cam.dist, ey = cam.ty - b.fwd[1] * cam.dist, ez = cam.tz - b.fwd[2] * cam.dist;
        const nxE = P[0] + (ex - P[0]) * eff, nyE = P[1] + (ey - P[1]) * eff, nzE = P[2] + (ez - P[2]) * eff;
        cam.tx = nxE + b.fwd[0] * nd; cam.ty = nyE + b.fwd[1] * nd; cam.tz = nzE + b.fwd[2] * nd;
      } else {
        const tanF = Math.tan(Math.PI / 8);
        let d = [
          b.fwd[0] + b.right[0] * nx * aspect * tanF + b.up[0] * ny * tanF,
          b.fwd[1] + b.right[1] * nx * aspect * tanF + b.up[1] * ny * tanF,
          b.fwd[2] + b.right[2] * nx * aspect * tanF + b.up[2] * ny * tanF
        ];
        const dl = Math.hypot(d[0], d[1], d[2]) || 1;
        d = [d[0] / dl, d[1] / dl, d[2] / dl];
        const dd = d[0] * b.fwd[0] + d[1] * b.fwd[1] + d[2] * b.fwd[2];
        if (dd > 0.05) {
          const t = cam.dist / dd;
          const ex = cam.tx - b.fwd[0] * cam.dist, ey = cam.ty - b.fwd[1] * cam.dist, ez = cam.tz - b.fwd[2] * cam.dist;
          const k = 1 - eff;
          cam.tx += (ex + d[0] * t - cam.tx) * k;
          cam.ty += (ey + d[1] * t - cam.ty) * k;
          cam.tz += (ez + d[2] * t - cam.tz) * k;
        }
      }
    }
    cam.dist = nd;
  }

  canvas.addEventListener("wheel", ev => {
    ev.preventDefault();
    flyNode = -1; camGoal = null;
    const r = canvas.getBoundingClientRect();
    zoomNx = ((ev.clientX - r.left) / r.width) * 2 - 1;
    zoomNy = 1 - ((ev.clientY - r.top) / r.height) * 2;
    zoomAspect = r.width / r.height;
    // Lock onto the cluster under the cursor for the whole gesture.
    zoomNode = pickAt(ev.clientX - r.left, ev.clientY - r.top);
    // Normalise units (lines/pages -> pixels); a pinch arrives as ctrl+wheel
    // with much smaller deltas, so it gets a larger gain.
    let dy = ev.deltaY * (ev.deltaMode === 1 ? 16 : ev.deltaMode === 2 ? 400 : 1);
    dy = Math.max(-240, Math.min(240, dy));
    const gain = ev.ctrlKey ? 0.012 : 0.0022;
    const base = zoomTarget > 0 ? zoomTarget : cam.dist;
    zoomTarget = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, base * Math.exp(dy * gain)));
    lastInteract = performance.now();
  }, { passive: false });

  // Advance the zoom one frame. Returns true while it is still moving.
  function stepZoom() {
    if (zoomTarget <= 0) return false;
    const ratio = zoomTarget / cam.dist;
    if (Math.abs(Math.log(ratio)) < 0.0008) {
      zoomTo(zoomNx, zoomNy, zoomAspect, zoomTarget);
      zoomTarget = 0; zoomNode = -1;
      return false;
    }
    zoomTo(zoomNx, zoomNy, zoomAspect, cam.dist * Math.pow(ratio, 0.22));
    return true;
  }

  function nodeY(v, o) {
    return (v[o + 6] * zMix[0] + v[o + 7] * zMix[1] + v[o + 8] * zMix[2] +
      v[o + 12] * zMix[3] + v[o + 13] * zMix[4] + v[o + 14] * zMix[5]) * (1 - flatShown) * hsShown;
  }
  function place(bx0, bz0, oix, oiz, orx, orz) {
    const x1 = bx0 + (bx0 * SI + oix - bx0) * exIShown;
    const z1 = bz0 + (bz0 * SI + oiz - bz0) * exIShown;
    return [x1 + (x1 * SR + orx - x1) * exRShown, z1 + (z1 * SR + orz - z1) * exRShown];
  }
  function pickAt(sx, sy) {
    const v = nodeData, VP = lastVP;
    if (!v || !VP) return -1;
    const W = canvas.clientWidth, H = canvas.clientHeight;
    const R2 = 13 * 13;
    let best = -1, bestScore = -1;
    for (let i = 0; i < G.nodeCount; i++) {
      if (!grpVisible(G.pGrp[i])) continue;
      const o = i * NF;
      const q = place(v[o], v[o + 1], v[o + 2], v[o + 3], v[o + 4], v[o + 5]);
      const gy = nodeY(v, o);
      const cw = VP[3] * q[0] + VP[7] * gy + VP[11] * q[1] + VP[15];
      if (cw <= 1e-6) continue;
      const cx = VP[0] * q[0] + VP[4] * gy + VP[8] * q[1] + VP[12];
      const cy = VP[1] * q[0] + VP[5] * gy + VP[9] * q[1] + VP[13];
      const px = (cx / cw * 0.5 + 0.5) * W - sx, py = (1 - (cy / cw * 0.5 + 0.5)) * H - sy;
      const d2 = px * px + py * py;
      if (d2 > R2) continue;
      const score = G.pVis[i] / (1 + d2 * 0.08);
      if (score > bestScore) { bestScore = score; best = i; }
    }
    return best;
  }
  function worldOf(i) {
    const v = nodeData, o = i * NF;
    const q = place(v[o], v[o + 1], v[o + 2], v[o + 3], v[o + 4], v[o + 5]);
    return [q[0], nodeY(v, o), q[1]];
  }
  // Fly the camera to a cluster and open it. The target is recomputed every
  // frame from the node index, so it stays locked on while explode animates.
  function jumpTo(node, grp) {
    if (node == null || node < 0 || !G || node >= G.nodeCount) return;
    if (grp >= 0 && !state.grpOn[grp]) { state.grpOn[grp] = true; syncSelectors(); }
    select(node);
    flyNode = node; flyFrames = 0;
    lastInteract = performance.now();
  }
  function project(i) {
    const v = nodeData, VP = lastVP, o = i * NF;
    const q = place(v[o], v[o + 1], v[o + 2], v[o + 3], v[o + 4], v[o + 5]);
    const gy = nodeY(v, o);
    const cw = VP[3] * q[0] + VP[7] * gy + VP[11] * q[1] + VP[15];
    if (cw <= 1e-6) return null;                         // behind the camera
    const cx = VP[0] * q[0] + VP[4] * gy + VP[8] * q[1] + VP[12];
    const cy = VP[1] * q[0] + VP[5] * gy + VP[9] * q[1] + VP[13];
    const W = canvas.clientWidth, H = canvas.clientHeight;
    const sx = (cx / cw * 0.5 + 0.5) * W, sy = (1 - (cy / cw * 0.5 + 0.5)) * H;
    const m = 28;                                        // half a marker
    if (sx < -m || sx > W + m || sy < -m || sy > H + m) return null;   // off-viewport
    return [sx, sy];
  }

  function projectWorld(x, y, z) {
    const VP = lastVP;
    if (!VP) return null;
    const cw = VP[3] * x + VP[7] * y + VP[11] * z + VP[15];
    if (cw <= 1e-6) return null;
    const cx = VP[0] * x + VP[4] * y + VP[8] * z + VP[12];
    const cy = VP[1] * x + VP[5] * y + VP[9] * z + VP[13];
    const W = canvas.clientWidth, H = canvas.clientHeight;
    return [(cx / cw * 0.5 + 0.5) * W, (1 - (cy / cw * 0.5 + 0.5)) * H];
  }

  /* ── UI ──────────────────────────────────────────────────────── */
  const fmt = n => n.toLocaleString("en-US");
  const GE = "≥";
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  function chip(label, colour, on, onClick) {
    const b = document.createElement("button");
    b.className = "chip";
    b.setAttribute("aria-pressed", String(on));
    b.innerHTML = (colour ? '<span class="sw" style="background:' + colour + '"></span>' : "") +
      '<span class="lb">' + esc(label) + '</span>';
    b.addEventListener("click", onClick);
    return b;
  }

  function buildSelectors() {
    // runs
    const runWrap = $("grp-runs"), runBox = $("runs");
    runWrap.hidden = DS.runs < 2;
    runBox.innerHTML = "";
    for (let r = 0; r < DS.runs; r++) {
      runBox.appendChild(chip("RUN " + r, hex(PAL5[r % 5]), runAnyOn(r), ev => {
        if (ev.shiftKey) for (let g = 0; g < NG; g++) state.grpOn[g] = (gRun[g] === r);
        else setRun(r, !runAnyOn(r));
        if (noneOn()) setRun(r, true);
        syncSelectors();
      }));
    }
    $("c-run").hidden = DS.runs < 2;
    $("grp-exr").hidden = DS.runs < 2;

    // islands
    const islBox = $("islands"); islBox.innerHTML = "";
    islBox.className = NG > 6 ? "chips grid" : "chips";
    $("islands-h").textContent = DS.runs > 1 ? "Groups · run · island" : "Islands";
    for (let g = 0; g < NG; g++) {
      const label = DS.runs > 1 ? gRun[g] + "·" + islLabel(gIsl[g]) : String(islLabel(gIsl[g]));
      islBox.appendChild(chip(label, hex(islandHue(gIsl[g])), state.grpOn[g], ev => {
        if (ev.shiftKey) for (let j = 0; j < NG; j++) state.grpOn[j] = (j === g);
        else state.grpOn[g] = !state.grpOn[g];
        if (noneOn()) state.grpOn[g] = true;
        syncSelectors();
      }));
    }

    // migration routes
    const rBox = $("routes"); rBox.innerHTML = "";
    G.routes.forEach((rt, k) => {
      const label = (DS.runs > 1 ? "r" + rt.run + " " : "") + islLabel(gIsl[rt.sg]) + "→" + islLabel(gIsl[rt.dg]);
      rBox.appendChild(chip(label, hex(islandHue(gIsl[rt.sg])), state.routesOn[k], ev => {
        if (ev.shiftKey) {
          const solo = state.routesOn.every((v, j) => j === k ? v : !v);
          for (let j = 0; j < state.routesOn.length; j++) state.routesOn[j] = solo ? true : (j === k);
        } else state.routesOn[k] = !state.routesOn[k];
        syncSelectors();
      }));
    });
    $("routes-n").textContent = G.routes.length + " routes";

    // jump-to-best buttons: one per island, one per run
    const bBox = $("bests"); bBox.innerHTML = "";
    bBox.className = NG > 6 ? "chips grid" : "chips";
    const jumpBtn = (icon, label, title, fn) => {
      const b = document.createElement("button");
      b.className = "chip best"; b.title = title;
      b.innerHTML = '<span class="icn ' + icon + '"></span><span class="lb">' + esc(label) + '</span>';
      b.addEventListener("click", fn);
      return b;
    };
    for (let g = 0; g < NG; g++) {
      const label = DS.runs > 1 ? gRun[g] + "·" + islLabel(gIsl[g]) : String(islLabel(gIsl[g]));
      bBox.appendChild(jumpBtn("ring2", label, "Best cluster of island " + islLabel(gIsl[g]),
        () => jumpTo(G.bestOfGroup[g], g)));
    }
    for (let r = 0; r < DS.runs; r++) {
      bBox.appendChild(jumpBtn("dia", DS.runs > 1 ? "R" + r : "BEST", "Best cluster of run " + r,
        () => { const n = G.bestOfRun[r]; jumpTo(n, n >= 0 ? G.pGrp[n] : -1); }));
    }
  }

  function syncSelectors() {
    $("mig-all").setAttribute("aria-pressed", String(state.routesOn.some(Boolean)));
    Array.prototype.forEach.call($("runs").children,
      (b, r) => b.setAttribute("aria-pressed", String(runAnyOn(r))));
    Array.prototype.forEach.call($("islands").children,
      (b, g) => b.setAttribute("aria-pressed", String(!!state.grpOn[g])));
    Array.prototype.forEach.call($("routes").children,
      (b, k) => b.setAttribute("aria-pressed", String(!!state.routesOn[k])));
    updateLegend();
  }

  function updateLegend() {
    const L = $("legend"); L.innerHTML = "";
    const add = html => { const s = document.createElement("span"); s.innerHTML = html; L.appendChild(s); };
    if (state.colourBy === "fitness") {
      add('<i class="fit"></i>Best to worst fitness');
    } else if (state.colourBy === "run" && DS.runs > 1) {
      for (let r = 0; r < DS.runs; r++) add('<i style="border-color:' + hex(PAL5[r % 5]) + '"></i>Run ' + r);
    } else if (DS.isl <= 6) {
      for (let i = 0; i < DS.isl; i++) add('<i style="border-color:' + hex(groupColour(i)) + '"></i>Island ' + islLabel(i));
    } else {
      add('<i class="ramp"></i>Island 0–' + (DS.isl - 1) + ' &middot; hue follows ring position');
    }
    add('<i style="border-color:var(--mig); border-top-width:3px"></i>Migration');
    add('<i class="ring"></i>Contested cluster');
    add('<i class="bi"></i>Island best');
    add('<i class="br"></i>Run best');
  }

  /* markers for island bests and run bests */
  const markBox = $("marks");
  let markEls = [];
  const labelBox = $("plabels");
  let labelEls = [];
  function buildMarks() {
    labelBox.innerHTML = ""; labelEls = [];
    for (let g = 0; g < NG; g++) {
      const d = document.createElement("div");
      d.className = "plabel";
      d.style.color = hex(groupColour(g));
      d.textContent = (DS.runs > 1 ? "RUN " + gRun[g] + " \u00b7 " : "") + "ISLAND " + islLabel(gIsl[g]);
      d.hidden = true;
      labelBox.appendChild(d);
      labelEls.push(d);
    }
    markBox.innerHTML = ""; markEls = [];
    for (let r = 0; r < DS.runs; r++) {
      const d = document.createElement("div");
      d.className = "bmark br";
      d.title = "Run best";
      markBox.appendChild(d);
      markEls.push({ el: d, kind: "run", r: r });
    }
    for (let g = 0; g < NG; g++) {
      const d = document.createElement("div");
      d.className = "bmark bi";
      d.title = "Island best";
      markBox.appendChild(d);
      markEls.push({ el: d, kind: "isl", g: g });
    }
  }

  /* inspector */
  const sci = v => (Math.abs(v) >= 1e4 || (v !== 0 && Math.abs(v) < 1e-3))
    ? v.toExponential(3) : v.toFixed(4);
  function clusterHash(cell, g) {
    const a = (Math.imul(cell, 2654435761) ^ Math.imul(g + 1, 0x9E3779B1)) >>> 0;
    const b = (Math.imul(cell, 40503) + Math.imul(g + 1, 2246822519)) >>> 0;
    const c = (a ^ (b >>> 7)) >>> 0, d = (b ^ (a >>> 11)) >>> 0;
    return [a, b, c, d].map(x => x.toString(16).padStart(8, "0")).join("");
  }
  const row = (k, v) => '<div class="ins-row"><dt>' + k + '</dt><dd>' + v + '</dd></div>';

  function select(i) {
    selected = i;
    const box = $("ins-body"), title = $("ins-title"), x = $("ins-x");
    if (i < 0 || !G || i >= G.nodeCount) {
      selected = -1;
      title.textContent = "Click a node to inspect it";
      x.hidden = true;
      box.innerHTML = '<p class="ins-empty">Click any node to inspect the cluster behind it ' +
        '&mdash; genome, fitness, how many evaluations landed there, and who shares it.</p>';
      return;
    }
    const g = G.pGrp[i], isl = islLabel(gIsl[g]), run = gRun[g];
    const sign = DS.fitSign || 1;                       // display in the log's own orientation
    title.innerHTML = '<i style="background:' + hex(groupColour(g)) + '"></i>' +
      (DS.runs > 1 ? "Run " + run + " &middot; " : "") + "Island " + isl + " &middot; " + i;
    x.hidden = false;
    const isIslBest = G.bestOfGroup[g] === i;
    const isRunBest = G.bestOfRun[run] === i;
    const badge = isRunBest ? '<span class="bdg run">RUN BEST</span>'
      : isIslBest ? '<span class="bdg isl">ISLAND BEST</span>' : "";
    const hash = DS.hashes ? DS.hashes[G.pSample[i]] : clusterHash(G.pCell[i], g);
    box.innerHTML =
      (badge ? '<div class="ins-row"><dt></dt><dd>' + badge + '</dd></div>' : "") +
      row("genome_hash", '<span class="mut">' + esc(hash) + '</span>') +
      row("genome_repr", "[" + G.px[i].toFixed(4) + ", " + G.py[i].toFixed(4) + "]") +
      row("fitness", sci(sign * G.pf[i]) + ' <span class="mut">mean</span>') +
      row("best", sci(sign * G.pBest[i]) + ' <span class="mut">in cluster</span>') +
      row("percentile", (fitnessPct(G.pf[i]) * 100).toFixed(1) + '% <span class="mut">of run &middot; lower is better</span>') +
      row("evaluations", fmt(G.pVis[i]) + ' <span class="mut">landed here</span>') +
      row("eval_index", fmt(G.pFirst[i]) + " &rarr; " + fmt(G.pLast[i])) +
      row("degree", G.pIn[i] + " in / " + G.pOut[i] + " out") +
      row("groups here", Math.round(G.pShared[i] * (NG - 1)) + 1 + ' <span class="mut">of ' + NG + '</span>') +
      (DS.runs > 1 ? row("runs here", G.pRuns[i] + ' <span class="mut">of ' + DS.runs + '</span>') : "") +
      row("migration", G.migNodes.has(i) ? "endpoint of a migration"
        : '<span class="mut">not a migration endpoint</span>');
  }
  $("ins-x").addEventListener("click", () => select(-1));

  /* controls */
  function segment(ids, get, set) {
    ids.forEach((id, i) => $(id).addEventListener("click", () => {
      set(i);
      ids.forEach((o, j) => $(o).setAttribute("aria-pressed", String(j === get())));
    }));
  }
  const HEIGHT_IDS = ["z-fit", "z-time", "z-isle", "z-vis", "z-deg", "z-shr"];
  const HEIGHT_NAMES = ["fitness", "time", "island plane", "evaluations", "links", "islands sharing"];
  // top label, bottom label: what sits high and what sits low
  const HEIGHT_AXIS = [["WORSE", "BETTER"], ["LATER", "EARLIER"], ["", ""],
    ["MORE EVALS", "FEWER"], ["MORE LINKS", "FEWER"], ["MORE ISLANDS", "FEWER"]];
  function syncHeight() {
    HEIGHT_IDS.forEach((id, j) => $(id).setAttribute("aria-pressed", String(!state.flat && j === state.zMode)));
    $("z-flat").setAttribute("aria-pressed", String(state.flat));
    $("v-height").textContent = state.flat ? "flat" : HEIGHT_NAMES[state.zMode];
    const ax = HEIGHT_AXIS[state.zMode];
    $("ax-top").textContent = ax[0]; $("ax-bot").textContent = ax[1];
  }
  HEIGHT_IDS.forEach((id, i) => $(id).addEventListener("click", () => {
    state.zMode = i; state.flat = false;
    zTarget = new Float32Array(6); zTarget[i] = 1;
    syncHeight();
  }));
  $("z-flat").addEventListener("click", () => { state.flat = !state.flat; syncHeight(); });
  segment(["c-isl", "c-run", "c-fit"], () => ["island", "run", "fitness"].indexOf(state.colourBy), i => {
    state.colourBy = ["island", "run", "fitness"][i];
    buildSelectors(); syncSelectors();
  });
  $("s-res").addEventListener("input", e => { applyRes(+e.target.value); });
  $("s-wt").addEventListener("input", e => {
    state.wt = +e.target.value; $("v-wt").textContent = GE + " " + state.wt + " visits";
    buildIndex(); updateStats();
  });
  $("s-ns").addEventListener("input", e => {
    state.ns = +e.target.value; $("v-ns").textContent = (state.ns / 100).toFixed(2);
  });
  $("s-op").addEventListener("input", e => {
    state.op = +e.target.value; $("v-op").textContent = (state.op / 100).toFixed(2);
  });
  $("s-dom").addEventListener("input", e => {
    state.dom = +e.target.value; $("v-dom").textContent = (state.dom / 100).toFixed(2);
  });
  $("s-exi").addEventListener("input", e => {
    state.exI = +e.target.value; $("v-exi").textContent = (state.exI / 100).toFixed(2);
  });
  $("s-hs").addEventListener("input", e => {
    state.hs = +e.target.value; $("v-hs").textContent = (state.hs / 100).toFixed(2);
  });
  $("s-exr").addEventListener("input", e => {
    state.exR = +e.target.value; $("v-exr").textContent = (state.exR / 100).toFixed(2);
  });
  const toggle = (id, key, after) => $(id).addEventListener("click", () => {
    state[key] = !state[key];
    $(id).setAttribute("aria-pressed", String(state[key]));
    if (after) after();
  });
  toggle("contest", "contest");
  toggle("b-sel", "selMark");
  toggle("t-edges", "edges", () => updateStats());
  toggle("b-isl", "bestIsl");
  toggle("b-run", "bestRun");
  // Group by island: islands pulled fully apart into their own patches, laid
  // flat on the ground plane (height collapsed), migration lifted into arcs, and
  // the camera eased to look down on the layout. Turning it off restores the
  // separation the reader had.
  $("b-group").addEventListener("click", () => {
    state.group = !state.group;
    $("b-group").setAttribute("aria-pressed", String(state.group));
    if (state.group) {
      state.exIBefore = state.exI;
      state.exI = 100;
      state.hsBefore = state.hs;
      state.hs = 30;
      camGoal = { el: 0.75, dist: 4.6 };
    } else {
      state.exI = state.exIBefore;
      state.hs = state.hsBefore;
      camGoal = { el: 0.30, dist: DS.runs > 1 ? 4.3 : 3.15 };
    }
    $("s-exi").value = state.exI; $("v-exi").textContent = (state.exI / 100).toFixed(2);
    $("s-hs").value = state.hs; $("v-hs").textContent = (state.hs / 100).toFixed(2);
    zoomTarget = 0;
  });
  $("mig-all").addEventListener("click", () => {
    const anyOff = state.routesOn.some(v => !v);
    for (let i = 0; i < state.routesOn.length; i++) state.routesOn[i] = anyOff;
    syncSelectors();
  });
  $("reset").addEventListener("click", () => {
    cam.az = DS.runs > 1 ? 1.14 : 0.62; cam.el = 0.30; cam.dist = DS.runs > 1 ? 4.3 : 3.15; cam.tx = cam.ty = cam.tz = 0;
    zoomTarget = 0;
  });

  let rebuildTimer = null;
  function applyRes(res) {
    state.res = res;
    $("s-res").value = res;
    $("v-res").textContent = GRID_NAMES[res];
    clearTimeout(rebuildTimer);
    note.textContent = "RE-CLUSTERING…"; note.style.display = "grid";
    rebuildTimer = setTimeout(() => {
      aggregate(state.res);
      const mx = Math.max(4, Math.min(24, Math.round(G.maxW * 0.25)));
      $("s-wt").max = mx;
      if (state.wt > mx) { state.wt = mx; $("s-wt").value = mx; $("v-wt").textContent = GE + " " + mx + " visits"; }
      // routes depend on topology, not granularity, so a rebuild keeps them
      if (state.routesOn.length !== G.routes.length) state.routesOn = G.routes.map(() => true);
      buildGeometry(); buildIndex(); buildSelectors(); syncSelectors();
      updateStats(); select(-1);
      note.style.display = "none";
    }, 30);
  }

  function updateStats() {
    $("k-nodes").textContent = fmt(G.nodeCount);
    $("k-edges").textContent = fmt(state.edges ? drawnEdges : 0);
    const pct = G.edgeCount && state.edges ? (drawnEdges / G.edgeCount * 100) : 0;
    $("k-pct").innerHTML = pct.toFixed(0) + '<small> %</small>';
    $("k-share").innerHTML = G.overlap.toFixed(2) + '<small> of ' + NG + '</small>';
    $("k-mig").textContent = fmt(G.mig.length);
    $("meta-run").textContent = DS.title || "";
    const lv = $("meta-level");
    lv.textContent = DS.levelNote || "";
    lv.className = "lvl" + (DS.levelWarn ? " warn" : "");
    $("meta-edges").textContent = fmt(G.edgeCount) + " unique transitions";
    $("meta-shape").innerHTML = DS.runs > 1
      ? DS.runs + " runs &times; " + DS.isl + " islands"
      : DS.isl + " islands" + (DS.shapeNote ? " &middot; " + esc(DS.shapeNote) : "") +
        (DS.cluster ? " &middot; " + fmt(G.nodeCount) + " clusters" : "");
  }

  function loadDataset(i) {
    state.ds = i;
    note.textContent = "LOADING …"; note.style.display = "grid";
    setTimeout(() => {
      if (!alive) return;
      const entry = entries[i];
      if (!entry._data) entry._data = entry.load ? entry.load() : entry;
      adopt(entry._data);
      state.grpOn = new Array(NG).fill(true);
      // Multi-run opens with runs pulled apart and hue on run: three legible
      // clouds whose overlap you can then collapse. Single-run opens merged.
      const multi = DS.runs > 1;
      state.colourBy = multi ? "run" : "island";
      state.exR = multi ? 100 : 0;
      state.exI = 0;
      cam.az = multi ? 1.14 : 0.62; cam.el = 0.30; cam.tx = cam.ty = cam.tz = 0;
      cam.dist = multi ? 4.3 : 3.15;
      $("s-exr").defaultValue = state.exR; $("s-exr").value = state.exR; $("v-exr").textContent = (state.exR / 100).toFixed(2);
      $("s-exi").value = 0; $("v-exi").textContent = "0.00";
      $("c-isl").setAttribute("aria-pressed", String(!multi));
      $("c-run").setAttribute("aria-pressed", String(multi));
      $("c-fit").setAttribute("aria-pressed", "false");
      $("cap").innerHTML = CAP;
      computeOffsets();
      aggregate(state.res);
      state.routesOn = G.routes.map(() => true);
      $("s-wt").max = Math.max(4, Math.min(24, Math.round(G.maxW * 0.25)));
      state.wt = 2; $("s-wt").value = 2; $("v-wt").textContent = GE + " 2 visits";
      buildGeometry(); buildIndex(); buildSelectors(); syncSelectors(); buildMarks();
      $("grp-agg").hidden = !!DS.cluster;
      syncHeight();
      updateStats(); select(-1);
      note.style.display = "none";
      startLoop();
    }, 30);
  }

  /* ── frame ───────────────────────────────────────────────────── */
  const alphaArr = new Float32Array(MAXG);
  const colArr = new Float32Array(MAXG * 3);
  const routeArr = new Float32Array(MAXG * 2);
  const zMix3a = new Float32Array(3), zMix3b = new Float32Array(3);
  const routeSrc = new Float32Array(MAXG * 2 * 3), routeDst = new Float32Array(MAXG * 2 * 3);
  const MIGC = [0.0, 0.898, 1.0];   // #00e5ff, reserved for migration
  let fpsN = 0, fpsLast = performance.now();

  const bgHex = getComputedStyle(root).getPropertyValue('--viz-bg').trim() || '#000000';
  const BG = [1, 3, 5].map(i => parseInt(bgHex.slice(i, i + 2), 16) / 255);

  let running = false, raf = 0, wantImage = false;
  $("save-img").addEventListener("click", () => { wantImage = true; });
  function startLoop() { if (!running) { running = true; raf = requestAnimationFrame(frame); } }

  function frame(now) {
    if (!alive) return;
    if (!G || !nodeData) { raf = requestAnimationFrame(frame); return; }
    resize();
    const W = canvas.width, H = canvas.height;
    const useHDR = ensureFBO(W, H);
    gl.bindFramebuffer(gl.FRAMEBUFFER, useHDR ? fbo : null);
    gl.viewport(0, 0, W, H);
    if (useHDR) gl.clearColor(0, 0, 0, 1); else gl.clearColor(BG[0], BG[1], BG[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);

    for (let i = 0; i < 6; i++) zMix[i] += (zTarget[i] - zMix[i]) * 0.08;
    exIShown += (state.exI / 100 - exIShown) * 0.10;
    exRShown += (state.exR / 100 - exRShown) * 0.10;
    contestShown += ((state.contest ? 1 : 0) - contestShown) * 0.12;
    flatShown += ((state.flat ? 1 : 0) - flatShown) * 0.08;
    groupShown += ((state.group ? 1 : 0) - groupShown) * 0.08;
    hsShown += (state.hs / 100 - hsShown) * 0.10;
    if (camGoal) {
      cam.el += (camGoal.el - cam.el) * 0.07;
      cam.dist += (camGoal.dist - cam.dist) * 0.07;
      if (Math.abs(camGoal.el - cam.el) < 0.003 && Math.abs(camGoal.dist - cam.dist) < 0.01) camGoal = null;
    }
    if (flyNode >= 0 && flyNode < G.nodeCount && nodeData) {
      const w = worldOf(flyNode), k = 0.14;
      cam.tx += (w[0] - cam.tx) * k; cam.ty += (w[1] - cam.ty) * k; cam.tz += (w[2] - cam.tz) * k;
      cam.dist += (0.9 - cam.dist) * k;
      if (++flyFrames > 130) flyNode = -1;
    }

    if (flyNode >= 0) zoomTarget = 0;
    stepZoom();
    const cz = [Math.sin(cam.az) * Math.cos(cam.el), Math.sin(cam.el), Math.cos(cam.az) * Math.cos(cam.el)];
    const eye = [cam.tx + cz[0] * cam.dist, cam.ty + cz[1] * cam.dist, cam.tz + cz[2] * cam.dist];
    const near = Math.max(0.00002, cam.dist * 0.004), far = cam.dist * 8 + 40;
    const VP = mul(perspective(Math.PI / 4, W / H, near, far), lookAt(eye, [cam.tx, cam.ty, cam.tz], [0, 1, 0]));
    lastVP = VP;
    for (let i = 0; i < 3; i++) { zMix3a[i] = zMix[i]; zMix3b[i] = zMix[i + 3]; }
    const fogN = cam.dist * 0.55, fogF = cam.dist * 1.95;

    for (let g = 0; g < NG && g < MAXG; g++) {
      alphaArr[g] = grpVisible(g) ? 1 : 0.045;
      const c = groupColour(g);
      colArr[g * 3] = c[0]; colArr[g * 3 + 1] = c[1]; colArr[g * 3 + 2] = c[2];
    }
    for (let k = 0; k < G.routes.length && k < MAXG * 2; k++) {
      const rt = G.routes[k];
      routeArr[k] = (state.routesOn[k] && grpVisible(rt.sg) && grpVisible(rt.dg)) ? 1 : 0;
      const cs = groupColour(rt.sg), cd = groupColour(rt.dg);
      routeSrc[k * 3] = cs[0]; routeSrc[k * 3 + 1] = cs[1]; routeSrc[k * 3 + 2] = cs[2];
      routeDst[k * 3] = cd[0]; routeDst[k * 3 + 1] = cd[1]; routeDst[k * 3 + 2] = cd[2];
    }

    function setGraph(P, base, pscale, contest) {
      gl.useProgram(P.p);
      gl.uniformMatrix4fv(P.u.uVP, false, VP);
      gl.uniform3fv(P.u.uZMix, zMix3a);
      gl.uniform3fv(P.u.uZMix2, zMix3b);
      gl.uniform3fv(P.u.uCol, colArr);
      gl.uniform1fv(P.u.uAlpha, alphaArr);
      gl.uniform1f(P.u.uBase, base);
      gl.uniform1f(P.u.uFogN, fogN);
      gl.uniform1f(P.u.uFogF, fogF);
      gl.uniform1f(P.u.uExI, exIShown);
      gl.uniform1f(P.u.uExR, exRShown);
      gl.uniform1f(P.u.uContest, contest);
      gl.uniform1f(P.u.uFlat, flatShown);
      gl.uniform1f(P.u.uHS, hsShown);
      gl.uniform1f(P.u.uByFit, state.colourBy === "fitness" ? 1 : 0);
      gl.uniform1f(P.u.uPScale, pscale);
    }

    if (state.edges && drawnEdges > 0) {
      gl.blendFunc(useHDR ? gl.ONE : gl.SRC_ALPHA, gl.ONE);
      setGraph(pLine, 0.05 * edgeGain, 1, contestShown);
      gl.bindVertexArray(vaoNodes);
      gl.drawElements(gl.LINES, drawnEdges * 2, gl.UNSIGNED_INT, 0);
    }

    gl.blendFunc(useHDR ? gl.ONE : gl.SRC_ALPHA, gl.ONE);
    setGraph(pPoint, (state.edges ? 0.14 : 0.42) * nodeGain, 1.35 * dpr() * state.ns / 100, contestShown);
    gl.bindVertexArray(vaoNodes);
    gl.drawArrays(gl.POINTS, 0, G.nodeCount);

    if (arcVerts > 0) {
      gl.blendFunc(useHDR ? gl.ONE : gl.SRC_ALPHA, gl.ONE);
      gl.useProgram(pArc.p);
      gl.uniformMatrix4fv(pArc.u.uVP, false, VP);
      gl.uniform3fv(pArc.u.uZMix, zMix3a);
      gl.uniform3fv(pArc.u.uZMix2, zMix3b);
      gl.uniform3fv(pArc.u.uMig, MIGC);
      gl.uniform1fv(pArc.u.uRoute, routeArr);
      gl.uniform1f(pArc.u.uBase, (state.edges ? 0.30 : 0.95) + 0.65 * groupShown);
      gl.uniform1f(pArc.u.uFlat, flatShown);
      gl.uniform1f(pArc.u.uHS, hsShown);
      gl.uniform1f(pArc.u.uLift, groupShown);
      gl.uniform1f(pArc.u.uRainbow, groupShown);
      gl.uniform3fv(pArc.u.uRSrc, routeSrc);
      gl.uniform3fv(pArc.u.uRDst, routeDst);
      gl.uniform1f(pArc.u.uExI, exIShown);
      gl.uniform1f(pArc.u.uExR, exRShown);
      gl.uniform1f(pArc.u.uAspect, W / H);
      gl.uniform1f(pArc.u.uHalfW, (0.85 + 0.9 * groupShown) * dpr() / H);
      gl.bindVertexArray(vaoArcs);
      gl.drawArrays(gl.TRIANGLES, 0, arcVerts);
    }
    gl.bindVertexArray(null);

    if (useHDR) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, W, H);
      gl.disable(gl.BLEND);
      gl.useProgram(pTone.p);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, fboT0);
      gl.uniform1i(pTone.u.uT0, 0);
      gl.uniform1f(pTone.u.uExp, state.op / 100);
      gl.uniform1f(pTone.u.uSat, state.dom / 100);
      gl.uniform3f(pTone.u.uBg, BG[0], BG[1], BG[2]);
      gl.bindVertexArray(vaoEmpty);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.bindVertexArray(null);
    }

    // selection reticle first: it claims its pixel before any best marker
    const mk = $("selmark");
    const selPos = (state.selMark && selected >= 0 && selected < G.nodeCount && nodeData)
      ? project(selected) : null;
    if (selPos) {
      mk.hidden = false;
      mk.style.transform = "translate(" + selPos[0].toFixed(1) + "px," + selPos[1].toFixed(1) + "px)";
    } else mk.hidden = true;

    placed.length = 0;
    if (selPos) placed.push(selPos[0], selPos[1]);
    for (let i = 0; i < markEls.length; i++) {
      const m = markEls[i];
      const on = m.kind === "isl" ? (state.bestIsl && grpVisible(m.g))
        : (state.bestRun && runAnyOn(m.r));
      const node = m.kind === "isl" ? G.bestOfGroup[m.g] : G.bestOfRun[m.r];
      if (!on || node < 0 || !nodeData || (state.selMark && node === selected)) { m.el.hidden = true; continue; }
      const s = project(node);
      if (!s) { m.el.hidden = true; continue; }
      let clash = false;
      for (let k = 0; k < placed.length; k += 2)
        if (Math.abs(placed[k] - s[0]) < 9 && Math.abs(placed[k + 1] - s[1]) < 9) { clash = true; break; }
      if (clash) { m.el.hidden = true; continue; }
      placed.push(s[0], s[1]);
      m.el.hidden = false;
      m.el.style.transform = "translate(" + s[0].toFixed(1) + "px," + s[1].toFixed(1) + "px)";
    }

    $("axis").style.opacity = String((1 - zMix[2]) * (1 - flatShown));

    // island names, pushed just outside each patch, once the layout is grouped
    for (let g = 0; g < labelEls.length; g++) {
      const el = labelEls[g];
      if (groupShown < 0.55 || !grpVisible(g)) { el.hidden = true; continue; }
      const q = place(0, 0, offI[g][0], offI[g][1], offR[g][0], offR[g][1]);
      const ol = Math.hypot(offI[g][0], offI[g][1]) || 1;
      const s = projectWorld(q[0] + offI[g][0] / ol * 0.5, 0, q[1] + offI[g][1] / ol * 0.5);
      if (!s) { el.hidden = true; continue; }
      el.hidden = false;
      el.style.left = s[0].toFixed(1) + "px"; el.style.top = s[1].toFixed(1) + "px";
      el.style.opacity = String(Math.min(1, (groupShown - 0.55) * 4));
    }

    fpsN++;
    if (now - fpsLast > 500) {
      $("k-fps").innerHTML = (fpsN / ((now - fpsLast) / 1000)).toFixed(0) + '<small> fps</small>';
      fpsN = 0; fpsLast = now;
    }
    if (wantImage) {                                    // the drawing buffer is only readable before the frame ends
      wantImage = false;
      const a = document.createElement("a");
      a.download = "archipelago-view.png"; a.href = canvas.toDataURL("image/png"); a.click();
    }
    raf = requestAnimationFrame(frame);
  }

  window.addEventListener("resize", resize);
  setTimeout(() => loadDataset(cfg.start || 0), 40);

  return {
    loadDataset,
    destroy() {
      alive = false;
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
      root.innerHTML = "";
    },
  };
}

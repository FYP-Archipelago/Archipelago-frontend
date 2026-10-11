/* Streamlit component bridge.
 *
 * Speaks the component protocol directly (postMessage), so the viewer needs no
 * npm package and no build step. Python sends a run payload; this decodes it
 * into the dataset shape the viewer takes and mounts it.
 */
import { mountStnViewer } from "./stn-viewer.js?v=12";

const send = (type, data) =>
  window.parent.postMessage({ isStreamlitMessage: true, type, ...data }, "*");

function b64(text, Ctor) {
  const bin = atob(text);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Ctor(bytes.buffer);
}

/** payload (from archipelago_ui/viewer/payload.py) -> viewer dataset. */
function toDataset(p) {
  const gLen = Int32Array.from(p.group_lengths);
  const gOff = new Int32Array(gLen.length);
  for (let g = 1; g < gLen.length; g++) gOff[g] = gOff[g - 1] + gLen[g - 1];
  const NG = gLen.length;
  const mig = b64(p.migrations, Int32Array);            // [a, b, sg, dg] * n
  const migEvents = [];
  for (let i = 0; i + 3 < mig.length; i += 4)
    migEvents.push({ a: mig[i], b: mig[i + 1], sg: mig[i + 2], dg: mig[i + 3], run: 0 });
  const gIsl = new Uint8Array(NG);
  for (let g = 0; g < NG; g++) gIsl[g] = g;
  return {
    tag: p.tag, title: p.title, runs: 1, isl: NG,
    rx: b64(p.x, Float32Array), ry: b64(p.y, Float32Array), rf: b64(p.fitness, Float32Array),
    gOff, gLen, gRun: new Uint8Array(NG), gIsl, migEvents,
    islandIds: p.island_ids, fitSign: p.fit_sign, hashes: p.hashes,
    parentPtr: b64(p.parent_ptr, Int32Array), parentIdx: b64(p.parent_idx, Int32Array),
    cluster: p.cluster ? b64(p.cluster, Int32Array) : undefined,
    clusterCount: p.cluster_count || 0,
    shapeNote: p.topology || "",
    levelNote: p.level_note || "", levelWarn: !!p.level_warn,
  };
}

let mounted = null, mountedKey = null;
const app = document.getElementById("app");

function stageHeight(h) {
  if (h) return h;
  try { return Math.round(Math.min(780, Math.max(480, window.parent.innerHeight * 0.74))); }
  catch (_) { return 720; }
}

function fit() {
  send("streamlit:setFrameHeight", { height: Math.ceil(app.getBoundingClientRect().height) + 6 });
}

function render(args) {
  const p = args.payload;
  const key = p.run_id + "|" + (p.cluster_id || "") + "|" + (p.level_note || "");
  document.documentElement.style.setProperty("--stage-h", stageHeight(args.stage_height) + "px");
  if (key !== mountedKey) {
    if (mounted) mounted.destroy();
    mounted = mountStnViewer(app, { datasets: [{ tag: p.tag, load: () => toDataset(p) }] });
    mountedKey = key;
  }
  fit();
}

window.addEventListener("message", ev => {
  if (ev.data && ev.data.type === "streamlit:render") render(ev.data.args || {});
});
window.addEventListener("resize", fit);
new ResizeObserver(fit).observe(app);
send("streamlit:componentReady", { apiVersion: 1 });

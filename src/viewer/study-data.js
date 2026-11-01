/* Synthetic datasets for the Scale study: about 400,000 generated evaluations
 * over a shared 36-basin landscape, with ring migration. The structure is
 * fabricated on purpose, to show the viewer at a scale and in configurations
 * no bundled run reaches. Generated deterministically in the browser.
 */

function makeRng(seed){
  let a = seed | 0;
  const rnd = function(){
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
  return {rnd, gauss(){
    let u = 0, v = 0;
    while(u === 0) u = rnd();
    while(v === 0) v = rnd();
    return Math.sqrt(-2*Math.log(u)) * Math.cos(2*Math.PI*v);
  }};
}

const NB = 36, bx = new Float32Array(NB), by = new Float32Array(NB), bd = new Float32Array(NB);
(function(){
  const L = makeRng(0x5EED17);
  for(let i=0;i<NB;i++){
    const gx = i % 6, gy = (i / 6) | 0;
    bx[i] = (gx/5)*1.7 - .85 + L.gauss()*.06;
    by[i] = (gy/5)*1.7 - .85 + L.gauss()*.06;
    bd[i] = .30 + L.rnd()*.55;
  }
  bd[14] = 1.35;
})();
const SIG2 = 2*0.085*0.085;
function landscape(x,y){
  let f = .34*(x*x + y*y);
  for(let i=0;i<NB;i++){
    const dx = x-bx[i], dy = y-by[i];
    f -= bd[i]*Math.exp(-(dx*dx+dy*dy)/SIG2);
  }
  return f;
}

export const STUDY_DATASETS = [
  {id:"five", label:"5 islands", detail:"400,000 evaluations", runs:1, isl:5, per:80000, migEvery:3600},
  {id:"twelve", label:"12 islands", detail:"408,000 evaluations", runs:1, isl:12, per:34000, migEvery:1500},
  {id:"runs", label:"3 runs", detail:"405,000 evaluations, 5 islands each", runs:3, isl:5, per:27000, migEvery:1200}
];

function generate(ds){
  const NG = ds.runs * ds.isl, PER = ds.per, RAW = NG * PER;
  const rx = new Float32Array(RAW); const ry = new Float32Array(RAW), rf = new Float32Array(RAW);
  const gRun = new Uint8Array(NG), gIsl = new Uint8Array(NG), migEvents = [];
  for(let r=0;r<ds.runs;r++) for(let i=0;i<ds.isl;i++){
    const g = r*ds.isl + i; gRun[g] = r; gIsl[g] = i;
  }

  const ATTRACT = .03, S0 = .10, SEND = .028, PMACRO = .05, MSIG = .26;
  const decay = Math.pow(SEND/S0, 1/PER);

  for(let r=0;r<ds.runs;r++){
    const R = makeRng(0xA53F1 + r*7919);          // each run its own stream
    const M = ds.isl;
    const x = new Float32Array(M), y = new Float32Array(M);
    const Bx = new Float32Array(M), By = new Float32Array(M), Bf = new Float32Array(M);
    const sg = new Float32Array(M);
    for(let i=0;i<M;i++){
      const a = (i/M)*Math.PI*2 + r*0.7;
      x[i] = Math.cos(a)*.62; y[i] = Math.sin(a)*.62;
      Bx[i] = x[i]; By[i] = y[i]; Bf[i] = landscape(x[i], y[i]);
      sg[i] = S0*(.8 + R.rnd()*.4);
    }
    for(let step=0; step<PER; step++){
      for(let i=0;i<M;i++){
        const idx = (r*M + i)*PER + step, q = R.rnd();
        let nx, ny;
        if(q < PMACRO){                                 // macro mutation: wide, local
          nx = Bx[i] + R.gauss()*MSIG; ny = By[i] + R.gauss()*MSIG;
        } else {                                        // selection pull + variation
          nx = x[i] + (Bx[i]-x[i])*ATTRACT + R.gauss()*sg[i];
          ny = y[i] + (By[i]-y[i])*ATTRACT + R.gauss()*sg[i];
        }
        nx = Math.max(-.99, Math.min(.99, nx)); ny = Math.max(-.99, Math.min(.99, ny));
        const nf = landscape(nx, ny);
        if(nf < Bf[i]){ Bf[i] = nf; Bx[i] = nx; By[i] = ny; }
        x[i]=nx; y[i]=ny; rx[idx]=nx; ry[idx]=ny; rf[idx]=nf;
        sg[i] *= decay;
      }
      if(step > 0 && step % ds.migEvery === 0){         // ring migration inside the run
        for(let i=0;i<M;i++){
          const j = (i+1) % M;
          const sIdx = (r*M + i)*PER + step, dIdx = (r*M + j)*PER + step;
          migEvents.push({a:sIdx, b:dIdx, sg:r*M+i, dg:r*M+j, run:r});
          const jx = Bx[i] + R.gauss()*.012, jy = By[i] + R.gauss()*.012;
          const jf = landscape(jx, jy);
          x[j]=jx; y[j]=jy; rx[dIdx]=jx; ry[dIdx]=jy; rf[dIdx]=jf;
          if(jf < Bf[j]){ Bf[j]=jf; Bx[j]=jx; By[j]=jy; }
        }
      }
    }
  }

  const gOff = new Int32Array(NG).map((_, g) => g * PER), gLen = new Int32Array(NG).fill(PER);
  return {
    tag: ds.id, title: "Synthetic study", runs: ds.runs, isl: ds.isl,
    rx, ry, rf, gOff, gLen, gRun, gIsl, migEvents, shapeNote: "ring topology",
  };
}

export const studyDataset = ds => ({ tag: ds.id, load: () => generate(ds) });

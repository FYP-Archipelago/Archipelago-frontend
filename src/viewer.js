import { mountStnViewer } from './viewer/stn-viewer.js';
import { studyDataset } from './viewer/study-data.js';

function b64(text, Ctor) {
  const bin = atob(text); const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Ctor(bytes.buffer);
}

export function toDataset(p) {
  const gLen = Int32Array.from(p.group_lengths), gOff = new Int32Array(gLen.length);
  for (let g = 1; g < gLen.length; g++) gOff[g] = gOff[g - 1] + gLen[g - 1];
  const mig = b64(p.migrations, Int32Array), migEvents = [];
  for (let i = 0; i + 3 < mig.length; i += 4) migEvents.push({ a: mig[i], b: mig[i + 1], sg: mig[i + 2], dg: mig[i + 3], run: 0 });
  const gIsl = new Uint8Array(gLen.length);
  for (let g = 0; g < gLen.length; g++) gIsl[g] = g;
  return {
    tag: p.tag, title: p.title, runs: 1, isl: gLen.length,
    rx: b64(p.x, Float32Array), ry: b64(p.y, Float32Array), rf: b64(p.fitness, Float32Array),
    gOff, gLen, gRun: new Uint8Array(gLen.length), gIsl, migEvents,
    islandIds: p.island_ids, fitSign: p.fit_sign, hashes: p.hashes,
    parentPtr: b64(p.parent_ptr, Int32Array), parentIdx: b64(p.parent_idx, Int32Array),
    cluster: p.cluster ? b64(p.cluster, Int32Array) : undefined,
    clusterCount: p.cluster_count || 0, shapeNote: p.topology || '',
    levelNote: p.level_note || '', levelWarn: !!p.level_warn,
  };
}

export function mountViewer(element, payload) {
  return mountStnViewer(element, { datasets: [{ tag: payload.tag, load: () => toDataset(payload) }] });
}

export function mountStudy(element, ds) {
  return mountStnViewer(element, { datasets: [studyDataset(ds)] });
}

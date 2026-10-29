import { Matrix, SingularValueDecomposition } from 'ml-matrix';

function unpack(text, kind) {
  const raw = Buffer.from(text, 'base64');
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  if (kind === 'float') return Array.from({ length: raw.length / 8 }, (_, i) => view.getFloat64(i * 8, true));
  if (kind === 'int') return Array.from({ length: raw.length / 4 }, (_, i) => view.getUint32(i * 4, true));
  return [];
}

export function decodeGenome(encoding, mode, payload) {
  if (!payload || mode === 'hashed') return null;
  try {
    if (mode === 'full') {
      const parsed = JSON.parse(payload);
      const values = Array.isArray(parsed) ? parsed : parsed?.x;
      return Array.isArray(values) ? values.map(Number) : null;
    }
    if (encoding === 'bitstring') {
      const [length, b64] = payload.split(':'); const bits = Buffer.from(b64, 'base64');
      return Array.from({ length: Number(length) }, (_, i) => (bits[i >> 3] >> (i & 7)) & 1);
    }
    if (encoding === 'permutation') return unpack(payload, 'int');
    if (['real_vector', 'real_vector_velocity', 'real_vector_sigma'].includes(encoding))
      return unpack(payload.startsWith('{') ? JSON.parse(payload).x : payload, 'float');
  } catch {}
  return null;
}

const b64 = array => Buffer.from(array.buffer, array.byteOffset, array.byteLength).toString('base64');

export function buildPayload(run) {
  const records = run.evaluations.flatMap(row => {
    if (![row.island_id, row.eval_index, row.fitness].every(Number.isFinite)) return [];
    const vector = decodeGenome(row.genome_encoding, row.genome_repr_mode, row.genome_repr);
    return vector?.length ? [{ row, vector }] : [];
  }).sort((a, b) => a.row.island_id - b.row.island_id || a.row.eval_index - b.row.eval_index);
  if (!records.length) return null;
  const width = Math.max(...records.map(r => r.vector.length));
  const means = Array(width).fill(0);
  for (const { vector } of records) vector.forEach((v, j) => { means[j] += v / records.length; });
  const matrix = new Matrix(records.map(({ vector }) => means.map((mean, j) => (vector[j] || 0) - mean)));
  let scores = [Array(records.length).fill(0), Array(records.length).fill(0)], variance = 0;
  if (records.length > 1 && width > 0) {
    const svd = new SingularValueDecomposition(matrix, { autoTranspose: true });
    const singular = svd.diagonal;
    const total = singular.reduce((n, s) => n + s * s, 0);
    variance = total ? singular.slice(0, 2).reduce((n, s) => n + s * s, 0) / total : 0;
    const v = svd.rightSingularVectors;
    scores = [0, 1].map(axis => records.map(({ vector }) => axis < v.columns ? means.reduce((sum, mean, j) => sum + ((vector[j] || 0) - mean) * v.get(j, axis), 0) : 0));
  }
  const scaled = scores.map(values => {
    const low = Math.min(...values), high = Math.max(...values), span = high - low;
    return new Float32Array(values.map(v => span < 1e-12 ? 0 : ((v - low) / span * 2 - 1) * 0.99));
  });
  const islandIds = [...new Set(records.map(r => r.row.island_id))].sort((a, b) => a - b);
  const groupOf = new Map(islandIds.map((id, i) => [id, i]));
  const groups = records.map(r => groupOf.get(r.row.island_id));
  const lengths = islandIds.map((_, i) => groups.filter(g => g === i).length);
  const sampleOf = new Map(records.map((r, i) => [r.row.individual_id, i]));
  const migrations = [], seen = new Set();
  for (const event of run.events.filter(e => e.type === 'migration_arrive')) {
    (event.origin_individual_ids || []).forEach((id, i) => {
      const a = sampleOf.get(id), b = sampleOf.get((event.arrived_individual_ids || [])[i]);
      if (a === undefined || b === undefined || seen.has(`${a}:${b}`)) return;
      seen.add(`${a}:${b}`); migrations.push(a, b, groups[a], groups[b]);
    });
  }
  const parentPtr = [0], parentIdx = [];
  records.forEach(({ row }, i) => {
    for (const id of (row.parent_ids || '').split(';')) {
      const j = sampleOf.get(id);
      if (j !== undefined && j !== i && groups[j] === groups[i]) parentIdx.push(j);
    }
    parentPtr.push(parentIdx.length);
  });
  const topology = run.events.find(e => e.type === 'migration_send')?.topology;
  return {
    run_id: run.id, tag: 'THIS RUN', title: `${run.start.algorithm || '?'} / ${run.start.benchmark || '?'}`,
    x: b64(scaled[0]), y: b64(scaled[1]), fitness: b64(new Float32Array(records.map(r => r.row.fitness * (run.maximising ? -1 : 1)))),
    fit_sign: run.maximising ? -1 : 1, group_lengths: lengths, island_ids: islandIds,
    migrations: b64(new Int32Array(migrations)), parent_ptr: b64(new Int32Array(parentPtr)), parent_idx: b64(new Int32Array(parentIdx)),
    hashes: records.map(r => String(r.row.genome_hash || '')), topology: topology ? `${topology} topology` : '', variance_kept: variance,
    algorithm: run.start.algorithm,
  };
}

export function withClusters(payload, assignments, id) {
  const labels = new Map(), out = [];
  payload.island_ids.forEach((island, group) => {
    const offset = payload.group_lengths.slice(0, group).reduce((a, b) => a + b, 0);
    for (let i = 0; i < payload.group_lengths[group]; i++) {
      const key = `${island}:${payload.hashes[offset + i]}`;
      const label = assignments[key] ?? `unclustered:${key}`;
      if (!labels.has(label)) labels.set(label, labels.size);
      out.push(labels.get(label));
    }
  });
  return { ...payload, cluster: b64(new Int32Array(out)), cluster_count: labels.size, cluster_id: id };
}

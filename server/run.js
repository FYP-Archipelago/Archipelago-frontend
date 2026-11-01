import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';

export const DATA_ROOT = path.resolve(import.meta.dirname, '../data');
export const FILES = ['evaluations.csv', 'run.jsonl', 'evaluations.schema.json', 'resolved_config.yaml', 'summary.json'];

export function csv(text) {
  const rows = []; let row = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (c !== '\r') cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const [headers = [], ...body] = rows;
  return body.filter(r => r.some(Boolean)).map(r => Object.fromEntries(headers.map((h, i) => [h, r[i] ?? ''])));
}

export function safeRunPath(id) {
  if (!/^[\w.\-]+$/.test(id) || id === '.' || id === '..') throw new Error('Invalid run id');
  return path.join(DATA_ROOT, id);
}

export async function listRuns() {
  let entries;
  try { entries = await readdir(DATA_ROOT, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const runs = await Promise.all(entries.filter(e => e.isDirectory()).map(async e => {
    const dir = safeRunPath(e.name);
    try {
      const info = await stat(path.join(dir, 'evaluations.csv'));
      let summary = {};
      try { summary = JSON.parse(await readFile(path.join(dir, 'summary.json'), 'utf8')); } catch {}
      let start = {};
      try {
        const line = (await readFile(path.join(dir, 'run.jsonl'), 'utf8')).split('\n').find(line => line.includes('"run_start"'));
        if (line) start = JSON.parse(line);
      } catch {}
      const files = await readdir(dir);
      const sizes = await Promise.all(files.map(async f => (await stat(path.join(dir, f))).size));
      const concise = Object.fromEntries(['total_evaluations','islands_completed','total_migration_events','global_best_fitness','termination_reason','wallclock_seconds'].map(key => [key, summary[key]]));
      return { id: e.name, size: sizes.reduce((a, b) => a + b, 0), summary: concise, algorithm: start.algorithm || '?', benchmark: start.benchmark || '?', islands: start.num_islands || summary.islands_completed || 0, evaluationsSize: info.size };
    } catch { return null; }
  }));
  return runs.filter(Boolean).sort((a, b) => b.id.localeCompare(a.id));
}

export async function loadRun(id) {
  const dir = safeRunPath(id);
  const evaluations = csv(await readFile(path.join(dir, 'evaluations.csv'), 'utf8'));
  const numeric = ['island_id', 'seq', 'eval_index', 'generation', 'genome_dim', 'fitness', 'objective', 'constraint_violation', 't_wall', 'origin_island'];
  for (const row of evaluations) for (const key of numeric) if (row[key] !== undefined) row[key] = row[key] === '' ? null : Number(row[key]);
  const t0 = Math.min(...evaluations.map(e => e.t_wall).filter(Number.isFinite));
  for (const row of evaluations) row.t_rel = row.t_wall - t0;
  let events = [], summary = {};
  try { events = (await readFile(path.join(dir, 'run.jsonl'), 'utf8')).split('\n').flatMap(line => { try { return line.trim() ? [JSON.parse(line)] : []; } catch { return []; } }); } catch {}
  try { summary = JSON.parse(await readFile(path.join(dir, 'summary.json'), 'utf8')); } catch {}
  const event = type => events.filter(e => e.type === type);
  const start = event('run_start')[0] || {}, end = event('run_end')[0] || {};
  const maximising = !!event('generation_end').find(e => 'maximising' in e)?.maximising;
  const islands = [...new Set(evaluations.map(e => e.island_id).filter(Number.isFinite))].sort((a, b) => a - b);
  const generations = event('generation_end');
  const gt0 = Math.min(...generations.map(e => e.t_wall).filter(Number.isFinite));
  for (const e of generations) e.t_rel = e.t_wall - gt0;
  const arrivals = new Map(event('migration_arrive').map(e => [e.migration_id, e]));
  const sends = event('migration_send');
  const mt0 = Math.min(...sends.map(e => e.t_wall).filter(Number.isFinite));
  const migrations = sends.map(e => {
    const a = arrivals.get(e.migration_id) || {};
    return { ...e, dest_generation: a.dest_generation ?? null, accepted: a.accepted ?? null, latency_seconds: a.latency_seconds ?? null,
      generational_drift: a.generational_drift ?? null, replacement_policy: a.replacement_policy ?? null,
      delivered: a.accepted !== undefined && a.accepted !== null && a.accepted !== false, t_rel: e.t_wall - mt0 };
  });
  return { id, evaluations, events, summary, start, end, maximising, islands, generations, migrations };
}

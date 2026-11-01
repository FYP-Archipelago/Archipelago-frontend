import http from 'node:http';
import path from 'node:path';
import { readFile, writeFile, mkdir, readdir, rm, stat } from 'node:fs/promises';
import JSZip from 'jszip';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DATA_ROOT, FILES, listRuns, loadRun, safeRunPath } from './run.js';
import { buildPayload, withClusters } from './payload.js';

const PORT = Number(process.env.PORT || process.env.ARCHIPELAGO_REWRITE_PORT || 4174);
const HOST = process.env.HOST || '127.0.0.1';
const API_URL = process.env.ARCHIPELAGO_API_URL || 'http://127.0.0.1:8000';
// Public deployments serve the bundled runs only: no writes, and no fetching caller-supplied URLs.
const READ_ONLY = Boolean(process.env.VERCEL);
const DIST_ROOT = path.resolve(import.meta.dirname, '../dist');
const cache = new Map();
const resultRoot = path.join(DATA_ROOT, '.cluster_results');
const json = (res, value, status = 200) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); };
const fail = (res, error, status = 400) => json(res, { error: String(error.message || error) }, status);
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };

async function staticFile(req, res, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return fail(res, 'Not found', 404);
  let relative;
  try { relative = decodeURIComponent(pathname).replace(/^\/+/, ''); } catch { return fail(res, 'Invalid path'); }
  const target = path.resolve(DIST_ROOT, relative);
  if (target !== DIST_ROOT && !target.startsWith(DIST_ROOT + path.sep)) return fail(res, 'Invalid path');
  let file = target;
  try { if ((await stat(file)).isDirectory()) file = path.join(file, 'index.html'); }
  catch { if (path.extname(relative)) return fail(res, 'Not found', 404); file = path.join(DIST_ROOT, 'index.html'); }
  try {
    const bytes = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'content-length': bytes.length });
    res.end(req.method === 'HEAD' ? undefined : bytes);
  } catch { fail(res, 'Build the frontend with npm run build', 503); }
}

async function body(req) {
  const chunks = []; let bytes = 0;
  for await (const chunk of req) { bytes += chunk.length; if (bytes > 150_000_000) throw Error('Upload exceeds 150 MB'); chunks.push(chunk); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}
function cleanName(name) { return String(name || 'run').replace(/[^\w.\-]/g, '') || 'run'; }
async function uniquePath(name) {
  let id = cleanName(name), n = 2;
  while (true) { try { await stat(safeRunPath(id)); id = `${cleanName(name)}-${n++}`; } catch { return { id, dir: safeRunPath(id) }; } }
}
async function install(files, name) {
  if (!files['evaluations.csv']) throw Error('evaluations.csv is required');
  const { id, dir } = await uniquePath(name);
  await mkdir(dir);
  try { for (const f of FILES) if (files[f]) await writeFile(path.join(dir, f), files[f]); }
  catch (error) { await rm(dir, { recursive: true, force: true }); throw error; }
  return id;
}
async function getRun(id) {
  const file = path.join(safeRunPath(id), 'evaluations.csv');
  const info = await stat(file); const key = `${id}:${info.size}:${info.mtimeMs}`;
  if (!cache.has(key)) {
    for (const old of cache.keys()) if (old.startsWith(`${id}:`)) cache.delete(old);
    const run = await loadRun(id); cache.set(key, { run, payload: buildPayload(run) });
  }
  return cache.get(key);
}
async function storedResults(id) {
  const dir = path.join(resultRoot, id); let names = [];
  try { names = await readdir(dir); } catch { return []; }
  const sig = await stat(path.join(safeRunPath(id), 'evaluations.csv'), { bigint: true });
  return (await Promise.all(names.filter(n => n.endsWith('.json')).map(async name => {
    try {
      const value = JSON.parse(await readFile(path.join(dir, name), 'utf8'));
      return Number(value.signature?.[0]) === Number(sig.size) && Number(value.signature?.[1]) === Number(sig.mtimeNs) ? value : null;
    } catch { return null; }
  }))).filter(Boolean).sort((a, b) => (b.stamp || '').localeCompare(a.stamp || ''));
}
async function saveResult(id, response, parameters) {
  const stages = response.stages_executed || [];
  const identity = `${id}|${stages.join('+') || 'level0'}|${Object.entries(parameters).sort().map(([k,v]) => `${k}=${v}`).join(',')}`;
  const now = new Date(); const dir = path.join(resultRoot, id);
  const sig = await stat(path.join(safeRunPath(id), 'evaluations.csv'), { bigint: true });
  const entry = { id: identity, run_id: id, stages, parameters, response, at: now.toLocaleString(), stamp: now.toISOString(), signature: [Number(sig.size), Number(sig.mtimeNs)] };
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, `${createHash('sha1').update(identity).digest('hex').slice(0, 16)}.json`), JSON.stringify(entry));
  return entry;
}
async function zipRun(id) {
  const zip = new JSZip(); const dir = safeRunPath(id);
  for (const f of FILES) try { zip.file(`${id}/${f}`, await readFile(path.join(dir, f))); } catch {}
  return zip.generateAsync({ type: 'nodebuffer' });
}
async function clustering(id, stages, parameters, url) {
  const base = String(url || API_URL).replace(/\/$/, '');
  let response = await fetch(`${base}/cluster/run`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ run_path: safeRunPath(id), stages, parameters }) });
  if ([403, 404].includes(response.status)) {
    const form = new FormData();
    for (const [k,v] of Object.entries(stages)) form.set(k, String(!!v));
    form.set('name', id); form.set('parameters', JSON.stringify(parameters));
    form.set('archive', new Blob([await zipRun(id)], { type: 'application/zip' }), `${id}.zip`);
    response = await fetch(`${base}/cluster/run/upload`, { method: 'POST', body: form });
  }
  if (response.status !== 202) throw Error((await response.text()).slice(0, 500));
  const { job_id } = await response.json();
  for (let i = 0; i < 2250; i++) {
    await new Promise(resolve => setTimeout(resolve, 400));
    const status = await fetch(`${base}/cluster/result/${encodeURIComponent(job_id)}`);
    if (status.status === 200) return saveResult(id, await status.json(), parameters);
    if (status.status !== 202) throw Error((await status.text()).slice(0, 500));
  }
  throw Error('Clustering timed out');
}

export async function handler(req, res) {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts[0] !== 'api') return staticFile(req, res, url.pathname);
    if (READ_ONLY && req.method !== 'GET') return fail(res, 'This shared demo is read-only. Run the app locally to add or cluster runs.', 403);
    if (READ_ONLY && parts[1] === 'health') return json(res, { available: false });
    if (req.method === 'GET' && parts[1] === 'status') return json(res, { ok: true });
    if (req.method === 'GET' && parts[1] === 'config') return json(res, { clusteringUrl: API_URL });
    if (req.method === 'GET' && parts[1] === 'runs' && !parts[2]) return json(res, await listRuns());
    if (req.method === 'GET' && parts[1] === 'runs' && parts[2]) {
      const { run, payload } = await getRun(parts[2]);
      if (parts[3] === 'payload') {
        const entry = (await storedResults(parts[2])).find(e => e.id === url.searchParams.get('result'));
        return json(res, entry ? withClusters(payload, entry.response.assignments, entry.id) : payload);
      }
      if (parts[3] === 'results') return json(res, await storedResults(parts[2]));
      return json(res, run);
    }
    if (req.method === 'GET' && parts[1] === 'health') {
      try { const r = await fetch(`${url.searchParams.get('url') || API_URL}/health`, { signal: AbortSignal.timeout(3000) }); return json(res, { available: r.ok, detail: r.ok ? await r.json() : null }); }
      catch { return json(res, { available: false }); }
    }
    if (req.method === 'POST' && parts[1] === 'runs' && parts[2] === 'upload') {
      const input = await body(req); let files = {};
      if (input.archive) {
        const zip = await JSZip.loadAsync(Buffer.from(input.archive, 'base64'));
        const names = Object.keys(zip.files).filter(n => !zip.files[n].dir);
        if (names.some(n => n.startsWith('/') || n.split(/[\\/]/).includes('..') || n.includes(':'))) throw Error('Unsafe archive path');
        const csvName = names.filter(n => n.split('/').at(-1) === 'evaluations.csv').sort((a,b) => a.split('/').length - b.split('/').length)[0];
        if (!csvName) throw Error('No evaluations.csv in archive');
        const prefix = csvName.slice(0, -'evaluations.csv'.length);
        for (const f of FILES) if (zip.file(prefix + f)) files[f] = await zip.file(prefix + f).async('nodebuffer');
      } else {
        for (const f of FILES) if (input.files?.[f]) files[f] = Buffer.from(input.files[f], 'base64');
      }
      return json(res, { id: await install(files, input.name) }, 201);
    }
    if (req.method === 'POST' && parts[1] === 'runs' && parts[2] === 'import') {
      const input = await body(req), source = path.resolve(String(input.path || ''));
      const files = {};
      for (const f of FILES) try { files[f] = await readFile(path.join(source, f)); } catch {}
      return json(res, { id: await install(files, path.basename(source)) }, 201);
    }
    if (req.method === 'DELETE' && parts[1] === 'runs' && parts[2]) {
      const dir = safeRunPath(parts[2]); await stat(path.join(dir, 'evaluations.csv'));
      await rm(dir, { recursive: true }); return json(res, { removed: parts[2] });
    }
    if (req.method === 'POST' && parts[1] === 'cluster' && parts[2]) {
      const input = await body(req);
      return json(res, await clustering(parts[2], input.stages || {}, input.parameters || {}, input.url));
    }
    return fail(res, 'Not found', 404);
  } catch (error) { fail(res, error, error.code === 'ENOENT' ? 404 : 400); }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await mkdir(DATA_ROOT, { recursive: true });
  http.createServer(handler).listen(PORT, HOST, () => console.log(`Archipelago JS on http://${HOST}:${PORT}`));
}

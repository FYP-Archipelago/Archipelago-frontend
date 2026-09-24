/**
 * Tables derived from a run's event stream (`run.jsonl`).
 *
 * The ports of `Run.generation_frame`, `Run.migration_frame` and the run
 * browser's provenance and per-island tables from the Python app. Pure functions
 * over parsed events, so the same code serves a finished file today and a live
 * stream later -- and so they can be tested without a browser.
 *
 * The event stream is small (hundreds of records on the sample runs, a few
 * thousand at the 100k-evaluation scale), so it is parsed on the main thread;
 * only evaluations -- the large file -- go through the worker.
 */

import type { LogEvent } from "../contract/schema.js";

export interface Generation {
  island: number;
  generation: number;
  /** Seconds since the first generation_end in the run. */
  tRel: number;
  bestSoFar: number | null;
  best: number | null;
  mean: number | null;
  diversity: number | null;
}

export interface Transfer {
  migrationId: string;
  sourceIsland: number;
  destIsland: number;
  sourceGeneration: number | null;
  destGeneration: number | null;
  migrants: number;
  /** Seconds since the first send in the run. */
  tRel: number;
  /** Null when the send never arrived -- a real behaviour, not a gap. */
  accepted: boolean | null;
  delivered: boolean;
  latencySeconds: number | null;
  drift: number | null;
  selection: string | null;
  replacement: string | null;
}

export interface IslandOutcome {
  island: number;
  reason: string;
  generations: number | null;
  evaluations: number | null;
  best: number | null;
  stagnant: number | null;
  sent: number;
  received: number;
  seconds: number | null;
}

export interface RunFacts {
  runStart: LogEvent | null;
  runEnd: LogEvent | null;
  maximising: boolean;
  diversityMetric: string | null;
  generations: Generation[];
  transfers: Transfer[];
  outcomes: IslandOutcome[];
  provenance: Array<[string, string]>;
}

const num = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;
const str = (value: unknown): string | null =>
  value === undefined || value === null ? null : String(value);

export function deriveRunFacts(events: readonly LogEvent[]): RunFacts {
  const byType = new Map<string, LogEvent[]>();
  for (const event of events) {
    const list = byType.get(event.type);
    if (list === undefined) byType.set(event.type, [event]);
    else list.push(event);
  }
  const of = (type: string) => byType.get(type) ?? [];

  const runStart = of("run_start")[0] ?? null;
  const runEnd = of("run_end")[0] ?? null;

  // ---- generations ----------------------------------------------------------
  const genEvents = of("generation_end");
  let maximising = false;
  let diversityMetric: string | null = null;
  let t0 = Infinity;
  for (const e of genEvents) {
    const wall = num(e["t_wall"]);
    if (wall !== null && wall < t0) t0 = wall;
  }
  const generations: Generation[] = genEvents.map((e) => ({
    island: Number(e["island_id"]),
    generation: Number(e["generation"]),
    tRel: (num(e["t_wall"]) ?? t0) - t0,
    bestSoFar: num(e["best_so_far_fitness"]),
    best: num(e["best_fitness"]),
    mean: num(e["mean_fitness"]),
    diversity: num(e["diversity"]),
  }));
  generations.sort((a, b) => a.island - b.island || a.generation - b.generation);
  for (const e of genEvents) {
    if (e["maximising"] !== undefined) {
      maximising = Boolean(e["maximising"]);
      break;
    }
  }
  diversityMetric = str(genEvents.find((e) => e["diversity_metric"] != null)?.["diversity_metric"]);

  // ---- transfers: every send, left-joined to its arrival ------------------
  // A left join, not an inner one: a send with no arrival is an undelivered
  // migrant, and losing it would hide a real behaviour.
  const arrivals = new Map<string, LogEvent>();
  for (const e of of("migration_arrive")) arrivals.set(String(e["migration_id"]), e);
  const sends = of("migration_send");
  let s0 = Infinity;
  for (const e of sends) {
    const wall = num(e["t_wall"]);
    if (wall !== null && wall < s0) s0 = wall;
  }
  const transfers: Transfer[] = sends.map((e) => {
    const id = String(e["migration_id"]);
    const arrive = arrivals.get(id);
    const accepted = arrive === undefined || arrive["accepted"] == null ? null : Boolean(arrive["accepted"]);
    return {
      migrationId: id,
      sourceIsland: Number(e["source_island"]),
      destIsland: Number(e["dest_island"]),
      sourceGeneration: num(e["source_generation"]),
      destGeneration: num(arrive?.["dest_generation"]),
      migrants: num(e["num_migrants"]) ?? 0,
      tRel: (num(e["t_wall"]) ?? s0) - s0,
      accepted,
      delivered: accepted !== null && accepted,
      latencySeconds: num(arrive?.["latency_seconds"]),
      drift: num(arrive?.["generational_drift"]),
      selection: str(e["selection_policy"]),
      replacement: str(arrive?.["replacement_policy"]),
    };
  });
  transfers.sort((a, b) => a.tRel - b.tRel);

  // ---- how each island finished -----------------------------------------
  const outcomes: IslandOutcome[] = of("island_end").map((e) => ({
    island: Number(e["island_id"]),
    reason: str(e["termination_reason"]) ?? "—",
    generations: num(e["generations_completed"]),
    evaluations: num(e["evaluations_total"]),
    best: num(e["best_fitness"]),
    stagnant: num(e["generations_since_improvement"]),
    sent: num(e["migrants_sent"]) ?? 0,
    received: num(e["migrants_received"]) ?? 0,
    seconds: num(e["wallclock_seconds"]),
  }));
  outcomes.sort((a, b) => a.island - b.island);

  return {
    runStart, runEnd, maximising, diversityMetric,
    generations, transfers, outcomes,
    provenance: provenanceRows(runStart),
  };
}

/** The facts a reviewer asks for: what problem, which instance, verified how. */
function provenanceRows(start: LogEvent | null): Array<[string, string]> {
  if (start === null) return [];
  const show = (value: unknown) => (value === undefined || value === null ? "—" : String(value));
  const rows: Array<[string, string]> = [
    ["Algorithm", show(start["algorithm"])],
    ["Benchmark", show(start["benchmark"])],
    ["Islands", show(start["num_islands"])],
    ["Population per island", show(start["population_size"])],
    ["Evaluation budget", num(start["evaluation_budget"])?.toLocaleString() ?? "—"],
    ["Backend", show(start["backend"])],
    ["Harness version", show(start["harness_version"])],
    ["Schema version", show(start["schema_version"])],
  ];
  const migration = start["migration"];
  if (migration !== null && typeof migration === "object") {
    const m = migration as Record<string, unknown>;
    rows.push(
      ["Topology", show(m["topology"])],
      ["Migration interval", show(m["interval"])],
      ["Migrants per event", show(m["num_migrants"])],
      ["Selection → replacement", `${show(m["selection"])} → ${show(m["replacement"])}`],
    );
  }
  const datasets = start["datasets"];
  if (datasets !== null && typeof datasets === "object") {
    for (const [key, value] of Object.entries(datasets as Record<string, unknown>)) {
      if (value !== null && typeof value === "object") {
        const v = value as Record<string, unknown>;
        if (v["sha256"] != null) rows.push([`${key} SHA-256`, `${String(v["sha256"]).slice(0, 16)}…`]);
        if (v["source"] != null) rows.push([`${key} source`, String(v["source"])]);
      } else if (key !== "benchmark") {
        rows.push([`Dataset ${key}`, show(value)]);
      }
    }
  }
  return rows;
}

/** Middle value; null for an empty list. */
export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

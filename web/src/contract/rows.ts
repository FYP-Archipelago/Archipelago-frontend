/**
 * Mapping parsed CSV records onto typed evaluation rows.
 *
 * Lives in `contract/` because it *is* the log format: both the browser worker
 * and the Node golden tests go through here, so the two cannot drift. Duplicating
 * this mapping would reintroduce exactly the class of silent disagreement the
 * golden tests exist to rule out.
 */

import type { EvaluationRow, LogEvent } from "./schema.js";

function toNumber(value: string | undefined): number {
  if (value === undefined || value === "") return Number.NaN;
  return Number(value);
}

/** The harness writes 1/0 for booleans; empty means absent. */
function toBool(value: string | undefined): boolean {
  return value === "1" || value === "true" || value === "True";
}

/**
 * Typed rows from parsed CSV records.
 *
 * `t_rel` is derived here from the whole file, matching Python's
 * `evaluations["t_rel"] = t_wall - t_wall.min()` at load time.
 */
export function toEvaluationRows(records: Array<Record<string, string>>): EvaluationRow[] {
  let minWall = Number.POSITIVE_INFINITY;
  for (const record of records) {
    const wall = toNumber(record["t_wall"]);
    if (Number.isFinite(wall) && wall < minWall) minWall = wall;
  }

  const rows: EvaluationRow[] = [];
  for (const record of records) {
    const island = toNumber(record["island_id"]);
    if (!Number.isFinite(island)) continue;
    rows.push({
      island_id: island,
      eval_index: toNumber(record["eval_index"]),
      individual_id: record["individual_id"] ?? "",
      parent_ids: record["parent_ids"] ?? "",
      operator: record["operator"] ?? "",
      fitness: toNumber(record["fitness"]),
      is_island_best: toBool(record["is_island_best"]),
      genome_encoding: record["genome_encoding"] ?? "",
      genome_hash: record["genome_hash"] ?? "",
      genome_repr: record["genome_repr"] ?? "",
      genome_repr_mode: record["genome_repr_mode"] ?? "",
      t_rel: toNumber(record["t_wall"]) - minWall,
    });
  }
  return rows;
}

/** Events from a `run.jsonl` body. A truncated tail is not a reason to fail. */
export function parseEvents(jsonl: string): LogEvent[] {
  const events: LogEvent[] = [];
  for (const line of jsonl.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      events.push(JSON.parse(trimmed) as LogEvent);
    } catch {
      // Same tolerance as Python's loader.
    }
  }
  return events;
}

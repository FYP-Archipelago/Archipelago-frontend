/**
 * Node-side run loader for the golden tests.
 *
 * Reads a run directory the way the Python `load_run` does, so the builder under
 * test sees the same rows. This is test scaffolding, not the shipping data path —
 * the app loads Arrow over HTTP (see the plan's M5) and this exists only to feed
 * the same bytes to both builders.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import Papa from "papaparse";

import type { EvaluationRow, LogEvent } from "../src/contract/schema.js";

export interface LoadedRun {
  runId: string;
  rows: EvaluationRow[];
  events: LogEvent[];
}

function toNumber(value: string | undefined): number {
  if (value === undefined || value === "") return Number.NaN;
  return Number(value);
}

/** The harness writes 1/0 for booleans; empty means absent. */
function toBool(value: string | undefined): boolean {
  return value === "1" || value === "true" || value === "True";
}

export function loadRun(runDir: string): LoadedRun {
  const csv = readFileSync(join(runDir, "evaluations.csv"), "utf-8");
  const parsed = Papa.parse<Record<string, string>>(csv, {
    header: true,
    skipEmptyLines: true,
  });

  // t_rel is derived at load time from the whole file, exactly as Python does:
  //   evaluations["t_rel"] = t_wall - t_wall.min()
  let minWall = Number.POSITIVE_INFINITY;
  for (const record of parsed.data) {
    const wall = toNumber(record["t_wall"]);
    if (Number.isFinite(wall) && wall < minWall) minWall = wall;
  }

  const rows: EvaluationRow[] = [];
  for (const record of parsed.data) {
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

  const jsonl = readFileSync(join(runDir, "run.jsonl"), "utf-8");
  const events: LogEvent[] = [];
  for (const line of jsonl.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      events.push(JSON.parse(trimmed) as LogEvent);
    } catch {
      // A truncated tail is not a reason to fail the load — same as Python.
    }
  }

  return { runId: runDir.split(/[\\/]/).pop() ?? runDir, rows, events };
}

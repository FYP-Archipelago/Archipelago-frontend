/**
 * Node-side run loader for the golden tests.
 *
 * Test scaffolding, not the shipping data path — the app fetches over HTTP. The
 * row mapping itself lives in `contract/rows.ts` and is shared with the browser
 * worker, so the two cannot disagree about what a row means.
 */

import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import Papa from "papaparse";

import { parseEvents, toEvaluationRows } from "../src/contract/rows.js";
import type { EvaluationRow, LogEvent } from "../src/contract/schema.js";

export interface LoadedRun {
  runId: string;
  rows: EvaluationRow[];
  events: LogEvent[];
}

export function loadRun(runDir: string): LoadedRun {
  const csv = readFileSync(join(runDir, "evaluations.csv"), "utf-8");
  const parsed = Papa.parse<Record<string, string>>(csv, {
    header: true,
    skipEmptyLines: true,
  });
  return {
    runId: basename(runDir),
    rows: toEvaluationRows(parsed.data),
    events: parseEvents(readFileSync(join(runDir, "run.jsonl"), "utf-8")),
  };
}

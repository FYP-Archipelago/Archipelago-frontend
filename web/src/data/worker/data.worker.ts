/**
 * Everything expensive, off the main thread.
 *
 * Fetches a run, decodes its genomes, builds the trajectory network and relaxes
 * a layout, then hands typed arrays back. The main thread never holds a node
 * object -- it receives buffers and passes them straight to the GPU. That rule
 * is what keeps this viable at a hundred thousand nodes, and it is much easier
 * to keep than to restore.
 *
 * The built network stays here between messages, so switching layout re-projects
 * rather than re-reading and re-decoding the run.
 */

import Papa from "papaparse";

import { parseEvents, toEvaluationRows } from "../../contract/rows.js";
import { driftLayout, type LayoutProvenance } from "../../layout/graph/DriftLayout.js";
import { pcaLayout } from "../../layout/pca/PcaLayout.js";
import { StnBuilder, type StnSnapshot } from "../stn/StnBuilder.js";

export type LayoutKind = "pca" | "drift";

export interface LayoutOptions {
  kind: LayoutKind;
  /** PCA only: spend the vertical axis on fitness. */
  elevation: boolean;
  /** Give each island its own footprint instead of overlaying them. */
  territories: boolean;
}

export interface StnPayload {
  runId: string;
  nodeCount: number;
  islandId: Int32Array;
  visits: Int32Array;
  fitness: Float64Array;
  flags: Uint8Array;
  edgeSource: Int32Array;
  edgeTarget: Int32Array;
  edgeWeight: Int32Array;
  migrationSource: Int32Array;
  migrationTarget: Int32Array;
  migrationTransfers: Int32Array;
  islands: number[];
  transferEvents: number;
  maximising: boolean;
}

export interface LayoutPayload {
  /** n × 3 interleaved. */
  positions: Float32Array;
  dims: 2 | 3;
  bounds: { min: [number, number, number]; max: [number, number, number] };
  provenance: LayoutProvenance;
}

export type WorkerRequest =
  | { type: "load"; runId: string; layout: LayoutOptions }
  | { type: "relayout"; layout: LayoutOptions };

export type WorkerResponse =
  | { type: "phase"; phase: string }
  | { type: "ready"; payload: StnPayload; layout: LayoutPayload }
  | { type: "layout"; layout: LayoutPayload }
  | { type: "error"; message: string };

let snapshot: StnSnapshot | null = null;
let maximising = false;

function post(message: WorkerResponse, transfer: Transferable[] = []): void {
  (self as unknown as Worker).postMessage(message, transfer);
}

function project(options: LayoutOptions): LayoutPayload {
  if (snapshot === null) throw new Error("no run loaded");
  const result =
    options.kind === "pca"
      ? pcaLayout(snapshot, {
          elevation: options.elevation,
          territories: options.territories,
          maximising,
        })
      : driftLayout(snapshot);
  return {
    positions: result.positions,
    dims: result.dims,
    bounds: result.bounds,
    provenance: result.provenance,
  };
}

async function load(runId: string, options: LayoutOptions): Promise<void> {
  post({ type: "phase", phase: "reading the run" });
  const [csv, jsonl] = await Promise.all([
    fetch(`/runs/${runId}/evaluations.csv`).then((r) => {
      if (!r.ok) throw new Error(`evaluations.csv: ${r.status}`);
      return r.text();
    }),
    fetch(`/runs/${runId}/run.jsonl`).then((r) => (r.ok ? r.text() : "")),
  ]);

  post({ type: "phase", phase: "decoding genomes" });
  const parsed = Papa.parse<Record<string, string>>(csv, {
    header: true,
    skipEmptyLines: true,
  });
  const rows = toEvaluationRows(parsed.data);
  const events = parseEvents(jsonl);

  // Whether lower is better. The harness states it on generation_end; absent, a
  // minimising run is the safe assumption and matches the Python reader.
  maximising = false;
  for (const event of events) {
    if (event["type"] === "generation_end" && event["maximising"] !== undefined) {
      maximising = Boolean(event["maximising"]);
      break;
    }
  }

  post({ type: "phase", phase: "building the network" });
  const builder = new StnBuilder();
  builder.ingestEvaluations(rows);
  builder.ingestEvents(events);
  snapshot = builder.snapshot();

  post({ type: "phase", phase: "projecting" });
  const layout = project(options);

  const islands = [...new Set([...snapshot.islandId])].sort((a, b) => a - b);
  const payload: StnPayload = {
    runId,
    nodeCount: snapshot.nodeKeys.length,
    // Copies, not transfers: the snapshot stays here so a layout switch can
    // re-project without re-reading the run, and a transferred buffer would be
    // detached out from under it.
    islandId: snapshot.islandId.slice(),
    visits: snapshot.visits.slice(),
    fitness: snapshot.fitness.slice(),
    flags: snapshot.flags.slice(),
    edgeSource: snapshot.edges.source.slice(),
    edgeTarget: snapshot.edges.target.slice(),
    edgeWeight: snapshot.edges.weight.slice(),
    migrationSource: snapshot.migrations.source.slice(),
    migrationTarget: snapshot.migrations.target.slice(),
    migrationTransfers: snapshot.migrations.transfers.slice(),
    islands,
    transferEvents: snapshot.transferEvents,
    maximising,
  };

  // Only the freshly-built layout positions are transferred; everything else is
  // copied above.
  post({ type: "ready", payload, layout }, [layout.positions.buffer]);
}

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;
  try {
    if (request.type === "load") {
      load(request.runId, request.layout).catch((error: unknown) => {
        post({
          type: "error",
          message: error instanceof Error ? error.message : String(error),
        });
      });
      return;
    }
    if (request.type === "relayout") {
      post({ type: "phase", phase: "projecting" });
      const layout = project(request.layout);
      post({ type: "layout", layout }, [layout.positions.buffer]);
    }
  } catch (error: unknown) {
    post({ type: "error", message: error instanceof Error ? error.message : String(error) });
  }
};

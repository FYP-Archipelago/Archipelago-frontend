/**
 * The gate for the whole rewrite.
 *
 * The node key `"<island>:<genome_hash>"` is the join key against `assignments`
 * from the clustering API. If this builder and the Python one ever disagree on
 * it, the join silently misses and the user is shown a *wrong picture* rather
 * than an error — which is exactly the kind of failure a screenshot review does
 * not catch. So the TypeScript builder is pinned to the Python one here, before
 * any of it is drawn.
 *
 * Fixtures are produced by `scripts/dump_stn_golden.py` against the v0.4 builder
 * on `main`. Regenerate with `npm run golden` when the Python side changes on
 * purpose.
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { StnBuilder } from "../src/data/stn/StnBuilder.js";
import { NodeFlag } from "../src/contract/schema.js";
import { loadRun } from "./loadRun.js";

const REPO = join(__dirname, "..", "..");
const GOLDEN = join(__dirname, "golden");

interface Fixture {
  run_id: string;
  islands: number[];
  maximising: boolean;
  counts: {
    evaluations: number;
    nodes: number;
    edges: number;
    migrations: number;
    transfer_events: number;
  };
  operators: string[];
  node_keys: string[];
  nodes: Array<[number, number, number, number, number, number]>;
  edges: Array<[number, number, number, number]>;
  migrations: Array<[number, number, number, number, number, boolean]>;
}

const index = JSON.parse(
  readFileSync(join(GOLDEN, "index.json"), "utf-8"),
) as Array<{ run_id: string }>;

/**
 * Means are summed in a different order here than in pandas, which uses pairwise
 * summation, so the last ulp can differ. Everything that must be exact — keys,
 * counts, indices, weights, flags — is compared exactly.
 */
const FLOAT_TOLERANCE = 1e-9;

function close(actual: number, expected: number): boolean {
  if (Object.is(actual, expected)) return true;
  const scale = Math.max(Math.abs(actual), Math.abs(expected), 1);
  return Math.abs(actual - expected) <= FLOAT_TOLERANCE * scale;
}

describe.each(index.map((entry) => entry.run_id))("STN builder vs Python: %s", (runId) => {
  const fixture = JSON.parse(
    readFileSync(join(GOLDEN, `${runId}.json`), "utf-8"),
  ) as Fixture;

  const runDir = join(REPO, "data", runId);
  const available = existsSync(join(runDir, "evaluations.csv"));

  it.runIf(available)("reproduces every node key, in order", () => {
    const snapshot = build(runDir);
    expect(snapshot.nodeKeys.length).toBe(fixture.counts.nodes);
    expect(snapshot.nodeKeys).toEqual(fixture.node_keys);
  });

  it.runIf(available)("reproduces the counts the review quotes", () => {
    const snapshot = build(runDir);
    expect({
      nodes: snapshot.nodeKeys.length,
      edges: snapshot.edges.source.length,
      migrations: snapshot.migrations.source.length,
      transfer_events: snapshot.transferEvents,
    }).toEqual({
      nodes: fixture.counts.nodes,
      edges: fixture.counts.edges,
      migrations: fixture.counts.migrations,
      transfer_events: fixture.counts.transfer_events,
    });
  });

  it.runIf(available)("reproduces every node's aggregates and flags", () => {
    const snapshot = build(runDir);
    const mismatches: string[] = [];
    for (let i = 0; i < fixture.nodes.length; i += 1) {
      const [island, visits, fit, best, firstEval, flags] = fixture.nodes[i]!;
      if (snapshot.islandId[i] !== island) mismatches.push(`${i} island`);
      if (snapshot.visits[i] !== visits) mismatches.push(`${i} visits`);
      if (!close(snapshot.fitness[i]!, fit)) mismatches.push(`${i} fitness`);
      if (!close(snapshot.bestFitness[i]!, best)) mismatches.push(`${i} bestFitness`);
      if (snapshot.firstEval[i] !== firstEval) mismatches.push(`${i} firstEval`);
      if (snapshot.flags[i] !== flags) mismatches.push(`${i} flags`);
      if (mismatches.length > 8) break;
    }
    expect(mismatches).toEqual([]);
  });

  it.runIf(available)("reproduces the trajectory edge table exactly", () => {
    const snapshot = build(runDir);
    expect(snapshot.operators).toEqual(fixture.operators);
    const actual: Array<[number, number, number, number]> = [];
    for (let i = 0; i < snapshot.edges.source.length; i += 1) {
      actual.push([
        snapshot.edges.source[i]!, snapshot.edges.target[i]!,
        snapshot.edges.operator[i]!, snapshot.edges.weight[i]!,
      ]);
    }
    expect(actual).toEqual(fixture.edges);
  });

  it.runIf(available)("reproduces the migration routes exactly", () => {
    const snapshot = build(runDir);
    const actual: Array<[number, number, number, number, number, boolean]> = [];
    for (let i = 0; i < snapshot.migrations.source.length; i += 1) {
      actual.push([
        snapshot.migrations.source[i]!, snapshot.migrations.target[i]!,
        snapshot.migrations.sourceIsland[i]!, snapshot.migrations.destIsland[i]!,
        snapshot.migrations.transfers[i]!, snapshot.migrations.accepted[i] === 1,
      ]);
    }
    expect(actual).toEqual(fixture.migrations);
  });

  it.runIf(available)("leaves no cross-island edge in the trajectory layer", () => {
    // The v0.4 invariant: turning migrations off must really disconnect the
    // islands. Asserted independently of the fixture so it cannot drift with it.
    const snapshot = build(runDir);
    let crossing = 0;
    for (let i = 0; i < snapshot.edges.source.length; i += 1) {
      const a = snapshot.islandId[snapshot.edges.source[i]!];
      const b = snapshot.islandId[snapshot.edges.target[i]!];
      if (a !== b) crossing += 1;
    }
    expect(crossing).toBe(0);
  });

  it.runIf(available)("merges duplicate transfers into routes", () => {
    const snapshot = build(runDir);
    // Routes never exceed the events they were merged from.
    expect(snapshot.migrations.source.length).toBeLessThanOrEqual(snapshot.transferEvents);
    let total = 0;
    for (const t of snapshot.migrations.transfers) total += t;
    expect(total).toBe(snapshot.transferEvents);
  });

  it.runIf(available)("flags exactly one final best per island that finished", () => {
    const snapshot = build(runDir);
    const perIsland = new Map<number, number>();
    for (let i = 0; i < snapshot.nodeKeys.length; i += 1) {
      if ((snapshot.flags[i]! & NodeFlag.FinalBest) === 0) continue;
      const island = snapshot.islandId[i]!;
      perIsland.set(island, (perIsland.get(island) ?? 0) + 1);
    }
    for (const [, count] of perIsland) expect(count).toBe(1);
  });

  it.runIf(available)("gives the same answer when rows arrive in batches", () => {
    // The whole point of the reshape: a live socket feeds the builder in chunks,
    // and it must land on the same network a single-shot file load produces.
    const { rows, events } = loadRun(runDir);
    const batched = new StnBuilder();
    const size = Math.max(1, Math.floor(rows.length / 7));
    for (let i = 0; i < rows.length; i += size) {
      batched.ingestEvaluations(rows.slice(i, i + size));
    }
    batched.ingestEvents(events);

    const whole = build(runDir);
    const incremental = batched.snapshot();
    expect(incremental.nodeKeys).toEqual(whole.nodeKeys);
    expect([...incremental.edges.source]).toEqual([...whole.edges.source]);
    expect([...incremental.edges.weight]).toEqual([...whole.edges.weight]);
    expect([...incremental.migrations.transfers]).toEqual([...whole.migrations.transfers]);
  });
});

function build(runDir: string) {
  const { rows, events } = loadRun(runDir);
  const builder = new StnBuilder();
  builder.ingestEvaluations(rows);
  builder.ingestEvents(events);
  return builder.snapshot();
}

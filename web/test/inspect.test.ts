/**
 * Node inspection: the parent and child indexes must agree with the edge table
 * exactly, and a traced lineage must be closed -- every ancestor's parents are in
 * it too -- or "trace lineage" would quietly show a partial story.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { StnBuilder } from "../src/data/stn/StnBuilder.js";
import { buildAdjacency, nodeDetail, traceLineage } from "../src/data/stn/inspect.js";
import { loadRun } from "./loadRun.js";

const REPO = join(__dirname, "..", "..");
const RUNS = ["run-20260903T230942Z-c7f38cc1", "run-20260903T230838Z-4891f68f"];

describe.each(RUNS)("inspection: %s", (runId) => {
  const dir = join(REPO, "data", runId);
  const available = existsSync(join(dir, "evaluations.csv"));
  const setup = () => {
    const { rows, events } = loadRun(dir);
    const builder = new StnBuilder();
    builder.ingestEvaluations(rows);
    builder.ingestEvents(events);
    const s = builder.snapshot();
    return { s, adj: buildAdjacency(s, false) };
  };

  it.runIf(available)("indexes every edge and route, in both directions", () => {
    const { s, adj } = setup();
    const n = s.nodeKeys.length;
    const total = s.edges.source.length + s.migrations.source.length;
    expect(adj.inStart[n]).toBe(total);
    expect(adj.outStart[n]).toBe(total);
    // Every trajectory edge is found from both of its ends.
    for (let e = 0; e < s.edges.source.length; e += 250) {
      const a = s.edges.source[e]!;
      const b = s.edges.target[e]!;
      const parents = Array.from(adj.inFrom.subarray(adj.inStart[b]!, adj.inStart[b + 1]!));
      const children = Array.from(adj.outTo.subarray(adj.outStart[a]!, adj.outStart[a + 1]!));
      expect(parents).toContain(a);
      expect(children).toContain(b);
    }
  });

  it.runIf(available)("ranks the best location first and counts neighbours exactly", () => {
    const { s, adj } = setup();
    const best = adj.rankOf.indexOf(0);
    const detail = nodeDetail(s, adj, best, false);
    expect(detail.rank).toBe(1);
    expect(detail.isBestOverall).toBe(true);
    for (let i = 0; i < s.nodeKeys.length; i += 1) {
      expect(s.fitness[i]!).toBeGreaterThanOrEqual(detail.fitness);
    }
    expect(detail.parentCount).toBe(adj.inStart[best + 1]! - adj.inStart[best]!);
    expect(detail.genome.length).toBe(s.dim);
  });

  it.runIf(available)("finds the same location on other islands", () => {
    const { s, adj } = setup();
    let checked = 0;
    for (const [hash, nodes] of adj.byHash) {
      if (nodes.length < 2) continue;
      const detail = nodeDetail(s, adj, nodes[0]!, false);
      expect(detail.twins.length).toBe(nodes.length - 1);
      for (const twin of detail.twins) {
        expect(s.nodeKeys[twin.index]!.endsWith(`:${hash}`)).toBe(true);
        expect(twin.island).not.toBe(detail.island);
      }
      if ((checked += 1) > 20) break;
    }
    expect(checked).toBeGreaterThan(0);
  });

  it.runIf(available)("traces a closed lineage back to where it began", () => {
    const { s, adj } = setup();
    const best = adj.rankOf.indexOf(0);
    const lineage = traceLineage(s, adj, best);
    expect(lineage.truncated).toBe(false);
    expect(lineage.nodes[0]).toBe(best);
    expect(lineage.origins).toBeGreaterThan(0);
    const inside = new Set(lineage.nodes);
    for (const node of lineage.nodes) {
      for (let k = adj.inStart[node]!; k < adj.inStart[node + 1]!; k += 1) {
        expect(inside.has(adj.inFrom[k]!)).toBe(true);
      }
    }
    for (const pairs of [lineage.edges, lineage.crossings]) for (let i = 0; i < pairs.length; i += 2) {
      expect(inside.has(pairs[i]!)).toBe(true);
      expect(inside.has(pairs[i + 1]!)).toBe(true);
    }
    // The winner's ancestry crosses islands through migration on both runs.
    expect(lineage.islands.length).toBeGreaterThan(1);
    expect(lineage.crossings.length).toBeGreaterThan(0);
  });
});

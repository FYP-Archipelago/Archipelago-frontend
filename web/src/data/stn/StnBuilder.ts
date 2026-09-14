/**
 * The Level 0 search trajectory network, built incrementally.
 *
 * A node is a *location* the run actually visited, keyed by genome hash scoped to
 * its island. Scoping to the island is the load-bearing part: a migration edge
 * joins the same location under two different islands, and keyed by hash alone
 * every migration would collapse into a self-loop.
 *
 * This is the port of `archipelago_ui/stn.py` (v0.4), reshaped from a one-shot
 * `build_stn(run)` into an append-reducer. The reshape is what makes a live
 * source possible: replaying a file and consuming a socket become the same code
 * path, because both just call `ingestEvaluations` repeatedly. Derived fields
 * that depend on the whole run — `shared`, `final_best`, and any edge whose
 * parent has not arrived yet — are resolved in `snapshot()`, which a live client
 * calls whenever it wants to draw.
 *
 * Output is held to byte-identical agreement with the Python builder by the
 * golden tests, because the node key is the join key against the clustering
 * API and a silent disagreement there shows a wrong picture rather than an error.
 */

import { decodeGenome } from "../../contract/genome.js";
import { NodeFlag, nodeKey, type EvaluationRow, type LogEvent } from "../../contract/schema.js";

export interface StnSnapshot {
  /** Node keys in first-appearance order. Index into every array below. */
  nodeKeys: string[];
  islandId: Int32Array;
  visits: Int32Array;
  /** Mean fitness over the visits to this location. */
  fitness: Float64Array;
  bestFitness: Float64Array;
  firstEval: Int32Array;
  tRel: Float64Array;
  /** Bit field: see NodeFlag. */
  flags: Uint8Array;
  /** n × dim, row-major. */
  positions: Float64Array;
  dim: number;

  /** Within-island trajectory edges. Crossings live in `migrations`. */
  edges: {
    source: Int32Array;
    target: Int32Array;
    /** Index into `operators`. */
    operator: Int32Array;
    weight: Int32Array;
  };
  operators: string[];

  /** One row per distinct route, not per transfer. */
  migrations: {
    source: Int32Array;
    target: Int32Array;
    sourceIsland: Int32Array;
    destIsland: Int32Array;
    transfers: Int32Array;
    accepted: Uint8Array;
  };
  /** Migration *events* before identical routes were merged. */
  transferEvents: number;
}

/** A parent→child step recorded before we know whether the parent resolves. */
interface PendingEdge {
  parents: string;
  childKey: string;
  operator: string;
}

interface MigrationEvent {
  originId: string;
  arrivedId: string;
  sourceIsland: number;
  destIsland: number;
  accepted: boolean;
}

/** A node under construction — running aggregates, one per location. */
interface NodeAccumulator {
  index: number;
  islandId: number;
  genomeHash: string;
  visits: number;
  fitnessSum: number;
  bestFitness: number;
  firstEval: number;
  tRel: number;
  isIslandBest: boolean;
  position: Float64Array;
}

export class StnBuilder {
  private readonly nodes = new Map<string, NodeAccumulator>();
  /** Every row's individual → node key, including rows whose genome did not decode. */
  private readonly individualToKey = new Map<string, string>();
  private readonly pending: PendingEdge[] = [];
  private readonly migrationEvents: MigrationEvent[] = [];
  /** island → its own final best hash, from island_end. */
  private readonly islandWinners = new Map<number, string>();
  private dim = 0;

  ingestEvaluations(rows: Iterable<EvaluationRow>): void {
    for (const row of rows) {
      // Python drops rows missing either field before anything else.
      if (row.island_id === null || row.island_id === undefined) continue;
      if (!row.genome_hash) continue;

      const key = nodeKey(row.island_id, row.genome_hash);

      // The individual → key map is built from *all* rows, decodable or not, so
      // a parent whose genome failed to decode still resolves to a key. That key
      // simply will not be in the node set, and the edge is dropped there.
      this.individualToKey.set(row.individual_id, key);

      // Queue the step regardless; parents are resolved once every row is in.
      if (row.parent_ids) {
        this.pending.push({
          parents: row.parent_ids,
          childKey: key,
          operator: row.operator,
        });
      }

      const position = decodeGenome(
        row.genome_encoding,
        row.genome_repr_mode,
        row.genome_repr,
      );
      if (position === null) continue;
      if (position.length > this.dim) this.dim = position.length;

      const existing = this.nodes.get(key);
      if (existing === undefined) {
        this.nodes.set(key, {
          index: this.nodes.size,
          islandId: Math.trunc(row.island_id),
          genomeHash: row.genome_hash,
          visits: 1,
          fitnessSum: row.fitness,
          bestFitness: row.fitness,
          firstEval: row.eval_index,
          tRel: row.t_rel,
          isIslandBest: row.is_island_best,
          position,
        });
      } else {
        existing.visits += 1;
        existing.fitnessSum += row.fitness;
        if (row.fitness < existing.bestFitness) existing.bestFitness = row.fitness;
        if (row.eval_index < existing.firstEval) existing.firstEval = row.eval_index;
        if (row.t_rel < existing.tRel) existing.tRel = row.t_rel;
        existing.isIslandBest ||= row.is_island_best;
      }
    }
  }

  ingestEvents(events: Iterable<LogEvent>): void {
    for (const event of events) {
      if (event["type"] === "island_end") {
        const island = event["island_id"];
        const hash = event["best_genome_hash"];
        if (typeof island === "number" && typeof hash === "string") {
          this.islandWinners.set(Math.trunc(island), hash);
        }
        continue;
      }
      if (event["type"] !== "migration_arrive") continue;

      const origins = event["origin_individual_ids"];
      const arrived = event["arrived_individual_ids"];
      if (!Array.isArray(origins) || !Array.isArray(arrived)) continue;

      const count = Math.min(origins.length, arrived.length);
      for (let i = 0; i < count; i += 1) {
        this.migrationEvents.push({
          originId: String(origins[i]),
          arrivedId: String(arrived[i]),
          sourceIsland: Number(event["source_island"]),
          destIsland: Number(event["dest_island"]),
          // Python's `event.get("accepted", True)` — absent means accepted.
          accepted: event["accepted"] === undefined ? true : Boolean(event["accepted"]),
        });
      }
    }
  }

  /** Resolve everything that depends on the whole run and emit a drawable snapshot. */
  snapshot(): StnSnapshot {
    const order = [...this.nodes.values()].sort((a, b) => a.index - b.index);
    const n = order.length;
    const dim = this.dim;

    const nodeKeys: string[] = new Array(n);
    const islandId = new Int32Array(n);
    const visits = new Int32Array(n);
    const fitness = new Float64Array(n);
    const bestFitness = new Float64Array(n);
    const firstEval = new Int32Array(n);
    const tRel = new Float64Array(n);
    const flags = new Uint8Array(n);
    const positions = new Float64Array(n * dim);

    // A location reached by more than one island. Computed on the hash, which is
    // island-independent by design.
    const islandsPerHash = new Map<string, Set<number>>();
    for (const node of order) {
      let seen = islandsPerHash.get(node.genomeHash);
      if (seen === undefined) {
        seen = new Set();
        islandsPerHash.set(node.genomeHash, seen);
      }
      seen.add(node.islandId);
    }

    const nodeIndex = new Map<string, number>();
    for (let i = 0; i < n; i += 1) {
      const node = order[i]!;
      const key = nodeKey(node.islandId, node.genomeHash);
      nodeKeys[i] = key;
      nodeIndex.set(key, i);

      islandId[i] = node.islandId;
      visits[i] = node.visits;
      fitness[i] = node.fitnessSum / node.visits;
      bestFitness[i] = node.bestFitness;
      firstEval[i] = node.firstEval;
      tRel[i] = node.tRel;
      positions.set(node.position, i * dim);

      let bits = 0;
      if (node.isIslandBest) bits |= NodeFlag.IslandBest;
      // Where the island actually finished, from island_end — NOT the running
      // is_island_best flag, which the harness sets on every improvement. A
      // truncated log carrying no island_end leaves every node unflagged, which
      // is better than letting the running flag stand in for it.
      if (this.islandWinners.get(node.islandId) === node.genomeHash) {
        bits |= NodeFlag.FinalBest;
      }
      if ((islandsPerHash.get(node.genomeHash)?.size ?? 0) > 1) bits |= NodeFlag.Shared;
      flags[i] = bits;
    }

    const { edges, operators } = this.buildEdges(nodeIndex, islandId);
    const migrations = this.buildMigrations(nodeIndex);

    return {
      nodeKeys, islandId, visits, fitness, bestFitness, firstEval, tRel, flags,
      positions, dim,
      edges, operators,
      migrations,
      transferEvents: this.countResolvedTransfers(nodeIndex),
    };
  }

  private buildEdges(
    nodeIndex: Map<string, number>,
    islandId: Int32Array,
  ): { edges: StnSnapshot["edges"]; operators: string[] } {
    // (source, target, operator) → how many times that step was taken.
    const tally = new Map<string, number>();

    for (const step of this.pending) {
      const child = nodeIndex.get(step.childKey);
      if (child === undefined) continue;
      for (const parentId of step.parents.split(";")) {
        const parentKey = this.individualToKey.get(parentId);
        if (parentKey === undefined || parentKey === step.childKey) continue;
        const parent = nodeIndex.get(parentKey);
        if (parent === undefined) continue;
        const composite = `${parentKey}\u0000${step.childKey}\u0000${step.operator}`;
        tally.set(composite, (tally.get(composite) ?? 0) + 1);
      }
    }

    // An edge whose endpoints sit on different islands is a migration, not a
    // step this island took by itself. Classified by comparing the endpoints'
    // island, not by the operator name: operator strings are algorithm-specific
    // (de_trial, pso_update, ...) while the island comparison holds everywhere.
    const kept: Array<{
      source: number; target: number;
      sourceKey: string; targetKey: string;
      op: string; weight: number;
    }> = [];
    const operatorSet = new Set<string>();
    for (const [composite, weight] of tally) {
      const [sourceKey = "", targetKey = "", op = ""] = composite.split("\u0000");
      const source = nodeIndex.get(sourceKey)!;
      const target = nodeIndex.get(targetKey)!;
      if (islandId[source] !== islandId[target]) continue;
      kept.push({ source, target, sourceKey, targetKey, op, weight });
      operatorSet.add(op);
    }

    const operators = [...operatorSet].sort();
    const operatorIndex = new Map(operators.map((name, i) => [name, i]));

    // Ordered by (source key, target key, operator) so the array lines up with
    // the Python fixture element for element, not merely as a set.
    kept.sort((a, b) => {
      if (a.sourceKey !== b.sourceKey) return a.sourceKey < b.sourceKey ? -1 : 1;
      if (a.targetKey !== b.targetKey) return a.targetKey < b.targetKey ? -1 : 1;
      return a.op < b.op ? -1 : a.op > b.op ? 1 : 0;
    });

    const count = kept.length;
    const edges = {
      source: new Int32Array(count),
      target: new Int32Array(count),
      operator: new Int32Array(count),
      weight: new Int32Array(count),
    };
    for (let i = 0; i < count; i += 1) {
      const e = kept[i]!;
      edges.source[i] = e.source;
      edges.target[i] = e.target;
      edges.operator[i] = operatorIndex.get(e.op)!;
      edges.weight[i] = e.weight;
    }
    return { edges, operators };
  }

  private buildMigrations(nodeIndex: Map<string, number>): StnSnapshot["migrations"] {
    // Several transfers can carry the same genome along the same island pair,
    // which draws the identical line over and over. One row per route, with the
    // event count kept as weight.
    const routes = new Map<
      string,
      { source: number; target: number; si: number; di: number; transfers: number; accepted: boolean }
    >();

    for (const event of this.migrationEvents) {
      const sourceKey = this.individualToKey.get(event.originId);
      const targetKey = this.individualToKey.get(event.arrivedId);
      if (sourceKey === undefined || targetKey === undefined) continue;
      if (sourceKey === targetKey) continue;
      const source = nodeIndex.get(sourceKey);
      const target = nodeIndex.get(targetKey);
      if (source === undefined || target === undefined) continue;

      const composite = `${sourceKey}\u0000${targetKey}\u0000${event.sourceIsland}\u0000${event.destIsland}`;
      const existing = routes.get(composite);
      if (existing === undefined) {
        routes.set(composite, {
          source, target, si: event.sourceIsland, di: event.destIsland,
          transfers: 1, accepted: event.accepted,
        });
      } else {
        existing.transfers += 1;
        existing.accepted ||= event.accepted;
      }
    }

    const rows = [...routes.entries()]
      .map(([composite, value]) => ({ composite, value }))
      .sort((a, b) => {
        const [sa = "", ta = ""] = a.composite.split("\u0000");
        const [sb = "", tb = ""] = b.composite.split("\u0000");
        if (sa !== sb) return sa < sb ? -1 : 1;
        if (ta !== tb) return ta < tb ? -1 : 1;
        if (a.value.si !== b.value.si) return a.value.si - b.value.si;
        return a.value.di - b.value.di;
      })
      .map((entry) => entry.value);

    const count = rows.length;
    const out = {
      source: new Int32Array(count),
      target: new Int32Array(count),
      sourceIsland: new Int32Array(count),
      destIsland: new Int32Array(count),
      transfers: new Int32Array(count),
      accepted: new Uint8Array(count),
    };
    for (let i = 0; i < count; i += 1) {
      const r = rows[i]!;
      out.source[i] = r.source;
      out.target[i] = r.target;
      out.sourceIsland[i] = r.si;
      out.destIsland[i] = r.di;
      out.transfers[i] = r.transfers;
      out.accepted[i] = r.accepted ? 1 : 0;
    }
    return out;
  }

  /** Transfers that resolved to a real pair of nodes — Python's pre-dedup count. */
  private countResolvedTransfers(nodeIndex: Map<string, number>): number {
    let total = 0;
    for (const event of this.migrationEvents) {
      const sourceKey = this.individualToKey.get(event.originId);
      const targetKey = this.individualToKey.get(event.arrivedId);
      if (sourceKey === undefined || targetKey === undefined) continue;
      if (sourceKey === targetKey) continue;
      if (!nodeIndex.has(sourceKey) || !nodeIndex.has(targetKey)) continue;
      total += 1;
    }
    return total;
  }
}

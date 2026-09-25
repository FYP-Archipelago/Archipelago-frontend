/**
 * Looking up one node: its record, its neighbours, and its full ancestry.
 *
 * The edge table is a flat list, which answers "where does this edge go" but not
 * "who are this node's parents". Two indexes over it (compressed sparse rows,
 * built once by counting sort) answer both directions in time proportional to
 * the answer. Migration routes are folded into the same indexes, marked, so a
 * node's parents include the island an arrived migrant came from.
 *
 * Pure functions over the snapshot, so the worker can call them and the tests
 * can check them without a browser.
 */

import { NodeFlag } from "../../contract/schema.js";
import type { StnSnapshot } from "./StnBuilder.js";

export interface Adjacency {
  /** Parents of node v are inFrom[inStart[v] .. inStart[v + 1]). */
  inStart: Int32Array;
  inFrom: Int32Array;
  /** >= 0: a trajectory edge index. < 0: migration route -(ref + 1). */
  inRef: Int32Array;
  outStart: Int32Array;
  outTo: Int32Array;
  outRef: Int32Array;
  /** Position of each node when sorted best first; 0 is the best. */
  rankOf: Int32Array;
  /** genome hash -> the nodes (one per island) at that location. */
  byHash: Map<string, number[]>;
}

export interface NeighbourRef {
  index: number;
  island: number;
  fitness: number;
  /** "step" for an edge within an island; "migration" for a crossing. */
  via: "step" | "migration";
  /** The operator that made the child, for steps. */
  operator: string | null;
  /** How many times this step or transfer happened. */
  weight: number;
}

export interface NodeDetail {
  index: number;
  key: string;
  island: number;
  genomeHash: string;
  visits: number;
  fitness: number;
  bestFitness: number;
  firstEval: number;
  tRel: number;
  flags: number;
  isBestOverall: boolean;
  /** 1 is the best location in the run. */
  rank: number;
  of: number;
  genome: number[];
  parents: NeighbourRef[];
  children: NeighbourRef[];
  parentCount: number;
  childCount: number;
  /** The same location, reached independently by other islands. */
  twins: Array<{ index: number; island: number }>;
}

export interface Lineage {
  /** Every ancestor, the node itself included. */
  nodes: Int32Array;
  /** Parent, child pairs along the ancestry, within an island. */
  edges: Int32Array;
  /** Parent, child pairs where the ancestry arrived by migration. */
  crossings: Int32Array;
  islands: number[];
  /** Steps back to the furthest initial individual. */
  depth: number;
  /** Ancestors with no parents -- where the lineage began. */
  origins: number;
  truncated: boolean;
}

/** Neighbour lists in the panel stop here; the counts stay exact. */
export const NEIGHBOUR_LIMIT = 40;
/** A lineage larger than this is cut off and marked as such. */
export const LINEAGE_LIMIT = 50_000;

export function buildAdjacency(s: StnSnapshot, maximising: boolean): Adjacency {
  const n = s.nodeKeys.length;
  const e = s.edges.source.length;
  const m = s.migrations.source.length;
  const total = e + m;

  const source = new Int32Array(total);
  const target = new Int32Array(total);
  const ref = new Int32Array(total);
  source.set(s.edges.source, 0);
  target.set(s.edges.target, 0);
  source.set(s.migrations.source, e);
  target.set(s.migrations.target, e);
  for (let i = 0; i < e; i += 1) ref[i] = i;
  for (let i = 0; i < m; i += 1) ref[e + i] = -(i + 1);

  const [inStart, inFrom, inRef] = csr(n, target, source, ref);
  const [outStart, outTo, outRef] = csr(n, source, target, ref);

  const order = Array.from({ length: n }, (_, i) => i).sort((a, b) =>
    maximising ? s.fitness[b]! - s.fitness[a]! : s.fitness[a]! - s.fitness[b]!,
  );
  const rankOf = new Int32Array(n);
  order.forEach((node, rank) => { rankOf[node] = rank; });

  const byHash = new Map<string, number[]>();
  for (let i = 0; i < n; i += 1) {
    const hash = hashOf(s.nodeKeys[i]!);
    const list = byHash.get(hash);
    if (list === undefined) byHash.set(hash, [i]);
    else list.push(i);
  }

  return { inStart, inFrom, inRef, outStart, outTo, outRef, rankOf, byHash };
}

/** Group edges by `key` node: counting sort, two passes, O(n + m). */
function csr(
  n: number, key: Int32Array, other: Int32Array, ref: Int32Array,
): [Int32Array, Int32Array, Int32Array] {
  const start = new Int32Array(n + 1);
  for (const k of key) start[k + 1]! += 1;
  for (let i = 0; i < n; i += 1) start[i + 1]! += start[i]!;
  const cursor = start.slice(0, n);
  const to = new Int32Array(key.length);
  const refs = new Int32Array(key.length);
  for (let i = 0; i < key.length; i += 1) {
    const slot = cursor[key[i]!]!++;
    to[slot] = other[i]!;
    refs[slot] = ref[i]!;
  }
  return [start, to, refs];
}

const hashOf = (key: string) => key.slice(key.indexOf(":") + 1);

export function nodeDetail(
  s: StnSnapshot, adj: Adjacency, index: number, maximising: boolean,
): NodeDetail {
  const key = s.nodeKeys[index]!;
  const neighbour = (other: number, edgeRef: number): NeighbourRef => {
    if (edgeRef >= 0) {
      return {
        index: other,
        island: s.islandId[other]!,
        fitness: s.fitness[other]!,
        via: "step",
        operator: s.operators[s.edges.operator[edgeRef]!] ?? null,
        weight: s.edges.weight[edgeRef]!,
      };
    }
    const route = -edgeRef - 1;
    return {
      index: other,
      island: s.islandId[other]!,
      fitness: s.fitness[other]!,
      via: "migration",
      operator: null,
      weight: s.migrations.transfers[route]!,
    };
  };
  const better = (a: NeighbourRef, b: NeighbourRef) =>
    maximising ? b.fitness - a.fitness : a.fitness - b.fitness;

  const parents: NeighbourRef[] = [];
  for (let k = adj.inStart[index]!; k < adj.inStart[index + 1]!; k += 1) {
    parents.push(neighbour(adj.inFrom[k]!, adj.inRef[k]!));
  }
  const children: NeighbourRef[] = [];
  for (let k = adj.outStart[index]!; k < adj.outStart[index + 1]!; k += 1) {
    children.push(neighbour(adj.outTo[k]!, adj.outRef[k]!));
  }
  parents.sort(better);
  children.sort(better);

  const dim = s.dim;
  const genome = Array.from(s.positions.subarray(index * dim, index * dim + dim));
  const twins = (adj.byHash.get(hashOf(key)) ?? [])
    .filter((other) => other !== index)
    .map((other) => ({ index: other, island: s.islandId[other]! }));

  return {
    index,
    key,
    island: s.islandId[index]!,
    genomeHash: hashOf(key),
    visits: s.visits[index]!,
    fitness: s.fitness[index]!,
    bestFitness: s.bestFitness[index]!,
    firstEval: s.firstEval[index]!,
    tRel: s.tRel[index]!,
    flags: s.flags[index]!,
    isBestOverall: adj.rankOf[index] === 0,
    rank: adj.rankOf[index]! + 1,
    of: s.nodeKeys.length,
    genome,
    parents: parents.slice(0, NEIGHBOUR_LIMIT),
    children: children.slice(0, NEIGHBOUR_LIMIT),
    parentCount: parents.length,
    childCount: children.length,
    twins,
  };
}

/** Walk parents back from `index` until every lineage reaches its start. */
export function traceLineage(s: StnSnapshot, adj: Adjacency, index: number): Lineage {
  const depthOf = new Map<number, number>([[index, 0]]);
  const queue = [index];
  const edges: number[] = [];
  const crossings: number[] = [];
  const islands = new Set<number>();
  let origins = 0;
  let depth = 0;
  let truncated = false;

  for (let head = 0; head < queue.length; head += 1) {
    const node = queue[head]!;
    const d = depthOf.get(node)!;
    islands.add(s.islandId[node]!);
    const from = adj.inStart[node]!;
    const to = adj.inStart[node + 1]!;
    if (from === to) origins += 1;
    for (let k = from; k < to; k += 1) {
      const parent = adj.inFrom[k]!;
      (adj.inRef[k]! < 0 ? crossings : edges).push(parent, node);
      if (depthOf.has(parent)) continue;
      if (depthOf.size >= LINEAGE_LIMIT) {
        truncated = true;
        continue;
      }
      depthOf.set(parent, d + 1);
      if (d + 1 > depth) depth = d + 1;
      queue.push(parent);
    }
  }

  return {
    nodes: Int32Array.from(queue),
    edges: Int32Array.from(edges),
    crossings: Int32Array.from(crossings),
    islands: [...islands].sort((a, b) => a - b),
    depth,
    origins,
    truncated,
  };
}

/** Whether a node carries a flag, for callers outside the contract module. */
export const hasFlag = (flags: number, flag: NodeFlag) => (flags & flag) !== 0;

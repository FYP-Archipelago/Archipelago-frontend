/**
 * "Drift" — a time-pinned force layout.
 *
 * The search trajectory network is time-ordered parent→child, with islands as
 * weak communities and migrations as the only links between them. Two classical
 * layouts each capture half of that:
 *
 *   - A layered DAG (Sugiyama) puts time on an axis, so the run reads as a
 *     trajectory. But crossing minimisation is NP-hard and the usual libraries
 *     fall over well below the sizes here.
 *   - Force-directed reveals the communities — islands genuinely separate,
 *     because migrations are their only connections — but loses the time order.
 *
 * Drift takes both cheaply: pin x to the evaluation index and force-relax y.
 * Time then reads left to right, island structure emerges vertically, and the
 * cost is O(n log n) per tick with Barnes–Hut rather than an NP-hard problem.
 *
 * This replaces the PCA projection as the default because PCA is what made the
 * old picture unreadable: projecting a 10-dimensional genome into 3D keeps only
 * ~35% of the variance, so position carried almost no information and every run
 * rendered as a blob. Here position means something exact — how far into the
 * search, and who is connected to whom.
 */

import {
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceY,
} from "d3-force-3d";

import type { StnSnapshot } from "../../data/stn/StnBuilder.js";

export interface LayoutProvenance {
  kind: "graph" | "pca";
  axisLabels: [string, string, string];
  /** PCA only: how much of the genome's variance the picture actually keeps. */
  honesty?: { retainedVariance: number; componentsUsed: number };
  /** Graph only: how settled the relaxation got. */
  quality?: { iterations: number; nodes: number; edges: number };
}

export interface LayoutResult {
  /** n × 3, interleaved. z is 0 in the 2D layouts. */
  positions: Float32Array;
  dims: 2 | 3;
  bounds: { min: [number, number, number]; max: [number, number, number] };
  provenance: LayoutProvenance;
}

/** Above this the JS quadtree stops being the right tool; see the plan. */
export const LAYOUT_WORKER_CEILING = 20_000;

const WIDTH = 1600;
const ITERATIONS = 300;
/** Height as a fraction of width, so a run frames landscape. */
const TARGET_ASPECT = 0.46;

interface SimNode {
  index: number;
  x: number;
  y: number;
  fx: number;
}

export function driftLayout(
  snapshot: StnSnapshot,
  onProgress?: (positions: Float32Array, progress: number) => void,
): LayoutResult {
  const n = snapshot.nodeKeys.length;
  const positions = new Float32Array(n * 3);
  if (n === 0) {
    return {
      positions, dims: 2,
      bounds: { min: [0, 0, 0], max: [0, 0, 0] },
      provenance: { kind: "graph", axisLabels: ["search progress", "structure", ""], quality: { iterations: 0, nodes: 0, edges: 0 } },
    };
  }

  // x is the evaluation index, normalised across the run. Pinned, not relaxed:
  // it is the one coordinate that already means something precise.
  let minEval = Infinity;
  let maxEval = -Infinity;
  for (let i = 0; i < n; i += 1) {
    const value = snapshot.firstEval[i]!;
    if (value < minEval) minEval = value;
    if (value > maxEval) maxEval = value;
  }
  const span = maxEval - minEval || 1;

  const nodes: SimNode[] = new Array(n);
  for (let i = 0; i < n; i += 1) {
    const t = (snapshot.firstEval[i]! - minEval) / span;
    const x = (t - 0.5) * WIDTH;
    nodes[i] = {
      index: i,
      x,
      fx: x,
      // Seed y by island so the relaxation starts from a sane separation rather
      // than untangling a random cloud. Cheap, and it converges much faster.
      y: (snapshot.islandId[i]! - 2) * 40 + (i % 17) - 8,
    };
  }

  // Trajectory edges only. Migrations are the sparse cross-island links and are
  // deliberately left out of the springs: letting them pull would drag the
  // islands back together, and their separation is the thing worth seeing.
  const links: Array<{ source: number; target: number }> = [];
  for (let i = 0; i < snapshot.edges.source.length; i += 1) {
    links.push({
      source: snapshot.edges.source[i]!,
      target: snapshot.edges.target[i]!,
    });
  }

  // Force weights, and why they are what they are.
  //
  // x is pinned, so y is the only freedom the relaxation has. A strong link
  // force therefore does not spread the graph -- it *flattens* it, pulling every
  // connected pair to the same height until each island is a horizontal barcode.
  // So the springs are kept weak and long, and the picture is made mostly by
  // repulsion and collision, which is what opens the vertical space up.
  const simulation = forceSimulation(nodes, 2)
    .force("charge", forceManyBody().strength(-90).theta(0.85).distanceMax(260))
    .force("link", forceLink<SimNode>(links).id((d) => d.index).distance(40).strength(0.04))
    .force("spread", forceCollide(2.2).strength(0.35))
    .force("settle", forceY(0).strength(0.004))
    .stop();

  const emitEvery = 20;
  for (let tick = 0; tick < ITERATIONS; tick += 1) {
    simulation.tick();
    if (onProgress && tick % emitEvery === 0) {
      onProgress(writePositions(nodes, positions), tick / ITERATIONS);
    }
  }
  writePositions(nodes, positions);

  // y is an arbitrary axis -- it carries structure, not a unit -- so it can be
  // rescaled freely, and doing so is what makes the run fill a wide canvas
  // instead of sitting in a tall column with empty space either side.
  normaliseAspect(positions, n, WIDTH * TARGET_ASPECT);

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < n; i += 1) {
    const x = positions[i * 3]!;
    const y = positions[i * 3 + 1]!;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }

  return {
    positions,
    dims: 2,
    bounds: { min: [minX, minY, 0], max: [maxX, maxY, 0] },
    provenance: {
      kind: "graph",
      axisLabels: ["search progress", "structure", ""],
      quality: { iterations: ITERATIONS, nodes: n, edges: links.length },
    },
  };
}

/** Scale the free axis so the drawing fills a landscape frame. */
function normaliseAspect(positions: Float32Array, n: number, targetSpan: number): void {
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < n; i += 1) {
    const y = positions[i * 3 + 1]!;
    if (y < min) min = y;
    if (y > max) max = y;
  }
  const span = max - min;
  if (span <= 0) return;
  const scale = targetSpan / span;
  const centre = (min + max) / 2;
  for (let i = 0; i < n; i += 1) {
    positions[i * 3 + 1] = (positions[i * 3 + 1]! - centre) * scale;
  }
}

function writePositions(nodes: SimNode[], out: Float32Array): Float32Array {
  for (let i = 0; i < nodes.length; i += 1) {
    const node = nodes[i]!;
    out[i * 3] = node.x;
    out[i * 3 + 1] = node.y;
    out[i * 3 + 2] = 0;
  }
  return out;
}

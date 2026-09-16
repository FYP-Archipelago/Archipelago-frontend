/**
 * The genome-space projection — the port of `archipelago_ui/layout.py`.
 *
 * This is the *actual* view the platform has always produced, and the one the
 * clustering pipeline draws: nodes placed by where they sit in search space,
 * projected to a plane by PCA. It is the default here for that reason. The graph
 * layout is offered beside it, not in front of it.
 *
 * Its honest weakness is carried in `retainedVariance` and shown in the UI: a
 * 10-dimensional genome projected onto two components keeps only about a third
 * of the variance, so distances across the plane are unreliable. That is a
 * property of the space, not of the run, and the fix for legibility is to draw
 * the structure better — which is what the edge rendering does — rather than to
 * quietly pretend the projection is faithful.
 */

import type { StnSnapshot } from "../../data/stn/StnBuilder.js";
import type { LayoutResult } from "../graph/DriftLayout.js";
import { jacobiEigen } from "./jacobi.js";

export interface PcaOptions {
  /** Spend the vertical axis on fitness rather than a third component. */
  elevation: boolean;
  /** Give each island its own footprint instead of overlaying them all. */
  territories: boolean;
  /** Spread the vertical axis by rank rather than raw fitness. */
  rankFitness: boolean;
  maximising: boolean;
}

const SCALE = 800;

export function pcaLayout(snapshot: StnSnapshot, options: PcaOptions): LayoutResult {
  const n = snapshot.nodeKeys.length;
  const d = snapshot.dim;
  const positions = new Float32Array(n * 3);

  if (n === 0 || d === 0) {
    return {
      positions, dims: options.elevation ? 3 : 3,
      bounds: { min: [0, 0, 0], max: [0, 0, 0] },
      provenance: {
        kind: "pca",
        axisLabels: ["component 1", "component 2", options.elevation ? "fitness" : "component 3"],
        honesty: { retainedVariance: 0, componentsUsed: 0 },
      },
    };
  }

  const wanted = options.elevation ? 2 : 3;

  // Centre, then take the covariance. d is the genome dimension (10 in every
  // corpus run), so this is a tiny matrix however many nodes there are.
  const mean = new Float64Array(d);
  for (let i = 0; i < n; i += 1) {
    for (let k = 0; k < d; k += 1) mean[k]! += snapshot.positions[i * d + k]!;
  }
  for (let k = 0; k < d; k += 1) mean[k]! /= n;

  const cov = new Float64Array(d * d);
  for (let i = 0; i < n; i += 1) {
    for (let a = 0; a < d; a += 1) {
      const da = snapshot.positions[i * d + a]! - mean[a]!;
      if (da === 0) continue;
      for (let b = a; b < d; b += 1) {
        cov[a * d + b]! += da * (snapshot.positions[i * d + b]! - mean[b]!);
      }
    }
  }
  for (let a = 0; a < d; a += 1) {
    for (let b = a; b < d; b += 1) {
      const value = cov[a * d + b]! / Math.max(n - 1, 1);
      cov[a * d + b] = value;
      cov[b * d + a] = value;
    }
  }

  const { values, vectors } = jacobiEigen(cov, d);
  let totalVariance = 0;
  for (let k = 0; k < d; k += 1) totalVariance += Math.max(values[k]!, 0);

  const components = Math.min(wanted, d);
  const projected: Float64Array[] = [];
  for (let c = 0; c < components; c += 1) {
    const axis = new Float64Array(n);
    for (let i = 0; i < n; i += 1) {
      let sum = 0;
      for (let k = 0; k < d; k += 1) {
        sum += (snapshot.positions[i * d + k]! - mean[k]!) * vectors[k * d + c]!;
      }
      axis[i] = sum;
    }
    projected.push(axis);
  }

  let retained = 0;
  for (let c = 0; c < components; c += 1) retained += Math.max(values[c]!, 0);
  retained = totalVariance > 0 ? retained / totalVariance : 0;

  // Each axis to [-1, 1], exactly as Python does before territories are applied.
  const planar = [normalise(projected[0]!, n), normalise(projected[1] ?? new Float64Array(n), n)];

  let vertical: Float64Array;
  if (options.elevation) {
    // Lower is better, so a maximising run is negated and convergence still
    // reads as descent.
    const source = new Float64Array(n);
    for (let i = 0; i < n; i += 1) {
      source[i] = options.maximising ? -snapshot.fitness[i]! : snapshot.fitness[i]!;
    }
    // Fitness is heavily skewed: a few terrible initial points set the top of the
    // range and everything else piles up at the floor, so a linear axis spends
    // most of its height on empty space. Ranking spreads the nodes over the axis
    // while staying monotonic in fitness, so descent still means improvement --
    // only the spacing between levels stops being linear.
    vertical = options.rankFitness ? rankNormalise(source, n) : normalise(source, n);
  } else {
    vertical = normalise(projected[2] ?? new Float64Array(n), n);
  }

  const centres = options.territories ? territoryCentres(snapshot, n) : null;
  const footprint = centres === null ? 1 : 0.62;

  for (let i = 0; i < n; i += 1) {
    const offset = centres?.get(snapshot.islandId[i]!) ?? [0, 0];
    positions[i * 3] = (planar[0]![i]! * footprint + offset[0]) * SCALE;
    positions[i * 3 + 1] = (planar[1]![i]! * footprint + offset[1]) * SCALE;
    positions[i * 3 + 2] = vertical[i]! * SCALE * 0.5;
  }

  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < n; i += 1) {
    const x = positions[i * 3]!, y = positions[i * 3 + 1]!, z = positions[i * 3 + 2]!;
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }

  return {
    positions,
    dims: 3,
    bounds: { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] },
    provenance: {
      kind: "pca",
      axisLabels: [
        "component 1",
        "component 2",
        options.elevation ? "fitness (lower = better)" : "component 3",
      ],
      honesty: { retainedVariance: retained, componentsUsed: components + (options.elevation ? 0 : 0) },
    },
  };
}

/** Position by order rather than by value, mapped to [-1, 1]. */
function rankNormalise(values: Float64Array, n: number): Float64Array {
  const order = Array.from({ length: n }, (_, i) => i).sort(
    (a, b) => values[a]! - values[b]!,
  );
  const out = new Float64Array(n);
  if (n === 1) return out;
  // Equal values share their average rank. Without this, ties are broken by sort
  // order, so a migrant and the individual it was copied from -- same genome,
  // same fitness -- would be drawn at different heights. "Equal" allows for the
  // last ulp: a node's fitness is a mean over its visits, and the same value
  // averaged over a different number of visits does not always round back to
  // exactly itself.
  const same = (a: number, b: number) =>
    Math.abs(a - b) <= 1e-9 * Math.max(Math.abs(a), Math.abs(b), 1);
  let start = 0;
  while (start < n) {
    let end = start;
    while (end + 1 < n && same(values[order[end + 1]!]!, values[order[start]!]!)) end += 1;
    const shared = ((start + end) / 2 / (n - 1)) * 2 - 1;
    for (let rank = start; rank <= end; rank += 1) out[order[rank]!] = shared;
    start = end + 1;
  }
  return out;
}

/** To [-1, 1]; a constant axis collapses to the middle rather than blowing up. */
function normalise(values: Float64Array, n: number): Float64Array {
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < n; i += 1) {
    const value = values[i]!;
    if (value < min) min = value;
    if (value > max) max = value;
  }
  const span = max - min;
  const out = new Float64Array(n);
  if (span === 0) return out;
  for (let i = 0; i < n; i += 1) out[i] = ((values[i]! - min) / span) * 2 - 1;
  return out;
}

/** A square-ish grid of island footprints, matching Python's `_territory_centres`. */
function territoryCentres(snapshot: StnSnapshot, n: number): Map<number, [number, number]> {
  const islands = [...new Set(Array.from({ length: n }, (_, i) => snapshot.islandId[i]!))].sort(
    (a, b) => a - b,
  );
  const centres = new Map<number, [number, number]>();
  if (islands.length <= 1) {
    for (const island of islands) centres.set(island, [0, 0]);
    return centres;
  }
  const columns = Math.ceil(Math.sqrt(islands.length));
  const spacing = 2.6;
  islands.forEach((island, i) => {
    const row = Math.floor(i / columns);
    const column = i % columns;
    centres.set(island, [
      (column - (columns - 1) / 2) * spacing,
      (row - (Math.ceil(islands.length / columns) - 1) / 2) * spacing,
    ]);
  });
  return centres;
}

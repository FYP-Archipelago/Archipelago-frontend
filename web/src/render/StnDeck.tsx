/**
 * The picture.
 *
 * Every layer is fed *binary attributes* — typed arrays straight from the worker
 * — rather than an array of objects with accessor functions. deck.gl supports
 * both; only the binary path survives a hundred thousand nodes, because the
 * alternative calls a JS function per datum per frame.
 *
 * Edges are drawn with additive blending and a very low per-edge alpha, so
 * density accumulates optically: where the search re-walked a route it burns
 * bright, where it passed once it stays faint. Nothing is sampled away. The old
 * Streamlit view kept the 1,000 "heaviest" of 11,197 edges and so reached only
 * 26% of the nodes, which read as missing data; here every edge is always drawn,
 * and exposure changes how density maps to opacity, not which edges exist.
 */

import { OrbitView, OrthographicView } from "@deck.gl/core";
import { LineLayer, ScatterplotLayer } from "@deck.gl/layers";
import DeckGL from "@deck.gl/react";
import { useMemo } from "react";

import { NodeFlag } from "../contract/schema.js";
import type { LayoutPayload, StnPayload } from "../data/worker/data.worker.js";

/** The palette's island cycle, as RGB. Must match tokens.css. */
const ISLAND_RGB: Array<[number, number, number]> = [
  [0x5a, 0xc8, 0xb8], // aqua
  [0xf2, 0xa6, 0x5a], // amber
  [0x7f, 0xa7, 0xe8], // sky
  [0xc8, 0x8b, 0xe0], // lilac
  [0x8f, 0xd1, 0x6a], // green
  [0xe8, 0x75, 0x6b], // coral
];
const MIGRATION_RGB: [number, number, number] = [0xff, 0x4d, 0x9d];
const ISLAND_BEST_RGB: [number, number, number] = [0xff, 0xd1, 0x66];

export interface StnDeckProps {
  payload: StnPayload;
  layout: LayoutPayload;
  viewState: Record<string, unknown>;
  onViewStateChange: (next: Record<string, unknown>) => void;
  /** Density that maps to full opacity. Lower burns more edges in. */
  exposure: number;
  showMigrations: boolean;
  hiddenIslands: ReadonlySet<number>;
}

export function StnDeck({
  payload, layout, viewState, onViewStateChange, exposure, showMigrations, hiddenIslands,
}: StnDeckProps) {
  const { islandId, visits, flags } = payload;
  const positions = layout.positions;
  const n = payload.nodeCount;
  const is3d = layout.dims === 3;

  const nodeVisual = useMemo(() => {
    const colours = new Uint8Array(n * 4);
    const radii = new Float32Array(n);
    for (let i = 0; i < n; i += 1) {
      const island = islandId[i]!;
      const hidden = hiddenIslands.has(island);
      const rgb = ISLAND_RGB[island % ISLAND_RGB.length]!;
      colours[i * 4] = rgb[0];
      colours[i * 4 + 1] = rgb[1];
      colours[i * 4 + 2] = rgb[2];
      colours[i * 4 + 3] = hidden ? 0 : 205;
      // Visit count, compressed: a location the run kept returning to should
      // read as bigger, but linearly it swamps everything else.
      radii[i] = hidden ? 0 : 1.0 + 1.4 * Math.pow(Math.min(visits[i]!, 12), 0.6);
    }
    return { colours, radii };
  }, [n, islandId, visits, hiddenIslands]);

  // Edge endpoints expanded into positions. deck wants a position per end, and
  // doing it here keeps the worker's payload down to indices.
  const edgeGeometry = useMemo(() => {
    const count = payload.edgeSource.length;
    const source = new Float32Array(count * 3);
    const target = new Float32Array(count * 3);
    const colours = new Uint8Array(count * 4);
    for (let i = 0; i < count; i += 1) {
      const a = payload.edgeSource[i]!;
      const b = payload.edgeTarget[i]!;
      source[i * 3] = positions[a * 3]!;
      source[i * 3 + 1] = positions[a * 3 + 1]!;
      source[i * 3 + 2] = positions[a * 3 + 2]!;
      target[i * 3] = positions[b * 3]!;
      target[i * 3 + 1] = positions[b * 3 + 1]!;
      target[i * 3 + 2] = positions[b * 3 + 2]!;

      const island = islandId[a]!;
      const rgb = ISLAND_RGB[island % ISLAND_RGB.length]!;
      // Alpha carries edge weight: a step the search repeated is denser. Kept
      // low so accumulation, not any single edge, makes the image.
      const weight = payload.edgeWeight[i]!;
      const alpha = hiddenIslands.has(island)
        ? 0
        : Math.min(255, Math.round((11 + 9 * (weight - 1)) / exposure));
      colours[i * 4] = rgb[0];
      colours[i * 4 + 1] = rgb[1];
      colours[i * 4 + 2] = rgb[2];
      colours[i * 4 + 3] = alpha;
    }
    return { count, source, target, colours };
  }, [payload, positions, islandId, exposure, hiddenIslands]);

  const migrationGeometry = useMemo(() => {
    const count = payload.migrationSource.length;
    const source = new Float32Array(count * 3);
    const target = new Float32Array(count * 3);
    const widths = new Float32Array(count);
    for (let i = 0; i < count; i += 1) {
      const a = payload.migrationSource[i]!;
      const b = payload.migrationTarget[i]!;
      source[i * 3] = positions[a * 3]!;
      source[i * 3 + 1] = positions[a * 3 + 1]!;
      source[i * 3 + 2] = positions[a * 3 + 2]!;
      target[i * 3] = positions[b * 3]!;
      target[i * 3 + 1] = positions[b * 3 + 1]!;
      target[i * 3 + 2] = positions[b * 3 + 2]!;
      widths[i] = 0.9 + 0.45 * Math.min(payload.migrationTransfers[i]!, 6);
    }
    return { count, source, target, widths };
  }, [payload, positions]);

  // A handful of points, so a plain object array is honest here.
  const bests = useMemo(() => {
    const out: Array<{ position: [number, number, number] }> = [];
    for (let i = 0; i < n; i += 1) {
      if ((flags[i]! & NodeFlag.FinalBest) === 0) continue;
      if (hiddenIslands.has(islandId[i]!)) continue;
      out.push({
        position: [positions[i * 3]!, positions[i * 3 + 1]!, positions[i * 3 + 2]!],
      });
    }
    return out;
  }, [n, flags, islandId, positions, hiddenIslands]);

  const layers = [
    new LineLayer({
      id: "trajectory",
      data: {
        length: edgeGeometry.count,
        attributes: {
          getSourcePosition: { value: edgeGeometry.source, size: 3 },
          getTargetPosition: { value: edgeGeometry.target, size: 3 },
          getColor: { value: edgeGeometry.colours, size: 4, normalized: true },
        },
      },
      getWidth: 1,
      widthUnits: "pixels",
      pickable: false,
      // Additive: overlapping edges accumulate rather than overwrite, which is
      // what turns a hairball into a density field.
      parameters: {
        blend: true,
        blendColorSrcFactor: "src-alpha",
        blendColorDstFactor: "one",
        blendAlphaSrcFactor: "one",
        blendAlphaDstFactor: "one",
        depthCompare: "always",
      },
      updateTriggers: { all: [exposure, hiddenIslands, positions] },
    }),

    // Migrations are drawn after the trajectory field and never inside it: the
    // palette reserves magenta for them, and a density field that averages hue
    // would let a dense region drift pink and break that rule.
    ...(showMigrations
      ? [
          new LineLayer({
            id: "migration",
            data: {
              length: migrationGeometry.count,
              attributes: {
                getSourcePosition: { value: migrationGeometry.source, size: 3 },
                getTargetPosition: { value: migrationGeometry.target, size: 3 },
                getWidth: { value: migrationGeometry.widths, size: 1 },
              },
            },
            getColor: [...MIGRATION_RGB, 165] as [number, number, number, number],
            widthUnits: "pixels",
            pickable: false,
            parameters: { depthCompare: "always" },
            updateTriggers: { all: [positions] },
          }),
        ]
      : []),

    new ScatterplotLayer({
      id: "nodes",
      data: {
        length: n,
        attributes: {
          getPosition: { value: positions, size: 3 },
          getFillColor: { value: nodeVisual.colours, size: 4, normalized: true },
          getRadius: { value: nodeVisual.radii, size: 1 },
        },
      },
      radiusUnits: "pixels",
      radiusMinPixels: 0,
      pickable: false,
      parameters: { depthCompare: "always" },
      updateTriggers: { all: [hiddenIslands, positions] },
    }),

    new ScatterplotLayer({
      id: "island-bests",
      data: bests,
      getPosition: (d: { position: [number, number, number] }) => d.position,
      getRadius: 5,
      radiusUnits: "pixels",
      getFillColor: [...ISLAND_BEST_RGB, 255] as [number, number, number, number],
      getLineColor: [8, 23, 31, 255] as [number, number, number, number],
      lineWidthUnits: "pixels",
      getLineWidth: 1.2,
      stroked: true,
      pickable: false,
      parameters: { depthCompare: "always" },
    }),
  ];

  return (
    <DeckGL
      views={is3d ? new OrbitView({ id: "stn" }) : new OrthographicView({ id: "stn" })}
      viewState={viewState}
      onViewStateChange={({ viewState: next }) =>
        onViewStateChange(next as Record<string, unknown>)
      }
      controller
      layers={layers}
      style={{ position: "absolute", inset: "0" }}
    />
  );
}

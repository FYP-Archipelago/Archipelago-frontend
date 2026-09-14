/**
 * The picture.
 *
 * Every layer is fed *binary attributes* — typed arrays straight from the worker
 * — rather than an array of objects with accessor functions. deck.gl supports
 * both; only the binary path survives a hundred thousand nodes, because the
 * alternative calls a JS function per datum per frame.
 *
 * What makes this read as a space rather than a flat wash:
 *
 *   - **Depth testing is on.** Near geometry occludes far geometry. Turning it
 *     off (`depthCompare: "always"`) is what made the first cut look flat no
 *     matter how good the GPU was: everything drew in list order, so there was
 *     no front or back.
 *   - **Node radii are in world units**, so they shrink with distance. Pixel
 *     radii keep far nodes the same size as near ones, which cancels the only
 *     other depth cue a billboard has.
 *   - **Edges test depth but do not write it.** They accumulate additively
 *     against each other, yet still disappear correctly behind nodes — the
 *     standard trick for transparent geometry over solid.
 *   - **A reference cage.** Rotating a cloud with no frame reads as the cloud
 *     deforming; one faint box makes it read as a camera moving.
 *
 * Edge density is still optical rather than sampled: every edge is drawn at
 * every setting, and exposure changes how density maps to opacity.
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
const DEEP: [number, number, number, number] = [8, 23, 31, 255];
const CAGE: [number, number, number, number] = [36, 66, 81, 110];

/** Solid geometry: occludes, and is occluded. */
const SOLID = { depthWriteEnabled: true, depthCompare: "less-equal" } as const;

/**
 * Transparent geometry: respects what is in front of it, but does not stop
 * other transparent geometry from accumulating behind it.
 */
const ADDITIVE = {
  blend: true,
  blendColorSrcFactor: "src-alpha",
  blendColorDstFactor: "one",
  blendAlphaSrcFactor: "one",
  blendAlphaDstFactor: "one",
  depthWriteEnabled: false,
  depthCompare: "less-equal",
} as const;

export interface StnDeckProps {
  payload: StnPayload;
  layout: LayoutPayload;
  viewState: Record<string, unknown>;
  onViewStateChange: (next: Record<string, unknown>) => void;
  /** Density that maps to full opacity. Lower burns more edges in. */
  exposure: number;
  showMigrations: boolean;
  showCage: boolean;
  hiddenIslands: ReadonlySet<number>;
  onError: (message: string) => void;
}

export function StnDeck({
  payload, layout, viewState, onViewStateChange,
  exposure, showMigrations, showCage, hiddenIslands, onError,
}: StnDeckProps) {
  const { islandId, visits, flags } = payload;
  const positions = layout.positions;
  const n = payload.nodeCount;
  const is3d = layout.dims === 3;

  // World-space extent, used to size nodes relative to the run rather than to
  // an arbitrary pixel constant.
  const extent = useMemo(() => {
    const { min, max } = layout.bounds;
    return Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2], 1);
  }, [layout.bounds]);

  const nodeVisual = useMemo(() => {
    const colours = new Uint8Array(n * 4);
    const radii = new Float32Array(n);
    // A location the run kept returning to should read as bigger, but linearly
    // the hot spots swamp everything, so the count is compressed.
    const base = extent * 0.0042;
    for (let i = 0; i < n; i += 1) {
      const island = islandId[i]!;
      const hidden = hiddenIslands.has(island);
      const rgb = ISLAND_RGB[island % ISLAND_RGB.length]!;
      colours[i * 4] = rgb[0];
      colours[i * 4 + 1] = rgb[1];
      colours[i * 4 + 2] = rgb[2];
      colours[i * 4 + 3] = hidden ? 0 : 255;
      radii[i] = hidden ? 0 : base * (1 + 0.85 * Math.pow(Math.min(visits[i]!, 14), 0.62));
    }
    return { colours, radii };
  }, [n, islandId, visits, hiddenIslands, extent]);

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
      const weight = payload.edgeWeight[i]!;
      const alpha = hiddenIslands.has(island)
        ? 0
        : Math.min(255, Math.round((14 + 11 * (weight - 1)) / exposure));
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
      widths[i] = 1.1 + 0.55 * Math.min(payload.migrationTransfers[i]!, 6);
    }
    return { count, source, target, widths };
  }, [payload, positions]);

  /**
   * The nodes the STN literature marks out: where a run ended up, and the
   * locations more than one island found independently. A few dozen points, so
   * plain objects are honest here.
   */
  const landmarks = useMemo(() => {
    const finals: Array<{ position: [number, number, number] }> = [];
    const shared: Array<{ position: [number, number, number] }> = [];
    for (let i = 0; i < n; i += 1) {
      if (hiddenIslands.has(islandId[i]!)) continue;
      const at: [number, number, number] = [
        positions[i * 3]!, positions[i * 3 + 1]!, positions[i * 3 + 2]!,
      ];
      if ((flags[i]! & NodeFlag.FinalBest) !== 0) finals.push({ position: at });
      else if ((flags[i]! & NodeFlag.Shared) !== 0) shared.push({ position: at });
    }
    return { finals, shared };
  }, [n, flags, islandId, positions, hiddenIslands]);

  /** A faint wireframe box, so rotating reads as a camera move. */
  const cage = useMemo(() => {
    const { min, max } = layout.bounds;
    const corner = (i: number): [number, number, number] => [
      (i & 1) === 0 ? min[0] : max[0],
      (i & 2) === 0 ? min[1] : max[1],
      (i & 4) === 0 ? min[2] : max[2],
    ];
    const pairs: Array<[number, number]> = [
      [0, 1], [2, 3], [4, 5], [6, 7],
      [0, 2], [1, 3], [4, 6], [5, 7],
      [0, 4], [1, 5], [2, 6], [3, 7],
    ];
    return pairs.map(([a, b]) => ({ from: corner(a), to: corner(b) }));
  }, [layout.bounds]);

  const layers = [
    ...(showCage && is3d
      ? [
          new LineLayer({
            id: "cage",
            data: cage,
            getSourcePosition: (d: { from: [number, number, number] }) => d.from,
            getTargetPosition: (d: { to: [number, number, number] }) => d.to,
            getColor: CAGE,
            getWidth: 1,
            widthUnits: "pixels",
            pickable: false,
            parameters: { depthWriteEnabled: false, depthCompare: "less-equal" },
          }),
        ]
      : []),

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
      parameters: ADDITIVE,
      updateTriggers: { all: [exposure, hiddenIslands, positions] },
    }),

    // Migrations are drawn apart from the trajectory field, never inside it: the
    // palette reserves magenta for them, and a field that averages hue would let
    // a dense region drift pink and break that rule.
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
            getColor: [...MIGRATION_RGB, 205] as [number, number, number, number],
            widthUnits: "pixels",
            pickable: false,
            parameters: { ...SOLID, depthWriteEnabled: false },
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
      // World units, so nodes shrink with distance and the cloud has depth.
      radiusUnits: is3d ? "common" : "pixels",
      radiusScale: is3d ? 1 : 2.4,
      radiusMinPixels: 1.4,
      radiusMaxPixels: 18,
      // A dark rim separates overlapping nodes instead of letting them merge
      // into one bright smear, which is most of what "clearly visible" means
      // at this density.
      stroked: true,
      getLineColor: DEEP,
      getLineWidth: 0.9,
      lineWidthUnits: "pixels",
      billboard: true,
      pickable: false,
      parameters: SOLID,
      updateTriggers: { all: [hiddenIslands, positions, is3d] },
    }),

    new ScatterplotLayer({
      id: "shared",
      data: landmarks.shared,
      getPosition: (d: { position: [number, number, number] }) => d.position,
      getRadius: 3.6,
      radiusUnits: "pixels",
      filled: false,
      stroked: true,
      getLineColor: [221, 232, 233, 190] as [number, number, number, number],
      getLineWidth: 1.1,
      lineWidthUnits: "pixels",
      pickable: false,
      parameters: SOLID,
    }),

    new ScatterplotLayer({
      id: "island-bests",
      data: landmarks.finals,
      getPosition: (d: { position: [number, number, number] }) => d.position,
      getRadius: 6,
      radiusUnits: "pixels",
      getFillColor: [...ISLAND_BEST_RGB, 255] as [number, number, number, number],
      stroked: true,
      getLineColor: DEEP,
      getLineWidth: 1.4,
      lineWidthUnits: "pixels",
      billboard: true,
      pickable: false,
      parameters: SOLID,
    }),
  ];

  return (
    <DeckGL
      views={
        is3d
          ? new OrbitView({ id: "stn", orbitAxis: "Z", fovy: 40 })
          : new OrthographicView({ id: "stn" })
      }
      viewState={viewState}
      onViewStateChange={({ viewState: next }) =>
        onViewStateChange(next as Record<string, unknown>)
      }
      controller={{ inertia: 260 }}
      layers={layers}
      // A WebGL failure otherwise leaves an empty black box with no explanation,
      // which is indistinguishable from "the run has no data".
      onError={(error: Error) => onError(error.message)}
      style={{ position: "absolute", inset: "0" }}
    />
  );
}

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type {
  LayoutKind, LayoutOptions, LayoutPayload, StnPayload, WorkerRequest, WorkerResponse,
} from "./data/worker/data.worker.js";
import { StnDeck } from "./render/StnDeck.js";
import "./theme/tokens.css";
import "./app.css";

const ISLAND_HEX = ["#5AC8B8", "#F2A65A", "#7FA7E8", "#C88BE0", "#8FD16A", "#E8756B"];

/** Frame the whole run, with a little air around it. */
function fitView(
  layout: LayoutPayload,
  width: number,
  height: number,
): Record<string, unknown> {
  const { min, max } = layout.bounds;
  const target: [number, number, number] = [
    (min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2,
  ];
  const spanX = Math.max(max[0] - min[0], 1);
  const spanY = Math.max(max[1] - min[1], 1);

  if (layout.dims === 3) {
    // Orbiting can swing any axis into either screen direction, so the frame has
    // to hold the largest extent whichever way the camera ends up pointing.
    const spanZ = Math.max(max[2] - min[2], 1);
    const extent = Math.max(spanX, spanY, spanZ);
    return {
      target,
      zoom: Math.log2((Math.min(width, height) / extent) * 0.95),
      rotationX: 26, rotationOrbit: -20,
      minZoom: -6, maxZoom: 8,
    };
  }
  return {
    target,
    zoom: Math.log2(Math.min(width / spanX, height / spanY) * 0.95),
    minZoom: -6, maxZoom: 8,
  };
}

export default function App() {
  const [runs, setRuns] = useState<string[]>([]);
  const [runId, setRunId] = useState<string | null>(null);
  const [payload, setPayload] = useState<StnPayload | null>(null);
  const [layout, setLayout] = useState<LayoutPayload | null>(null);
  const [phase, setPhase] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Defaults reproduce the view the platform already had: the genome-space
  // projection, fitness on the vertical, islands overlaid. The graph layout and
  // the island footprints are offered, not imposed -- the base is the real
  // picture, improved only in how clearly it is drawn.
  const [layoutKind, setLayoutKind] = useState<LayoutKind>("pca");
  const [elevation, setElevation] = useState(true);
  const [territories, setTerritories] = useState(false);

  const [exposure, setExposure] = useState(1);
  const [showMigrations, setShowMigrations] = useState(true);
  const [hiddenIslands, setHiddenIslands] = useState<ReadonlySet<number>>(new Set());
  const [viewState, setViewState] = useState<Record<string, unknown>>({});

  const workerRef = useRef<Worker | null>(null);
  const canvasRef = useRef<HTMLDivElement | null>(null);

  const options = useMemo<LayoutOptions>(
    () => ({ kind: layoutKind, elevation, territories }),
    [layoutKind, elevation, territories],
  );
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const frame = useCallback((next: LayoutPayload) => {
    const box = canvasRef.current?.getBoundingClientRect();
    setViewState(fitView(next, box?.width ?? 1200, box?.height ?? 620));
  }, []);

  useEffect(() => {
    fetch("/runs")
      .then((r) => r.json() as Promise<{ runs: string[] }>)
      .then((body) => {
        setRuns(body.runs);
        setRunId((current) => current ?? body.runs[0] ?? null);
      })
      .catch(() => setError("could not list runs"));
  }, []);

  useEffect(() => {
    if (runId === null) return;
    setPayload(null);
    setLayout(null);
    setError(null);
    setPhase("starting");
    setHiddenIslands(new Set());

    const worker = new Worker(new URL("./data/worker/data.worker.ts", import.meta.url), {
      type: "module",
    });
    workerRef.current = worker;
    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const message = event.data;
      if (message.type === "phase") setPhase(message.phase);
      else if (message.type === "ready") {
        setPayload(message.payload);
        setLayout(message.layout);
        frame(message.layout);
        setPhase(null);
      } else if (message.type === "layout") {
        setLayout(message.layout);
        frame(message.layout);
        setPhase(null);
      } else {
        setError(message.message);
        setPhase(null);
      }
    };
    worker.postMessage({
      type: "load", runId, layout: optionsRef.current,
    } satisfies WorkerRequest);
    return () => {
      worker.terminate();
      workerRef.current = null;
    };
  }, [runId, frame]);

  // Re-project when the layout choice changes. The network itself is not rebuilt,
  // so this is a projection, not a reload.
  const settled = useRef(false);
  useEffect(() => {
    if (!settled.current) {
      settled.current = true;
      return;
    }
    const worker = workerRef.current;
    if (worker === null || payload === null) return;
    setPhase("projecting");
    worker.postMessage({ type: "relayout", layout: options } satisfies WorkerRequest);
    // payload is intentionally not a dependency: a reload already projects.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [options]);

  const toggleIsland = useCallback((island: number) => {
    setHiddenIslands((current) => {
      const next = new Set(current);
      if (next.has(island)) next.delete(island);
      else next.add(island);
      return next;
    });
  }, []);

  const honesty = layout?.provenance.honesty;

  /**
   * Migration edges with no length.
   *
   * A migration copies an individual, so both endpoints hold the *same genome*
   * and — in the search-space projection — land on the same point. Only the
   * island differs. So the legend can count hundreds of routes while the plot
   * shows none, which reads as a bug in the data rather than what it is: a
   * property of the projection. Island grouping pulls the islands apart and
   * gives the edges somewhere to span; the graph layout gives every one of them
   * length by construction, because there position comes from structure.
   */
  const flatMigrations = useMemo(() => {
    if (payload === null || layout === null) return 0;
    const { positions } = layout;
    let flat = 0;
    for (let i = 0; i < payload.migrationSource.length; i += 1) {
      const a = payload.migrationSource[i]!;
      const b = payload.migrationTarget[i]!;
      if (
        positions[a * 3] === positions[b * 3] &&
        positions[a * 3 + 1] === positions[b * 3 + 1] &&
        positions[a * 3 + 2] === positions[b * 3 + 2]
      ) {
        flat += 1;
      }
    }
    return flat;
  }, [payload, layout]);

  const metrics = useMemo(() => {
    if (payload === null) return null;
    return [
      { label: "Nodes", value: payload.nodeCount.toLocaleString() },
      { label: "Trajectory edges", value: payload.edgeSource.length.toLocaleString() },
      {
        label: "Migration routes",
        value: payload.migrationSource.length.toLocaleString(),
        note: `from ${payload.transferEvents.toLocaleString()} transfers`,
        warn: flatMigrations > 0 ? `${flatMigrations.toLocaleString()} have zero length here` : undefined,
      },
      honesty !== undefined
        ? {
            label: "Variance kept",
            value: `${Math.round(honesty.retainedVariance * 100)}%`,
            note: "of the genome's spread",
          }
        : { label: "Islands", value: String(payload.islands.length) },
    ];
  }, [payload, honesty, flatMigrations]);

  const lowVariance = honesty !== undefined && honesty.retainedVariance < 0.5;

  return (
    <div className="shell">
      <header className="head">
        <div>
          <div className="eyebrow">The search</div>
          <h1>Archipelago</h1>
        </div>
        <div className="head-right">
          <span className="badge">v0.5 · typescript</span>
          <select
            className="run-select"
            value={runId ?? ""}
            onChange={(e) => setRunId(e.target.value)}
          >
            {runs.map((id) => (
              <option key={id} value={id}>{id}</option>
            ))}
          </select>
        </div>
      </header>

      <p className="deck-copy">
        {layoutKind === "pca" ? (
          <>
            Every location the run actually visited, placed by where it sits in
            search space. Height is fitness, so convergence reads as descent and a
            stalled island as one that never gets down.
          </>
        ) : (
          <>
            The same locations, placed by the network instead of the genome:
            horizontal is how far into the run a location was first reached,
            vertical is what it connects to. Islands separate because migrations
            are the only thing joining them.
          </>
        )}
      </p>

      {metrics !== null && (
        <div className="metrics">
          {metrics.map((m) => (
            <div className="metric" key={m.label}>
              <div className="metric-label">{m.label}</div>
              <div className="metric-value">{m.value}</div>
              {m.note !== undefined && <div className="metric-note">{m.note}</div>}
              {"warn" in m && m.warn !== undefined && (
                <div className="metric-warn">{m.warn}</div>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="controls">
        <div className="control">
          <span className="control-label">Layout</span>
          <div className="seg">
            <button
              className={layoutKind === "pca" ? "seg-on" : ""}
              onClick={() => setLayoutKind("pca")}
            >
              Search space
            </button>
            <button
              className={layoutKind === "drift" ? "seg-on" : ""}
              onClick={() => setLayoutKind("drift")}
            >
              Graph structure
            </button>
          </div>
        </div>

        {layoutKind === "pca" && (
          <>
            <label className="control control-inline">
              <input
                type="checkbox"
                checked={elevation}
                onChange={(e) => setElevation(e.target.checked)}
              />
              <span className="control-label">Fitness elevation</span>
            </label>
            <label className="control control-inline">
              <input
                type="checkbox"
                checked={territories}
                onChange={(e) => setTerritories(e.target.checked)}
              />
              <span className="control-label">Island grouping</span>
            </label>
          </>
        )}

        <label className="control">
          <span className="control-label">Edge exposure</span>
          <input
            type="range" min={0.25} max={6} step={0.05}
            value={exposure}
            onChange={(e) => setExposure(Number(e.target.value))}
          />
        </label>

        <label className="control control-inline">
          <input
            type="checkbox"
            checked={showMigrations}
            onChange={(e) => setShowMigrations(e.target.checked)}
          />
          <span className="control-label">Migrations</span>
        </label>

        {payload !== null && (
          <div className="control">
            <span className="control-label">Islands</span>
            <div className="island-chips">
              {payload.islands.map((island) => {
                const hidden = hiddenIslands.has(island);
                const hex = ISLAND_HEX[island % ISLAND_HEX.length]!;
                return (
                  <button
                    key={island}
                    className={`chip${hidden ? " chip-off" : ""}`}
                    style={{ ["--chip" as string]: hex }}
                    onClick={() => toggleIsland(island)}
                    aria-pressed={!hidden}
                  >
                    {island}
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </div>

      <div className="canvas" ref={canvasRef}>
        {payload !== null && layout !== null && (
          <StnDeck
            payload={payload}
            layout={layout}
            viewState={viewState}
            onViewStateChange={setViewState}
            exposure={exposure}
            showMigrations={showMigrations}
            hiddenIslands={hiddenIslands}
          />
        )}
        {phase !== null && (
          <div className="overlay">
            <div className="spinner" />
            <div className="overlay-text">{phase}…</div>
          </div>
        )}
        {error !== null && <div className="overlay overlay-error">{error}</div>}
      </div>

      <p className="caption">
        {lowVariance && (
          <>
            The projection keeps only{" "}
            <b>{Math.round((honesty?.retainedVariance ?? 0) * 100)}%</b> of the
            variance, so distances across the plane are unreliable — read the
            structure, not the spacing. That is a property of the space, not the run.{" "}
          </>
        )}
        {flatMigrations > 0 && showMigrations && (
          <>
            <b>{flatMigrations.toLocaleString()}</b> migration routes have zero
            length here and so cannot render: a migration copies an individual, so
            both ends hold the same genome and project to the same point — only the
            island differs. Turn on <b>island grouping</b>, or switch to{" "}
            <b>graph structure</b>, where every crossing has length by construction.{" "}
          </>
        )}
        Every edge is drawn at every setting: <b>exposure</b> changes how density
        maps to opacity, not which edges exist. Gold marks where each island
        finished; magenta is a migration. Drag to orbit, scroll to zoom.
      </p>
    </div>
  );
}

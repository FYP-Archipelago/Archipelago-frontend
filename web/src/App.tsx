import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  BrandMark, ChevronIcon, EyeIcon, InfoIcon, MoonIcon, ResetIcon, SunIcon,
} from "./components/icons.js";
import type {
  LayoutKind, LayoutOptions, LayoutPayload, StnPayload, WorkerRequest, WorkerResponse,
} from "./data/worker/data.worker.js";
import { StnScene } from "./render/StnScene.js";
import { ISLAND_CSS, type ThemeName } from "./theme/palette.js";
import "./theme/tokens.css";
import "./app.css";

const THEME_KEY = "archipelago-theme";

/** Dark unless the viewer chose light; the choice is remembered per browser. */
function useTheme(): [ThemeName, () => void] {
  const [theme, setTheme] = useState<ThemeName>(() => {
    try {
      return localStorage.getItem(THEME_KEY) === "light" ? "light" : "dark";
    } catch {
      return "dark";
    }
  });
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch {
      // Storage can be unavailable (private windows); the theme still applies.
    }
  }, [theme]);
  const toggle = useCallback(() => setTheme((t) => (t === "dark" ? "light" : "dark")), []);
  return [theme, toggle];
}

export default function App() {
  const [theme, toggleTheme] = useTheme();

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
  const [rankFitness, setRankFitness] = useState(true);

  // Shown as intensity (right is brighter) and handed to the scene as exposure.
  const [intensity, setIntensity] = useState(1);
  const [showMigrations, setShowMigrations] = useState(true);
  const [showFrame, setShowFrame] = useState(true);
  const [nodeScale, setNodeScale] = useState(1);
  const [resetCount, setResetCount] = useState(0);
  const [hiddenIslands, setHiddenIslands] = useState<ReadonlySet<number>>(new Set());

  const workerRef = useRef<Worker | null>(null);

  const options = useMemo<LayoutOptions>(
    () => ({ kind: layoutKind, elevation, territories, rankFitness }),
    [layoutKind, elevation, territories, rankFitness],
  );
  const optionsRef = useRef(options);
  optionsRef.current = options;

  useEffect(() => {
    fetch("/runs")
      .then((r) => r.json() as Promise<{ runs: string[] }>)
      .then((body) => {
        setRuns(body.runs);
        setRunId((current) => current ?? body.runs[0] ?? null);
      })
      .catch(() => setError("Could not list runs. Is the dev server serving data/?"));
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
        setPhase(null);
      } else if (message.type === "layout") {
        // A new projection of the same run: the camera stays where the user left
        // it, so toggling a control never throws the view somewhere else.
        setLayout(message.layout);
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
  }, [runId]);

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

  const islandCounts = useMemo(() => {
    const counts = new Map<number, number>();
    if (payload === null) return counts;
    for (const island of payload.islandId) counts.set(island, (counts.get(island) ?? 0) + 1);
    return counts;
  }, [payload]);

  const honesty = layout?.provenance.honesty;

  /**
   * Migration edges with no length.
   *
   * A migration copies an individual, so both endpoints hold the *same genome*
   * and — in the search-space projection — land on the same point. Only the
   * island differs. So the count can say hundreds of routes while the plot shows
   * none, which reads as a bug in the data rather than what it is: a property of
   * the projection. Island grouping pulls the islands apart and gives the edges
   * somewhere to span; the graph layout gives every one of them length by
   * construction, because there position comes from structure.
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

  const stats = useMemo(() => {
    if (payload === null) return null;
    return [
      { label: "Nodes", value: payload.nodeCount.toLocaleString(), note: `${payload.islands.length} islands` },
      { label: "Trajectory edges", value: payload.edgeSource.length.toLocaleString(), note: "within islands" },
      {
        label: "Migration routes",
        value: payload.migrationSource.length.toLocaleString(),
        note: `from ${payload.transferEvents.toLocaleString()} transfers`,
      },
      honesty !== undefined
        ? {
            label: "Variance kept",
            value: `${Math.round(honesty.retainedVariance * 100)}%`,
            note: "of the genome's spread",
          }
        : { label: "Layout", value: "Graph", note: "position from structure" },
    ];
  }, [payload, honesty]);

  const lowVariance = honesty !== undefined && honesty.retainedVariance < 0.5;
  const islandHex = ISLAND_CSS[theme];

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <BrandMark />
          <span className="brand-name">Archipelago</span>
          <span className="pill">v0.5</span>
        </div>
        <span className="crumb">Search trajectory network</span>

        <div className="topbar-right">
          <label className="picker">
            <span className="picker-label">Run</span>
            <select value={runId ?? ""} onChange={(e) => setRunId(e.target.value)}>
              {runs.map((id) => (
                <option key={id} value={id}>{id}</option>
              ))}
            </select>
            <ChevronIcon size={14} />
          </label>
          <button
            className="icon-btn"
            onClick={toggleTheme}
            aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
            title={theme === "dark" ? "Light mode" : "Dark mode"}
          >
            {theme === "dark" ? <SunIcon /> : <MoonIcon />}
          </button>
        </div>
      </header>

      <div className="body">
        <aside className="sidebar">
          <section className="section">
            <h2 className="section-title">Layout</h2>
            <div className="seg" role="group" aria-label="Layout">
              <button aria-pressed={layoutKind === "pca"} onClick={() => setLayoutKind("pca")}>
                Search space
              </button>
              <button aria-pressed={layoutKind === "drift"} onClick={() => setLayoutKind("drift")}>
                Graph structure
              </button>
            </div>
            <p className="helper">
              {layoutKind === "pca"
                ? "Placed by where each location sits in search space. Height is fitness, so convergence reads as descent."
                : "Placed by the network: left to right is how far into the run, up and down is what connects to what."}
            </p>
          </section>

          {layoutKind === "pca" && (
            <section className="section">
              <h2 className="section-title">Projection</h2>
              <Switch label="Fitness as height" checked={elevation} onChange={setElevation} />
              {elevation && (
                <Switch
                  label="Even height"
                  hint="Spread skewed fitness by rank"
                  checked={rankFitness}
                  onChange={setRankFitness}
                />
              )}
              <Switch
                label="Island grouping"
                hint="Give each island its own footprint"
                checked={territories}
                onChange={setTerritories}
              />
            </section>
          )}

          <section className="section">
            <h2 className="section-title">Display</h2>
            <Slider
              label="Edge intensity" min={0.2} max={4} step={0.05}
              value={intensity} onChange={setIntensity}
            />
            <Slider
              label="Node size" min={0.4} max={2.5} step={0.05}
              value={nodeScale} onChange={setNodeScale}
            />
            <Switch label="Migrations" checked={showMigrations} onChange={setShowMigrations} />
            {layout?.dims === 3 && (
              <Switch label="Frame and axes" checked={showFrame} onChange={setShowFrame} />
            )}
          </section>

          {payload !== null && (
            <section className="section">
              <h2 className="section-title">
                Islands
                {hiddenIslands.size > 0 && (
                  <button className="text-btn" onClick={() => setHiddenIslands(new Set())}>
                    Show all
                  </button>
                )}
              </h2>
              <div className="islands">
                {payload.islands.map((island) => {
                  const hidden = hiddenIslands.has(island);
                  return (
                    <button
                      key={island}
                      className="island"
                      aria-pressed={!hidden}
                      onClick={() => toggleIsland(island)}
                      style={{ ["--dot" as string]: islandHex[island % islandHex.length] }}
                    >
                      <span className="dot" />
                      <span className="island-name">Island {island}</span>
                      <span className="island-count">
                        {(islandCounts.get(island) ?? 0).toLocaleString()}
                      </span>
                    </button>
                  );
                })}
              </div>
            </section>
          )}

          {(lowVariance || (flatMigrations > 0 && showMigrations)) && (
            <section className="section">
              <h2 className="section-title">Reading this view</h2>
              {lowVariance && (
                <div className="note">
                  <InfoIcon size={15} />
                  <p>
                    The projection keeps <b>{Math.round((honesty?.retainedVariance ?? 0) * 100)}%</b> of
                    the variance, so read the structure, not the spacing. That is a property
                    of the space, not the run.
                  </p>
                </div>
              )}
              {flatMigrations > 0 && showMigrations && (
                <div className="note note-warn">
                  <InfoIcon size={15} />
                  <p>
                    <b>{flatMigrations.toLocaleString()}</b> migration routes have zero length
                    here: both ends hold the same genome. Turn on island grouping, or use
                    graph structure, to see them.
                  </p>
                </div>
              )}
            </section>
          )}
        </aside>

        <main className="stage">
          {stats !== null && (
            <div className="stats">
              {stats.map((s) => (
                <div className="stat" key={s.label}>
                  <div className="stat-label">{s.label}</div>
                  <div className="stat-value">{s.value}</div>
                  <div className="stat-note">{s.note}</div>
                </div>
              ))}
            </div>
          )}

          <div className="canvas">
            {payload !== null && layout !== null && (
              <StnScene
                payload={payload}
                layout={layout}
                exposure={1 / intensity}
                nodeScale={nodeScale}
                showMigrations={showMigrations}
                showFrame={showFrame}
                hiddenIslands={hiddenIslands}
                theme={theme}
                resetToken={`${runId ?? ""}:${resetCount}`}
                onError={(message) => setError(`Graphics: ${message}`)}
              />
            )}

            {payload !== null && (
              <div className="toolbar">
                <button onClick={() => setResetCount((c) => c + 1)} title="Reset the camera">
                  <ResetIcon size={14} />
                  Reset view
                </button>
              </div>
            )}

            {payload !== null && (
              <div className="legend" aria-label="Legend">
                <span><i className="glyph glyph-sphere" />Location, by island</span>
                <span><i className="glyph glyph-start" />Trajectory start</span>
                <span><i className="glyph glyph-end" />Where an island finished</span>
                <span><i className="glyph glyph-best" />Best found</span>
                <span><i className="glyph glyph-shared" />Reached by several islands</span>
                <span><i className="glyph glyph-migration" />Migration</span>
              </div>
            )}

            {payload !== null && (
              <div className="hint">
                <EyeIcon size={13} />
                {layout?.dims === 3 ? "Drag to orbit · scroll to zoom" : "Drag to pan · scroll to zoom"}
              </div>
            )}

            {phase !== null && (
              <div className="overlay">
                <div className="overlay-card">
                  <div className="spinner" />
                  <span>{phase.charAt(0).toUpperCase() + phase.slice(1)}…</span>
                </div>
              </div>
            )}
            {error !== null && (
              <div className="overlay">
                <div className="overlay-card overlay-error">{error}</div>
              </div>
            )}
          </div>
        </main>
      </div>
    </div>
  );
}

function Switch({
  label, hint, checked, onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <label className="row">
      <span className="row-text">
        <span className="row-label">{label}</span>
        {hint !== undefined && <span className="row-hint">{hint}</span>}
      </span>
      <input
        type="checkbox" role="switch" className="switch"
        checked={checked} onChange={(e) => onChange(e.target.checked)}
      />
    </label>
  );
}

function Slider({
  label, min, max, step, value, onChange,
}: {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  onChange: (next: number) => void;
}) {
  const fill = `${((value - min) / (max - min)) * 100}%`;
  return (
    <label className="slider">
      <span className="slider-head">
        <span className="row-label">{label}</span>
        <span className="slider-value">{value.toFixed(2)}×</span>
      </span>
      <input
        type="range" className="range" min={min} max={max} step={step} value={value}
        style={{ ["--fill" as string]: fill }}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </label>
  );
}

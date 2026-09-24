import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  BrandMark, ChevronIcon, InfoIcon, MoonIcon, ResetIcon, SlidersIcon, SunIcon,
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

/**
 * One screen, picture first.
 *
 * The earlier shell spread every control, count and caveat across a sidebar and
 * four stat cards, and the result read as a dashboard with a plot in it. This
 * follows the old Plotly view instead: the scene fills the window, the counts
 * are one line of text, every option sits behind a single View button, and the
 * legend is also the island filter -- click an island to hide it, as Plotly's
 * legend did.
 */
export default function App() {
  const [theme, toggleTheme] = useTheme();

  const [runs, setRuns] = useState<string[]>([]);
  const [runId, setRunId] = useState<string | null>(null);
  const [payload, setPayload] = useState<StnPayload | null>(null);
  const [layout, setLayout] = useState<LayoutPayload | null>(null);
  const [phase, setPhase] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Defaults reproduce the view the platform already had: the genome-space
  // projection, fitness on the vertical, islands overlaid.
  const [layoutKind, setLayoutKind] = useState<LayoutKind>("pca");
  const [elevation, setElevation] = useState(true);
  const [territories, setTerritories] = useState(false);
  const [rankFitness, setRankFitness] = useState(true);

  const [edgeIntensity, setEdgeIntensity] = useState(1);
  const [nodeScale, setNodeScale] = useState(1);
  const [showMigrations, setShowMigrations] = useState(true);
  const [showFrame, setShowFrame] = useState(true);
  const [hiddenIslands, setHiddenIslands] = useState<ReadonlySet<number>>(new Set());
  const [resetCount, setResetCount] = useState(0);
  const [viewOpen, setViewOpen] = useState(false);

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
        // it, so changing an option never throws the view somewhere else.
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

  // Re-project when a layout option changes. The network is not rebuilt.
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

  /** Plotly's double-click-in-legend: show only this island, or everything again. */
  const isolateIsland = useCallback((island: number) => {
    if (payload === null) return;
    setHiddenIslands((current) => {
      const alone = current.size === payload.islands.length - 1 && !current.has(island);
      return alone ? new Set() : new Set(payload.islands.filter((i) => i !== island));
    });
  }, [payload]);

  const islandCounts = useMemo(() => {
    const counts = new Map<number, number>();
    if (payload === null) return counts;
    for (const island of payload.islandId) counts.set(island, (counts.get(island) ?? 0) + 1);
    return counts;
  }, [payload]);

  /**
   * Migration routes with no length. A migration copies an individual, so both
   * ends hold the same genome and -- in the search-space projection -- land on
   * the same point. Island grouping or the graph layout gives them length.
   */
  const flatMigrations = useMemo(() => {
    if (payload === null || layout === null) return 0;
    const { positions } = layout;
    let flat = 0;
    for (let i = 0; i < payload.migrationSource.length; i += 1) {
      const a = payload.migrationSource[i]! * 3;
      const b = payload.migrationTarget[i]! * 3;
      if (positions[a] === positions[b] && positions[a + 1] === positions[b + 1]
        && positions[a + 2] === positions[b + 2]) flat += 1;
    }
    return flat;
  }, [payload, layout]);

  const honesty = layout?.provenance.honesty;
  const islandHex = ISLAND_CSS[theme];

  const caveats: string[] = [];
  if (honesty !== undefined && honesty.retainedVariance < 0.5) {
    caveats.push(
      `The projection keeps ${Math.round(honesty.retainedVariance * 100)}% of the genome's variance, `
      + "so read the structure, not the distances.",
    );
  }
  if (flatMigrations > 0 && showMigrations) {
    caveats.push(
      `${flatMigrations.toLocaleString()} migration routes have zero length here, because both ends `
      + "hold the same genome. Island grouping or the graph layout shows them.",
    );
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <BrandMark />
          <span className="brand-name">Archipelago</span>
        </div>

        <label className="picker">
          <span className="sr-only">Run</span>
          <select value={runId ?? ""} onChange={(e) => setRunId(e.target.value)}>
            {runs.map((id) => (
              <option key={id} value={id}>{id}</option>
            ))}
          </select>
          <ChevronIcon size={14} />
        </label>

        <div className="topbar-right">
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

      <main className="stage">
        {payload !== null && layout !== null && (
          <StnScene
            payload={payload}
            layout={layout}
            edgeIntensity={edgeIntensity}
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
          <div className="summary">
            <span><b>{payload.nodeCount.toLocaleString()}</b> locations</span>
            <span><b>{payload.edgeSource.length.toLocaleString()}</b> steps</span>
            <span><b>{payload.migrationSource.length.toLocaleString()}</b> migration routes</span>
            {honesty !== undefined && (
              <span><b>{Math.round(honesty.retainedVariance * 100)}%</b> variance kept</span>
            )}
            {caveats.length > 0 && (
              <span className="caveat" tabIndex={0}>
                <InfoIcon size={14} />
                <span className="caveat-text">
                  {caveats.map((text) => <span key={text}>{text}</span>)}
                </span>
              </span>
            )}
          </div>
        )}

        {payload !== null && (
          <div className="actions">
            <button onClick={() => setResetCount((c) => c + 1)} title="Reset the camera (or double-click the view)">
              <ResetIcon size={14} />
              Reset
            </button>
            <button
              aria-expanded={viewOpen}
              className={viewOpen ? "is-open" : ""}
              onClick={() => setViewOpen((open) => !open)}
            >
              <SlidersIcon size={14} />
              View
            </button>
          </div>
        )}

        {viewOpen && payload !== null && (
          <ViewPanel onClose={() => setViewOpen(false)}>
            <div className="seg" role="group" aria-label="Layout">
              <button aria-pressed={layoutKind === "pca"} onClick={() => setLayoutKind("pca")}>
                Search space
              </button>
              <button aria-pressed={layoutKind === "drift"} onClick={() => setLayoutKind("drift")}>
                Graph structure
              </button>
            </div>

            {layoutKind === "pca" && (
              <div className="group">
                <Switch label="Fitness as height" checked={elevation} onChange={setElevation} />
                {elevation && (
                  <Switch label="Even height" hint="Spread skewed fitness by rank"
                    checked={rankFitness} onChange={setRankFitness} />
                )}
                <Switch label="Island grouping" hint="Each island in its own footprint"
                  checked={territories} onChange={setTerritories} />
              </div>
            )}

            <div className="group">
              <Slider label="Edges" min={0} max={4} step={0.05}
                value={edgeIntensity} onChange={setEdgeIntensity} />
              <Slider label="Nodes" min={0.5} max={2} step={0.05}
                value={nodeScale} onChange={setNodeScale} />
            </div>

            <div className="group">
              <Switch label="Migrations" checked={showMigrations} onChange={setShowMigrations} />
              {layout?.dims === 3 && (
                <Switch label="Box and axes" checked={showFrame} onChange={setShowFrame} />
              )}
            </div>
          </ViewPanel>
        )}

        {payload !== null && (
          <div className="legend">
            <div className="legend-islands" role="group" aria-label="Islands">
              {payload.islands.map((island) => (
                <button
                  key={island}
                  aria-pressed={!hiddenIslands.has(island)}
                  onClick={() => toggleIsland(island)}
                  onDoubleClick={() => isolateIsland(island)}
                  title="Click to hide · double-click to show only this island"
                  style={{ ["--dot" as string]: islandHex[island % islandHex.length] }}
                >
                  <i className="dot" />
                  Island {island}
                  <span className="count">{(islandCounts.get(island) ?? 0).toLocaleString()}</span>
                </button>
              ))}
            </div>
            <div className="legend-marks">
              <span><i className="mark-diamond" />Where each island finished</span>
              {showMigrations && <span><i className="mark-line" />Migration</span>}
            </div>
          </div>
        )}

        {payload !== null && (
          <div className="hint">
            {layout?.dims === 3
              ? "Drag to turn · scroll to zoom · double-click to reset"
              : "Drag to pan · scroll to zoom · double-click to reset"}
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
      </main>
    </div>
  );
}

/** A floating panel that closes on Escape or a click outside it. */
function ViewPanel({ onClose, children }: { onClose: () => void; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (ref.current?.contains(target) || target?.closest(".actions") !== null) return;
      onClose();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onPointer);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onPointer);
    };
  }, [onClose]);
  return (
    <div className="panel" ref={ref} role="dialog" aria-label="View options">
      {children}
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
        <span>{label}</span>
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
      <span>{label}</span>
      <input
        type="range" className="range" min={min} max={max} step={step} value={value}
        style={{ ["--fill" as string]: fill }}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <span className="slider-value">{value.toFixed(1)}×</span>
    </label>
  );
}

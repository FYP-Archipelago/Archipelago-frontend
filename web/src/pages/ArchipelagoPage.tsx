/**
 * The search, in 3D. Picture first: the scene fills the page, the counts are
 * one line, every option sits behind a single View button, and the legend is
 * also the island filter -- click to hide, double-click to isolate, as in the
 * old Plotly view.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { InfoIcon, ResetIcon, SlidersIcon } from "../components/icons.js";
import type { StnState } from "../data/useStn.js";
import type { LayoutKind } from "../data/worker/data.worker.js";
import { StnScene } from "../render/StnScene.js";
import { ISLAND_CSS, type ThemeName } from "../theme/palette.js";

export interface ViewState {
  layoutKind: LayoutKind;
  elevation: boolean;
  territories: boolean;
  rankFitness: boolean;
  bestOnTop: boolean;
  edgeIntensity: number;
  nodeScale: number;
  showMigrations: boolean;
  showFrame: boolean;
}

export const DEFAULT_VIEW: ViewState = {
  // The view the platform already had: genome-space projection, fitness on the
  // vertical, islands overlaid.
  layoutKind: "pca",
  elevation: true,
  territories: false,
  rankFitness: true,
  bestOnTop: false,
  edgeIntensity: 1,
  nodeScale: 1,
  showMigrations: true,
  showFrame: true,
};

export function ArchipelagoPage({ runId, stn, theme, view, setView, hiddenIslands, setHiddenIslands }: {
  runId: string | null;
  stn: StnState;
  theme: ThemeName;
  view: ViewState;
  setView: (patch: Partial<ViewState>) => void;
  hiddenIslands: ReadonlySet<number>;
  setHiddenIslands: (next: ReadonlySet<number>) => void;
}) {
  const { payload, layout, phase, error } = stn;
  const [resetCount, setResetCount] = useState(0);
  const [viewOpen, setViewOpen] = useState(false);
  const [graphicsError, setGraphicsError] = useState<string | null>(null);

  const toggleIsland = useCallback((island: number) => {
    const next = new Set(hiddenIslands);
    if (next.has(island)) next.delete(island);
    else next.add(island);
    setHiddenIslands(next);
  }, [hiddenIslands, setHiddenIslands]);

  /** Plotly's legend double-click: show only this island, or everything again. */
  const isolateIsland = useCallback((island: number) => {
    if (payload === null) return;
    const alone = hiddenIslands.size === payload.islands.length - 1 && !hiddenIslands.has(island);
    setHiddenIslands(alone ? new Set() : new Set(payload.islands.filter((i) => i !== island)));
  }, [payload, hiddenIslands, setHiddenIslands]);

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
  if (flatMigrations > 0 && view.showMigrations) {
    caveats.push(
      `${flatMigrations.toLocaleString()} migration routes have zero length here, because both ends `
      + "hold the same genome. Island grouping or the graph layout shows them.",
    );
  }

  const shownError = error ?? graphicsError;

  return (
    <div className="stage">
      {payload !== null && layout !== null && (
        <StnScene
          payload={payload}
          layout={layout}
          edgeIntensity={view.edgeIntensity}
          nodeScale={view.nodeScale}
          showMigrations={view.showMigrations}
          showFrame={view.showFrame}
          hiddenIslands={hiddenIslands}
          theme={theme}
          resetToken={`${runId ?? ""}:${resetCount}`}
          onError={(message) => setGraphicsError(`Graphics: ${message}`)}
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
            <span className="caveat" tabIndex={0} aria-label="Reading notes">
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
            <button aria-pressed={view.layoutKind === "pca"} onClick={() => setView({ layoutKind: "pca" })}>
              Search space
            </button>
            <button aria-pressed={view.layoutKind === "drift"} onClick={() => setView({ layoutKind: "drift" })}>
              Graph structure
            </button>
          </div>

          {view.layoutKind === "pca" && (
            <div className="group">
              <Switch label="Fitness as height" checked={view.elevation}
                onChange={(v) => setView({ elevation: v })} />
              {view.elevation && (
                <>
                  <Switch label="Best at top" hint="As the clustering repo's fitness plot draws it"
                    checked={view.bestOnTop} onChange={(v) => setView({ bestOnTop: v })} />
                  <Switch label="Even height" hint="Spread skewed fitness by rank"
                    checked={view.rankFitness} onChange={(v) => setView({ rankFitness: v })} />
                </>
              )}
              <Switch label="Island grouping" hint="Each island in its own footprint"
                checked={view.territories} onChange={(v) => setView({ territories: v })} />
            </div>
          )}

          <div className="group">
            <Slider label="Edges" min={0} max={4} step={0.05}
              value={view.edgeIntensity} onChange={(v) => setView({ edgeIntensity: v })} />
            <Slider label="Nodes" min={0.5} max={2} step={0.05}
              value={view.nodeScale} onChange={(v) => setView({ nodeScale: v })} />
          </div>

          <div className="group">
            <Switch label="Migrations" checked={view.showMigrations}
              onChange={(v) => setView({ showMigrations: v })} />
            {layout?.dims === 3 && (
              <Switch label="Box and axes" checked={view.showFrame}
                onChange={(v) => setView({ showFrame: v })} />
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
            {view.showMigrations && <span><i className="mark-line" />Migration</span>}
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
      {shownError !== null && (
        <div className="overlay">
          <div className="overlay-card overlay-error">{shownError}</div>
        </div>
      )}
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

function Switch({ label, hint, checked, onChange }: {
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

function Slider({ label, min, max, step, value, onChange }: {
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

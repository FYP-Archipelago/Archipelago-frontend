/**
 * The search, in 3D. Picture first: the scene fills the page, the counts are
 * one line, every option sits behind a single View button, and the legend is
 * also the island filter -- click to hide, double-click to isolate, as in the
 * old Plotly view.
 *
 * Click a node to see it in full; hover for a quick read. The keyboard reaches
 * everything the mouse does, and `?` lists how.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { NodePanel } from "../components/NodePanel.js";
import {
  CameraIcon, InfoIcon, KeyboardIcon, ResetIcon, SlidersIcon, StarIcon,
} from "../components/icons.js";
import type { Lineage, NodeDetail } from "../data/stn/inspect.js";
import type { StnQueries, StnState } from "../data/useStn.js";
import type { LayoutKind } from "../data/worker/data.worker.js";
import { StnScene, type Focus, type SceneApi } from "../render/StnScene.js";
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
  colourBy: "island" | "fitness";
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
  colourBy: "island",
};

const SHORTCUTS: Array<[string, string]> = [
  ["Click", "Select a location"],
  ["↑ / ↓", "Go to where it came from / what it led to"],
  ["L", "Trace the selected location's lineage"],
  ["C", "Centre the view on the selection"],
  ["B", "Select the best location in the run"],
  ["Esc", "Clear the selection, or close a panel"],
  ["R", "Reset the camera (or double-click the view)"],
  ["V", "View options"],
  ["F", "Colour by fitness or by island"],
  ["M", "Show or hide migrations"],
  ["1 – 9", "Show or hide an island"],
  ["S", "Save the view as an image"],
  ["?", "This list"],
];

export function ArchipelagoPage({
  runId, stn, theme, view, setView, hiddenIslands, setHiddenIslands,
}: {
  runId: string | null;
  stn: StnState & StnQueries;
  theme: ThemeName;
  view: ViewState;
  setView: (patch: Partial<ViewState>) => void;
  hiddenIslands: ReadonlySet<number>;
  setHiddenIslands: (next: ReadonlySet<number>) => void;
}) {
  const { payload, layout, phase, error, inspect, traceLineage } = stn;
  const [resetCount, setResetCount] = useState(0);
  const [viewOpen, setViewOpen] = useState(false);
  const [keysOpen, setKeysOpen] = useState(false);
  const [graphicsError, setGraphicsError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const sceneApi = useRef<SceneApi | null>(null);

  // ---- selection --------------------------------------------------------------
  const [selected, setSelected] = useState<number | null>(null);
  const [detail, setDetail] = useState<NodeDetail | null>(null);
  const [lineageOn, setLineageOn] = useState(false);
  const [lineage, setLineage] = useState<Lineage | null>(null);
  const [hover, setHover] = useState<{ index: number; x: number; y: number } | null>(null);

  // A new run has different nodes; nothing selected carries over.
  useEffect(() => {
    setSelected(null);
    setHover(null);
  }, [payload]);

  // A lineage belongs to a selection; closing one ends the other.
  useEffect(() => { if (selected === null) setLineageOn(false); }, [selected]);

  useEffect(() => {
    if (selected === null) {
      setDetail(null);
      return;
    }
    let live = true;
    setDetail((current) => (current?.index === selected ? current : null));
    inspect(selected).then((d) => { if (live) setDetail(d); }).catch(() => {});
    return () => { live = false; };
  }, [selected, inspect]);

  useEffect(() => {
    if (selected === null || !lineageOn) {
      setLineage(null);
      return;
    }
    let live = true;
    setLineage(null);
    traceLineage(selected).then((l) => { if (live) setLineage(l); }).catch(() => {});
    return () => { live = false; };
  }, [selected, lineageOn, traceLineage]);

  const focus = useMemo<Focus>(() => {
    const current = detail !== null && detail.index === selected ? detail : null;
    return {
      selected,
      parents: current?.parents ?? [],
      children: current?.children ?? [],
      lineage,
    };
  }, [selected, detail, lineage]);

  const bestIndex = useMemo(() => {
    if (payload === null) return null;
    let best = -1;
    for (let i = 0; i < payload.nodeCount; i += 1) {
      const f = payload.fitness[i]!;
      if (best < 0 || (payload.maximising ? f > payload.fitness[best]! : f < payload.fitness[best]!)) best = i;
    }
    return best < 0 ? null : best;
  }, [payload]);

  const flash = useCallback((message: string) => {
    setToast(message);
    window.setTimeout(() => setToast((t) => (t === message ? null : t)), 1800);
  }, []);

  const saveImage = useCallback(() => {
    const url = sceneApi.current?.capture();
    if (url == null) return;
    const link = document.createElement("a");
    link.href = url;
    link.download = `${runId ?? "archipelago"}-${view.layoutKind}.png`;
    link.click();
    flash("Image saved");
  }, [runId, view.layoutKind, flash]);

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

  // ---- keyboard -------------------------------------------------------------
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, select, textarea") || event.ctrlKey || event.metaKey || event.altKey) return;
      if (payload === null) return;
      const key = event.key;
      const handled = () => event.preventDefault();

      if (key === "Escape") {
        if (keysOpen) setKeysOpen(false);
        else if (viewOpen) setViewOpen(false);
        else if (selected !== null) setSelected(null);
        return;
      }
      if (key === "?") { setKeysOpen((open) => !open); handled(); return; }
      if ((key === "ArrowUp" || key === "ArrowDown") && detail !== null && detail.index === selected) {
        const next = key === "ArrowUp" ? detail.parents[0] : detail.children[0];
        if (next !== undefined) setSelected(next.index);
        handled();
        return;
      }
      switch (key.toLowerCase()) {
        case "l": if (selected !== null) setLineageOn((on) => !on); break;
        case "c": if (selected !== null) sceneApi.current?.centreOn(selected); break;
        case "b": if (bestIndex !== null) setSelected(bestIndex); break;
        case "r": setResetCount((c) => c + 1); break;
        case "v": setViewOpen((open) => !open); break;
        case "f": setView({ colourBy: view.colourBy === "island" ? "fitness" : "island" }); break;
        case "m": setView({ showMigrations: !view.showMigrations }); break;
        case "s": saveImage(); break;
        default: {
          const digit = Number.parseInt(key, 10);
          const island = payload.islands[digit - 1];
          if (digit >= 1 && island !== undefined) toggleIsland(island);
          else return;
        }
      }
      handled();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [payload, selected, detail, keysOpen, viewOpen, bestIndex, view, setView, saveImage, toggleIsland]);

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
  const hovered = hover !== null && payload !== null && hover.index < payload.nodeCount ? hover : null;

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
          colourBy={view.colourBy}
          focus={focus}
          onPick={setSelected}
          onHover={setHover}
          apiRef={sceneApi}
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
          <button onClick={() => bestIndex !== null && setSelected(bestIndex)} title="Select the best location (B)">
            <StarIcon size={14} />
            Best
          </button>
          <button onClick={saveImage} title="Save the view as an image (S)">
            <CameraIcon size={14} />
            Save
          </button>
          <button onClick={() => setResetCount((c) => c + 1)} title="Reset the camera (R, or double-click the view)">
            <ResetIcon size={14} />
            Reset
          </button>
          <button
            aria-expanded={viewOpen}
            className={viewOpen ? "is-open" : ""}
            onClick={() => setViewOpen((open) => !open)}
            title="View options (V)"
          >
            <SlidersIcon size={14} />
            View
          </button>
          <button
            aria-expanded={keysOpen}
            className={keysOpen ? "is-open icon-only" : "icon-only"}
            onClick={() => setKeysOpen((open) => !open)}
            title="Keyboard shortcuts (?)"
            aria-label="Keyboard shortcuts"
          >
            <KeyboardIcon size={15} />
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
            <div className="row">
              <span>Colour by</span>
              <div className="seg seg-small" role="group" aria-label="Colour by">
                <button aria-pressed={view.colourBy === "island"} onClick={() => setView({ colourBy: "island" })}>
                  Island
                </button>
                <button aria-pressed={view.colourBy === "fitness"} onClick={() => setView({ colourBy: "fitness" })}>
                  Fitness
                </button>
              </div>
            </div>
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

      {keysOpen && (
        <div className="keys" role="dialog" aria-label="Keyboard shortcuts">
          <div className="keys-head">
            <h2>Keyboard</h2>
            <button className="close" onClick={() => setKeysOpen(false)} aria-label="Close">×</button>
          </div>
          <dl>
            {SHORTCUTS.map(([key, action]) => (
              <div key={key}><dt><kbd>{key}</kbd></dt><dd>{action}</dd></div>
            ))}
          </dl>
        </div>
      )}

      {selected !== null && payload !== null && (
        <NodePanel
          detail={detail !== null && detail.index === selected ? detail : null}
          lineage={lineage}
          lineageOn={lineageOn}
          islandHex={islandHex}
          maximising={payload.maximising}
          onSelect={setSelected}
          onToggleLineage={() => setLineageOn((on) => !on)}
          onCentre={() => sceneApi.current?.centreOn(selected)}
          onClose={() => setSelected(null)}
        />
      )}

      {payload !== null && (
        <div className="legend">
          <div className="legend-islands" role="group" aria-label="Islands">
            {payload.islands.map((island, k) => (
              <button
                key={island}
                aria-pressed={!hiddenIslands.has(island)}
                onClick={() => toggleIsland(island)}
                onDoubleClick={() => isolateIsland(island)}
                title={`Click to hide · double-click to show only this island${k < 9 ? ` · key ${k + 1}` : ""}`}
                style={{ ["--dot" as string]: islandHex[island % islandHex.length] }}
              >
                <i className="dot" />
                Island {island}
                <span className="count">{(islandCounts.get(island) ?? 0).toLocaleString()}</span>
              </button>
            ))}
          </div>
          <div className="legend-marks">
            {view.colourBy === "fitness" && (
              <span className="ramp-row">
                <span className="ramp-end">worst</span>
                <i className="ramp" />
                <span className="ramp-end">best</span>
              </span>
            )}
            <span><i className="mark-diamond" />Where each island finished</span>
            {view.showMigrations && <span><i className="mark-line" />Migration</span>}
          </div>
        </div>
      )}

      {hovered !== null && payload !== null && hovered.index !== selected && (
        <div className="tip" style={{ left: hovered.x, top: hovered.y }}>
          <span className="tip-island" style={{ ["--dot" as string]: islandHex[payload.islandId[hovered.index]! % islandHex.length] }}>
            <i className="dot" />Island {payload.islandId[hovered.index]}
          </span>
          <span className="num">{formatFitness(payload.fitness[hovered.index]!)}</span>
          <span className="muted">
            {payload.visits[hovered.index]} {payload.visits[hovered.index] === 1 ? "visit" : "visits"}
          </span>
        </div>
      )}

      {payload !== null && selected === null && (
        <div className="hint">
          {layout?.dims === 3
            ? "Click a node for details · drag to turn · scroll to zoom · ? for keys"
            : "Click a node for details · drag to pan · scroll to zoom · ? for keys"}
        </div>
      )}

      {toast !== null && <div className="toast" role="status">{toast}</div>}

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

function formatFitness(value: number): string {
  const magnitude = Math.abs(value);
  return magnitude >= 1000 || (magnitude > 0 && magnitude < 0.001) ? value.toExponential(3) : value.toFixed(4);
}

/** A floating panel that closes on Escape or a click outside it. */
function ViewPanel({ onClose, children }: { onClose: () => void; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (ref.current?.contains(target) || target?.closest(".actions") !== null) return;
      onClose();
    };
    window.addEventListener("pointerdown", onPointer);
    return () => window.removeEventListener("pointerdown", onPointer);
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

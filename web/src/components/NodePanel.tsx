/**
 * One node, in full: what it is, where it came from, where it led.
 *
 * Floats over the right of the scene rather than squeezing it, so opening the
 * panel never moves the node that was just clicked.
 */

import { useState } from "react";

import { NodeFlag } from "../contract/schema.js";
import type { Lineage, NeighbourRef, NodeDetail } from "../data/stn/inspect.js";

export function NodePanel({
  detail, lineage, lineageOn, islandHex, maximising,
  onSelect, onToggleLineage, onCentre, onClose,
}: {
  detail: NodeDetail | null;
  lineage: Lineage | null;
  lineageOn: boolean;
  islandHex: readonly string[];
  maximising: boolean;
  onSelect: (index: number) => void;
  onToggleLineage: () => void;
  onCentre: () => void;
  onClose: () => void;
}) {
  const colour = (island: number) => islandHex[island % islandHex.length]!;

  if (detail === null) {
    return (
      <aside className="node-panel" aria-label="Selected location">
        <div className="node-loading"><div className="spinner" /> Looking it up…</div>
      </aside>
    );
  }

  const topShare = (detail.rank / detail.of) * 100;
  // The traced set holds the node itself; the rest are its ancestors.
  const ancestors = lineage === null ? 0 : lineage.nodes.length - 1;
  const crossings = lineage === null ? 0 : lineage.crossings.length / 2;
  const badges: Array<[string, string]> = [];
  if (detail.isBestOverall) badges.push(["Best in the run", "badge-best"]);
  if ((detail.flags & NodeFlag.FinalBest) !== 0) badges.push(["Island finished here", "badge-final"]);
  if ((detail.flags & NodeFlag.Shared) !== 0) badges.push(["Reached by several islands", "badge-shared"]);

  return (
    <aside className="node-panel" aria-label="Selected location">
      <header className="node-head">
        <div className="node-title">
          <span className="node-eyebrow">Location</span>
          <span className="node-island" style={{ ["--dot" as string]: colour(detail.island) }}>
            <i className="dot" />Island {detail.island}
          </span>
        </div>
        <button className="close" onClick={onClose} aria-label="Close (Esc)" title="Close (Esc)">×</button>
      </header>

      {badges.length > 0 && (
        <div className="node-badges">
          {badges.map(([label, tone]) => <span key={label} className={`node-badge ${tone}`}>{label}</span>)}
        </div>
      )}

      <CopyKey value={detail.key} />

      <dl className="node-facts">
        <dt>Fitness</dt>
        <dd className="num">{format(detail.fitness)}</dd>
        <dt>Rank</dt>
        <dd>
          <span className="num">{detail.rank.toLocaleString()}</span> of {detail.of.toLocaleString()}
          <span className="muted"> · top {topShare < 0.1 ? "0.1" : topShare.toFixed(topShare < 10 ? 1 : 0)}%</span>
        </dd>
        <dt>Visits</dt>
        <dd className="num">{detail.visits}</dd>
        <dt>First reached</dt>
        <dd>
          evaluation <span className="num">{detail.firstEval.toLocaleString()}</span>
          <span className="muted"> · {detail.tRel.toFixed(2)} s in</span>
        </dd>
      </dl>

      <div className="node-actions">
        <button className={lineageOn ? "btn btn-on" : "btn"} onClick={onToggleLineage} title="L">
          {lineageOn ? "Hide lineage" : "Trace lineage"}
        </button>
        <button className="btn btn-quiet" onClick={onCentre} title="C">Centre view here</button>
      </div>

      {lineageOn && (
        <p className="lineage-note">
          {lineage === null ? "Tracing…" : ancestors === 0 ? "No ancestors: a lineage starts here." : (
            <>
              <b>{ancestors.toLocaleString()}</b> {ancestors === 1 ? "ancestor" : "ancestors"} across{" "}
              <b>{lineage.islands.length}</b> {lineage.islands.length === 1 ? "island" : "islands"},{" "}
              <b>{lineage.depth}</b> {lineage.depth === 1 ? "step" : "steps"} back to{" "}
              {lineage.origins === 1 ? "its start" : `${lineage.origins.toLocaleString()} starting points`}.{" "}
              {crossings > 0 && (
                <><b className="migration-tag">{crossings.toLocaleString()}</b> of its links arrived by migration.</>
              )}
              {lineage.truncated && " Cut off at 50,000 ancestors."}
            </>
          )}
        </p>
      )}

      <Neighbours
        title="Came from"
        empty="Nothing: this is where a lineage starts."
        items={detail.parents}
        total={detail.parentCount}
        colour={colour}
        onSelect={onSelect}
        maximising={maximising}
        reference={detail.fitness}
      />
      <Neighbours
        title="Led to"
        empty="Nothing: the search went no further from here."
        items={detail.children}
        total={detail.childCount}
        colour={colour}
        onSelect={onSelect}
        maximising={maximising}
        reference={detail.fitness}
      />

      {detail.twins.length > 0 && (
        <section className="node-section">
          <h3>Same location, other islands</h3>
          <div className="twins">
            {detail.twins.map((twin) => (
              <button
                key={twin.index}
                className="twin"
                style={{ ["--dot" as string]: colour(twin.island) }}
                onClick={() => onSelect(twin.index)}
              >
                <i className="dot" />Island {twin.island}
              </button>
            ))}
          </div>
        </section>
      )}

      <details className="node-section genome">
        <summary>Genome · {detail.genome.length} dimensions</summary>
        <GenomeStrip values={detail.genome} />
      </details>

      <p className="node-keys">↑ came from · ↓ led to · L lineage · Esc close</p>
    </aside>
  );
}

function Neighbours({ title, empty, items, total, colour, onSelect, maximising, reference }: {
  title: string;
  empty: string;
  items: readonly NeighbourRef[];
  total: number;
  colour: (island: number) => string;
  onSelect: (index: number) => void;
  maximising: boolean;
  reference: number;
}) {
  return (
    <section className="node-section">
      <h3>{title} <span className="muted">{total.toLocaleString()}</span></h3>
      {items.length === 0 ? (
        <p className="muted small">{empty}</p>
      ) : (
        <ul className="neighbours">
          {items.map((item) => {
            // Positive when this neighbour is better than the selected node.
            const gain = maximising ? item.fitness - reference : reference - item.fitness;
            return (
              <li key={`${item.via}-${item.index}`}>
                <button onClick={() => onSelect(item.index)} style={{ ["--dot" as string]: colour(item.island) }}>
                  <i className="dot" />
                  <span className="n-island">Island {item.island}</span>
                  <span className="n-how">
                    {item.via === "migration"
                      ? <span className="migration-tag">migration{item.weight > 1 ? ` ×${item.weight}` : ""}</span>
                      : <>{item.operator ?? "step"}{item.weight > 1 ? ` ×${item.weight}` : ""}</>}
                  </span>
                  <span className={gain > 0 ? "n-fit better" : "n-fit"}>{format(item.fitness)}</span>
                </button>
              </li>
            );
          })}
          {total > items.length && (
            <li className="more">and {(total - items.length).toLocaleString()} more</li>
          )}
        </ul>
      )}
    </section>
  );
}

/** The node key, copyable: it is the clustering API's join key. */
function CopyKey({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard?.writeText(value)
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1400);
      })
      .catch(() => setCopied(false));
  };
  return (
    <div className="node-key">
      <code title={value}>{value}</code>
      <button className="btn btn-quiet btn-tiny" onClick={copy}>{copied ? "Copied" : "Copy"}</button>
    </div>
  );
}

/** One bar per genome dimension, centred on zero. */
function GenomeStrip({ values }: { values: readonly number[] }) {
  const reach = Math.max(...values.map((v) => Math.abs(v)), 1e-9);
  const width = 300;
  const row = 16;
  const mid = 118;
  const half = 92;
  return (
    <svg viewBox={`0 0 ${width} ${values.length * row + 4}`} className="genome-strip" role="img"
      aria-label="Genome values by dimension">
      <line x1={mid} x2={mid} y1={0} y2={values.length * row + 4} className="genome-axis" />
      {values.map((value, d) => {
        const length = (Math.abs(value) / reach) * half;
        const y = d * row + 3;
        return (
          <g key={d}>
            <text x={0} y={y + 10} className="genome-dim">x{d}</text>
            <rect x={value < 0 ? mid - length : mid} y={y} width={Math.max(length, 0.5)} height={row - 5} rx={2}
              className={value < 0 ? "genome-neg" : "genome-pos"} />
            <text x={width} y={y + 10} textAnchor="end" className="genome-value">{value.toFixed(3)}</text>
          </g>
        );
      })}
    </svg>
  );
}

function format(value: number): string {
  if (!Number.isFinite(value)) return "—";
  const magnitude = Math.abs(value);
  return magnitude >= 1000 || (magnitude > 0 && magnitude < 0.001) ? value.toExponential(3) : value.toFixed(4);
}

/**
 * Every individual that crossed between islands: where it went, how long it
 * took, and whether it arrived at all. The port of the Streamlit migration
 * explorer.
 */

import * as Plot from "@observablehq/plot";
import { useMemo } from "react";

import { Chart } from "../components/Chart.js";
import { Card, Empty, Loading, PageHeader, Stats, Table, fmt } from "../components/ui.js";
import { median, type RunFacts, type Transfer } from "../data/runEvents.js";
import { cssVar } from "../theme/cssVar.js";
import type { ThemeName } from "../theme/palette.js";

export function MigrationPage({ facts, theme }: { facts: RunFacts | null; theme: ThemeName }) {
  const transfers = facts?.transfers ?? [];

  const summary = useMemo(() => {
    const delivered = transfers.filter((t) => t.delivered).length;
    const moved = transfers.reduce((sum, t) => sum + t.migrants, 0);
    const latency = median(transfers.flatMap((t) => (t.latencySeconds === null ? [] : [t.latencySeconds])));
    const drift = median(transfers.flatMap((t) => (t.drift === null ? [] : [t.drift])));
    return { delivered, moved, latency, drift };
  }, [transfers]);

  /** Source × destination totals, including the zero cells, so the grid is whole. */
  const matrix = useMemo(() => {
    const islands = [...new Set(transfers.flatMap((t) => [t.sourceIsland, t.destIsland]))].sort((a, b) => a - b);
    const totals = new Map<string, number>();
    for (const t of transfers) {
      const key = `${t.sourceIsland}>${t.destIsland}`;
      totals.set(key, (totals.get(key) ?? 0) + t.migrants);
    }
    const cells = islands.flatMap((s) => islands.map((d) => ({
      source: `Island ${s}`, dest: `Island ${d}`, migrants: totals.get(`${s}>${d}`) ?? 0,
    })));
    return { islands, cells };
  }, [transfers]);

  if (facts === null) return <div className="page"><Loading label="Reading the event log…" /></div>;

  const undelivered = transfers.length - summary.delivered;

  return (
    <div className="page">
      <PageHeader eyebrow="The search" title="Migration">
        Every individual that crossed between islands: where it went, how long it took, and whether
        it arrived at all.
      </PageHeader>

      {transfers.length === 0 ? (
        <Empty>This run has no migration events.</Empty>
      ) : (
        <>
          <Stats items={[
            { label: "Migration events", value: transfers.length.toLocaleString() },
            { label: "Individuals moved", value: summary.moved.toLocaleString() },
            {
              label: "Delivered",
              value: summary.delivered.toLocaleString(),
              note: undelivered > 0 ? `${undelivered.toLocaleString()} never arrived` : "every send arrived",
              tone: undelivered > 0 ? "warn" : undefined,
            },
            {
              label: "Median latency",
              value: summary.latency === null ? "—" : `${(summary.latency * 1000).toFixed(1)} ms`,
            },
            {
              label: "Median drift",
              value: summary.drift === null ? "—" : `${summary.drift.toFixed(0)} gen`,
              note: "receiver's lead over sender",
            },
          ]} />

          <div className="grid-2">
            <Card
              title="Who sent to whom"
              note="A ring topology fills only the off-diagonal band; a fully connected one fills every cell. The shape of this grid is the topology, recovered from the log."
            >
              <Chart
                label="Migrant counts by source and destination island"
                height={330}
                deps={[matrix, theme]}
                render={(width) => {
                  const size = Math.min(width, 440);
                  return Plot.plot({
                    width: size,
                    height: size * 0.82,
                    marginLeft: 72,
                    marginBottom: 44,
                    style: { background: "transparent", fontSize: "11.5px" },
                    x: { label: "destination", tickSize: 0 },
                    y: { label: "source", tickSize: 0 },
                    color: {
                      type: "linear",
                      range: [cssVar("--surface-sunken"), cssVar("--migration")],
                      legend: false,
                    },
                    marks: [
                      Plot.cell(matrix.cells, { x: "dest", y: "source", fill: "migrants", inset: 1.5, rx: 3 }),
                      Plot.text(matrix.cells, {
                        x: "dest", y: "source",
                        text: (d: { migrants: number }) => (d.migrants === 0 ? "" : d.migrants),
                        fill: cssVar("--ink"),
                        fontSize: 11,
                      }),
                    ],
                  });
                }}
              />
            </Card>

            <Card
              title="When each transfer happened"
              note="Clusters and gaps follow the migration interval, and the fact that islands reach their migration points at different moments."
            >
              <Chart
                label="Migration events over time by source island"
                height={330}
                deps={[transfers, theme]}
                render={(width) => Plot.plot({
                  width,
                  height: 330,
                  marginLeft: 72,
                  marginBottom: 44,
                  style: { background: "transparent", fontSize: "11.5px" },
                  x: { label: "seconds since first send", grid: true },
                  y: { label: "source", tickFormat: (d: number) => `Island ${d}` , type: "point"},
                  color: {
                    domain: ["delivered", "never arrived"],
                    range: [cssVar("--migration"), cssVar("--ink-faint")],
                    legend: true,
                  },
                  marks: [
                    Plot.dot(transfers, {
                      x: "tRel",
                      y: "sourceIsland",
                      r: (t: Transfer) => 2 + t.migrants,
                      fill: (t: Transfer) => (t.delivered ? "delivered" : "never arrived"),
                      fillOpacity: 0.75,
                      tip: true,
                      title: (t: Transfer) =>
                        `${t.migrationId}\nisland ${t.sourceIsland} → ${t.destIsland}\n${t.migrants} migrants`
                        + (t.latencySeconds === null ? "\nnever arrived" : `\n${(t.latencySeconds * 1000).toFixed(1)} ms`),
                    }),
                  ],
                })}
              />
            </Card>
          </div>

          <Card title="Transfer records" wide>
            <Table
              rows={transfers}
              rowKey={(t) => t.migrationId}
              maxHeight={360}
              columns={[
                { label: "Migration", value: (t) => <code>{t.migrationId}</code> },
                { label: "From", value: (t) => t.sourceIsland, numeric: true },
                { label: "To", value: (t) => t.destIsland, numeric: true },
                { label: "Sent at gen", value: (t) => t.sourceGeneration ?? "—", numeric: true },
                { label: "Arrived at gen", value: (t) => t.destGeneration ?? "—", numeric: true },
                { label: "Migrants", value: (t) => t.migrants, numeric: true },
                {
                  label: "Latency",
                  value: (t) => (t.latencySeconds === null ? "—" : `${fmt(t.latencySeconds * 1000, 1)} ms`),
                  numeric: true,
                },
                { label: "Drift", value: (t) => t.drift ?? "—", numeric: true },
                {
                  label: "Outcome",
                  value: (t) => (t.delivered
                    ? <span className="tag tag-ok">accepted</span>
                    : <span className="tag tag-warn">{t.accepted === false ? "rejected" : "never arrived"}</span>),
                },
                { label: "Policy", value: (t) => `${t.selection ?? "?"} → ${t.replacement ?? "?"}` },
              ]}
            />
          </Card>
        </>
      )}
    </div>
  );
}

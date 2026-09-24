/**
 * What ran, on what, and how it ended -- read from run_start, run_end and
 * island_end. The port of the Streamlit run browser.
 */

import { Card, Empty, Loading, PageHeader, Stats, Table, fmt } from "../components/ui.js";
import type { RunFacts } from "../data/runEvents.js";

const num = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

export function RunPage({ facts, evaluations }: { facts: RunFacts | null; evaluations: number | null }) {
  if (facts === null) return <div className="page"><Loading label="Reading the event log…" /></div>;

  const end: Record<string, unknown> = facts.runEnd ?? {};
  const best = num(end["global_best_fitness"]);
  const bestIsland = end["global_best_island"];
  const config = facts.runStart?.["config"];

  return (
    <div className="page">
      <PageHeader eyebrow="The run" title="Run">
        Provenance and outcome for the selected run, taken from the first and last records in its
        event stream.
      </PageHeader>

      {facts.runStart === null && facts.runEnd === null ? (
        <Empty>This run's log has no <code>run_start</code> or <code>run_end</code> record.</Empty>
      ) : (
        <>
          <Stats items={[
            {
              label: "Evaluations",
              value: (num(end["total_evaluations"]) ?? evaluations ?? 0).toLocaleString(),
            },
            { label: "Islands", value: String(end["islands_completed"] ?? facts.outcomes.length) },
            { label: "Migration events", value: (num(end["total_migration_events"]) ?? 0).toLocaleString() },
            {
              label: "Global best",
              value: fmt(best),
              note: bestIsland !== undefined && bestIsland !== null ? `found on island ${String(bestIsland)}` : undefined,
            },
            { label: "Wall clock", value: `${(num(end["wallclock_seconds"]) ?? 0).toFixed(2)} s` },
          ]} />

          <p className="page-note">
            Ended with <code>{String(end["termination_reason"] ?? "unknown")}</code>. Fitness is being{" "}
            <b>{facts.maximising ? "maximised" : "minimised"}</b>, so {facts.maximising ? "higher" : "lower"} is
            better throughout this app.
          </p>

            <Card
              title="How each island finished"
              wide
              note="The termination reason read beside how long an island had been stagnant tells convergence apart from simply running out of budget -- a distinction a fitness curve hides."
            >
              {facts.outcomes.length === 0 ? (
                <Empty>No <code>island_end</code> records in this run.</Empty>
              ) : (
                <Table
                  rows={facts.outcomes}
                  rowKey={(o) => String(o.island)}
                  columns={[
                    { label: "Island", value: (o) => o.island, numeric: true },
                    { label: "Stopped because", value: (o) => <code>{o.reason}</code> },
                    { label: "Generations", value: (o) => o.generations ?? "—", numeric: true },
                    { label: "Evaluations", value: (o) => o.evaluations?.toLocaleString() ?? "—", numeric: true },
                    {
                      label: "Best fitness",
                      value: (o) => (
                        <span className={o.island === bestIsland ? "best" : undefined}>{fmt(o.best)}</span>
                      ),
                      numeric: true,
                    },
                    { label: "Stagnant for", value: (o) => o.stagnant ?? "—", numeric: true },
                    { label: "Sent", value: (o) => o.sent, numeric: true },
                    { label: "Received", value: (o) => o.received, numeric: true },
                    { label: "Seconds", value: (o) => fmt(o.seconds, 2), numeric: true },
                  ]}
                />
              )}
            </Card>

          <div className="grid-2">
            <Card title="Provenance">
              <Table
                rows={facts.provenance}
                rowKey={([field]) => field}
                columns={[
                  { label: "Field", value: ([field]) => <span className="muted">{field}</span> },
                  { label: "Value", value: ([, value]) => value },
                ]}
              />
            </Card>

            <Card title="Resolved configuration">
              {config !== undefined && config !== null
                ? <pre className="code code-tall">{JSON.stringify(config, null, 2)}</pre>
                : <Empty>This run's <code>run_start</code> carries no configuration.</Empty>}
            </Card>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * Per-island progress on run-relative wall time.
 *
 * Islands are asynchronous, so plotting against generation number would imply
 * a simultaneity the run never had. Every chart here uses wall time instead;
 * the third chart makes that asynchrony itself visible.
 */

import * as Plot from "@observablehq/plot";
import { useMemo } from "react";

import { Chart } from "../components/Chart.js";
import { Card, Empty, Loading, PageHeader, Stats } from "../components/ui.js";
import type { Generation, RunFacts } from "../data/runEvents.js";
import { cssVar } from "../theme/cssVar.js";
import { ISLAND_CSS, type ThemeName } from "../theme/palette.js";

type Field = "bestSoFar" | "diversity" | "generation";

export function ConvergencePage({ facts, theme }: { facts: RunFacts | null; theme: ThemeName }) {
  const generations = facts?.generations ?? [];

  const islands = useMemo(
    () => [...new Set(generations.map((g) => g.island))].sort((a, b) => a - b),
    [generations],
  );

  const spread = useMemo(() => {
    const reached = new Map<number, number>();
    const finished = new Map<number, number>();
    for (const g of generations) {
      reached.set(g.island, Math.max(reached.get(g.island) ?? 0, g.generation));
      finished.set(g.island, Math.max(finished.get(g.island) ?? 0, g.tRel));
    }
    const r = [...reached.values()];
    const f = [...finished.values()];
    return {
      low: r.length ? Math.min(...r) : 0,
      high: r.length ? Math.max(...r) : 0,
      finish: f.length ? Math.max(...f) - Math.min(...f) : 0,
    };
  }, [generations]);

  if (facts === null) return <div className="page"><Loading label="Reading the event log…" /></div>;

  const colour = {
    domain: islands.map((i) => `Island ${i}`),
    range: islands.map((i) => ISLAND_CSS[theme][i % ISLAND_CSS[theme].length]!),
    legend: true,
  };

  const lines = (field: Field, yLabel: string, width: number, height: number) => Plot.plot({
    width,
    height,
    marginLeft: 56,
    marginBottom: 44,
    style: { background: "transparent", fontSize: "11.5px" },
    x: { label: "seconds since run start", grid: true },
    y: { label: yLabel, grid: true },
    color: colour,
    marks: [
      Plot.line(generations.filter((g) => g[field] !== null), {
        x: "tRel",
        y: field,
        z: "island",
        stroke: (g: Generation) => `Island ${g.island}`,
        strokeWidth: 1.8,
        curve: field === "bestSoFar" ? "step-after" : "linear",
      }),
      Plot.ruleY([0], { stroke: cssVar("--rule") }),
      Plot.tip(generations, Plot.pointerX({
        x: "tRel",
        y: field,
        title: (g: Generation) => `Island ${g.island} · generation ${g.generation}\n${yLabel}: ${Number(g[field]).toPrecision(5)}`,
      })),
    ],
  });

  return (
    <div className="page">
      <PageHeader eyebrow="The run" title="Convergence">
        Per-island progress on wall-clock time. Islands are asynchronous, so a generation axis would
        quietly misreport what happened at the same moment.
      </PageHeader>

      {generations.length === 0 ? (
        <Empty>This run has no <code>generation_end</code> records.</Empty>
      ) : (
        <>
          <Stats items={[
            { label: "Islands", value: String(islands.length) },
            { label: "Generations reached", value: `${spread.low} – ${spread.high}`, note: "slowest to fastest island" },
            { label: "Finish spread", value: `${spread.finish.toFixed(2)} s`, note: "first to last island to stop" },
            {
              label: "Objective",
              value: facts.maximising ? "Maximise" : "Minimise",
              note: facts.maximising ? "higher fitness is better" : "lower fitness is better",
            },
          ]} />

          <div className="grid-2">
            <Card
              title="Best so far, per island"
              note="A flat line is an island that stopped improving. Read it beside the termination reason on the Run page to tell convergence from an exhausted budget."
            >
              <Chart label="Best-so-far fitness per island over time" height={320}
                deps={[generations, theme]} render={(w) => lines("bestSoFar", "fitness", w, 320)} />
            </Card>
            <Card
              title="Population diversity"
              note={facts.diversityMetric !== null
                ? <>Measured as <code>{facts.diversityMetric}</code>. The metric depends on the representation, so the log names it alongside the value.</>
                : "The log does not name the diversity metric for this run."}
            >
              <Chart label="Population diversity per island over time" height={320}
                deps={[generations, theme]} render={(w) => lines("diversity", "diversity", w, 320)} />
            </Card>
          </div>

          <Card
            title="Generation reached, against wall time"
            note="Lines that fan apart are islands running at different speeds. This is why nothing on this page is plotted against generation number."
            wide
          >
            <Chart label="Generation reached per island over time" height={280}
              deps={[generations, theme]} render={(w) => lines("generation", "generation", w, 280)} />
          </Card>
        </>
      )}
    </div>
  );
}

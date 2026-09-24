/**
 * What this tool is for, and what it deliberately does not do. Prose carried
 * over from the Streamlit overview page, changed only where the new app
 * behaves differently.
 */

import { PageHeader } from "../components/ui.js";

const STAGES = [
  { name: "Execution", detail: "islands evolve in parallel and swap individuals", state: "produced elsewhere" },
  { name: "Logs", detail: "every evaluation and migration, one schema", state: "produced elsewhere" },
  { name: "Clustering", detail: "LSH → BIRCH → DenStream compress the stream", state: "produced elsewhere" },
  { name: "Network", detail: "trajectories become a graph, with migration edges", state: "" },
  { name: "Analytics", detail: "MMD compares what each island explored", state: "not yet built" },
];

export function AboutPage() {
  return (
    <div className="page page-prose">
      <PageHeader eyebrow="Archipelago" title="Explaining what a distributed EA actually did">
        A distributed evolutionary algorithm runs several populations at once and lets them trade
        individuals. Standard tools flatten all of that into a single fitness curve. This one keeps
        the islands apart and draws where each of them actually searched.
      </PageHeader>

      <ol className="pipeline" aria-label="Where Archipelago sits in the pipeline">
        {STAGES.map((stage) => (
          <li key={stage.name} className={stage.state === "" ? "here" : undefined}>
            <span className="pipeline-name">{stage.name}</span>
            <span className="pipeline-detail">{stage.detail}</span>
            {stage.state !== "" && <span className="pipeline-state">{stage.state}</span>}
          </li>
        ))}
      </ol>
      <p className="page-note">
        Archipelago occupies the middle of that strip. It does not run searches — the harness does
        that locally and <b>Volpe</b> does it on the cluster — and it does not need the clustering
        stage to draw anything: the default view is one node per location actually visited.
      </p>

      <div className="prose-grid">
        <section>
          <h2>The vocabulary</h2>
          <dl className="vocab">
            <dt>Island</dt>
            <dd>
              One independent subpopulation running its own copy of the algorithm. Islands are
              asynchronous: island 2 being on generation 9 says nothing about where island 3 is at the
              same moment.
            </dd>
            <dt>Migration</dt>
            <dd>
              Individuals periodically copied from one island to another, along a topology — a ring,
              or fully connected. This is what makes a distributed EA more than several separate runs.
            </dd>
            <dt>STN node</dt>
            <dd>
              One location in the search space. Two evaluations that land in the same place become
              the same node, which is what turns a list of evaluations into a graph.
            </dd>
            <dt>Migration edge</dt>
            <dd>
              A cross-island edge, drawn in <span className="magenta">magenta</span> throughout this
              app. It is the one visual element the whole platform exists for.
            </dd>
          </dl>
        </section>

        <section>
          <h2>Why a fitness curve isn't enough</h2>
          <p>
            A convergence plot tells you the best score improved. It cannot tell you <i>why</i>, and
            in a distributed run the interesting answers are all structural:
          </p>
          <ul>
            <li>Were the islands exploring different regions, or all grinding over the same one?</li>
            <li>Did a migration actually move the receiving island somewhere new?</li>
            <li>Which island found the best solution, and did that discovery spread?</li>
            <li>Did an island stall, and how long before anyone could tell?</li>
          </ul>
          <p>
            Each of those is a question about <i>shape</i>, which is why this is a graph tool and not
            a chart tool.
          </p>
        </section>

        <section>
          <h2>Where this sits</h2>
          <p>
            Archipelago is the <b>analysis</b> layer, and only that. It does not schedule jobs, hold
            cluster credentials or own a worker pool, because it never executes a search:{" "}
            <b>Volpe</b> already runs jobs, and the baseline harness runs them locally.
          </p>
          <p>
            What it consumes is a finished run in the schema 2.0 layout. That is the entire
            interface, which is what makes a run from a laptop and a run from Volpe the same object
            here. Bring one in on the <a href="#/library">Runs</a> page by picking its folder.
          </p>
        </section>

        <section>
          <h2>A note on the vertical axis</h2>
          <p>
            Search spaces usually have many more than three dimensions. Squeezing one into three
            typically keeps well under half of the variance, which is why a naive 3D scatter of a
            continuous run tends to look like a shapeless blob.
          </p>
          <p>
            So the Archipelago view spends only two axes on position and gives the third to{" "}
            <b>fitness</b>. By default good regions are low, and you can watch each island descend
            into its own basin; <i>Best at top</i> turns that into a climb, as the clustering repo's
            fitness plot draws it. The view always reports how much variance its projection kept, so a
            poor projection is never mistaken for a poor result.
          </p>
        </section>
      </div>
    </div>
  );
}

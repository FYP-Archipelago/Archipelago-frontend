# archipelago-frontend

Explainability frontend for **Archipelago** — the visualization layer over
distributed evolutionary algorithm runs produced by
[`FYP-Archipelago/baseline-dEA`](https://github.com/FYP-Archipelago/baseline-dEA).

Team 21, Dept. of CSE, Amrita Vishwa Vidyapeetham. Guide: Dr. Ritwik M.

> **Status: v0.2 — Level 0.** This build draws the trajectory network with **no
> clustering applied**. The LSH → BIRCH → DenStream cascade and the MMD analytics
> are separate work; the *seam* they plug into exists and is documented in
> [docs/EXTENDING.md](docs/EXTENDING.md), but no reducer is implemented.

---

## What it does

A distributed EA runs several populations in parallel and lets them trade
individuals. Standard tooling flattens that into one fitness curve. This reads
the run's log and draws what each island actually did.

| Page | Reads | Shows |
|---|---|---|
| **Archipelago** | `evaluations.csv` | The Level 0 trajectory network in 3D |
| **Migration** | `migration_send` ⋈ `migration_arrive` | Every transfer: route, latency, drift, delivery |
| **Convergence** | `generation_end` | Per-island progress and diversity on wall-clock time |
| **Run browser** | `run_start`, `island_end`, `run_end` | Provenance, budget, how and why each island stopped |
| **Runs** | the library | Add a run, see what is loaded, remove one |
| **Overview** | — | What a dEA is, what an STN is, why a fitness curve isn't enough |

## Where this sits

Archipelago is the **analysis** layer and only that. It does not schedule jobs,
hold cluster credentials, or own a worker pool, because it never executes a
search — **Volpe** already runs jobs, and the baseline harness runs them locally.
Duplicating that would be work with no result attached.

What it consumes is a finished run in the schema 2.0 layout. That is the entire
interface, which is what makes a run from a laptop and a run from Volpe the same
object here, and why connecting the two later is a matter of pointing at a
directory rather than a rewrite.

Bring a run in on the **Runs** page: upload a zip, drop in the loose files, or
point at a path this machine can already see.

## Two design decisions worth knowing

**The vertical axis carries fitness, not a third component.** A 10-dimensional
search space projected into 3D typically keeps under half its variance, which
is why a naive 3D scatter of a continuous run is a shapeless blob. Spending two
axes on position and the third on fitness loses little — that component is
mostly noise — and turns the picture into a landscape where good regions are low
and convergence reads as descent. Every 3D view reports the variance its
projection actually kept, so a poor projection is never mistaken for a poor
result. Both this and the per-island territory layout are toggles, not
assumptions.

**Every timeline is wall-clock, never generation number.** Islands are
asynchronous by design: equal generation numbers on two islands do not mean the
same moment. Indexing a timeline by generation would quietly misreport what was
simultaneous, so charts use clock-corrected `t_wall` throughout.

## Running it

```bash
pip install -r requirements.txt
streamlit run app.py
```

Two sample runs ship in `data/`, so it works with no setup. Both are real output
from the baseline harness — DE on Rastrigin, one with ring migration every 3
generations and one fully-connected migrating every generation.

To use your own run, add it on the **Runs** page, or drop its directory into
`data/`:

```
data/<run id>/
├── evaluations.csv          one row per evaluated individual
├── evaluations.schema.json  the CSV's column contract
├── run.jsonl                every other event
├── resolved_config.yaml     the configuration actually used
└── summary.json             machine-readable outcome
```

Generate one from the harness with:

```bash
python -m orchestrator.cli run --config config/smoke_local.yaml
```

## Layout

```
app.py                       entry point and navigation
archipelago_ui/
├── logreader.py             the read side of the schema 2.0 contract
├── stn.py                   Level 0 network: nodes, edges, migration edges
├── levels.py                the seam the clustering cascade plugs into
├── ingest.py                validating and installing an uploaded run
├── layout.py                projection, fitness elevation, island territories
├── theme.py                 palette and Plotly template
├── data.py                  cached accessors, the run selector
└── pages/                   one module per page
data/                        sample runs
docs/EXTENDING.md            how to add a clustering level
docs/version-history/        screenshots, one folder per tagged version
scripts/capture_screenshots.py
```

## Coupling

This repo imports nothing from the dEA harness and nothing from the clustering
pipeline. The **schema 2.0 log format is the only coupling point**, which is the
same rule `archipelago_logging` follows on the producing side. `logreader.py`
reimplements the genome decoding rather than importing it, so a run can be read
without the harness installed — the packing is part of the published contract.

## Screenshots

Each tagged version keeps a folder under `docs/version-history/`. To refresh them, with
the app already running:

```bash
pip install playwright && python -m playwright install chromium
python scripts/capture_screenshots.py --version v0.2
```

## Ready for the clustering cascade

`levels.py` defines the whole contract a level has to satisfy:

```python
(STN, Run, params) -> Reduction
```

Because the input and output are both an `STN`, every view — the 3D archipelago,
the metrics, the migration overlay — works on a reduced network with no change.
`levels.collapse()` does the mechanical part (regrouping nodes, rewriting edge
endpoints, dropping self-loops, conserving visit counts), so a reducer only has
to produce cluster labels.

Levels 1–3 are registered as placeholders: they appear in the sidebar picker
greyed as *not built yet*, and selecting one falls back to Level 0 with a notice.
Registering a `build` function over the same key replaces the placeholder and
lights up the compression figure and diagnostics table already wired into the
page. Full walkthrough in [docs/EXTENDING.md](docs/EXTENDING.md).

## Not built yet

- The clustering cascade itself (LSH → BIRCH → DenStream)
- MMD divergence between islands
- Replay / time scrubbing with DenStream decay
- Node telemetry — `device_metrics` was removed in schema 2.0, so this needs a
  separate sidecar stream before it can show real data

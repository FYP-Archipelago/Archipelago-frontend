# Changelog

One entry per tagged frontend version: what shipped, what it demonstrates, and
what building it revealed. Screenshots for each live in `docs/version-history/<version>/`.

## v0.4 — Honest edges

**Shipped.** The 3D view now draws what it says it draws. Island territories
default off, every trajectory edge is drawn rather than a biased tenth of them,
and the migration layer owns every line that crosses between islands.

**What it demonstrates.** That the log is internally consistent enough to check
itself. Cross-island edges can be derived two independent ways — by walking
`parent_ids` and by joining `migration_arrive` events — and on both sample runs
the two derivations produce *exactly* the same set of node pairs (387 of 387 on
the fully-connected run, 21 of 21 on the ring). Two paths through the schema,
one answer.

**What building it revealed.**

- `nlargest(limit, "weight")` reads like "keep the important edges" and was the
  opposite. About 90% of Level 0 trajectory edges have weight exactly 1, and the
  few that repeat all sit in the converged core, so the old default drew 1,000
  of 11,197 edges and reached only **26% of nodes**. Three quarters of the graph
  looked like isolated dots — a drawing limit that read as missing data. A
  seeded uniform sample now reaches 100%.
- Migration edges were counted in the legend and never rendered. A migration
  copies an individual, so both endpoints hold the same genome and project to
  the same point — only the island differs. With territories off, 518 of 598 had
  exactly zero length. That is geometry, not data, so the view now says so
  instead of looking empty.
- 387 edges (3.5%) in the "trajectory" layer were crossing between islands, every
  one of them an arrival. Switching migration off therefore left the islands
  visibly wired together. Crossings are now classified by comparing the
  endpoints' `island_id` — not by the operator string, which is
  algorithm-specific (`de_trial` here, `pso_update` elsewhere) — so the two
  toggles finally control disjoint sets of lines.
- Duplicate transfers along the same route were drawing the identical line
  repeatedly: 598 events collapse to 387 distinct routes, and the event count is
  kept as weight rather than as overdraw.

**Cross-checked against the pipeline.** `dEA-clustering` was run directly over
the same log (Level 0: 3,034 nodes; full cascade: 360, an 88.1% reduction). It
keys nodes by `genome_hash` alone where the frontend keys by
`(island, genome_hash)`, and the consequence is visible in its own output:
**100% of its migration edges are self-loops.** Under hash-only keying a
migration arrives at a node the individual already occupies, so the cross-island
edge cannot exist. Worth settling before the two halves diverge further.

## v0.3 — The cascade, connected

**Shipped.** The clustering cascade runs. `archipelago-api` is a new FastAPI
service that calls into `dEA-clustering` and hands back cluster labels; this app
turns them into a collapsed network.

The controls live on the **Runs** page, where a run is submitted: pick the run,
toggle which of LSH / BIRCH / DenStream execute, tune them if you want, and press
**Run clustering**. That button is the REST call, and it is the only thing in the
app that starts one.

Every execution is kept. Clustering a run with LSH only and then with all three
leaves both available, and the Archipelago page gained a **Clustering result**
picker to choose between them — because comparing two configurations is the point
of a toggleable pipeline, and you cannot compare what has been overwritten. The
`lsh` / `birch` / `denstream` placeholders are unregistered: which stages ran is
a property of a result, not of a level.

**What it demonstrates.** That the seam v0.2 designed was the right one. The
cascade arrived as an addition and not a rewrite: `app.py` gained one import,
`pages/archipelago.py` gained a call to `level.controls()`, and **no view
changed**. On the sample run the full cascade takes 3,294 nodes to 842 — 3.9×.

**Why the API returns labels, not the artifact.** `dEA-clustering` emits a
documented schema-1.0 artifact — `nodes.json`, `edges.json` and the rest. Handing
that to this app would have meant rewriting the 3D view to consume a second,
differently-shaped graph. But this app already builds its own Level 0 network
from the same log and already knows how to collapse it given one label per node.
So the API returns exactly that, keyed by this app's own node key
`"<island>:<genome_hash>"`. The smallest thing that connects the two systems is
labels; the artifact stays available behind `include_artifact`.

**Neither repository was modified.** `dEA-clustering` is imported through its
public entry points and nothing in it was touched. The service reads
`STAGE_ORDER` from the pipeline's own `Config.stage_flags()` rather than
restating it, so the two cannot drift apart.

**What building it revealed.**

- **A location can receive two cluster labels, and only under DenStream.** Rows
  sharing a `genome_hash` share a feature vector, so LSH and BIRCH necessarily
  agree on them. DenStream ages points, so a location revisited long after it was
  first seen can land in a newer micro-cluster. Running DenStream alone on the
  sample run produces 18 such locations. The majority label is used and the count
  is surfaced as a warning, rather than the choice being made silently.
- **The compression figure is not the raw cluster count.** A macro node never
  spans two islands, so the drawn node count is the number of distinct
  `(island, label)` pairs, not of labels. The API reports both.
- **`levels.controls` was documented but never called.** v0.2 defined per-level
  controls in the contract and the page never invoked them, so no level could
  have had a switch of its own. The stage toggles are the first user of it.
- **Configuring the pipeline belongs where the run is submitted, not where the
  result is viewed.** The first cut put the toggles behind the sidebar's
  abstraction-level picker, which meant nothing on the default screen suggested
  they existed. They moved to the Runs page, and `archipelago_ui/extensions.py`
  is the seam that let them go there without `pages/library.py` importing the API
  client — the same inward-registration rule `levels.py` already used.
- **Viewing must not be able to start work.** With toggles on the Archipelago
  page, moving one fired a clustering request: an identical configuration came
  back from cache, but a new one ran the pipeline. Looking at a graph should
  never do that. The viewing side now imports no HTTP client at all, so it is not
  a matter of care — it structurally cannot reach the service.
- **Streamlit discards widget state when you leave the page that drew it.** Two
  pages sharing one set of widget keys therefore do *not* share a selection:
  running LSH-only on Runs and then opening Archipelago silently redrew all three
  stages, because the toggles had reset to their defaults. The selection now
  lives in a plain session key that widgets read from and write back to.
- **A widget key cannot be assigned after its widget exists.** Switching the
  abstraction level for the user, so the result is on screen when they arrive,
  is a write to `abstraction_level` — and the sidebar picker is drawn before the
  page body. It works from a button's `on_click`, which runs before the rerun
  that creates the widgets.
- **The screenshot script was capturing the wrong thing for the default page.**
  Streamlit serves a default page at the root, so requesting its declared
  `url_path` raises a "Page not found" modal — which then landed *in* the
  screenshot. `v0.2/01-archipelago.png` has it. Fixed for v0.3 onward; the old
  folder is left as captured, since a version history that gets edited is not one.

## v0.2 — Runs in, cascade seam out

**Shipped.** A **Runs** page: bring a run in as a zip, as loose files, or by
pointing at a path this machine can already see, then see the library and remove
what you do not need. An **abstraction level** picker in the sidebar. A light
visual pass — depth on the ground, an accent hairline on each metric tile, an
active rail in the navigation.

**What it demonstrates.** That the platform boundary is real. Archipelago is the
analysis layer and does not execute searches: Volpe already runs jobs and the
harness runs them locally, so this app holds no scheduler, no worker pool and no
cluster credentials. A finished run in the schema 2.0 layout is the entire
interface, which is why a run from a laptop and a run from Volpe are the same
object here.

**The cascade seam.** `levels.py` fixes the contract at `(STN, Run, params) ->
Reduction`. Input and output are both an `STN`, so every view works on a reduced
network unchanged; `collapse()` handles regrouping, edge rewriting and self-loop
removal, so a reducer only produces labels. Levels 1–3 are registered as
placeholders — greyed in the picker, falling back to Level 0 with a notice — and
registering a `build` over the same key replaces one. No clustering is
implemented here, deliberately.

**What building it revealed.**

- A macro node must never span two islands. Grouping by cluster label alone
  would merge locations from different islands into one node, inventing a place
  no island visited and erasing the cross-island edge. `collapse()` keys groups
  by `(island_id, label)` so this cannot happen by accident.
- Zip entry names are always `/`-separated, but `pathlib.Path` on Windows renders
  them back with `\`. Building an archive prefix through `Path` therefore
  matched nothing and extracted zero files — for the *normal* case of zipping a
  run directory. `PurePosixPath` throughout the archive code fixed it.
- An uploaded archive is untrusted input. Entries are rejected if they are
  absolute or contain `..`, and only the five contract files are ever written,
  so what lands in `data/` is always exactly a run.

## v0.1 — Level 0

**Shipped.** Five pages: Overview, Run browser, Archipelago (3D trajectory
network), Migration explorer, Convergence & diversity. Dark theme, two real
sample runs committed, a Playwright screenshot capture script.

**What it demonstrates.** That the schema 2.0 log contract is sufficient on its
own to draw a genuine search trajectory network — nodes keyed by `genome_hash`,
edges read from `parent_ids`, migration edges joined on `migration_id`. No
clustering is involved, which makes this the Level 0 baseline the cascade will
later be measured against.

**What building it revealed.**

- Nodes have to be keyed by *(island, location)*, not location alone. Keyed by
  location, a migration moves an individual to a node it already occupies and
  every migration collapses into a self-loop — the cross-island edge, which is
  the entire point of the platform, disappears.
- Migration sparsity is a configuration property, not a rendering one. The ring
  configuration at `interval: 3` produces 22 migration events; fully-connected
  at `interval: 1` produces 324 on a comparable budget, and converges markedly
  better. Both runs ship so the difference is visible.
- Level 0 on a continuous problem is close to one node per evaluation —
  real-vector genomes almost never repeat a rounded location — so the graph is
  effectively the genealogy. Revisits, and therefore compression, are what the
  clustering cascade has to create.
- The projection keeps roughly a third of the variance on a 10-dimensional
  problem. That number is now reported on every 3D view rather than left
  implicit, and it is the reason the vertical axis carries fitness instead of a
  third principal component.

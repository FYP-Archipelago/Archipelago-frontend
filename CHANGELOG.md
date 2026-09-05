# Changelog

One entry per tagged frontend version: what shipped, what it demonstrates, and
what building it revealed. Screenshots for each live in `docs/version-history/<version>/`.

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

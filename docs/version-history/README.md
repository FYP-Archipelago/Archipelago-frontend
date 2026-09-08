# Version history

One folder per tagged frontend version, holding a full-page screenshot of every
page as that version actually shipped.

**Old versions are never re-captured.** Each folder is a record of what the app
looked like at that tag, not a rendering of today's code against an old label —
so the progression is real and the differences between folders are the actual
changes. `CHANGELOG.md` at the repo root says what changed and why; this says
what it looked like.

Captured 1680 wide, full page, on the `de / rastrigin · 5 islands`
fully-connected sample run.

From v0.3 the capture height follows the page. Streamlit scrolls an inner
element, not the document, so Playwright's `full_page` stopped at the 1050px
viewport and quietly cut everything below the fold — the v0.1 and v0.2 folders
are all clipped at that height for this reason. The script now measures the app's
own scroll container and grows the viewport to match before shooting.

---

## v0.4 — honest edges

Six pages. No new pages since v0.3 — this round is correctness in the 3D view.

| | Page | |
|---|---|---|
| 01 | Archipelago | [01-archipelago.png](v0.4/01-archipelago.png) |
| 02 | Migration | [02-migration.png](v0.4/02-migration.png) |
| 03 | Convergence | [03-convergence.png](v0.4/03-convergence.png) |
| 04 | Run browser | [04-run-browser.png](v0.4/04-run-browser.png) |
| 05 | Runs | [05-runs.png](v0.4/05-runs.png) |
| 06 | Overview | [06-overview.png](v0.4/06-overview.png) |

What changed, and it is all in **01-archipelago**:

- **Every trajectory edge is drawn.** v0.3 kept the 1,000 heaviest of 11,197,
  which reached only 26% of nodes and left most of the cloud looking like
  unconnected dots. That fix is the whole point of this version.
- **Trajectory edges are now within-island only** (10,810, down from 11,197).
  The 387 that crossed between islands were migrations filed in the wrong layer,
  so switching migration off used to leave the islands visibly wired together.
- **"Migration routes" replaces "Migration edges"** — 598 transfer events collapse
  to 387 distinct routes rather than drawing the same line repeatedly.
- **Island territories default off**, which is why the metric reports edges that
  cannot be drawn: a migration links two islands at the same genome, so its edge
  has zero length until the islands are pulled apart.

The clustered second states (`01b`, `05b`) are **absent for this version**: the
clustering service could not start, because `archipelago-api` imports
`archipelago_clustering` while `dEA-clustering` provides `clustering`. See the
v0.4 CHANGELOG entry.

## v0.3 — the cascade, connected

Seven shots for six pages: **01b** is the Archipelago page a second time, with
the clustering cascade applied, because the difference between it and **01** is
what this version *is*.


What to look at:

- **05-runs, lower half** — *Run the clustering pipeline*. Choose the run, toggle
  which of LSH / BIRCH / DenStream execute, tune them, and press the button. That
  button is the REST call; the pipeline runs in a separate service, named in the
  strip above the picker. This is where clustering is *asked for* — 01b is where
  the answer is looked at.
- **01 against 01b** — the same run, the same view, 3,294 nodes against 842.
  The tile reads *3.9x compression*, and the plot goes from a dense smear to
  islands with visible internal structure. Nothing about the view was rewritten
  to draw the second one: the reducer returns an `STN` and every view already
  took one.
- **01b, the stage row** — LSH, Birch and Denstream on individual toggles, with
  `Order: lsh → birch → denstream` beside them. Membership is the user's choice;
  the sequence is not, because each stage refines the partition the previous one
  produced.
- **01b, the sidebar** — Levels 1–3 have lost their *not built yet* suffix, and
  Level 4 is new. Level 4 is the only one from which two-stage combinations are
  reachable.
- **01b, the service strip** — where the clustering ran. The pipeline is a
  separate process behind a REST API, and the app says so rather than pretending
  the work is local.

> **A note on 01 in v0.2.** That file has a *Page not found* modal across it. The
> capture script requested the Archipelago page by its declared `url_path`, but
> Streamlit serves the default page at the root, so the request 404'd and the
> modal landed in the shot. Fixed in the script for v0.3; the v0.2 folder is left
> exactly as captured, per the rule above.

> **Screenshots for v0.3 were never captured.** The folder does not exist, so
> the progression jumps from v0.2 to v0.4. To fill the gap, check out the v0.3
> commit, run the app, and capture into `v0.3/` — do **not** capture it from
> current code, which would show v0.4's behaviour under a v0.3 label.

## v0.2 — run library, cascade seam, visual pass

Six pages. **Runs** is new, and navigation is grouped (Analyse / The run / About),
which is why the numbering differs from v0.1 — the files are numbered in
navigation order, and that order changed.

| | Page | |
|---|---|---|
| 01 | Archipelago | [01-archipelago.png](v0.2/01-archipelago.png) |
| 02 | Migration | [02-migration.png](v0.2/02-migration.png) |
| 03 | Convergence | [03-convergence.png](v0.2/03-convergence.png) |
| 04 | Run browser | [04-run-browser.png](v0.2/04-run-browser.png) |
| 05 | **Runs** *(new)* | [05-runs.png](v0.2/05-runs.png) |
| 06 | Overview | [06-overview.png](v0.2/06-overview.png) |

What to look at:

- **05-runs** — the page that makes the app usable by someone who did not
  generate the run. Zip, loose files, or a path already on the machine.
- **06-overview** — the pipeline strip now separates *produced elsewhere*
  (Execution, Logs) from *built* and *not yet built*, which is where the
  execution boundary with Volpe is stated.
- **01-archipelago** — the sidebar gained an **Abstraction level** picker.
  Levels 1–3 show greyed as *not built yet*; selecting one falls back to Level 0
  with a notice. That is the seam the clustering cascade replaces.
- Everywhere — metric tiles gained an accent hairline, charts are panelled, and
  the active page carries a rail in the navigation.

## v0.1 — Level 0

Five pages. The first build that drew a real trajectory network from the log.

| | Page | |
|---|---|---|
| 01 | Overview | [01-overview.png](v0.1/01-overview.png) |
| 02 | Run browser | [02-run-browser.png](v0.1/02-run-browser.png) |
| 03 | Archipelago | [03-archipelago.png](v0.1/03-archipelago.png) |
| 04 | Migration | [04-migration.png](v0.1/04-migration.png) |
| 05 | Convergence | [05-convergence.png](v0.1/05-convergence.png) |

What to look at:

- **03-archipelago** — islands as separate territories, fitness on the vertical
  axis, magenta migration edges, gold diamonds for island bests.
- **04-migration** — the source × destination matrix recovers the topology from
  the log alone; a fully-connected run fills it, a ring fills only the band.

---

## Capturing a new version

With the app running:

```bash
python scripts/capture_screenshots.py --version v0.4
```

The clustered shot needs the API service up as well; without it that one shot is
skipped with a notice and the other six still capture. A screenshot of an error
message is not a record of what a version looked like.

```bash
cd ../archipelago-api && ./.venv/bin/python -m uvicorn app.main:app --port 8000
```

It writes one full-page PNG per page into `docs/version-history/v0.3/`. The page
list and the file numbering live in `PAGES` at the top of that script — update it
when a page is added, renamed, or moved in the navigation, then add a section
here.

Needs Playwright once:

```bash
pip install playwright && python -m playwright install chromium
```

# Version history

One folder per tagged frontend version, holding a full-page screenshot of every
page as that version actually shipped.

**Old versions are never re-captured.** Each folder is a record of what the app
looked like at that tag, not a rendering of today's code against an old label —
so the progression is real and the differences between folders are the actual
changes. `CHANGELOG.md` at the repo root says what changed and why; this says
what it looked like.

Captured at 1680×1050, full page, on the `de / rastrigin · 5 islands`
fully-connected sample run.

---

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
python scripts/capture_screenshots.py --version v0.3
```

It writes one full-page PNG per page into `docs/version-history/v0.3/`. The page
list and the file numbering live in `PAGES` at the top of that script — update it
when a page is added, renamed, or moved in the navigation, then add a section
here.

Needs Playwright once:

```bash
pip install playwright && python -m playwright install chromium
```

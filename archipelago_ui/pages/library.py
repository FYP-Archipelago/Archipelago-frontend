"""The run library: add runs, look at what is loaded, remove what is not needed.

This is the page that makes the app usable by someone who did not generate the
run themselves. Everything else here reads a run; this is where one arrives.
"""

from __future__ import annotations

from pathlib import Path

import pandas as pd
import streamlit as st

from .. import ingest
from ..data import DATA_ROOT, caption, invalidate, page_header


def _install_notice(target: Path, inspection: ingest.Inspection) -> None:
    st.success(f"Added **{target.name}** — {len(inspection.present)} of 5 contract files.")
    for warning in inspection.warnings:
        st.warning(f"Missing file: {warning}.")


def _upload_archive() -> None:
    upload = st.file_uploader(
        "Run archive",
        type=["zip"],
        help="A zip of a run directory, or of its contents. Nesting is fine.",
        key="library_zip",
    )
    if upload is None:
        return

    payload = upload.getvalue()
    inspection = ingest.inspect_zip(payload)

    if not inspection.ok:
        st.error(inspection.summary)
        return

    st.info(
        f"Found a run in **{upload.name}** — "
        + ", ".join(f"`{f}`" for f in inspection.present)
        + (
            "  \nMissing: " + ", ".join(f"`{f}`" for f in inspection.missing)
            if inspection.missing
            else ""
        )
    )
    name = st.text_input(
        "Name it",
        value=inspection.suggested_name or Path(upload.name).stem,
        help="Used as the directory name under data/. Run ids sort newest-first.",
        key="library_zip_name",
    )
    if st.button("Add to library", type="primary", key="library_zip_go"):
        try:
            target = ingest.install_zip(payload, DATA_ROOT, name=name)
        except (ValueError, OSError) as error:
            st.error(f"Could not add it: {error}")
            return
        invalidate()
        _install_notice(target, inspection)
        st.rerun()


def _upload_loose() -> None:
    uploads = st.file_uploader(
        "Run files",
        accept_multiple_files=True,
        help="Select the files from one run directory. Only evaluations.csv is required.",
        key="library_files",
    )
    if not uploads:
        return

    files = {u.name: u.getvalue() for u in uploads if u.name in ingest.REQUIRED + tuple(ingest.OPTIONAL)}
    ignored = [u.name for u in uploads if u.name not in files]

    if not files:
        st.error(
            "None of those are contract files. Expected: "
            + ", ".join(f"`{f}`" for f in (ingest.REQUIRED + tuple(ingest.OPTIONAL)))
        )
        return
    if "evaluations.csv" not in files:
        st.error("`evaluations.csv` is required — without it there is no trajectory to draw.")
        return
    if ignored:
        st.caption("Ignoring: " + ", ".join(f"`{n}`" for n in ignored))

    name = st.text_input("Name it", value="uploaded-run", key="library_files_name")
    if st.button("Add to library", type="primary", key="library_files_go"):
        try:
            target = ingest.install_files(files, DATA_ROOT, name=name)
        except (ValueError, OSError) as error:
            st.error(f"Could not add it: {error}")
            return
        invalidate()
        missing = [f for f in ingest.OPTIONAL if f not in files]
        _install_notice(
            target,
            ingest.Inspection(
                ok=True,
                present=list(files),
                missing=missing,
                warnings=[ingest.OPTIONAL[f] for f in missing],
            ),
        )
        st.rerun()


def _import_path() -> None:
    caption(
        "If the run is already on this machine — a harness <code>runs/</code> directory, a "
        "mounted share — point at it instead of zipping it up."
    )
    raw = st.text_input(
        "Path to a run directory",
        placeholder=r"C:\...\baseline-dEA\runs\run-20260903T230942Z-c7f38cc1",
        key="library_path",
    )
    if not raw.strip():
        return

    source = Path(raw.strip().strip('"'))
    inspection = ingest.inspect_directory(source)
    if not inspection.ok:
        st.error(inspection.summary)
        return

    st.info("Found: " + ", ".join(f"`{f}`" for f in inspection.present))
    if st.button("Copy into the library", type="primary", key="library_path_go"):
        try:
            target = ingest.import_directory(source, DATA_ROOT)
        except (ValueError, OSError) as error:
            st.error(f"Could not import it: {error}")
            return
        invalidate()
        _install_notice(target, inspection)
        st.rerun()


def _library_table(paths: list[Path]) -> None:
    rows = [ingest.describe(p) for p in paths]
    frame = pd.DataFrame(rows)

    display = pd.DataFrame(
        {
            "Run": frame["name"],
            "Islands": frame.get("islands"),
            "Evaluations": frame.get("evaluations"),
            "Migrations": frame.get("migrations"),
            "Best fitness": frame.get("best"),
            "Outcome": frame.get("outcome"),
            "Size": (frame["size"] / 1e6).round(2),
        }
    )
    st.dataframe(
        display,
        hide_index=True,
        use_container_width=True,
        column_config={
            "Best fitness": st.column_config.NumberColumn(format="%.4f"),
            "Size": st.column_config.NumberColumn("Size (MB)", format="%.2f"),
        },
    )


def _remove(paths: list[Path]) -> None:
    with st.expander("Remove a run"):
        st.caption("Deletes the directory from `data/`. The original is untouched.")
        chosen = st.selectbox(
            "Run", paths, format_func=lambda p: p.name, key="library_remove_pick"
        )
        confirm = st.checkbox(f"Yes, delete `{chosen.name}`", key="library_remove_confirm")
        if st.button("Delete", disabled=not confirm, key="library_remove_go"):
            try:
                ingest.remove_run(chosen, DATA_ROOT)
            except (ValueError, OSError) as error:
                st.error(f"Could not delete it: {error}")
                return
            invalidate()
            st.success(f"Removed {chosen.name}.")
            st.rerun()


def render() -> None:
    page_header(
        "The library",
        "Runs",
        "Archipelago reads finished runs; it does not execute them. Bring a run in from the "
        "baseline harness, from Volpe, or from a colleague, and every page here works on it.",
    )

    paths = sorted(
        (p for p in DATA_ROOT.iterdir() if p.is_dir() and (p / "evaluations.csv").is_file()),
        key=lambda p: p.name,
        reverse=True,
    ) if DATA_ROOT.exists() else []

    left, right = st.columns([1.25, 1], gap="large")

    with left:
        st.markdown("### Add a run")
        archive, loose, from_path = st.tabs(["Zip archive", "Loose files", "From a path"])
        with archive:
            _upload_archive()
        with loose:
            _upload_loose()
        with from_path:
            _import_path()

    with right:
        st.markdown("### What a run looks like")
        st.code(
            "<run id>/\n"
            "├── evaluations.csv          required — one row per evaluated individual\n"
            "├── run.jsonl                every other event\n"
            "├── evaluations.schema.json  the CSV's column contract\n"
            "├── resolved_config.yaml     the configuration actually used\n"
            "└── summary.json             machine-readable outcome",
            language="text",
        )
        caption(
            "Only <code>evaluations.csv</code> is strictly required — the Archipelago view "
            "works from it alone. Each other file switches on a page: without "
            "<code>run.jsonl</code> there is no migration or convergence story to tell."
        )

    st.markdown("---")
    st.markdown("### In the library")

    if not paths:
        st.info("Nothing loaded yet. Add a run above.")
        return

    _library_table(paths)
    caption(
        "Figures come from each run's <code>summary.json</code> without parsing the CSV, so "
        "this table stays fast however large the library gets."
    )
    _remove(paths)

    st.markdown("---")
    with st.expander("Where runs come from"):
        st.markdown(
            """
Archipelago is the analysis layer. It deliberately does not orchestrate searches — that is
the harness's job, and Volpe already owns running jobs on the cluster. Keeping execution out
means this app has no scheduler, no worker pool and no cluster credentials to hold: it reads
a directory, which is why a run from a laptop and a run from Volpe are the same thing to it.

**From the baseline harness, locally**

```bash
python -m orchestrator.cli run --config config/smoke_local.yaml
```

writes `runs/<run id>/`. Point the *From a path* tab at it, or zip it and upload.

**From Volpe, or any other executor**

Anything that emits the schema 2.0 layout is readable here, whatever produced it. The
contract is the only coupling point — see `SCHEMA_USAGE.md` for the exact fields this app
reads, which is a strict subset of what the harness writes.
"""
        )

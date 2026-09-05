"""What ran, on what, and how it ended -- read from run_start / run_end."""

from __future__ import annotations

import pandas as pd
import streamlit as st

from ..data import caption, page_header
from ..logreader import Run


def _provenance(run: Run) -> pd.DataFrame:
    """The facts a reviewer asks for: what problem, which instance, verified how."""
    start = run.run_start
    rows = [
        ("Algorithm", start.get("algorithm", "—")),
        ("Benchmark", start.get("benchmark", "—")),
        ("Islands", start.get("num_islands", "—")),
        ("Population / island", start.get("population_size", "—")),
        ("Evaluation budget", f"{start.get('evaluation_budget', 0):,}"),
        ("Backend", start.get("backend", "—")),
        ("Harness version", start.get("harness_version", "—")),
        ("Schema version", start.get("schema_version", "—")),
    ]

    migration = start.get("migration", {}) or {}
    if migration:
        rows += [
            ("Topology", migration.get("topology", "—")),
            ("Migration interval", migration.get("interval", "—")),
            ("Migrants per event", migration.get("num_migrants", "—")),
            ("Selection → replacement",
             f"{migration.get('selection', '?')} → {migration.get('replacement', '?')}"),
        ]

    datasets = start.get("datasets", {}) or {}
    for key, value in datasets.items():
        if isinstance(value, dict):
            if "sha256" in value:
                rows.append((f"{key} SHA-256", str(value["sha256"])[:16] + "…"))
            if "source" in value:
                rows.append((f"{key} source", str(value["source"])))
        else:
            rows.append((str(key), str(value)))

    return pd.DataFrame(rows, columns=["Field", "Value"])


def _per_island(run: Run) -> pd.DataFrame:
    """One row per island, from island_end -- how each one finished and why."""
    rows = []
    for event in run.event("island_end"):
        rows.append(
            {
                "Island": event.get("island_id"),
                "Stopped because": event.get("termination_reason", "—"),
                "Generations": event.get("generations_completed"),
                "Evaluations": event.get("evaluations_total"),
                "Best fitness": event.get("best_fitness"),
                "Stagnant for": event.get("generations_since_improvement"),
                "Migrants sent": event.get("migrants_sent", 0),
                "Migrants received": event.get("migrants_received", 0),
                "Seconds": round(float(event.get("wallclock_seconds", 0)), 2),
            }
        )
    return pd.DataFrame(rows).sort_values("Island") if rows else pd.DataFrame()


def render(run: Run) -> None:
    page_header(
        "The run",
        "Run browser",
        "Provenance and outcome for the selected run, taken from the first and last records "
        "in the event stream.",
    )

    end = run.run_end
    best = end.get("global_best_fitness")

    columns = st.columns(5)
    columns[0].metric("Evaluations", f"{len(run.evaluations):,}")
    columns[1].metric("Islands", f"{end.get('islands_completed', len(run.islands))}")
    columns[2].metric("Migration events", f"{end.get('total_migration_events', 0):,}")
    columns[3].metric(
        "Global best",
        f"{best:.4f}" if isinstance(best, (int, float)) else "—",
        help=f"Found on island {end.get('global_best_island')}"
        if end.get("global_best_island") is not None
        else None,
    )
    columns[4].metric("Wall clock", f"{end.get('wallclock_seconds', 0):.1f}s")

    caption(
        f"Terminated: <code>{end.get('termination_reason', 'unknown')}</code>. "
        f"Fitness is being <b>{'maximised' if run.maximising else 'minimised'}</b>, so lower is "
        f"{'worse' if run.maximising else 'better'} throughout this app."
    )

    st.markdown("---")

    left, right = st.columns([1, 1.25], gap="large")

    with left:
        st.markdown("### Provenance")
        st.dataframe(
            _provenance(run),
            hide_index=True,
            use_container_width=True,
            height=430,
        )

    with right:
        st.markdown("### How each island finished")
        islands = _per_island(run)
        if islands.empty:
            st.info("No `island_end` records in this run.")
        else:
            st.dataframe(
                islands,
                hide_index=True,
                use_container_width=True,
                column_config={
                    "Best fitness": st.column_config.NumberColumn(format="%.4f"),
                },
            )
            caption(
                "<code>termination_reason</code> read beside <code>stagnant for</code> tells you "
                "whether an island converged or simply ran out of budget — a distinction a "
                "fitness curve hides."
            )

    with st.expander("Resolved configuration"):
        st.json(run.run_start.get("config", {}), expanded=False)

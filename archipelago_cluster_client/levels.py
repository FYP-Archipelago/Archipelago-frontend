"""Drawing a finished clustering result as an abstraction level.

This is the *viewing* half of the integration and it does nothing else. It never
calls the pipeline: every result it can draw was produced by pressing **Run
clustering** on the Runs page, and this page only chooses between them.

That separation is deliberate. Running the pipeline is slow, costs a request to
another service, and is something a user should ask for on purpose. Earlier this
module fired a run whenever a stage toggle moved, which meant looking at a graph
could start work — the two acts are now in two places.

The shape is what ``docs/EXTENDING.md`` describes: a reducer produces one label
per row of ``stn.nodes`` and hands them to ``levels.collapse``. Because the
labels came from the API, the 3D view, the metrics, the migration overlay and the
projection all render a clustered network with no change to any of them.

The dependency points inward: this package imports ``archipelago_ui``; nothing in
``archipelago_ui`` imports this.
"""

from __future__ import annotations

from typing import Any, Mapping

import streamlit as st

from archipelago_ui import levels
from archipelago_ui.logreader import Run
from archipelago_ui.stn import STN

from . import results

#: Sidebar key for the picker. One entry beside Level 0, not one per algorithm:
#: which stages ran is a property of a result, not of a level.
LEVEL_KEY = "clustered"

#: Widget key for the result picker on the page.
PICKER_KEY = "cluster_result_pick"

#: The placeholders shipped by archipelago_ui. They promised a level per
#: algorithm; results supersede that, so they are taken out of the picker rather
#: than left offering a choice this client does not implement.
_SUPERSEDED = ("lsh", "birch", "denstream", "cascade")


def _labels_for(stn: STN, response) -> list[Any]:
    """Map the API's node keys onto ``stn.nodes`` row order.

    ``stn.nodes`` is indexed by ``"<island>:<genome_hash>"``, which is exactly
    the key the API returns, so this is a lookup rather than a join.

    A node the response does not cover keeps a group of its own — a location with
    no decodable genome. Merging those into some default group would invent a
    cluster nobody computed.
    """
    assignments = response.assignments
    return [assignments.get(key, f"unclustered:{key}") for key in stn.nodes.index]


def _diagnostics(entry: results.ClusterRun, stn: STN, reduced: STN) -> dict[str, Any]:
    """Flatten the stored result into the table the page already renders."""
    response = entry.response
    report: dict[str, Any] = {
        "stages executed": entry.stage_label,
        "run at": entry.at,
        "nodes": f"{stn.n_nodes:,} → {reduced.n_nodes:,}",
        "compression": f"{stn.n_nodes / reduced.n_nodes:.1f}×" if reduced.n_nodes else "—",
        "evaluations clustered": f"{response.counts.get('rows_clustered', 0):,}",
        "backend time": f"{response.elapsed_seconds:.2f}s",
    }
    for name, value in entry.parameters.items():
        report[f"tuned.{name}"] = value

    if response.node_weights:
        # DenStream ran. A weight of 0 is a region the search has left; the count
        # of those is the single most informative number the stage produces.
        weights = list(response.node_weights.values())
        faded = sum(1 for w in weights if w <= 0.0)
        report["decayed nodes (weight 0)"] = f"{faded:,} of {len(weights):,}"
        report["mean node weight"] = f"{sum(weights) / len(weights):.3f}"

    for stage, values in response.diagnostics.items():
        for key, value in values.items():
            if isinstance(value, (int, float, str, bool)):
                report[f"{stage}.{key}"] = _readable(value)
    return report


def _readable(value: Any) -> str:
    """One column, one type: text.

    The page renders this dict as a two-column table, and Streamlit hands that to
    Arrow, which types a column rather than a cell. A mix of strings and floats
    has no common type, so Arrow raises and Streamlit falls back to a guess --
    loudly, with a traceback. Formatting here also beats Arrow's own rendering:
    a bucket width reads better as 0.5499 than as 0.5498620953271941.
    """
    if isinstance(value, bool):
        return "yes" if value else "no"
    if isinstance(value, float):
        return f"{value:,.4g}"
    if isinstance(value, int):
        return f"{value:,}"
    return str(value)


# --------------------------------------------------------------------------
# the picker
# --------------------------------------------------------------------------


def result_controls(run: Run) -> Mapping[str, Any]:
    """Choose which stored result to draw. No toggles, and no pipeline run.

    Returns the chosen result in ``params`` so the builder does not have to look
    it up again and cannot disagree with what was just shown.
    """
    available = results.for_run(run.run_id)

    if not available:
        st.info(
            "No clustering results for this run yet. Go to **Runs**, choose which "
            "stages to execute, and press **Run clustering** — then come back and "
            "the result will be here.",
            icon=":material/science:",
        )
        return {"entry": None}

    chosen_id = st.session_state.get(results.SELECTED_STATE)
    ids = [entry.id for entry in available]
    index = ids.index(chosen_id) if chosen_id in ids else 0
    by_id = {entry.id: entry for entry in available}

    row = st.columns([3, 1.6])
    picked = row[0].selectbox(
        "Clustering result",
        ids,
        index=index,
        format_func=lambda i: by_id[i].label(),
        key=PICKER_KEY,
        help="Every run of the pipeline on this dEA run, newest first. Producing "
             "one is the Runs page's job; this only chooses which to draw.",
    )
    results.select(picked)
    entry = by_id[picked]

    with row[1]:
        st.caption(
            f"Executed `{entry.stage_label}`  \n"
            f"{entry.level0_nodes:,} → {entry.nodes:,} nodes"
        )
        if len(available) > 1:
            st.caption(f"{len(available)} results stored for this run.")

    return {"entry": entry}


def _build(stn: STN, run: Run, params: Mapping[str, Any]) -> levels.Reduction:
    """Collapse the network using a stored result. Never runs anything."""
    entry = params.get("entry")
    if entry is None or entry.response is None:
        # Nothing to draw with. Level 0 is the honest fallback: it is the network
        # the log describes, and the picker has already said why.
        return levels.Reduction(stn)

    for warning in entry.response.warnings:
        st.warning(warning, icon=":material/info:")

    reduced = levels.collapse(stn, _labels_for(stn, entry.response))
    return levels.Reduction(reduced, _diagnostics(entry, stn, reduced))


def install() -> None:
    """Replace the per-algorithm placeholders with one result-backed level."""
    for key in _SUPERSEDED:
        levels.unregister(key)

    levels.register(
        levels.Level(
            key=LEVEL_KEY,
            order=1,
            label="Clustered — pipeline result",
            summary="A result produced on the Runs page. Pick which one to draw.",
            detail=(
                "The trajectory network collapsed by a clustering run. Which stages "
                "ran is a property of the result you choose, not of this level — "
                "run a different combination on the Runs page and it appears here "
                "alongside this one, so two configurations can be compared."
            ),
            build=_build,
            controls=result_controls,
        )
    )


install()

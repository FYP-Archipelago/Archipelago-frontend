"""The clustering panel on the Runs page: pick a run, pick the stages, run it.

This is where a user *asks for* clustering. The Archipelago page is where they
look at the result, and it does not re-run anything — the call is cached on
(run, stages, parameters), so pressing the button here is what actually spends
the time, and switching pages afterwards is free.

The whole panel is a client of the REST API and nothing else. It holds no
clustering code, imports no part of the pipeline, and cannot run a stage on its
own: pressing the button is an HTTP request, and if the service is down the
panel says so rather than quietly doing the work locally.
"""

from __future__ import annotations

from pathlib import Path

import streamlit as st

from . import api, results, state
from .settings import base_url, url_input

#: The abstraction level a completed run switches the app to, so the result is
#: what the Archipelago page draws when the user gets there.
CLUSTERED_LEVEL = "clustered"

#: Sidebar key the Archipelago page reads. Matches archipelago_ui.data.LEVEL_STATE.
LEVEL_STATE = "abstraction_level"


def _service_strip() -> bool:
    """Where the pipeline runs, and whether it is reachable. False if it is not."""
    url = base_url()
    info = api.health(url)

    if info is None:
        st.error(
            f"No clustering service at `{url}`. The pipeline runs there, not in this "
            "app, so nothing can be clustered until it is up.",
            icon=":material/cloud_off:",
        )
        with st.expander("Start it, or point somewhere else"):
            st.code(
                "cd archipelago-api\n"
                "./.venv/bin/python -m uvicorn app.main:app --port 8000",
                language="bash",
            )
            url_input()
        return False

    st.caption(
        f"Pipeline service `{url}` · v{info.get('service_version', '?').lstrip('v')} · "
        f"cascade `{' → '.join(api.stage_order(url))}`"
    )
    return True


def _run_picker(paths: list[Path]) -> Path | None:
    if not paths:
        st.info("Add a run above, then choose it here to cluster it.")
        return None
    return st.selectbox(
        "Run to cluster",
        paths,
        format_func=lambda p: p.name,
        key="cluster_panel_run",
        help="Any run in the library. The service reads it from disk; if it cannot "
             "see the path, the run is uploaded instead.",
    )


#: Where a failed run leaves its message, so the next render can show it.
LAST_ERROR = "cluster_last_error"


def _execute(run_path: Path, stages: dict[str, bool], params: dict) -> None:
    """Fire the REST call. Runs as a button callback, not during a render.

    That placement is load-bearing. This sets ``abstraction_level``, which is a
    widget key, and Streamlit refuses an assignment to one after that widget has
    been instantiated — the sidebar's level picker is drawn before this page's
    body, so doing it inline raises. A callback runs *before* the rerun that
    creates the widgets, which is the one moment the write is legal.
    """
    try:
        response = _cluster_cached(
            str(run_path),
            tuple(sorted(stages.items())),
            state.cache_key(params),
            base_url(),
        )
    except api.ClusterUnavailable as error:
        st.session_state[LAST_ERROR] = str(error)
        st.session_state.pop(state.LAST_RESULT, None)
        return

    st.session_state.pop(LAST_ERROR, None)
    state.remember(response)
    # File it alongside any earlier result for this run, rather than replacing
    # one: comparing two configurations is the point of a toggleable pipeline.
    results.record(response, params)
    # The user asked for this clustering, so the app should be showing it. Set the
    # level they would otherwise have to go and find.
    st.session_state[LEVEL_STATE] = CLUSTERED_LEVEL


@st.cache_data(show_spinner=False, max_entries=16)
def _cluster_cached(run_path: str, stages: tuple, params: tuple, url: str):
    """One call per (run, stages, parameters, service).

    Shared with the Archipelago page's reducer, which is the point: the run
    happens once, here, and looking at it costs nothing.
    """
    return api.cluster_run(
        run_path,
        dict(stages),
        base_url=url,
        parameters=state.to_request(dict(params)),
    )


def _report(response: api.ClusterResponse) -> None:
    executed = " → ".join(response.stages_executed) or "none (Level 0 baseline)"
    st.success(f"Ran `{executed}` on **{response.run_id}**", icon=":material/check_circle:")

    counts = response.counts
    level0 = counts.get("level0_nodes", 0)
    nodes = counts.get("nodes", 0)

    tiles = st.columns(4)
    tiles[0].metric("Evaluations", f"{counts.get('evaluations', 0):,}")
    tiles[1].metric("Level 0 nodes", f"{level0:,}", help="What no clustering would give.")
    tiles[2].metric(
        "Clustered nodes",
        f"{nodes:,}",
        delta=f"{level0 / nodes:.1f}x compression" if nodes else None,
        delta_color="off",
    )
    tiles[3].metric("Backend time", f"{response.elapsed_seconds:.2f}s")

    for warning in response.warnings:
        st.warning(warning, icon=":material/info:")

    if response.transport == "upload":
        st.caption(
            "The service could not read the run from disk, so it was uploaded. The "
            "result is identical either way."
        )

    stored = results.for_run(response.run_id)
    st.info(
        "Open **Archipelago** to see it drawn — it is already selected there. "
        + (
            f"{len(stored)} results are stored for this run; the picker on that page "
            "chooses between them."
            if len(stored) > 1
            else "Run another combination and both stay available to compare."
        ),
        icon=":material/scatter_plot:",
    )


def clustering_panel(paths: list[Path]) -> None:
    """The Runs page's clustering section. Registered into the ``library`` slot."""
    st.markdown("### Run the clustering pipeline")
    st.caption(
        "Choose which stages execute, then run them. The stages cascade in a fixed "
        "order and each refines the partition the previous one produced, so what is "
        "yours to choose is which run — not in what sequence."
    )

    if not _service_strip():
        return

    run_path = _run_picker(paths)
    if run_path is None:
        return

    st.markdown("**Stages to execute**")
    stages = state.stage_toggles()
    state.order_caption(stages)
    params = state.parameter_controls(stages)

    st.button(
        "Run clustering",
        type="primary",
        key="cluster_panel_go",
        on_click=_execute,
        args=(run_path, stages, params),
        help="Sends the run and this stage selection to the pipeline service.",
    )

    error = st.session_state.get(LAST_ERROR)
    if error:
        st.error(error, icon=":material/error:")
        return

    previous = state.last_result()
    if previous is not None and previous.run_id == run_path.name:
        _report(previous)


def install() -> None:
    """Register the panel onto the Runs page."""
    from archipelago_ui import extensions

    extensions.register("library", clustering_panel, order=10, name="clustering")


install()

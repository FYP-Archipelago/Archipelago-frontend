"""The centrepiece: the search trajectory network, drawn by the WebGL2 viewer."""

from __future__ import annotations

import pandas as pd
import streamlit as st

from .. import levels
from ..data import caption, get_stn, get_viewer_payload, page_header, selected_level
from ..logreader import Run
from ..viewer import stn_viewer
from ..viewer.clusters import with_clusters


def render(run: Run) -> None:
    page_header(
        "The search",
        "Archipelago",
        "Every location the run actually visited, with height standing for fitness — so "
        "convergence reads as descent and a stalled island reads as one that never gets down. "
        "Trajectory edges are within-island lineage; anything crossing between islands is a migration.",
    )

    payload = get_viewer_payload(str(run.path))
    if payload is None:
        st.error("No decodable genomes in this run — nothing to place.")
        return

    # Abstraction level. Level 0 draws the run as logged; a level that registered
    # itself through archipelago_ui/levels.py supplies its own controls and, for
    # the clustering pipeline, a stored result whose assignments the viewer
    # buckets by instead of by grid cell.
    level = selected_level()
    reduction = None
    payload = {**payload, "level_note": "Level 0 \u00b7 raw trajectory", "level_warn": False}
    if not level.available:
        st.info(
            f"**{level.label}** is not built yet — showing Level 0. {level.detail}",
            icon=":material/construction:",
        )
    elif level.key != "level0":
        params = dict(level.controls(run)) if level.controls is not None else {}
        entry = params.get("entry")
        if entry is not None and getattr(entry, "response", None) is not None:
            payload = with_clusters(
                payload,
                entry.response.assignments,
                cluster_id=entry.id,
                label=entry.stage_label,
            )
            reduction = levels.apply(level.key, get_stn(str(run.path)), run, params)
            payload["level_note"] = f"Clustered \u00b7 {entry.stage_label}"
        else:
            payload["level_note"] = (
                "Clustered level selected, but there is no clustering result for this run "
                "in this session \u2014 showing Level 0. Run clustering on the Runs page."
            )
            payload["level_warn"] = True

    stn_viewer(payload, key=f"stn-viewer-{run.run_id}")

    if reduction is not None and reduction.diagnostics:
        with st.expander(f"{level.label} — what the reduction did"):
            st.dataframe(
                pd.DataFrame(reduction.diagnostics.items(), columns=["measure", "value"]),
                hide_index=True,
                use_container_width=True,
            )

    caption(
        f"Projection keeps <b>{payload['variance_kept']:.0%}</b> of the genome-space variance "
        "in its two planar components; height carries fitness."
    )

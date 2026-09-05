"""Convergence and diversity, drawn on wall-clock time.

The time axis matters here. Islands are asynchronous by design, so plotting
against generation number would imply a simultaneity the run never had. Every
chart on this page uses run-relative wall time instead.
"""

from __future__ import annotations

import plotly.graph_objects as go
import streamlit as st

from .. import theme
from ..data import caption, page_header
from ..logreader import Run


def _series(frame, run: Run, column: str, title: str, y_label: str) -> go.Figure:
    figure = go.Figure()
    for island in sorted(frame["island_id"].dropna().unique()):
        subset = frame[frame["island_id"] == island].sort_values("t_rel")
        if column not in subset or subset[column].isna().all():
            continue
        figure.add_trace(
            go.Scatter(
                x=subset["t_rel"],
                y=subset[column],
                mode="lines",
                name=f"island {int(island)}",
                line=dict(color=theme.island_colour(int(island)), width=2),
                hovertemplate=(
                    f"island {int(island)}<br>t=%{{x:.2f}}s<br>{y_label}=%{{y:.4f}}<extra></extra>"
                ),
            )
        )
    figure.update_layout(
        title=title,
        height=340,
        xaxis_title="seconds since run start",
        yaxis_title=y_label,
        legend=dict(orientation="h", yanchor="bottom", y=1.0, x=0),
        margin=dict(l=56, r=16, t=56, b=44),
    )
    return figure


def _async_figure(frame) -> go.Figure:
    """Generation reached against wall time -- the asynchrony, made visible."""
    figure = go.Figure()
    for island in sorted(frame["island_id"].dropna().unique()):
        subset = frame[frame["island_id"] == island].sort_values("t_rel")
        figure.add_trace(
            go.Scatter(
                x=subset["t_rel"],
                y=subset["generation"],
                mode="lines",
                name=f"island {int(island)}",
                line=dict(color=theme.island_colour(int(island)), width=2),
                showlegend=False,
                hovertemplate=(
                    f"island {int(island)}<br>t=%{{x:.2f}}s<br>generation %{{y}}<extra></extra>"
                ),
            )
        )
    figure.update_layout(
        title="Generation reached, against wall time",
        height=320,
        xaxis_title="seconds since run start",
        yaxis_title="generation",
        margin=dict(l=56, r=16, t=56, b=44),
    )
    return figure


def render(run: Run) -> None:
    page_header(
        "The run",
        "Convergence & diversity",
        "Per-island progress on run-relative wall time. Islands are asynchronous, so a "
        "generation slider would quietly misreport what happened at the same moment.",
    )

    frame = run.generation_frame()
    if frame.empty:
        st.info("This run has no `generation_end` records.")
        return

    left, right = st.columns(2, gap="large")

    with left:
        st.plotly_chart(
            _series(frame, run, "best_so_far_fitness", "Best so far, per island", "fitness"),
            use_container_width=True,
        )
        caption(
            "A flat line is an island that has stopped improving. Compare it against "
            "<code>termination_reason</code> on the Run browser to tell convergence from "
            "an exhausted budget."
        )

    with right:
        # The metric name can be long (mean_pairwise_euclidean_normalised), so it
        # goes in the caption rather than crushing the plot as an axis title.
        has_name = "diversity_metric" in frame and frame["diversity_metric"].notna().any()
        label = frame["diversity_metric"].dropna().iloc[0] if has_name else "diversity"
        st.plotly_chart(
            _series(frame, run, "diversity", "Population diversity", "diversity"),
            use_container_width=True,
        )
        caption(
            f"Measured as <code>{label}</code>. The metric is representation-dependent, so its "
            "name is logged with the value and used as the axis label — the axis is never wrong "
            "across algorithms."
        )

    st.markdown("---")

    left, right = st.columns([1.4, 1], gap="large")
    with left:
        st.plotly_chart(_async_figure(frame), use_container_width=True)
    with right:
        st.markdown("### Reading the drift")
        reached = frame.groupby("island_id")["generation"].max()
        finished = frame.groupby("island_id")["t_rel"].max()

        spread = st.columns(2)
        spread[0].metric(
            "Generation spread",
            f"{int(reached.min())} – {int(reached.max())}",
            help="Lowest and highest generation any island reached.",
        )
        spread[1].metric(
            "Finish spread",
            f"{finished.max() - finished.min():.2f}s",
            help="Wall-clock gap between the first and last island to stop.",
        )
        st.markdown(
            f"""
<div style="color:{theme.INK_SOFT};font-size:15px;line-height:1.6;margin-top:10px;">
<p>Islands are separate processes with their own budgets and their own stopping rules, so
they neither start nor end together. The wider these two numbers, the less a
generation-indexed view could be trusted.</p>
<p>That is the property standard STN tooling assumes away, and it is why every timeline here
is driven by clock-corrected <code>t_wall</code> rather than generation number.</p>
</div>
""",
            unsafe_allow_html=True,
        )

    with st.expander("Generation records"):
        columns = [
            c
            for c in (
                "island_id", "generation", "best_fitness", "mean_fitness", "worst_fitness",
                "best_so_far_fitness", "diversity", "unique_genome_hashes",
                "evaluations_total", "migrants_received_this_generation",
            )
            if c in frame.columns
        ]
        st.dataframe(frame[columns], hide_index=True, use_container_width=True, height=320)

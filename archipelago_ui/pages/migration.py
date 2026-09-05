"""Migration explorer -- the one visual element the platform exists for.

Built from ``migration_send`` left-joined to ``migration_arrive`` on
``migration_id``. The join is deliberately a left join: a send with no arrival
is an undelivered migrant, which is a real behaviour and not a gap in the data.
"""

from __future__ import annotations

import numpy as np
import plotly.graph_objects as go
import streamlit as st

from .. import theme
from ..data import caption, page_header
from ..logreader import Run


def _matrix_figure(frame, islands) -> go.Figure:
    """Who feeds whom: a source x destination count matrix."""
    grid = np.zeros((len(islands), len(islands)))
    index = {island: position for position, island in enumerate(islands)}
    for source, dest, count in zip(
        frame["source_island"], frame["dest_island"], frame["num_migrants"]
    ):
        if source in index and dest in index:
            grid[index[source], index[dest]] += count

    figure = go.Figure(
        go.Heatmap(
            z=grid,
            x=[f"→ {i}" for i in islands],
            y=[f"island {i}" for i in islands],
            colorscale=[[0, theme.DEEP], [0.5, "#7A2B57"], [1, theme.MIGRATION]],
            hovertemplate="%{y} %{x}<br>%{z:.0f} individuals<extra></extra>",
            colorbar=dict(
                title=dict(text="individuals", font=dict(color=theme.INK_SOFT, size=11)),
                tickfont=dict(color=theme.INK_FAINT, size=9),
                thickness=10, len=0.7,
            ),
        )
    )
    figure.update_layout(
        title="Migrants sent, source → destination",
        height=380,
        # Island 0 at the top, so the matrix reads like a matrix rather than a chart.
        yaxis=dict(autorange="reversed"),
        margin=dict(l=76, r=16, t=56, b=44),
    )
    return figure


def _timeline_figure(frame) -> go.Figure:
    """Every transfer on wall time, split by whether it landed."""
    figure = go.Figure()
    for delivered, name, colour, symbol in (
        (True, "delivered", theme.MIGRATION, "circle"),
        (False, "not delivered", theme.INK_FAINT, "x"),
    ):
        subset = frame[frame["delivered"] == delivered]
        if subset.empty:
            continue
        figure.add_trace(
            go.Scatter(
                x=subset["t_rel"],
                y=subset["source_island"],
                mode="markers",
                name=name,
                marker=dict(color=colour, size=8, symbol=symbol, opacity=0.85),
                customdata=subset[["dest_island", "num_migrants"]],
                hovertemplate=(
                    "island %{y} → %{customdata[0]}<br>"
                    "%{customdata[1]} migrants<br>t=%{x:.2f}s<extra></extra>"
                ),
            )
        )
    figure.update_layout(
        title="Transfers over time",
        height=380,
        xaxis_title="seconds since run start",
        yaxis_title="source island",
        legend=dict(orientation="h", yanchor="bottom", y=1.0, x=0),
        margin=dict(l=76, r=16, t=56, b=44),
    )
    return figure


def render(run: Run) -> None:
    page_header(
        "The search",
        "Migration explorer",
        "Every individual that crossed between islands: where it went, how long it took, and "
        "whether it arrived at all.",
    )

    frame = run.migration_frame()
    if frame.empty:
        st.info("No migration events in this run.")
        return

    delivered = int(frame["delivered"].sum())
    total = len(frame)
    latency = frame["latency_seconds"].dropna() if "latency_seconds" in frame else []
    drift = frame["generational_drift"].dropna() if "generational_drift" in frame else []

    metrics = st.columns(5)
    metrics[0].metric("Migration events", f"{total:,}")
    metrics[1].metric("Individuals moved", f"{int(frame['num_migrants'].sum()):,}")
    metrics[2].metric(
        "Delivered", f"{delivered:,}",
        delta=f"-{total - delivered} undelivered" if total > delivered else None,
    )
    metrics[3].metric(
        "Median latency", f"{float(np.median(latency)) * 1000:.0f} ms" if len(latency) else "—"
    )
    metrics[4].metric(
        "Median drift", f"{float(np.median(drift)):.0f} gen" if len(drift) else "—",
        help="dest_generation − source_generation: how far ahead the receiver was.",
    )

    if total > delivered:
        caption(
            f"<b>{total - delivered}</b> transfers never arrived — the destination island had "
            "already terminated. A left join keeps them visible; an inner join would have "
            "silently dropped them."
        )

    st.markdown("---")

    left, right = st.columns(2, gap="large")
    with left:
        st.plotly_chart(_matrix_figure(frame, run.islands), use_container_width=True)
        caption(
            "A ring topology fills only the off-diagonal band; a fully-connected one fills "
            "everything. The shape of this matrix is the topology, recovered from the log."
        )
    with right:
        st.plotly_chart(_timeline_figure(frame), use_container_width=True)
        caption(
            "Gaps and clustering here reflect <code>migration_interval</code> and the fact that "
            "islands reach their migration points at different wall-clock moments."
        )

    with st.expander("Transfer records"):
        columns = [
            c
            for c in (
                "migration_id", "source_island", "dest_island", "source_generation",
                "dest_generation", "num_migrants", "latency_seconds", "generational_drift",
                "accepted", "selection_policy", "replacement_policy",
            )
            if c in frame.columns
        ]
        # Sort before selecting: t_rel is the ordering key but not a display column.
        ordered = frame.sort_values("t_rel") if "t_rel" in frame else frame
        st.dataframe(
            ordered[columns],
            hide_index=True,
            use_container_width=True,
            height=340,
        )

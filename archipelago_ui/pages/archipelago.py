"""The centrepiece: the Level 0 trajectory network in 3D."""

from __future__ import annotations

import pandas as pd
import plotly.graph_objects as go
import streamlit as st

from .. import theme
from .. import levels
from ..data import caption, get_stn, page_header, selected_level
from ..layout import edge_segments, project
from ..logreader import Run


def _controls(run: Run) -> dict:
    """Layout controls. Kept on the page, not the sidebar -- they *are* the view."""
    row = st.columns([1.05, 1.05, 1.05, 1.5, 1.1, 1.1])

    elevation = row[0].toggle(
        "Fitness elevation",
        value=True,
        help="Spend the vertical axis on fitness instead of a third principal component.",
    )
    territories = row[1].toggle(
        "Island territories",
        value=True,
        help="Give each island its own footprint instead of overlaying them all.",
    )
    show_migration = row[2].toggle(
        "Migration edges",
        value=True,
        help="On a run that migrates often these can crowd everything else out.",
    )
    islands = row[3].multiselect(
        "Islands", run.islands, default=run.islands, help="Filter to a subset."
    )
    edge_limit = row[4].select_slider(
        "Edges drawn", options=[0, 250, 1000, 3000, 10000], value=1000,
        help="Heaviest edges first. Drawing all of them is what makes a hairball.",
    )
    colour_by = row[5].radio("Colour by", ["Island", "Fitness"], horizontal=True)

    return {
        "elevation": elevation,
        "territories": territories,
        "show_migration": show_migration,
        "islands": islands,
        "edge_limit": edge_limit,
        "colour_by": colour_by,
    }


def _figure(stn, coords, options, run: Run) -> go.Figure:
    nodes = stn.nodes
    figure = go.Figure()

    # --- trajectory edges, drawn first so nodes sit on top -----------------
    if options["edge_limit"]:
        xs, ys, zs = edge_segments(stn.edges, coords, limit=options["edge_limit"])
        if xs:
            figure.add_trace(
                go.Scatter3d(
                    x=xs, y=ys, z=zs,
                    mode="lines",
                    line=dict(color=theme.TRAJECTORY, width=1),
                    hoverinfo="skip",
                    name="trajectory edge",
                )
            )

    # --- migration edges ---------------------------------------------------
    # Semi-transparent: on a fully-connected, every-generation run there are
    # hundreds of these and at full opacity they bury the nodes entirely.
    if options["show_migration"] and not stn.migrations.empty:
        xs, ys, zs = edge_segments(stn.migrations, coords, limit=None)
        if xs:
            figure.add_trace(
                go.Scatter3d(
                    x=xs, y=ys, z=zs,
                    mode="lines",
                    line=dict(color=theme.MIGRATION_SOFT, width=1.6),
                    hoverinfo="skip",
                    name=f"migration edge ({len(stn.migrations)})",
                )
            )

    # --- nodes -------------------------------------------------------------
    sizes = 3.0 + 2.4 * (nodes["visits"].clip(upper=8) ** 0.7)
    hover = [
        f"island {int(island)}<br>fitness {fitness:.4f}<br>visits {visits}"
        f"{'<br>visited by >1 island' if shared else ''}"
        for island, fitness, visits, shared in zip(
            nodes["island_id"], nodes["fitness"], nodes["visits"], nodes["shared"]
        )
    ]

    if options["colour_by"] == "Island":
        for island in sorted(nodes["island_id"].unique()):
            mask = (nodes["island_id"] == island).to_numpy()
            subset = coords[mask]
            figure.add_trace(
                go.Scatter3d(
                    x=subset["x"], y=subset["y"], z=subset["z"],
                    mode="markers",
                    marker=dict(
                        size=sizes[mask],
                        color=theme.island_colour(int(island)),
                        line=dict(width=0),
                        opacity=0.85,
                    ),
                    name=f"island {int(island)}",
                    text=[h for h, keep in zip(hover, mask) if keep],
                    hovertemplate="%{text}<extra></extra>",
                )
            )
    else:
        figure.add_trace(
            go.Scatter3d(
                x=coords["x"], y=coords["y"], z=coords["z"],
                mode="markers",
                marker=dict(
                    size=sizes,
                    color=nodes["fitness"],
                    colorscale="Viridis",
                    reversescale=not run.maximising,
                    line=dict(width=0),
                    opacity=0.88,
                    colorbar=dict(
                        title=dict(text="fitness", font=dict(color=theme.INK_SOFT, size=11)),
                        tickfont=dict(color=theme.INK_FAINT, size=9),
                        thickness=10, len=0.55, x=1.0,
                    ),
                ),
                name="node",
                text=hover,
                hovertemplate="%{text}<extra></extra>",
            )
        )

    # --- island bests, starred, on top -------------------------------------
    best_mask = nodes["is_island_best"].fillna(False).to_numpy()
    if best_mask.any():
        best = coords[best_mask]
        figure.add_trace(
            go.Scatter3d(
                x=best["x"], y=best["y"], z=best["z"],
                mode="markers",
                marker=dict(
                    size=7,
                    color=theme.ISLAND_BEST,
                    symbol="diamond",
                    line=dict(width=0.5, color=theme.DEEP),
                ),
                name="island best",
                hovertemplate="island best<extra></extra>",
            )
        )

    figure.update_layout(
        height=680,
        showlegend=True,
        legend=dict(orientation="h", yanchor="bottom", y=-0.06, x=0),
        margin=dict(l=0, r=0, t=8, b=0),
        scene=dict(
            xaxis=theme.scene_axis("component 1", show_ticks=False),
            yaxis=theme.scene_axis("component 2", show_ticks=False),
            zaxis=theme.scene_axis(
                "fitness" if options["elevation"] else "component 3", show_ticks=True
            ),
            aspectmode="cube",
            camera=dict(eye=dict(x=1.55, y=1.45, z=0.85)),
        ),
    )
    return figure


def render(run: Run) -> None:
    page_header(
        "The search",
        "Archipelago",
        "Every location the run actually visited. Each island keeps its own territory, and "
        "height is fitness — so convergence reads as descent and a stalled island reads as one "
        "that never gets down.",
    )

    options = _controls(run)
    if not options["islands"]:
        st.warning("Select at least one island.")
        return

    stn = get_stn(str(run.path), tuple(options["islands"]))
    if stn.n_nodes == 0:
        st.error("No decodable genomes in this run — nothing to place.")
        return

    # Abstraction level. Level 0 is the identity, so this is a no-op until the
    # clustering cascade registers a reducer -- see archipelago_ui/levels.py.
    level = selected_level()
    raw_nodes = stn.n_nodes
    if not level.available:
        st.info(
            f"**{level.label}** is not built yet — showing Level 0. {level.detail}",
            icon=":material/construction:",
        )
    reduction = levels.apply(level.key, stn, run)
    stn = reduction.stn

    projection = project(
        stn.nodes,
        elevation=options["elevation"],
        territories=options["territories"],
        maximising=run.maximising,
    )

    metrics = st.columns(5)
    metrics[0].metric("Nodes", f"{stn.n_nodes:,}")
    metrics[1].metric("Trajectory edges", f"{stn.n_edges:,}")
    metrics[2].metric("Migration edges", f"{len(stn.migrations):,}")
    metrics[3].metric("Shared locations", f"{int(stn.nodes['shared'].sum()):,}",
                      help="Visited by more than one island.")
    metrics[4].metric(
        "Variance kept",
        f"{projection.retained_variance:.0%}",
        help=f"By the {projection.components_used} projected component(s). "
             "The vertical axis is excluded when it carries fitness.",
        delta=(
            f"{raw_nodes / stn.n_nodes:.1f}x compression"
            if stn.n_nodes and stn.n_nodes < raw_nodes
            else None
        ),
        delta_color="off",
    )

    if reduction.diagnostics:
        with st.expander(f"{level.label} — what the reduction did"):
            st.dataframe(
                pd.DataFrame(
                    reduction.diagnostics.items(), columns=["measure", "value"]
                ),
                hide_index=True,
                use_container_width=True,
            )

    if projection.retained_variance < 0.40:
        caption(
            f"⚠️ The projection keeps only <b>{projection.retained_variance:.0%}</b> of the "
            "variance, so distances across the plane are unreliable — read the structure, not "
            "the spacing. This is a property of the space, not of the run."
        )

    st.plotly_chart(_figure(stn, projection.frame, options, run), use_container_width=True)

    caption(
        f"<b>{level.label}</b>. Node size is visit count, gold diamonds are island "
        f"bests, magenta is a migration. Vertical axis: <code>{projection.vertical}</code>. "
        f"Drag to orbit, scroll to zoom."
    )

"""The explanatory landing page.

Understandability is the primary goal of this frontend, so this page assumes
the reader has never opened an STN paper.
"""

from __future__ import annotations

import streamlit as st

from .. import theme
from ..data import caption, page_header

#: (name, detail, state). ``state`` is one of: "external" -- someone else runs
#: this and we read the result; "built" -- in this app today; "planned" -- the
#: seam exists, the implementation does not.
_STAGES = [
    ("Execution", "islands evolve in parallel and swap individuals", "external"),
    ("Logs", "every evaluation and migration, one schema", "external"),
    ("Clustering", "LSH → BIRCH → DenStream compress the stream", "planned"),
    ("Network", "trajectories become a graph, with migration edges", "built"),
    ("Analytics", "MMD compares what each island explored", "planned"),
]

_STATE_TAG = {
    "external": "produced elsewhere",
    "planned": "not yet built",
    "built": "",
}


def _flow() -> None:
    """The pipeline strip: what this app does, and what it deliberately does not."""
    cells = []
    for name, detail, state in _STAGES:
        colour = theme.TEAL if state == "built" else theme.INK_FAINT
        border = "rgba(79,191,179,.30)" if state == "built" else theme.RULE
        label = _STATE_TAG[state]
        tag = (
            f'<div style="font-size:10px;letter-spacing:.1em;text-transform:uppercase;'
            f'color:{theme.INK_FAINT};margin-top:6px;">{label}</div>'
            if label
            else ""
        )
        cells.append(
            f'<div style="flex:1 1 180px;min-width:170px;background:{theme.SURFACE};'
            f'border:1px solid {border};border-radius:3px;padding:14px 16px;">'
            f'<div style="font-size:13px;font-weight:600;color:{colour};'
            f'letter-spacing:.02em;">{name}</div>'
            f'<div style="font-size:12.5px;color:{theme.INK_SOFT};line-height:1.45;'
            f'margin-top:5px;">{detail}</div>{tag}</div>'
        )
    st.markdown(
        '<div style="display:flex;gap:10px;flex-wrap:wrap;margin:6px 0 8px 0;">'
        + "".join(cells)
        + "</div>",
        unsafe_allow_html=True,
    )


def render() -> None:
    page_header(
        "Archipelago",
        "Explaining what a distributed EA actually did",
        "A distributed evolutionary algorithm runs several populations at once and lets them "
        "trade individuals. Standard tools flatten all of that into a single fitness curve. "
        "This one keeps the islands apart and draws where each of them actually searched.",
    )

    _flow()
    caption(
        "Archipelago occupies the middle of that strip. It does not run searches — the harness "
        "does that locally and <b>Volpe</b> does it on the cluster — and it does not need the "
        "clustering stage to draw anything: the current view is <b>Level 0</b>, one node per "
        "location actually visited."
    )

    st.markdown("---")

    left, right = st.columns(2, gap="large")

    with left:
        st.markdown("### The vocabulary")
        st.markdown(
            f"""
<div style="color:{theme.INK_SOFT};font-size:15px;line-height:1.6;">
<p><b style="color:{theme.INK};">Island</b> — one independent subpopulation running its own
copy of the algorithm. Islands are <i>asynchronous</i>: island 2 being on generation 9 says
nothing about where island 3 is at the same moment.</p>

<p><b style="color:{theme.INK};">Migration</b> — individuals periodically copied from one
island to another, along a topology (a ring, or fully connected). This is the mechanism
that makes a distributed EA more than several separate runs.</p>

<p><b style="color:{theme.INK};">STN node</b> — one location in the search space. Two
evaluations that land in the same place become the same node, which is what turns a list of
evaluations into a graph.</p>

<p><b style="color:{theme.INK};">Migration edge</b> — a cross-island edge, drawn in
magenta throughout this app. It is the one visual element the whole platform exists for.</p>
</div>
""",
            unsafe_allow_html=True,
        )

    with right:
        st.markdown("### Why a fitness curve isn't enough")
        st.markdown(
            f"""
<div style="color:{theme.INK_SOFT};font-size:15px;line-height:1.6;">
<p>A convergence plot tells you the best score improved. It cannot tell you
<i>why</i>, and in a distributed run the interesting answers are all structural:</p>
<ul style="margin:10px 0 0 0;padding-left:1.15em;">
  <li>Were the islands exploring different regions, or all grinding over the same one?</li>
  <li>Did a migration actually move the receiving island somewhere new?</li>
  <li>Which island found the best solution, and did that discovery spread?</li>
  <li>Did an island stall, and how long before anyone could tell?</li>
</ul>
<p style="margin-top:12px;">Each of those is a question about <i>shape</i>, which is why this
is a graph tool and not a chart tool.</p>
</div>
""",
            unsafe_allow_html=True,
        )

    st.markdown("---")
    st.markdown("### Where this sits")
    st.markdown(
        f"""
<div style="color:{theme.INK_SOFT};font-size:15px;line-height:1.6;max-width:82ch;">
<p>Archipelago is the <b style="color:{theme.INK};">analysis</b> layer, and only that. It
does not schedule jobs, hold cluster credentials or own a worker pool, because it never
executes a search: <b style="color:{theme.INK};">Volpe</b> already runs jobs, and the
baseline harness runs them locally. Duplicating that would be work with no result attached.</p>
<p>What it consumes is a finished run in the schema 2.0 layout. That is the entire interface,
which is what makes a run from a laptop and a run from Volpe the same object here — and why
connecting the two later is a matter of pointing at a directory, not a rewrite.</p>
<p>Bring a run in on the <b style="color:{theme.TEAL};">Runs</b> page: upload a zip, drop in
the loose files, or point at a path this machine can already see.</p>
</div>
""",
        unsafe_allow_html=True,
    )

    st.markdown("---")
    st.markdown("### A note on the vertical axis")
    st.markdown(
        f"""
<div style="color:{theme.INK_SOFT};font-size:15px;line-height:1.6;max-width:82ch;">
<p>Search spaces usually have many more than three dimensions. Squeezing one into three
typically keeps well under half of the variance, which is why a naive 3D scatter of a
continuous run tends to look like a shapeless blob.</p>
<p>So the <b style="color:{theme.INK};">Archipelago</b> view spends only two axes on
position and gives the third to <b style="color:{theme.TEAL};">fitness</b>. Little is lost —
that third component is usually mostly noise — and the picture becomes a landscape: good
regions are low, and you can watch each island descend into its own basin. Every 3D view
reports how much variance its projection actually kept, so a poor projection is never
mistaken for a poor result.</p>
<p>You can turn this off. The toggle is on the Archipelago page.</p>
</div>
""",
        unsafe_allow_html=True,
    )

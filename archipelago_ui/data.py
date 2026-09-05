"""Cached accessors, the run selector, and the shared page furniture.

Every page reads the current run through here, so a run is parsed once per
session no matter how many pages look at it.
"""

from __future__ import annotations

from pathlib import Path

import streamlit as st

from . import levels
from .logreader import Run, discover_runs, load_run
from .stn import STN, build_stn

#: Where runs live. Anything with the schema 2.0 layout works.
DATA_ROOT = Path(__file__).resolve().parent.parent / "data"

VERSION = "v0.2"

#: Sidebar key for the selected abstraction level.
LEVEL_STATE = "abstraction_level"


@st.cache_data(show_spinner=False)
def get_run(path: str) -> Run:
    return load_run(path)


@st.cache_data(show_spinner="Building the trajectory network…")
def get_stn(path: str, islands: tuple[int, ...] | None = None) -> STN:
    return build_stn(get_run(path), list(islands) if islands else None)


@st.cache_data(show_spinner=False)
def available_runs(root: str) -> list[str]:
    return [str(p) for p in discover_runs(root)]


def invalidate() -> None:
    """Drop every cached read. Called after the library changes on disk."""
    get_run.clear()
    get_stn.clear()
    available_runs.clear()


def selected_level() -> levels.Level:
    """The abstraction level chosen in the sidebar. Falls back to Level 0."""
    key = st.session_state.get(LEVEL_STATE, "level0")
    try:
        return levels.get(key)
    except KeyError:
        return levels.get("level0")


# --------------------------------------------------------------------------
# sidebar
# --------------------------------------------------------------------------


def _level_picker() -> None:
    """Abstraction level. Only Level 0 is built; the rest show what is coming."""
    # Options are keys, not Level objects: a widget's value lands in session
    # state, and selected_level() has to be able to look it up from there.
    def label(key: str) -> str:
        level = levels.get(key)
        return level.label if level.available else f"{level.label} · not built yet"

    st.selectbox(
        "Abstraction level",
        [level.key for level in levels.all_levels()],
        format_func=label,
        key=LEVEL_STATE,
        help="How much the trajectory network is collapsed before it is drawn.",
    )
    chosen = selected_level()
    st.caption(chosen.summary if chosen.available else f"⋯ {chosen.summary} Falling back to Level 0.")


def run_selector() -> Run | None:
    """Sidebar run picker. Returns the selected run, or None if there are none."""
    paths = available_runs(str(DATA_ROOT))

    with st.sidebar:
        st.markdown(
            '<p class="eyebrow">Archipelago</p>'
            f'<span class="badge">{VERSION}</span>',
            unsafe_allow_html=True,
        )
        st.markdown("")

        if not paths:
            return None

        def label(path: str) -> str:
            run = get_run(path)
            return f"{run.algorithm} / {run.benchmark} · {len(run.islands)} islands"

        chosen = st.selectbox(
            "Run",
            paths,
            format_func=label,
            help="Any directory following the schema 2.0 run layout. Add more on the Runs page.",
        )
        run = get_run(chosen)
        st.caption(f"`{run.run_id}`")

        st.markdown("")
        _level_picker()

    return run


def sidebar_footer(run: Run) -> None:
    """Run facts and the standing caveat, below the navigation."""
    with st.sidebar:
        st.markdown("---")
        st.caption(
            f"**{run.algorithm}** on **{run.benchmark}**  \n"
            f"{len(run.islands)} islands · {len(run.evaluations):,} evaluations · "
            f"{'maximising' if run.maximising else 'minimising'}"
        )


# --------------------------------------------------------------------------
# page furniture
# --------------------------------------------------------------------------


def page_header(eyebrow: str, title: str, deck: str) -> None:
    """Consistent page opening: eyebrow, title, one-line explanation."""
    st.markdown(f'<p class="eyebrow">{eyebrow}</p>', unsafe_allow_html=True)
    st.markdown(f"# {title}")
    st.markdown(f'<p class="deck">{deck}</p>', unsafe_allow_html=True)


def caption(text: str) -> None:
    st.markdown(f'<p class="caption">{text}</p>', unsafe_allow_html=True)

"""Archipelago — explainability frontend for distributed evolutionary algorithms.

Run with::

    streamlit run app.py

Reads runs written by FYP-Archipelago/baseline-dEA in the schema 2.0 layout. It
imports nothing from the harness and nothing from the clustering pipeline: the
log format is the only coupling point, which is the same rule the harness itself
follows. Runs are produced elsewhere — locally, or on Volpe — and read here.
"""

from __future__ import annotations

import streamlit as st

from archipelago_ui import theme
from archipelago_ui.data import VERSION, run_selector, sidebar_footer
from archipelago_ui.pages import (
    archipelago,
    convergence,
    library,
    migration,
    overview,
    run_browser,
)


def _page(render, title: str, icon: str, url_path: str) -> st.Page:
    return st.Page(render, title=title, icon=f":material/{icon}:", url_path=url_path)


def main() -> None:
    st.set_page_config(
        page_title="Archipelago",
        page_icon="🏝️",
        layout="wide",
        initial_sidebar_state="expanded",
    )
    theme.register_template()
    st.markdown(theme.CSS, unsafe_allow_html=True)

    run = run_selector()

    if run is None:
        # No runs yet. Rather than a dead end, hand the user the page that fixes
        # it -- the library is where a run arrives.
        with st.sidebar:
            st.info("No runs loaded yet.")
        st.navigation(
            [
                st.Page(library.render, title="Runs", icon=":material/inventory_2:", default=True),
                st.Page(overview.render, title="Overview", icon=":material/insights:"),
            ]
        ).run()
        return

    pages = {
        "Analyse": [
            st.Page(
                lambda: archipelago.render(run),
                title="Archipelago",
                icon=":material/scatter_plot:",
                url_path="archipelago",
                default=True,
            ),
            _page(lambda: migration.render(run), "Migration", "sync_alt", "migration"),
            _page(lambda: convergence.render(run), "Convergence", "trending_down", "convergence"),
        ],
        "The run": [
            _page(lambda: run_browser.render(run), "Run browser", "description", "run"),
            _page(library.render, "Runs", "inventory_2", "library"),
        ],
        "About": [
            _page(overview.render, "Overview", "insights", "overview"),
        ],
    }

    navigation = st.navigation(pages)
    sidebar_footer(run)
    navigation.run()

    st.markdown(
        f'<p class="caption" style="margin-top:36px;">Archipelago {VERSION} · '
        "Team 21, Amrita Vishwa Vidyapeetham · reads schema 2.0 run logs</p>",
        unsafe_allow_html=True,
    )


if __name__ == "__main__":
    main()

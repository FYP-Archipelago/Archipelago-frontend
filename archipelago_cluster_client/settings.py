"""Where the clustering service is.

One setting, three places it can come from, in this order: what the user typed
into the sidebar this session, ``ARCHIPELAGO_API_URL`` in the environment, and
localhost. The sidebar entry exists because the service is a separate process
and telling someone to restart Streamlit with a different environment variable
is a poor answer to "it's on the other machine".
"""

from __future__ import annotations

import streamlit as st

from .api import DEFAULT_BASE_URL

URL_STATE = "cluster_api_url"


def base_url() -> str:
    return st.session_state.get(URL_STATE) or DEFAULT_BASE_URL


def url_input() -> None:
    """A text box for the service URL. Render it wherever it belongs."""
    st.text_input(
        "Clustering service",
        value=base_url(),
        key=URL_STATE,
        help="The archipelago-api service. Defaults to ARCHIPELAGO_API_URL, "
             "then http://127.0.0.1:8000.",
    )

"""Streamlit wrapper around the WebGL2 viewer in ``frontend/``."""

from __future__ import annotations

from pathlib import Path

import streamlit.components.v1 as components

_FRONTEND = Path(__file__).resolve().parent / "frontend"

# Registered once at import; Streamlit serves ``frontend/`` as static files.
_component = components.declare_component("archipelago_stn_viewer", path=str(_FRONTEND))


def stn_viewer(payload: dict, *, stage_height: int | None = None, key: str | None = None) -> None:
    """Draw ``payload`` (see ``payload.build_payload``) in the WebGL2 viewer."""
    _component(payload=payload, stage_height=stage_height, key=key, default=None)

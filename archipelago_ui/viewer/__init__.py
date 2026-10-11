"""The WebGL2 STN viewer, as a Streamlit component.

``frontend/`` is plain JavaScript with no build step; ``payload`` turns a loaded
run into the per-evaluation stream it consumes.
"""

from .component import stn_viewer

__all__ = ["stn_viewer"]

"""The seam between the Archipelago frontend and the dEA clustering pipeline.

Importing this package does two things to the app, and nothing else:

* registers a **clustering panel** on the Runs page, where a user picks a run,
  picks which of LSH / BIRCH / DenStream to execute, and presses the button that
  calls the REST API;
* registers the **Clustered** abstraction level, which draws a result already
  produced. That page never runs the pipeline: it picks between finished
  results, so looking at a graph cannot start work.

Both point inward — this package imports ``archipelago_ui``; the UI never imports
this. One line in ``app.py`` turns it on:

    import archipelago_cluster_client

Nothing here clusters anything. The work happens in ``archipelago-api``, which
calls into ``dEA-clustering`` unmodified; this side sends a run and a stage
selection over HTTP and turns the labels that come back into a collapsed STN.
"""

from . import panel as _panel  # noqa: F401 -- registers the Runs page panel
from . import levels as _levels  # noqa: F401 -- registers the abstraction levels
from .api import ClusterUnavailable, cluster_run, health, stage_order
from .settings import base_url, url_input

__all__ = [
    "ClusterUnavailable",
    "cluster_run",
    "health",
    "stage_order",
    "base_url",
    "url_input",
]

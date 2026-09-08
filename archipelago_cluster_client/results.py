"""Finished clustering runs, kept so they can be chosen between.

Pressing **Run clustering** on the Runs page produces a result. This is where it
goes. Nothing is recomputed to look at it again, and nothing is thrown away when
the next one is run: clustering the same run with LSH only and then with all
three leaves *both* available, and the Archipelago page picks which to draw.

That is the whole reason this module exists rather than a single "last result"
slot. A comparison between two configurations is the point of a toggleable
pipeline, and you cannot compare what has been overwritten.

Results live for the session. They are cheap to recreate — the API caches on
(run, stages, parameters), so re-running an identical configuration after a
restart costs one round trip and no clustering.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

import streamlit as st

from .api import ClusterResponse

#: Session keys. Plain, not widget keys: these must survive a page change.
RESULTS_STATE = "cluster_results"
SELECTED_STATE = "cluster_selected_result"


@dataclass(frozen=True)
class ClusterRun:
    """One completed execution of the pipeline."""

    id: str
    run_id: str
    #: The stages that actually executed, in cascade order, as the API reported
    #: them -- not as they were requested.
    stages: tuple[str, ...]
    parameters: dict[str, Any] = field(default_factory=dict)
    response: ClusterResponse | None = None
    at: str = ""

    @property
    def stage_label(self) -> str:
        return " → ".join(self.stages) if self.stages else "no stages (Level 0)"

    @property
    def nodes(self) -> int:
        return int(self.response.counts.get("nodes", 0)) if self.response else 0

    @property
    def level0_nodes(self) -> int:
        return int(self.response.counts.get("level0_nodes", 0)) if self.response else 0

    @property
    def compression(self) -> float:
        return self.level0_nodes / self.nodes if self.nodes else 0.0

    def label(self) -> str:
        """What the picker shows. Configuration first: it is what distinguishes
        one result from another, and the counts are the consequence."""
        parts = [self.stage_label, f"{self.nodes:,} nodes"]
        if self.compression > 1:
            parts.append(f"{self.compression:.1f}×")
        if self.parameters:
            parts.append("tuned")
        return " · ".join(parts) + f"  ({self.at})"


def _identity(run_id: str, stages: tuple[str, ...], parameters: dict[str, Any]) -> str:
    """A result is identified by what produced it, so re-running the same
    configuration updates that entry rather than adding a duplicate."""
    tuned = ",".join(f"{k}={v}" for k, v in sorted(parameters.items()))
    return f"{run_id}|{'+'.join(stages) or 'level0'}|{tuned}"


def _store() -> dict[str, ClusterRun]:
    return st.session_state.setdefault(RESULTS_STATE, {})


def record(response: ClusterResponse, parameters: dict[str, Any]) -> ClusterRun:
    """File a completed run and make it the selected one."""
    stages = tuple(response.stages_executed)
    entry = ClusterRun(
        id=_identity(response.run_id, stages, parameters),
        run_id=response.run_id,
        stages=stages,
        parameters=dict(parameters),
        response=response,
        at=datetime.now().strftime("%H:%M:%S"),
    )
    _store()[entry.id] = entry
    st.session_state[SELECTED_STATE] = entry.id
    return entry


def for_run(run_id: str) -> list[ClusterRun]:
    """Every result for one dEA run, newest first.

    Scoped to the run because a result's labels are keyed by that run's node
    keys. Offering another run's result here would produce a graph where nothing
    matched and every node fell back to a singleton -- a picture that looks like
    a failed clustering rather than a mistake in the picker.
    """
    entries = [e for e in _store().values() if e.run_id == run_id]
    return sorted(entries, key=lambda e: e.at, reverse=True)


def get(identity: str) -> ClusterRun | None:
    return _store().get(identity)


def select(identity: str) -> None:
    st.session_state[SELECTED_STATE] = identity


def selected_for(run_id: str) -> ClusterRun | None:
    """The chosen result, if it belongs to ``run_id``.

    Switching the dEA run in the sidebar leaves a selection pointing at a result
    for the previous one; that is not an error, it just does not apply here, so
    the newest result for the current run takes over.
    """
    candidates = for_run(run_id)
    if not candidates:
        return None
    chosen = st.session_state.get(SELECTED_STATE)
    for entry in candidates:
        if entry.id == chosen:
            return entry
    return candidates[0]


def count() -> int:
    return len(_store())

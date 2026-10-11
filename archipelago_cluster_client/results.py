"""Finished clustering runs, kept so they can be chosen between.

Pressing **Run clustering** on the Runs page produces a result. This is where it
goes. Nothing is recomputed to look at it again, and nothing is thrown away when
the next one is run: clustering the same run with LSH only and then with all
three leaves *both* available, and the Archipelago page picks which to draw.

That is the whole reason this module exists rather than a single "last result"
slot. A comparison between two configurations is the point of a toggleable
pipeline, and you cannot compare what has been overwritten.

Results are kept on disk as well as in the session, under
``data/.cluster_results/<run id>/``, so they survive a browser reload and a
restart of the app. A saved result is tied to the run's ``evaluations.csv`` by
size and modification time: if the run is replaced, its old labels no longer
describe it and are ignored rather than drawn as a broken clustering.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import asdict, dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any

import streamlit as st

from archipelago_ui.data import DATA_ROOT

from .api import ClusterResponse

#: Session keys. Plain, not widget keys: these must survive a page change.
RESULTS_STATE = "cluster_results"
SELECTED_STATE = "cluster_selected_result"
_LOADED_STATE = "cluster_results_loaded"

#: Where finished results are kept between sessions. Hidden, so run discovery
#: (which looks for evaluations.csv in each directory) never mistakes it for a run.
STORE_ROOT = Path(DATA_ROOT) / ".cluster_results"


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
    #: ISO timestamp, for ordering across days; ``at`` is only for display.
    stamp: str = ""

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


# --------------------------------------------------------------------------
# disk
# --------------------------------------------------------------------------


def _signature(run_id: str) -> list[int] | None:
    """Size and mtime of the run's evaluations.csv, or None if it is gone."""
    try:
        info = (Path(DATA_ROOT) / run_id / "evaluations.csv").stat()
    except OSError:
        return None
    return [info.st_size, info.st_mtime_ns]


def _file_for(entry: ClusterRun) -> Path:
    digest = hashlib.sha1(entry.id.encode("utf-8")).hexdigest()[:16]
    return STORE_ROOT / entry.run_id / f"{digest}.json"


def _save(entry: ClusterRun) -> None:
    """Write a result next to the others. Never raises: a read-only disk should
    cost persistence, not the result the user just waited for."""
    if entry.response is None:
        return
    try:
        path = _file_for(entry)
        path.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            "id": entry.id,
            "run_id": entry.run_id,
            "stages": list(entry.stages),
            "parameters": entry.parameters,
            "at": entry.at,
            "stamp": entry.stamp,
            "signature": _signature(entry.run_id),
            "response": asdict(entry.response),
        }
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps(payload), encoding="utf-8")
        tmp.replace(path)
    except (OSError, TypeError, ValueError):
        pass


def _load_all() -> dict[str, ClusterRun]:
    found: dict[str, ClusterRun] = {}
    if not STORE_ROOT.exists():
        return found
    for path in STORE_ROOT.glob("*/*.json"):
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
            if raw.get("signature") != _signature(raw["run_id"]):
                continue  # the run changed (or vanished): these labels are stale
            entry = ClusterRun(
                id=raw["id"],
                run_id=raw["run_id"],
                stages=tuple(raw["stages"]),
                parameters=dict(raw.get("parameters", {})),
                response=ClusterResponse(**raw["response"]),
                at=raw.get("at", ""),
                stamp=raw.get("stamp", ""),
            )
        except (OSError, ValueError, KeyError, TypeError):
            continue  # a corrupt or older-format file is skipped, not fatal
        found[entry.id] = entry
    return found


def _store() -> dict[str, ClusterRun]:
    store = st.session_state.setdefault(RESULTS_STATE, {})
    if not st.session_state.get(_LOADED_STATE):
        # Once per session. Anything produced earlier in this session wins over
        # the disk copy, so a re-run is never overwritten by what it replaced.
        for key, entry in _load_all().items():
            store.setdefault(key, entry)
        st.session_state[_LOADED_STATE] = True
    return store


def record(response: ClusterResponse, parameters: dict[str, Any]) -> ClusterRun:
    """File a completed run, keep it on disk, and make it the selected one."""
    stages = tuple(response.stages_executed)
    now = datetime.now()
    entry = ClusterRun(
        id=_identity(response.run_id, stages, parameters),
        run_id=response.run_id,
        stages=stages,
        parameters=dict(parameters),
        response=response,
        at=now.strftime("%d %b %H:%M"),
        stamp=now.isoformat(timespec="seconds"),
    )
    _store()[entry.id] = entry
    _save(entry)
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
    return sorted(entries, key=lambda e: e.stamp or e.at, reverse=True)


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

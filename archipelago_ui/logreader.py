"""Read side of the Archipelago log contract (schema 2.0).

This module knows how to turn a ``runs/<run id>/`` directory into dataframes.
It reads the contract and nothing else -- no import from the dEA harness, no
import from the clustering pipeline -- which is the same decoupling rule
``archipelago_logging`` itself follows.

Directory layout it expects, per ``docs/RUNNING.md`` in baseline-dEA::

    <run id>/
      evaluations.csv          one row per evaluated individual
      evaluations.schema.json  the CSV's column contract
      run.jsonl                every other event
      resolved_config.yaml     the configuration actually used
      summary.json             machine-readable outcome
"""

from __future__ import annotations

import base64
import json
import struct
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import pandas as pd

# Genome encodings whose "position" is a plain vector of floats.
_REAL_ENCODINGS = {"real_vector", "real_vector_velocity", "real_vector_sigma"}


# --------------------------------------------------------------------------
# genome decoding
#
# Mirrors archipelago_logging.genome.decode_compact. Reimplemented here rather
# than imported so the frontend can read a run without the harness installed;
# the packing is part of the published contract, so this is safe to depend on.
# --------------------------------------------------------------------------


def _unpack_floats(text: str) -> list[float]:
    """Little-endian float64, base64'd -- ``_pack_floats`` in the contract."""
    raw = base64.b64decode(text)
    return list(struct.unpack(f"<{len(raw) // 8}d", raw))


def _unpack_bits(text: str) -> list[float]:
    """``<length>:<base64>``, 8 bits to the byte."""
    length_text, _, payload = text.partition(":")
    length = int(length_text)
    packed = base64.b64decode(payload)
    return [float((packed[i // 8] >> (i % 8)) & 1) for i in range(length)]


def _unpack_ints(text: str) -> list[float]:
    """Little-endian uint32 -- permutation encoding."""
    raw = base64.b64decode(text)
    return [float(v) for v in struct.unpack(f"<{len(raw) // 4}I", raw)]


def decode_genome(encoding: str, repr_mode: str, payload) -> list[float] | None:
    """Return a genome's position as a float vector, or None if undecodable.

    Handles both ``compact`` and ``full`` modes because a single run mixes them:
    island bests are written in full, everything else compact.
    """
    if payload is None or (isinstance(payload, float) and np.isnan(payload)):
        return None
    if repr_mode == "hashed":
        return None

    text = str(payload)

    if repr_mode == "full":
        try:
            value = json.loads(text)
        except json.JSONDecodeError:
            return None
        if isinstance(value, dict):  # composite encodings keep position under "x"
            value = value.get("x")
        if isinstance(value, list):
            try:
                return [float(v) for v in value]
            except (TypeError, ValueError):
                return None
        return None

    # compact
    try:
        if encoding == "bitstring":
            return _unpack_bits(text)
        if encoding == "permutation":
            return _unpack_ints(text)
        if encoding in _REAL_ENCODINGS:
            if text.startswith("{"):  # composite: {"x": ..., "v": ...}
                return _unpack_floats(json.loads(text)["x"])
            return _unpack_floats(text)
    except (ValueError, KeyError, struct.error, json.JSONDecodeError):
        return None
    return None


# --------------------------------------------------------------------------
# the run
# --------------------------------------------------------------------------


@dataclass(frozen=True)
class Run:
    """One loaded run: the evaluation table plus every other event."""

    run_id: str
    path: Path
    evaluations: pd.DataFrame
    events: list[dict]
    summary: dict

    # -- convenience accessors over the event stream ------------------------

    def event(self, event_type: str) -> list[dict]:
        return [e for e in self.events if e.get("type") == event_type]

    def first(self, event_type: str) -> dict:
        found = self.event(event_type)
        return found[0] if found else {}

    @property
    def run_start(self) -> dict:
        return self.first("run_start")

    @property
    def run_end(self) -> dict:
        return self.first("run_end")

    @property
    def islands(self) -> list[int]:
        return sorted(int(i) for i in self.evaluations["island_id"].dropna().unique())

    @property
    def algorithm(self) -> str:
        return self.run_start.get("algorithm", "?")

    @property
    def benchmark(self) -> str:
        return self.run_start.get("benchmark", "?")

    @property
    def maximising(self) -> bool:
        """Fitness orientation, taken from any generation_end record."""
        for event in self.events:
            if event.get("type") == "generation_end" and "maximising" in event:
                return bool(event["maximising"])
        return False

    def generation_frame(self) -> pd.DataFrame:
        """generation_end events as a frame, with a run-relative time column."""
        rows = self.event("generation_end")
        if not rows:
            return pd.DataFrame()
        frame = pd.DataFrame(rows)
        frame["t_rel"] = frame["t_wall"] - frame["t_wall"].min()
        return frame.sort_values(["island_id", "generation"])

    def migration_frame(self) -> pd.DataFrame:
        """migration_send left-joined to its migration_arrive on migration_id.

        A left join, not an inner one: sends with no arrival are exactly the
        undelivered migrants, and losing them would hide a real behaviour.
        """
        sends = self.event("migration_send")
        if not sends:
            return pd.DataFrame()

        send = pd.DataFrame(sends)[
            [
                "migration_id",
                "source_island",
                "dest_island",
                "source_generation",
                "num_migrants",
                "topology",
                "selection_policy",
                "t_wall",
            ]
        ]

        arrivals = self.event("migration_arrive")
        if arrivals:
            arrive = pd.DataFrame(arrivals)
            keep = [
                c
                for c in (
                    "migration_id",
                    "dest_generation",
                    "accepted",
                    "latency_seconds",
                    "generational_drift",
                    "replacement_policy",
                )
                if c in arrive.columns
            ]
            merged = send.merge(arrive[keep], on="migration_id", how="left")
        else:
            merged = send.assign(dest_generation=np.nan, accepted=np.nan)

        merged["delivered"] = merged.get("accepted").notna() & (
            merged.get("accepted") != False  # noqa: E712 -- NaN must stay falsy-but-unknown
        )
        merged["t_rel"] = merged["t_wall"] - merged["t_wall"].min()
        return merged


def _coerce(frame: pd.DataFrame) -> pd.DataFrame:
    """Give the CSV its types back. ``1/0/empty`` booleans per the contract."""
    for column in ("island_id", "seq", "eval_index", "generation", "genome_dim"):
        if column in frame:
            frame[column] = pd.to_numeric(frame[column], errors="coerce").astype("Int64")
    for column in ("fitness", "objective", "constraint_violation", "t_wall", "origin_island"):
        if column in frame:
            frame[column] = pd.to_numeric(frame[column], errors="coerce")
    for column in ("is_island_best", "feasible"):
        if column in frame:
            frame[column] = frame[column].map({1: True, 0: False, "1": True, "0": False})
    if "parent_ids" in frame:
        frame["parent_ids"] = frame["parent_ids"].fillna("")
    return frame


def load_run(path: str | Path) -> Run:
    """Load one run directory."""
    path = Path(path)

    evaluations = _coerce(pd.read_csv(path / "evaluations.csv", dtype={"parent_ids": str}))
    evaluations["t_rel"] = evaluations["t_wall"] - evaluations["t_wall"].min()

    events: list[dict] = []
    jsonl = path / "run.jsonl"
    if jsonl.exists():
        with jsonl.open(encoding="utf-8") as handle:
            for line in handle:
                line = line.strip()
                if line:
                    try:
                        events.append(json.loads(line))
                    except json.JSONDecodeError:
                        continue  # a truncated tail is not a reason to fail the load

    summary_path = path / "summary.json"
    summary = json.loads(summary_path.read_text(encoding="utf-8")) if summary_path.exists() else {}

    return Run(path.name, path, evaluations, events, summary)


def discover_runs(root: str | Path) -> list[Path]:
    """Every run directory under ``root``, newest first by name.

    Run ids are timestamp-prefixed, so a reverse name sort is a time sort.
    """
    root = Path(root)
    if not root.exists():
        return []
    found = [p for p in root.iterdir() if p.is_dir() and (p / "evaluations.csv").exists()]
    return sorted(found, key=lambda p: p.name, reverse=True)

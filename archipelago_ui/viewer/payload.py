"""A loaded run, as the per-evaluation stream the WebGL viewer consumes.

The viewer does its own aggregation (cluster granularity, backbone, explode are
all client-side controls), so what it needs is the raw log in a shape that costs
little to ship: group-major float32 arrays, one group per island.

  * ``x``, ``y``   -- a 2D PCA of the decoded genomes, fitted ONCE over every
                      evaluation of the run and then frozen, scaled into
                      [-0.99, 0.99]. One projection for all islands is what
                      makes identical coordinates mean identical genomes.
  * ``fitness``    -- oriented so lower is better (negated when the run is
                      maximising; orientation comes from ``generation_end``).
  * ``parent_ptr/idx`` -- CSR of each sample's same-island parents (lineage edges).
  * ``migrations`` -- int32 quads (send sample, arrive sample, src group,
                      dst group), one per migrant, read from ``migration_arrive``.
"""

from __future__ import annotations

import base64

import numpy as np

from ..layout import _pca
from ..logreader import Run, decode_genome


def _b64(array: np.ndarray, dtype) -> str:
    return base64.b64encode(np.ascontiguousarray(array, dtype=dtype).tobytes()).decode("ascii")


def build_payload(run: Run) -> dict | None:
    """Return the viewer payload for ``run``, or None if nothing is drawable."""
    frame = run.evaluations.dropna(subset=["island_id", "eval_index", "fitness"])
    if frame.empty:
        return None

    positions = [
        decode_genome(enc, mode, payload)
        for enc, mode, payload in zip(
            frame["genome_encoding"], frame["genome_repr_mode"], frame["genome_repr"]
        )
    ]
    keep = np.array([p is not None for p in positions])
    if not keep.any():
        return None

    frame = frame[keep]
    positions = [p for p in positions if p is not None]

    # Group-major, trajectory order within a group: eval_index is per island,
    # gap-free and monotonic, so it needs no clock reconciliation.
    order = np.lexsort((frame["eval_index"].to_numpy(), frame["island_id"].to_numpy()))
    frame = frame.iloc[order].reset_index(drop=True)
    positions = [positions[i] for i in order]

    width = max(len(p) for p in positions)
    matrix = np.zeros((len(positions), width), dtype=float)
    for row, vector in enumerate(positions):
        matrix[row, : len(vector)] = vector

    scores, ratio = _pca(matrix, max(2, min(3, width)))
    xy = np.zeros((len(matrix), 2))
    for axis in range(2):
        column = scores[:, axis]
        low, high = float(column.min()), float(column.max())
        span = high - low
        xy[:, axis] = 0.0 if span < 1e-12 else ((column - low) / span * 2.0 - 1.0) * 0.99

    fitness = frame["fitness"].to_numpy(dtype=float)
    sign = -1.0 if run.maximising else 1.0

    island_ids = sorted(int(i) for i in frame["island_id"].unique())
    group_of = {island: g for g, island in enumerate(island_ids)}
    groups = frame["island_id"].astype(int).map(group_of).to_numpy()
    lengths = np.bincount(groups, minlength=len(island_ids))

    # individual_id -> index into the arrays above, for the migration join.
    sample_of = dict(zip(frame["individual_id"], range(len(frame))))
    quads: list[int] = []
    seen: set[tuple[int, int]] = set()
    for event in run.event("migration_arrive"):
        for origin_id, arrived_id in zip(
            event.get("origin_individual_ids", []), event.get("arrived_individual_ids", [])
        ):
            a, b = sample_of.get(origin_id), sample_of.get(arrived_id)
            if a is None or b is None or (a, b) in seen:
                continue
            seen.add((a, b))
            quads += [a, b, int(groups[a]), int(groups[b])]

    # Trajectory edges are lineage: parent -> child, within an island. A log's
    # consecutive eval_index rows are different population members, not a path,
    # so linking neighbours would draw edges that never happened. A parent on
    # another island is a migrated copy and belongs to the migration layer.
    ptr = [0]
    pidx: list[int] = []
    for i, text in enumerate(frame["parent_ids"].fillna("").astype(str)):
        for parent in text.split(";"):
            j = sample_of.get(parent)
            if j is not None and j != i and groups[j] == groups[i]:
                pidx.append(j)
        ptr.append(len(pidx))

    start = run.run_start
    topology = None
    for event in run.event("migration_send"):
        topology = event.get("topology")
        break

    return {
        "run_id": run.run_id,
        "tag": "THIS RUN",
        "title": f"{run.algorithm} / {run.benchmark}",
        "x": _b64(xy[:, 0], np.float32),
        "y": _b64(xy[:, 1], np.float32),
        "fitness": _b64(fitness * sign, np.float32),
        "fit_sign": sign,
        "group_lengths": [int(v) for v in lengths],
        "island_ids": island_ids,
        "migrations": _b64(np.array(quads, dtype=np.int32), np.int32),
        "parent_ptr": _b64(np.array(ptr, dtype=np.int32), np.int32),
        "parent_idx": _b64(np.array(pidx, dtype=np.int32), np.int32),
        "hashes": [str(h) for h in frame["genome_hash"].fillna("")],
        "topology": f"{topology} topology" if topology else "",
        "variance_kept": float(ratio[:2].sum()),
        "algorithm": start.get("algorithm"),
    }

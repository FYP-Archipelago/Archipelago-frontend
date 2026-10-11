"""Pipeline results, as a cluster id per evaluation for the viewer.

A clustering result assigns each Level 0 node key (``"<island>:<genome_hash>"``)
to a cluster. The viewer draws per-evaluation samples, so this maps every sample
to its cluster id. A sample the result does not cover keeps a cluster of its own
rather than being merged into some default -- the same rule ``levels.collapse``
follows, because merging them would invent a cluster nobody computed.
"""

from __future__ import annotations

import base64
from collections.abc import Mapping
from typing import Any

import numpy as np


def with_clusters(payload: dict, assignments: Mapping[str, Any], *, cluster_id: str,
                  label: str) -> dict:
    """Return a copy of ``payload`` carrying per-sample cluster ids."""
    islands = np.repeat(payload["island_ids"], payload["group_lengths"])
    ids: dict[Any, int] = {}
    out = np.empty(len(islands), dtype=np.int32)
    for i, (island, genome_hash) in enumerate(zip(islands, payload["hashes"])):
        key = f"{int(island)}:{genome_hash}"
        label_value = assignments.get(key, f"unclustered:{key}")
        out[i] = ids.setdefault(label_value, len(ids))
    return {
        **payload,
        "cluster": base64.b64encode(out.tobytes()).decode("ascii"),
        "cluster_count": len(ids),
        "cluster_id": cluster_id,
        "title": payload["title"],
    }

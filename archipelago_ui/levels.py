"""Abstraction levels, and the seam the clustering cascade plugs into.

The frontend draws a :class:`~archipelago_ui.stn.STN`. Level 0 is that network
exactly as the log describes it -- one node per distinct location visited. Every
higher level is the *same shape* with fewer nodes: a reducer groups locations
and collapses each group to one macro node.

That is the whole contract. A level is a function::

    (STN, Run, params) -> Reduction

and because the input and the output are both an ``STN``, every view in this
app -- the 3D archipelago, the metrics, the migration overlay -- works on a
reduced network without a single change.

Adding a level
--------------

Implement the reduction, then register it::

    from archipelago_ui import levels
    from archipelago_ui.stn import STN

    def build_birch(stn, run, params):
        labels = ...                      # one cluster id per row of stn.nodes
        reduced = levels.collapse(stn, labels)
        return levels.Reduction(reduced, {"clusters": int(labels.max()) + 1})

    levels.register(levels.Level(
        key="birch",
        order=2,
        label="Level 2 — BIRCH",
        summary="Micro-clusters from the CF-tree.",
        detail="...shown on the page when this level is selected...",
        build=build_birch,
        controls=birch_controls,          # optional; returns a params dict
    ))

:func:`collapse` does the mechanical part -- regrouping nodes, rewriting edge
endpoints, dropping self-loops, keeping migration edges pointing at the right
macro nodes -- so a reducer only has to produce cluster labels. If a reducer
needs to build the network some other way it can return its own ``STN``
directly; nothing here requires :func:`collapse`.

Nothing in this module imports the clustering pipeline. Registration is the
only direction of dependency, and it points inward.
"""

from __future__ import annotations

from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any

import numpy as np
import pandas as pd

from .logreader import Run
from .stn import STN, coordinate_matrix  # re-exported: reducers need the coords


@dataclass(frozen=True)
class Reduction:
    """What a level produced: the network, plus whatever it wants to report.

    ``diagnostics`` is free-form and rendered as a table, so a reducer can
    surface silhouette scores, tree depth, decay parameters -- anything that
    explains the result it just produced.
    """

    stn: STN
    diagnostics: dict[str, Any] = field(default_factory=dict)


#: A level's reduction step. Takes the Level 0 network and returns a coarser one.
Builder = Callable[[STN, Run, Mapping[str, Any]], Reduction]

#: Optional per-level Streamlit controls. Returns the params dict for ``Builder``.
Controls = Callable[[], Mapping[str, Any]]


@dataclass(frozen=True)
class Level:
    """One abstraction level in the picker."""

    key: str
    order: int
    label: str
    summary: str
    detail: str = ""
    build: Builder | None = None
    controls: Controls | None = None

    @property
    def available(self) -> bool:
        """False for a level that is registered but not implemented yet."""
        return self.build is not None


_REGISTRY: dict[str, Level] = {}


def register(level: Level) -> None:
    """Add or replace a level. Re-registering a key overrides it."""
    _REGISTRY[level.key] = level


def get(key: str) -> Level:
    return _REGISTRY[key]


def all_levels() -> list[Level]:
    """Every registered level, coarsest last."""
    return sorted(_REGISTRY.values(), key=lambda level: level.order)


def available_levels() -> list[Level]:
    return [level for level in all_levels() if level.available]


def apply(key: str, stn: STN, run: Run, params: Mapping[str, Any] | None = None) -> Reduction:
    """Run a level's reduction. Level 0 (and any unimplemented level) is a no-op."""
    level = _REGISTRY.get(key)
    if level is None or level.build is None:
        return Reduction(stn)
    return level.build(stn, run, params or {})


# --------------------------------------------------------------------------
# the mechanical part of a reduction
# --------------------------------------------------------------------------


def collapse(stn: STN, labels: Sequence[Any]) -> STN:
    """Collapse ``stn`` by grouping its nodes according to ``labels``.

    ``labels`` is one group id per row of ``stn.nodes``, in row order. Rows
    sharing an id become one macro node whose position is the group centroid.

    Everything a view needs survives the collapse:

    * ``visits`` sums, so node size still means "how much time was spent here";
    * ``fitness`` is the group mean and ``best_fitness`` the group minimum,
      so the colour scale and the elevation axis stay meaningful;
    * ``is_island_best`` and ``shared`` survive if any member had them;
    * ``members`` is added -- how many Level 0 locations each macro node ate,
      which is the compression the cascade exists to produce.

    Edges are rewritten onto the macro nodes, self-loops (both endpoints in one
    group) are dropped, and parallel edges are summed into ``weight``. Migration
    edges get the same treatment but are kept even when they collapse to a
    self-loop is impossible -- a migration always crosses islands, and islands
    are never merged, so the endpoints stay distinct by construction.
    """
    nodes = stn.nodes
    if nodes.empty:
        return stn

    labels = list(labels)
    if len(labels) != len(nodes):
        raise ValueError(f"expected {len(nodes)} labels, got {len(labels)}")

    # A macro node never spans two islands: islands are separate territories in
    # every view, and merging across them would invent a location no island
    # visited. Key the group by (island, label) to enforce that.
    work = nodes.assign(_label=labels)
    work["_group"] = [
        f"{int(island)}:{label}" for island, label in zip(work["island_id"], work["_label"])
    ]

    grouped = work.groupby("_group", sort=False)
    reduced = pd.DataFrame(
        {
            "island_id": grouped["island_id"].first().astype(int),
            "genome_hash": grouped["genome_hash"].first(),
            "visits": grouped["visits"].sum(),
            "members": grouped.size(),
            "fitness": grouped["fitness"].mean(),
            "best_fitness": grouped["best_fitness"].min(),
            "first_eval": grouped["first_eval"].min(),
            "t_rel": grouped["t_rel"].min(),
            "is_island_best": grouped["is_island_best"].any(),
            "shared": grouped["shared"].any(),
            "position": grouped["position"].apply(_centroid),
        }
    )

    remap = dict(zip(work.index, work["_group"]))
    return STN(
        nodes=reduced,
        edges=_remap_edges(stn.edges, remap, drop_self_loops=True),
        migrations=_remap_edges(stn.migrations, remap, drop_self_loops=False),
    )


def _centroid(positions: pd.Series) -> list[float]:
    vectors = list(positions)
    width = max(len(v) for v in vectors)
    matrix = np.zeros((len(vectors), width), dtype=float)
    for row, vector in enumerate(vectors):
        matrix[row, : len(vector)] = vector
    return matrix.mean(axis=0).tolist()


def _remap_edges(edges: pd.DataFrame, remap: dict, *, drop_self_loops: bool) -> pd.DataFrame:
    """Point an edge table at macro nodes, summing anything that becomes parallel."""
    if edges.empty:
        return edges

    moved = edges.assign(
        source=edges["source"].map(remap),
        target=edges["target"].map(remap),
    ).dropna(subset=["source", "target"])

    if drop_self_loops:
        moved = moved[moved["source"] != moved["target"]]
    if moved.empty:
        return moved

    if "weight" in moved.columns:
        keys = [c for c in ("source", "target", "operator") if c in moved.columns]
        return moved.groupby(keys, as_index=False)["weight"].sum()
    return moved.drop_duplicates(subset=["source", "target"])


# --------------------------------------------------------------------------
# the levels themselves
# --------------------------------------------------------------------------


def _identity(stn: STN, run: Run, params: Mapping[str, Any]) -> Reduction:
    """Level 0's reduction: there isn't one. The log is already the network."""
    return Reduction(stn)


register(
    Level(
        key="level0",
        order=0,
        label="Level 0 — raw trajectory",
        summary="One node per location the run actually visited. No clustering.",
        detail=(
            "The network exactly as the log describes it. On a continuous problem this is "
            "close to one node per evaluation, because a real-vector genome almost never "
            "lands on a rounded location twice — which is the reason the cascade exists."
        ),
        build=_identity,
    )
)

register(
    Level(
        key="lsh",
        order=1,
        label="Level 1 — LSH buckets",
        summary="Locality-sensitive hashing groups near-identical locations.",
        detail=(
            "The cheap first pass: hash each location into a bucket so that near neighbours "
            "collide, then treat a bucket as one node. Bounds the work the later stages see."
        ),
        build=None,
    )
)

register(
    Level(
        key="birch",
        order=2,
        label="Level 2 — BIRCH micro-clusters",
        summary="Clustering features summarise each region in one pass.",
        detail=(
            "A CF-tree keeps a running summary of each region, so the whole run is "
            "summarised in a single pass with bounded memory."
        ),
        build=None,
    )
)

register(
    Level(
        key="denstream",
        order=3,
        label="Level 3 — DenStream",
        summary="Density clusters with decay, so stale regions fade.",
        detail=(
            "Weights each micro-cluster by recency, so a region the search has abandoned "
            "decays out of the picture instead of sitting there forever."
        ),
        build=None,
    )
)

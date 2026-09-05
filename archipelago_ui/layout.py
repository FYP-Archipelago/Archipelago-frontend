"""Placing STN nodes in 3D.

The design question this module answers is the one the baseline gallery ran
into: a 3D projection of a 10-dimensional genome space keeps only 35-44% of the
variance, so every continuous run reads as a blob.

Two levers, both offered to the user rather than chosen for them:

``elevation``
    Spend the vertical axis on **fitness** instead of a third principal
    component. Nothing is lost -- that component was mostly noise anyway -- and
    the picture becomes a landscape where height means quality and convergence
    is visible as descent.

``territories``
    Give each island its own footprint instead of overlaying every island in
    one cloud. Costs absolute comparability between islands, buys back the
    per-island reading the research is actually about.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd

from .stn import coordinate_matrix


@dataclass(frozen=True)
class Projection:
    """Node coordinates plus the honesty numbers that go with them."""

    frame: pd.DataFrame  # x, y, z per node_key
    retained_variance: float  # fraction kept by the *planar* components
    components_used: int
    vertical: str  # what the z axis means


def _pca(matrix: np.ndarray, n_components: int) -> tuple[np.ndarray, np.ndarray]:
    """Plain PCA via SVD. Returns (scores, explained variance ratio)."""
    centred = matrix - matrix.mean(axis=0, keepdims=True)
    # A degenerate column set (all points identical) would make SVD useless.
    if not np.any(centred):
        return np.zeros((len(matrix), n_components)), np.zeros(n_components)

    _, singular, right = np.linalg.svd(centred, full_matrices=False)
    variance = singular**2
    total = variance.sum()
    ratio = variance / total if total > 0 else np.zeros_like(variance)

    keep = min(n_components, right.shape[0])
    scores = centred @ right[:keep].T
    if keep < n_components:  # fewer dimensions than asked for; pad with zeros
        scores = np.hstack([scores, np.zeros((len(scores), n_components - keep))])
        ratio = np.hstack([ratio, np.zeros(n_components - len(ratio))])
    return scores, ratio[:n_components]


def _normalise(values: np.ndarray) -> np.ndarray:
    """Scale to [0, 1]; a constant vector maps to its midpoint."""
    low, high = float(np.min(values)), float(np.max(values))
    if high - low < 1e-12:
        return np.full_like(values, 0.5, dtype=float)
    return (values - low) / (high - low)


def _territory_centres(islands: list[int], spacing: float = 2.6) -> dict[int, tuple[float, float]]:
    """Lay island footprints out on the tidiest grid that fits them."""
    count = len(islands)
    columns = int(np.ceil(np.sqrt(count)))
    rows = int(np.ceil(count / columns))
    centres = {}
    for index, island in enumerate(islands):
        column = index % columns
        row = index // columns
        centres[island] = (
            (column - (columns - 1) / 2) * spacing,
            (row - (rows - 1) / 2) * spacing,
        )
    return centres


def project(
    nodes: pd.DataFrame,
    *,
    elevation: bool = True,
    territories: bool = True,
    maximising: bool = False,
) -> Projection:
    """Place ``nodes`` in 3D under the chosen layout.

    With ``elevation``, z is fitness oriented so that **better is lower** --
    good regions become basins you can see the search fall into. With
    ``maximising`` the fitness is negated first so the orientation holds.
    """
    matrix = coordinate_matrix(nodes)
    planar_components = 2 if elevation else 3
    scores, ratio = _pca(matrix, max(planar_components, 3))

    x = _normalise(scores[:, 0]) * 2.0 - 1.0
    y = _normalise(scores[:, 1]) * 2.0 - 1.0

    if elevation:
        fitness = nodes["fitness"].to_numpy(dtype=float)
        # Orient so that "better" is always down, whichever way the run runs.
        oriented = -fitness if maximising else fitness
        z = _normalise(oriented) * 2.0 - 1.0
        vertical = "fitness (lower = better)"
        retained = float(ratio[:2].sum())
        used = 2
    else:
        z = _normalise(scores[:, 2]) * 2.0 - 1.0
        vertical = "principal component 3"
        retained = float(ratio[:3].sum())
        used = 3

    frame = pd.DataFrame({"x": x, "y": y, "z": z}, index=nodes.index)

    if territories:
        # Shrink each island's cloud, then move it to its own footprint. Done
        # after a shared PCA so island scales stay comparable.
        island_ids = sorted(nodes["island_id"].unique())
        centres = _territory_centres([int(i) for i in island_ids])
        scale = 0.62 if len(island_ids) > 1 else 1.0
        for island in island_ids:
            mask = (nodes["island_id"] == island).to_numpy()
            centre_x, centre_y = centres[int(island)]
            frame.loc[mask, "x"] = frame.loc[mask, "x"] * scale + centre_x
            frame.loc[mask, "y"] = frame.loc[mask, "y"] * scale + centre_y

    return Projection(frame, retained, used, vertical)


def edge_segments(
    edges: pd.DataFrame, coords: pd.DataFrame, limit: int | None = None
) -> tuple[list[float], list[float], list[float]]:
    """Flatten edges into the None-separated triples Plotly draws as lines.

    ``limit`` keeps the heaviest edges only. Drawing every edge on a Level 0
    graph is what makes it a hairball; the weight ordering keeps the ones that
    carry the trajectory.
    """
    if edges.empty:
        return [], [], []

    frame = edges
    if limit is not None and len(frame) > limit:
        sort_key = "weight" if "weight" in frame.columns else frame.columns[-1]
        frame = frame.nlargest(limit, sort_key)

    known = coords.index
    xs: list[float] = []
    ys: list[float] = []
    zs: list[float] = []
    for source, target in zip(frame["source"], frame["target"]):
        if source not in known or target not in known:
            continue
        start, end = coords.loc[source], coords.loc[target]
        xs += [start["x"], end["x"], None]
        ys += [start["y"], end["y"], None]
        zs += [start["z"], end["z"], None]
    return xs, ys, zs

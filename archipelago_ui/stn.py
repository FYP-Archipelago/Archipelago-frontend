"""Level 0 search trajectory network, built straight from the log.

Level 0 means *no clustering*: one node per distinct location actually visited.
The clustering cascade (LSH -> BIRCH -> DenStream) will later collapse these
into macro nodes, but it is not needed to draw the graph -- the contract
already carries everything:

  * a node is a location, keyed by ``genome_hash`` (the rounded location
    signature), scoped to the island that visited it;
  * an edge is a parent -> child step, read from ``parent_ids``, labelled by
    the ``operator`` that produced the child;
  * a migration edge joins the *same location* under two different islands,
    which is why nodes are keyed by (island, location) and not by location
    alone -- otherwise every migration would collapse into a self-loop.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd

from .logreader import Run, decode_genome


@dataclass(frozen=True)
class STN:
    """A Level 0 trajectory network.

    ``nodes`` is indexed by ``node_key`` = ``"<island>:<genome_hash>"``.
    """

    nodes: pd.DataFrame
    edges: pd.DataFrame
    migrations: pd.DataFrame

    @property
    def n_nodes(self) -> int:
        return len(self.nodes)

    @property
    def n_edges(self) -> int:
        return len(self.edges)


def _node_key(island, genome_hash) -> str:
    return f"{int(island)}:{genome_hash}"


def build_stn(run: Run, islands: list[int] | None = None) -> STN:
    """Build the Level 0 STN for ``run``, optionally limited to some islands."""
    frame = run.evaluations
    if islands is not None:
        frame = frame[frame["island_id"].isin(islands)]
    frame = frame.dropna(subset=["island_id", "genome_hash"])

    # ---- nodes ----------------------------------------------------------
    # Decode each row's position once, then aggregate by (island, location).
    positions = [
        decode_genome(enc, mode, payload)
        for enc, mode, payload in zip(
            frame["genome_encoding"], frame["genome_repr_mode"], frame["genome_repr"]
        )
    ]
    work = frame.assign(
        node_key=[_node_key(i, h) for i, h in zip(frame["island_id"], frame["genome_hash"])],
        position=positions,
    )

    decodable = work[work["position"].notna()]
    if decodable.empty:
        empty = pd.DataFrame()
        return STN(empty, empty, empty)

    grouped = decodable.groupby("node_key", sort=False)
    nodes = pd.DataFrame(
        {
            "island_id": grouped["island_id"].first().astype(int),
            "genome_hash": grouped["genome_hash"].first(),
            "visits": grouped.size(),
            "fitness": grouped["fitness"].mean(),
            "best_fitness": grouped["fitness"].min(),
            "first_eval": grouped["eval_index"].min(),
            "t_rel": grouped["t_rel"].min(),
            "is_island_best": grouped["is_island_best"].any(),
            # Every row in a group shares a location by construction; take one.
            "position": grouped["position"].first(),
        }
    )

    # A location visited by more than one island -- the legend's "visited by >1
    # island". Computed on the hash, which is island-independent by design.
    shared = nodes.groupby("genome_hash")["island_id"].nunique()
    nodes["shared"] = nodes["genome_hash"].map(shared).gt(1)

    # ---- trajectory edges ------------------------------------------------
    # individual_id -> node_key, so parent ids resolve to nodes.
    lookup = dict(zip(work["individual_id"], work["node_key"]))
    valid = set(nodes.index)

    edge_rows: list[tuple[str, str, str]] = []
    for parents, child_key, operator in zip(
        work["parent_ids"], work["node_key"], work["operator"]
    ):
        if not parents or child_key not in valid:
            continue
        for parent in str(parents).split(";"):
            parent_key = lookup.get(parent)
            if parent_key is None or parent_key not in valid or parent_key == child_key:
                continue
            edge_rows.append((parent_key, child_key, operator))

    edges = pd.DataFrame(edge_rows, columns=["source", "target", "operator"])
    if not edges.empty:
        edges = (
            edges.groupby(["source", "target", "operator"], as_index=False)
            .size()
            .rename(columns={"size": "weight"})
        )

    # ---- migration edges -------------------------------------------------
    migration_rows: list[dict] = []
    for event in run.event("migration_arrive"):
        for origin_id, arrived_id in zip(
            event.get("origin_individual_ids", []), event.get("arrived_individual_ids", [])
        ):
            source_key = lookup.get(origin_id)
            target_key = lookup.get(arrived_id)
            if source_key in valid and target_key in valid and source_key != target_key:
                migration_rows.append(
                    {
                        "source": source_key,
                        "target": target_key,
                        "source_island": event.get("source_island"),
                        "dest_island": event.get("dest_island"),
                        "migration_id": event.get("migration_id"),
                        "accepted": event.get("accepted", True),
                    }
                )

    migrations = pd.DataFrame(migration_rows)
    return STN(nodes, edges, migrations)


def coordinate_matrix(nodes: pd.DataFrame) -> np.ndarray:
    """Stack node positions into an (n, dim) array, padding ragged rows.

    Ragged rows only happen across mixed encodings, which one run never has;
    the pad is defensive rather than expected.
    """
    vectors = list(nodes["position"])
    width = max(len(v) for v in vectors)
    matrix = np.zeros((len(vectors), width), dtype=float)
    for row, vector in enumerate(vectors):
        matrix[row, : len(vector)] = vector
    return matrix

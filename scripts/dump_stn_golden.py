"""Dump the Python STN builder's output as golden fixtures for the TypeScript port.

The TypeScript rewrite rebuilds the search trajectory network in the browser, and
the node key it produces -- ``"<island>:<genome_hash>"`` -- is the join key against
``assignments`` from the clustering API. If the two builders ever disagree on that
key the failure is silent: the join simply misses, and the user sees a *wrong
picture* rather than an error. So the TS builder is held to byte-identical output
against this dump before any of it is drawn.

Read-only. Writes fixtures under ``web/test/golden/`` and touches nothing else.

Usage:
    python scripts/dump_stn_golden.py
"""

from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from archipelago_ui.layout import project  # noqa: E402
from archipelago_ui.logreader import discover_runs, load_run  # noqa: E402
from archipelago_ui.stn import build_stn  # noqa: E402

OUT_DIR = ROOT / "web" / "test" / "golden"


def _digest(rows: list) -> str:
    """A stable hash over a canonical serialisation, for a cheap identity check."""
    payload = json.dumps(rows, separators=(",", ":"), sort_keys=False, default=float)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _flags(row) -> int:
    """Pack the three booleans into one int so the fixture stays compact."""
    return (
        (1 if row.is_island_best else 0)
        | (2 if row.final_best else 0)
        | (4 if row.shared else 0)
    )


def dump(run_path: Path) -> dict:
    run = load_run(run_path)
    stn = build_stn(run)

    # Node keys in the builder's own order. The TS port must reproduce this set;
    # order is recorded too, because the edge table below indexes into it.
    node_keys = list(stn.nodes.index)
    key_to_index = {key: i for i, key in enumerate(node_keys)}

    nodes = [
        [
            int(row.island_id),
            int(row.visits),
            float(row.fitness),
            float(row.best_fitness),
            int(row.first_eval),
            _flags(row),
        ]
        for row in stn.nodes.itertuples()
    ]

    # Operators are dictionary-encoded: the edge rows carry an index into this
    # list rather than repeating the string ten thousand times.
    operators = sorted(stn.edges["operator"].unique()) if not stn.edges.empty else []
    op_index = {name: i for i, name in enumerate(operators)}

    edges = [
        [key_to_index[s], key_to_index[t], op_index[o], int(w)]
        for s, t, o, w in zip(
            stn.edges["source"], stn.edges["target"],
            stn.edges["operator"], stn.edges["weight"],
        )
    ] if not stn.edges.empty else []

    migrations = [
        [
            key_to_index[s], key_to_index[t],
            int(si), int(di), int(n), bool(a),
        ]
        for s, t, si, di, n, a in zip(
            stn.migrations["source"], stn.migrations["target"],
            stn.migrations["source_island"], stn.migrations["dest_island"],
            stn.migrations["transfers"], stn.migrations["accepted"],
        )
    ] if not stn.migrations.empty else []

    # The projection is the other thing the port has to match: TS replaces
    # numpy's SVD with a Jacobi eigensolver, and retained variance is the number
    # that proves the two agree.
    projections = {}
    for elevation in (True, False):
        for territories in (True, False):
            p = project(
                stn.nodes,
                elevation=elevation,
                territories=territories,
                maximising=run.maximising,
            )
            name = f"elev={int(elevation)},terr={int(territories)}"
            projections[name] = {
                "retained_variance": float(p.retained_variance),
                "components_used": int(p.components_used),
                "vertical": p.vertical,
            }

    return {
        "run_id": run.run_id,
        "source": "python/archipelago_ui v0.4",
        "islands": [int(i) for i in run.islands],
        "maximising": bool(run.maximising),
        "counts": {
            "evaluations": int(len(run.evaluations)),
            "nodes": int(stn.n_nodes),
            "edges": int(stn.n_edges),
            "migrations": int(stn.n_crossings),
            "transfer_events": int(stn.transfer_events),
        },
        "digests": {
            "node_keys": _digest(node_keys),
            "nodes": _digest(nodes),
            "edges": _digest(edges),
            "migrations": _digest(migrations),
        },
        "operators": operators,
        "node_keys": node_keys,
        "nodes": nodes,
        "edges": edges,
        "migrations": migrations,
        "projections": projections,
    }


def main() -> int:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    runs = discover_runs(ROOT / "data")
    if not runs:
        print("no runs found under data/", file=sys.stderr)
        return 1

    index = []
    for run_path in runs:
        fixture = dump(run_path)
        target = OUT_DIR / f"{fixture['run_id']}.json"
        target.write_text(
            json.dumps(fixture, separators=(",", ":")), encoding="utf-8"
        )
        c = fixture["counts"]
        size_kb = target.stat().st_size / 1024
        print(
            f"  {fixture['run_id']:<34} "
            f"nodes={c['nodes']:>6,} edges={c['edges']:>7,} "
            f"routes={c['migrations']:>5,} (from {c['transfer_events']:>5,} events)"
            f"  [{size_kb:,.0f} KB]"
        )
        index.append({"run_id": fixture["run_id"], "counts": c})

    (OUT_DIR / "index.json").write_text(
        json.dumps(index, indent=2), encoding="utf-8"
    )
    print(f"\n{len(index)} fixtures written to {OUT_DIR.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

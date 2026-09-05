# Adding the clustering cascade

The frontend was built so the cascade is an addition, not a rewrite. This is
the whole of what you have to touch.

## The contract

Every view in the app draws an `STN` — nodes, edges, migration edges. Level 0 is
that network exactly as the log describes it. A higher level is *the same shape
with fewer nodes*.

So a level is one function:

```python
(STN, Run, params) -> Reduction
```

Because the input and output are both `STN`, the 3D view, the metrics, the
migration overlay and the projection all work on a reduced network without a
single change to any of them.

## What you write

`archipelago_ui/levels.py` already registers Level 0 (implemented, an identity)
and Levels 1–3 (`lsh`, `birch`, `denstream`) as placeholders with `build=None`.
A placeholder shows in the sidebar picker greyed as *not built yet*, and
selecting it falls back to Level 0 with a notice. Replace one by registering
over its key:

```python
# archipelago_clustering/frontend_levels.py  (your module, wherever it lives)
from archipelago_ui import levels

def build_birch(stn, run, params):
    coords = levels.coordinate_matrix(stn.nodes)      # (n_nodes, dim) float array
    labels = your_birch(coords, threshold=params["threshold"])
    return levels.Reduction(
        levels.collapse(stn, labels),
        {"clusters": len(set(labels)), "threshold": params["threshold"]},
    )

def birch_controls():
    import streamlit as st
    return {"threshold": st.slider("CF-tree threshold", 0.01, 1.0, 0.15)}

levels.register(levels.Level(
    key="birch",                       # same key replaces the placeholder
    order=2,
    label="Level 2 — BIRCH",
    summary="Micro-clusters from the CF-tree.",
    detail="Shown on the page when this level is selected.",
    build=build_birch,
    controls=birch_controls,
))
```

Then import your module once at startup (one line in `app.py`) so the
registration runs.

`labels` is one group id per row of `stn.nodes`, in row order. Anything hashable
works — ints, strings, tuples.

## What `collapse()` does for you

You produce labels; it does the mechanical part:

| Field | After collapse |
|---|---|
| `visits` | summed, so node size still means time spent |
| `fitness` | group mean — keeps the colour scale meaningful |
| `best_fitness` | group minimum — keeps the elevation axis meaningful |
| `is_island_best`, `shared` | true if any member was |
| `position` | group centroid, same dimensionality |
| `members` | **added** — how many Level 0 nodes this macro node ate |

Edges are rewritten onto the macro nodes, self-loops dropped, parallel edges
summed into `weight`. Migration edges are remapped the same way but never
dropped.

One invariant it enforces: **a macro node never spans two islands.** Groups are
keyed by `(island_id, label)`, so a label that appears on three islands becomes
three macro nodes. Islands are separate territories in every view, and merging
across them would invent a location no island visited.

You do not have to use `collapse()`. If your reducer builds the network some
other way, return your own `STN` — nothing requires it.

## What you get for free

- The sidebar picker, with your level in it
- The fallback notice when a level isn't built
- A **compression figure** on the Archipelago page (`3294 → 412, 8.0x`), computed
  from node counts before and after
- A diagnostics table — whatever dict you put in `Reduction.diagnostics` is
  rendered under the plot, so silhouette scores, tree depth and decay parameters
  have somewhere to go
- Per-level controls, if you supply a `controls` callable

## Checking it works

The invariants the views depend on:

```python
from archipelago_ui.logreader import load_run
from archipelago_ui.stn import build_stn
from archipelago_ui import levels

run = load_run("data/run-20260903T230942Z-c7f38cc1")
stn = build_stn(run)
reduced = levels.collapse(stn, your_labels)

assert reduced.nodes["visits"].sum() == stn.nodes["visits"].sum()
assert reduced.nodes["members"].sum() == stn.n_nodes
assert set(reduced.edges["source"]) <= set(reduced.nodes.index)
assert (reduced.edges["source"] != reduced.edges["target"]).all()
```

## What Level 0 tells you about the problem

Worth knowing before you tune anything: on the sample runs, Level 0 produces
close to **one node per evaluation** (3,294 nodes from 3,866 evaluations). A
real-vector genome almost never lands on the same rounded location twice, so
the Level 0 graph is effectively the genealogy, and the revisit structure that
would make it a *network* barely exists.

That is the gap the cascade fills. The compression figure on the Archipelago
page is the direct measure of it.

## Where not to put things

`archipelago_ui/` imports nothing from the harness and nothing from the
clustering pipeline — the log contract is the only coupling point, which is the
same rule `archipelago_logging` follows on the producing side. Keep the cascade
in its own package and let it register inward. If you find yourself importing
clustering code *into* `archipelago_ui/`, the dependency has turned around.

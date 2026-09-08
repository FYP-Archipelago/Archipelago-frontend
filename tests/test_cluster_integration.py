"""The integration, checked against the invariants the views actually depend on.

These are the assertions ``docs/EXTENDING.md`` lists under "Checking it works",
run against labels that came from the real service rather than from a stub. They
need ``archipelago-api`` up:

    cd ../archipelago-api && uvicorn app.main:app --port 8000
    cd ../archipelago-frontend && pytest tests/

Skipped, not failed, when it is not: a missing service is a setup condition, and
a red suite should mean broken code.
"""

from __future__ import annotations

import itertools
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from archipelago_cluster_client import api  # noqa: E402
from archipelago_ui import levels  # noqa: E402
from archipelago_ui.data import DATA_ROOT  # noqa: E402
from archipelago_ui.logreader import discover_runs, load_run  # noqa: E402
from archipelago_ui.stn import build_stn  # noqa: E402

BASE_URL = api.DEFAULT_BASE_URL

pytestmark = pytest.mark.skipif(
    api.health(BASE_URL) is None,
    reason=f"no clustering service at {BASE_URL}",
)


@pytest.fixture(scope="module")
def run():
    paths = discover_runs(DATA_ROOT)
    if not paths:
        pytest.skip("no runs in data/")
    return load_run(paths[0])


@pytest.fixture(scope="module")
def stn(run):
    return build_stn(run)


def _labels(stn, response):
    return [response.assignments.get(key, f"unclustered:{key}") for key in stn.nodes.index]


def _cluster(run, **stages):
    return api.cluster_run(
        run.path,
        {name: stages.get(name, False) for name in api.FALLBACK_STAGE_ORDER},
        base_url=BASE_URL,
    )


# --------------------------------------------------------------------------
# the contract between the two sides
# --------------------------------------------------------------------------


def test_the_api_covers_every_node_the_frontend_built(run, stn):
    """Both sides derive node keys from the same log, so neither should surprise
    the other. If this fails, the two key formats have drifted."""
    response = _cluster(run, birch=True)
    missing = set(stn.nodes.index) - set(response.assignments)
    assert not missing, f"{len(missing)} nodes had no label, e.g. {list(missing)[:3]}"


@pytest.mark.parametrize(
    "selection",
    [
        combination
        for size in (1, 2, 3)
        for combination in itertools.combinations(api.FALLBACK_STAGE_ORDER, size)
    ],
)
def test_every_combination_collapses_into_a_drawable_network(run, stn, selection):
    """Any 1, any 2, or all 3 — and the result is still an STN the views accept."""
    response = _cluster(run, **{name: True for name in selection})

    # Order is the backend's, never the request's.
    assert response.stages_executed == [
        name for name in api.FALLBACK_STAGE_ORDER if name in selection
    ]

    reduced = levels.collapse(stn, _labels(stn, response))

    # The invariants docs/EXTENDING.md says the views depend on.
    assert reduced.nodes["visits"].sum() == stn.nodes["visits"].sum()
    assert reduced.nodes["members"].sum() == stn.n_nodes
    assert set(reduced.edges["source"]) <= set(reduced.nodes.index)
    if not reduced.edges.empty:
        assert (reduced.edges["source"] != reduced.edges["target"]).all()

    # And what the reduction is for.
    assert reduced.n_nodes <= stn.n_nodes


def test_a_macro_node_never_spans_two_islands(run, stn):
    response = _cluster(run, lsh=True, birch=True)
    reduced = levels.collapse(stn, _labels(stn, response))
    assert reduced.nodes["island_id"].notna().all()
    # collapse() keys groups by (island, label), so the count it produces has to
    # match the count computed that way from the raw assignment.
    pairs = {
        (key.split(":", 1)[0], label)
        for key, label in zip(stn.nodes.index, _labels(stn, response))
    }
    assert reduced.n_nodes == len(pairs)


def test_denstream_returns_weights_and_the_others_do_not(run):
    assert _cluster(run, denstream=True).node_weights
    assert _cluster(run, lsh=True, birch=True).node_weights is None


def test_no_stages_selected_is_the_level_0_baseline(run, stn):
    response = _cluster(run)
    assert response.stages_executed == []
    reduced = levels.collapse(stn, _labels(stn, response))
    # Level 0 is already one node per (island, location), so collapsing by the
    # baseline labels changes nothing.
    assert reduced.n_nodes == stn.n_nodes


def test_an_unreachable_service_raises_rather_than_returning_junk(run):
    with pytest.raises(api.ClusterUnavailable):
        api.cluster_run(run.path, {"birch": True}, base_url="http://127.0.0.1:9")

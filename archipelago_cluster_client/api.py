"""Talking to the clustering API.

Transport only: no Streamlit, no knowledge of the STN. Everything here is a
plain function over HTTP so it can be exercised without a browser.

The service is normally on the same machine as this app, in which case a run
never moves -- the frontend names a path under ``data/`` and the service reads
it. When it is not (a shared clustering box, a container), the same run is sent
as a zip instead. :func:`cluster_run` tries the cheap way first and falls back,
because which case you are in is a deployment detail and not something a user
should have to know.
"""

from __future__ import annotations

import io
import os
import time
import zipfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

import requests

DEFAULT_BASE_URL = os.environ.get("ARCHIPELAGO_API_URL", "http://127.0.0.1:8000")

#: The cascade, in the order the backend runs it. Fetched from /stages at
#: runtime; this is the fallback for the picker before the first successful call.
FALLBACK_STAGE_ORDER = ("lsh", "birch", "denstream")

#: One line per stage for the toggle tooltips. Kept beside the transport rather
#: than in the UI module so the wording stays with the thing it describes.
STAGE_HELP = {
    "lsh": "Locality-sensitive hashing. Blocks near-identical locations together "
           "and bounds the work the later stages see.",
    "birch": "A CF-tree summarises each region in one pass with bounded memory.",
    "denstream": "Density micro-clusters with time decay, so a region the search "
                 "has abandoned fades instead of sitting there forever.",
}

#: Files worth sending when a run has to travel. evaluations.csv is the dataset;
#: run.jsonl carries the clock offsets that put islands on one timeline.
UPLOAD_FILES = ("evaluations.csv", "run.jsonl", "evaluations.schema.json", "summary.json")


class ClusterUnavailable(RuntimeError):
    """The clustering service could not be reached, or refused the request.

    Raised rather than returned so a caller cannot mistake a failure for a
    result. Callers that must not break the page catch it and fall back to
    Level 0 with the message shown.
    """


@dataclass
class ClusterResponse:
    """A finished job, as the API describes it."""

    run_id: str
    assignments: dict[str, int]
    node_weights: dict[str, float] | None
    stages_executed: list[str]
    counts: dict[str, int]
    diagnostics: dict[str, Any]
    elapsed_seconds: float
    warnings: list[str] = field(default_factory=list)
    transport: str = "path"


def _url(base_url: str, path: str) -> str:
    return f"{base_url.rstrip('/')}{path}"


def health(base_url: str = DEFAULT_BASE_URL, timeout: float = 3.0) -> dict | None:
    """What the service says about itself, or ``None`` if it is not there."""
    try:
        response = requests.get(_url(base_url, "/health"), timeout=timeout)
        response.raise_for_status()
        return response.json()
    except (requests.RequestException, ValueError):
        return None


def stage_order(base_url: str = DEFAULT_BASE_URL, timeout: float = 3.0) -> tuple[str, ...]:
    """The backend's cascade order, so the UI never states it independently."""
    try:
        response = requests.get(_url(base_url, "/stages"), timeout=timeout)
        response.raise_for_status()
        return tuple(response.json()["order"])
    except (requests.RequestException, KeyError, ValueError):
        return FALLBACK_STAGE_ORDER


def _zip_run(run_path: Path) -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        for name in UPLOAD_FILES:
            source = run_path / name
            if source.is_file():
                archive.write(source, f"{run_path.name}/{name}")
    return buffer.getvalue()


def cluster_run(
    run_path: str | Path,
    stages: dict[str, bool],
    *,
    base_url: str = DEFAULT_BASE_URL,
    parameters: dict[str, Any] | None = None,
    poll_seconds: float = 0.4,
    timeout: float = 900.0,
    on_progress: Callable[[str], None] | None = None,
) -> ClusterResponse:
    """Cluster ``run_path`` with the selected stages and wait for the labels.

    ``stages`` chooses membership only. The service decides the sequence and
    reports it back in ``stages_executed``; a caller that wants to display the
    order should read that rather than assume one.
    """
    run_path = Path(run_path)
    body: dict[str, Any] = {
        "run_path": str(run_path.resolve()),
        "stages": stages,
        "parameters": parameters or {},
    }

    try:
        response = requests.post(_url(base_url, "/cluster/run"), json=body, timeout=30)
    except requests.RequestException as error:
        raise ClusterUnavailable(
            f"could not reach the clustering service at {base_url} ({error}). "
            "Start it with: uvicorn app.main:app --port 8000"
        ) from error

    transport = "path"
    if response.status_code in (403, 404):
        # The service cannot see this path -- a different machine, or a root it
        # has not been told about. Send the run instead of arguing about paths.
        if on_progress:
            on_progress("uploading the run")
        transport = "upload"
        response = _submit_upload(base_url, run_path, stages, parameters)

    if response.status_code != 202:
        raise ClusterUnavailable(_detail(response))

    accepted = response.json()
    result = _await_result(
        base_url, accepted["job_id"], poll_seconds, timeout, on_progress
    )
    return ClusterResponse(
        run_id=result["run_id"],
        assignments=result["assignments"],
        node_weights=result.get("node_weights"),
        stages_executed=result["stages_executed"],
        counts=result["counts"],
        diagnostics=result.get("diagnostics", {}),
        elapsed_seconds=result["elapsed_seconds"],
        warnings=result.get("warnings", []),
        transport=transport,
    )


def _submit_upload(
    base_url: str,
    run_path: Path,
    stages: dict[str, bool],
    parameters: dict[str, Any] | None,
) -> requests.Response:
    import json

    data = {name: str(bool(stages.get(name, False))).lower() for name in FALLBACK_STAGE_ORDER}
    data["name"] = run_path.name
    if parameters:
        data["parameters"] = json.dumps(parameters)
    try:
        return requests.post(
            _url(base_url, "/cluster/run/upload"),
            files={"archive": (f"{run_path.name}.zip", _zip_run(run_path), "application/zip")},
            data=data,
            timeout=300,
        )
    except requests.RequestException as error:
        raise ClusterUnavailable(f"upload to {base_url} failed: {error}") from error


def _await_result(
    base_url: str,
    job_id: str,
    poll_seconds: float,
    timeout: float,
    on_progress: Callable[[str], None] | None,
) -> dict:
    deadline = time.monotonic() + timeout
    last_phase = None
    while time.monotonic() < deadline:
        try:
            response = requests.get(_url(base_url, f"/cluster/result/{job_id}"), timeout=30)
        except requests.RequestException as error:
            raise ClusterUnavailable(f"lost the clustering service mid-job: {error}") from error

        if response.status_code == 200:
            return response.json()
        if response.status_code == 202:
            # Still running. The body is the job state, so progress is free.
            phase = response.json().get("phase")
            if on_progress and phase and phase != last_phase:
                on_progress(phase)
                last_phase = phase
            time.sleep(poll_seconds)
            continue
        raise ClusterUnavailable(_detail(response))

    raise ClusterUnavailable(
        f"clustering did not finish within {timeout:.0f}s. The largest corpus run "
        "takes about 33s with the full cascade, so this is likely a stuck job."
    )


def _detail(response: requests.Response) -> str:
    try:
        detail = response.json().get("detail")
    except ValueError:
        detail = None
    return f"clustering service returned {response.status_code}: {detail or response.text[:300]}"

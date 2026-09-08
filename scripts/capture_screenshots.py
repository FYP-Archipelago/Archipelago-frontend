"""Capture one screenshot per page into docs/version-history/<version>/.

The guide asked for a visible progression across frontend versions, so every
tagged version gets its own folder of screenshots. Run this with the app
already serving:

    streamlit run app.py            # in one terminal
    python scripts/capture_screenshots.py --version v0.3

From v0.3 two extra shots are taken after the six: the Runs page having just run
the pipeline, and the Archipelago page drawing that result. Both need
``archipelago-api`` running, and both are skipped with a notice when it is not —
a screenshot of an error message is not a record of what the version looked like.

They come last on purpose. The six are the app as it opens, with nothing
clustered yet; producing a result changes that state and cannot be undone within
one browser session.

    cd ../archipelago-api && ./.venv/bin/python -m uvicorn app.main:app --port 8000

Requires Playwright's Chromium::

    pip install playwright && python -m playwright install chromium
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

#: url_path -> output file stem. Must track the pages registered in app.py.
#:
#: Archipelago is keyed on the empty path, not "archipelago". It is the *default*
#: page, and Streamlit serves a default page at the root: requesting its declared
#: url_path raises the "Page not found" modal over the app, which then lands in
#: the screenshot on top of the page it was supposed to show.
PAGES = {
    "": "01-archipelago",
    "migration": "02-migration",
    "convergence": "03-convergence",
    "run": "04-run-browser",
    "library": "05-runs",
    "overview": "06-overview",
}

#: Second states of pages rather than pages of their own, so each is numbered as
#: a suffix of the one it belongs to.
CLUSTERED_STEM = "01b-archipelago-clustered"
RESULT_STEM = "05b-runs-clustered"

#: The level the clustered shot needs. Matches the label registered in
#: archipelago_cluster_client/levels.py. Pressing Run clustering selects it
#: already; this is the fallback when it somehow has not.
CLUSTERED_LEVEL = "Clustered — pipeline result"


#: Ceiling on the grown viewport. A runaway page should produce a tall
#: screenshot, not exhaust memory rendering one.
MAX_CAPTURE_HEIGHT = 6000


def _fit_viewport(page, width: int, height: int, settle_ms: int) -> None:
    """Grow the viewport to the page's own scroll height before shooting.

    Playwright's ``full_page`` extends the *document*, but Streamlit scrolls an
    inner element (``.stMain``) whose overflow the document never sees. So a
    full-page shot silently stops at the viewport and everything below the fold
    is missing — which is how the clustering panel went uncaptured. Measuring
    that container and resizing to it is what actually gets the whole page.
    """
    needed = page.evaluate(
        """() => {
            const main = document.querySelector('.stMain');
            if (!main) return 0;
            return Math.ceil(main.scrollHeight);
        }"""
    )
    target = min(max(int(needed) + 80, height), MAX_CAPTURE_HEIGHT)
    if target > height:
        page.set_viewport_size({"width": width, "height": target})
        # Plotly redraws to the new size, and lazy content below the old fold
        # renders for the first time.
        page.wait_for_timeout(settle_ms)


def _select_level(page, label: str, settle_ms: int) -> bool:
    """Pick an abstraction level in the sidebar. False if it is not offered.

    Streamlit renders a selectbox as a combobox whose options only exist in the
    DOM while it is open, so this has to click rather than set a value.
    """
    try:
        page.get_by_role("combobox", name="Abstraction level").click(timeout=10_000)
        page.get_by_text(label, exact=True).click(timeout=10_000)
    except Exception as error:  # noqa: BLE001 -- reported, and the run continues
        print(f"  ! could not select {label!r}: {type(error).__name__}", file=sys.stderr)
        return False

    # Clustering is a round trip to the API on top of the usual Streamlit rerun,
    # so this waits considerably longer than a plain page load.
    page.wait_for_timeout(settle_ms * 3)
    return True


def _run_pipeline(page, base_url: str, width: int, height: int, settle_ms: int) -> bool:
    """Press Run clustering on the Runs page, so there is a result to screenshot.

    From v0.3 the Archipelago page only *chooses between* stored results; it
    cannot produce one. A capture that skipped this would photograph the empty
    state and call it the clustered view.
    """
    page.set_viewport_size({"width": width, "height": height})
    page.goto(base_url.rstrip("/") + "/library", wait_until="networkidle")
    page.wait_for_timeout(settle_ms)
    try:
        button = page.get_by_role("button", name="Run clustering")
        button.scroll_into_view_if_needed(timeout=10_000)
        button.click(timeout=10_000)
    except Exception as error:  # noqa: BLE001 -- reported, and the run continues
        print(f"  ! could not run the pipeline: {type(error).__name__}", file=sys.stderr)
        return False

    # A round trip to the service on top of the usual Streamlit rerun.
    page.wait_for_timeout(settle_ms * 3)
    return True


def _showing_result(page) -> bool:
    """Whether the Archipelago page already has a result selected."""
    try:
        return page.get_by_text("Clustering result", exact=True).count() > 0
    except Exception:  # noqa: BLE001
        return False


def _clustering_available(base_url: str) -> bool:
    """Whether the API the clustered shot needs is up."""
    import os

    import requests

    url = os.environ.get("ARCHIPELAGO_API_URL", "http://127.0.0.1:8000")
    try:
        return requests.get(f"{url.rstrip('/')}/health", timeout=3).ok
    except requests.RequestException:
        print(
            f"  ! no clustering service at {url} — skipping {CLUSTERED_STEM}.\n"
            "    Start it: cd ../archipelago-api && "
            "./.venv/bin/python -m uvicorn app.main:app --port 8000",
            file=sys.stderr,
        )
        return False


def capture(
    base_url: str,
    version: str,
    width: int,
    height: int,
    settle_ms: int,
    clustered: bool,
) -> int:
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        print(
            "Playwright is not installed.\n"
            "  pip install playwright && python -m playwright install chromium",
            file=sys.stderr,
        )
        return 1

    out_dir = ROOT / "docs" / "version-history" / version
    out_dir.mkdir(parents=True, exist_ok=True)
    written = 0

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch()
        page = browser.new_page(viewport={"width": width, "height": height})

        for url_path, stem in PAGES.items():
            url = f"{base_url.rstrip('/')}/{url_path}"
            page.set_viewport_size({"width": width, "height": height})
            page.goto(url, wait_until="networkidle")
            # Streamlit streams its layout in, and Plotly draws after that.
            page.wait_for_timeout(settle_ms)
            _fit_viewport(page, width, height, settle_ms)

            target = out_dir / f"{stem}.png"
            page.screenshot(path=str(target), full_page=True)
            print(f"  {target.relative_to(ROOT)}")
            written += 1

        # The clustered shots come last and in this order, because they need
        # state the earlier ones must not have: the six above are the app as it
        # opens, with no result stored.
        if clustered and _clustering_available(base_url):
            if _run_pipeline(page, base_url, width, height, settle_ms):
                target = out_dir / f"{RESULT_STEM}.png"
                _fit_viewport(page, width, height, settle_ms)
                page.screenshot(path=str(target), full_page=True)
                print(f"  {target.relative_to(ROOT)}")
                written += 1

                # Running it selects the Clustered level, so the Archipelago page
                # is already showing the result; the picker is only a fallback.
                page.set_viewport_size({"width": width, "height": height})
                page.goto(base_url.rstrip("/") + "/", wait_until="networkidle")
                page.wait_for_timeout(settle_ms)
                if not _showing_result(page):
                    _select_level(page, CLUSTERED_LEVEL, settle_ms)
                _fit_viewport(page, width, height, settle_ms)
                target = out_dir / f"{CLUSTERED_STEM}.png"
                page.screenshot(path=str(target), full_page=True)
                print(f"  {target.relative_to(ROOT)}")
                written += 1

        browser.close()

    print(f"\n{written} screenshots in {out_dir.relative_to(ROOT)}")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--version", default="v0.3", help="Folder name under docs/version-history/.")
    parser.add_argument("--url", default="http://localhost:8501", help="Where the app is served.")
    parser.add_argument("--width", type=int, default=1680)
    parser.add_argument("--height", type=int, default=1050)
    parser.add_argument(
        "--settle-ms",
        type=int,
        default=5000,
        help="Pause after load, so Plotly has finished drawing.",
    )
    parser.add_argument(
        "--no-clustered",
        action="store_true",
        help=f"Skip the {CLUSTERED_STEM} shot even if the API is up.",
    )
    args = parser.parse_args()
    return capture(
        args.url,
        args.version,
        args.width,
        args.height,
        args.settle_ms,
        clustered=not args.no_clustered,
    )


if __name__ == "__main__":
    raise SystemExit(main())

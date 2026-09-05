"""Capture one screenshot per page into docs/version-history/<version>/.

The guide asked for a visible progression across frontend versions, so every
tagged version gets its own folder of screenshots. Run this with the app
already serving:

    streamlit run app.py            # in one terminal
    python scripts/capture_screenshots.py --version v0.1

Requires Playwright's Chromium::

    pip install playwright && python -m playwright install chromium
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

#: url_path -> output file stem. Must track the pages registered in app.py.
PAGES = {
    "archipelago": "01-archipelago",
    "migration": "02-migration",
    "convergence": "03-convergence",
    "run": "04-run-browser",
    "library": "05-runs",
    "overview": "06-overview",
}


def capture(base_url: str, version: str, width: int, height: int, settle_ms: int) -> int:
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

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch()
        page = browser.new_page(viewport={"width": width, "height": height})

        for url_path, stem in PAGES.items():
            url = f"{base_url.rstrip('/')}/{url_path}"
            page.goto(url, wait_until="networkidle")
            # Streamlit streams its layout in, and Plotly draws after that.
            page.wait_for_timeout(settle_ms)

            target = out_dir / f"{stem}.png"
            page.screenshot(path=str(target), full_page=True)
            print(f"  {target.relative_to(ROOT)}")

        browser.close()

    print(f"\n{len(PAGES)} screenshots in {out_dir.relative_to(ROOT)}")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--version", default="v0.2", help="Folder name under docs/version-history/.")
    parser.add_argument("--url", default="http://localhost:8501", help="Where the app is served.")
    parser.add_argument("--width", type=int, default=1680)
    parser.add_argument("--height", type=int, default=1050)
    parser.add_argument(
        "--settle-ms",
        type=int,
        default=5000,
        help="Pause after load, so Plotly has finished drawing.",
    )
    args = parser.parse_args()
    return capture(args.url, args.version, args.width, args.height, args.settle_ms)


if __name__ == "__main__":
    raise SystemExit(main())

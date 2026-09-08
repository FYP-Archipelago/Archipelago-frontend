"""Slots a page offers, and the panels registered into them.

The same rule as :mod:`archipelago_ui.levels`, applied to page content instead of
reductions: a page declares a named slot, something outside this package
registers a callable for it, and the page renders whatever turned up. Nothing
here imports the clustering pipeline or its client — registration is the only
direction of dependency, and it points inward.

Without this, putting the clustering controls on the Runs page would mean
``pages/library.py`` importing the API client, which turns the dependency around
and couples the UI to a service it is supposed to work without.

    from archipelago_ui import extensions

    def clustering_panel():
        ...

    extensions.register("library", clustering_panel, order=10)

A slot with nothing registered renders nothing at all, so the app is unchanged
when the client is not installed.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

#: A panel is called with whatever the slot passes it, and draws.
Panel = Callable[..., Any]


@dataclass(frozen=True)
class _Registration:
    key: str
    panel: Panel
    order: int = 0
    #: Registering the same name twice replaces it, rather than drawing twice.
    name: str = field(default="")


_SLOTS: dict[str, dict[str, _Registration]] = {}


def register(slot: str, panel: Panel, *, order: int = 0, name: str | None = None) -> None:
    """Add or replace a panel in ``slot``. Lower ``order`` draws first."""
    identity = name or getattr(panel, "__name__", repr(panel))
    _SLOTS.setdefault(slot, {})[identity] = _Registration(slot, panel, order, identity)


def registered(slot: str) -> list[Panel]:
    """Everything registered for ``slot``, in draw order."""
    entries = _SLOTS.get(slot, {}).values()
    return [entry.panel for entry in sorted(entries, key=lambda e: (e.order, e.name))]


def render(slot: str, *args: Any, **kwargs: Any) -> int:
    """Draw every panel in ``slot``. Returns how many drew, so a page can decide
    whether to show a heading or a separator around an empty slot."""
    panels = registered(slot)
    for panel in panels:
        panel(*args, **kwargs)
    return len(panels)


def has(slot: str) -> bool:
    return bool(_SLOTS.get(slot))

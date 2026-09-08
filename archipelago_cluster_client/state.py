"""The stage selection and its parameters, shared across pages.

One selection, two places it can be edited: the Runs page, where a run is
submitted, and the Archipelago page, where the result is looked at. They must not
drift, or "run LSH only" on one page and a picture built from all three on the
other would both be on screen at once.

Sharing the *widget keys* between the two pages does not achieve this, though it
looks as if it should. Streamlit discards the session-state entry for any widget
that was not instantiated on the latest run, so navigating from Runs to
Archipelago clears every toggle back to its default and the second page silently
draws a different configuration from the one that was executed.

So the source of truth is a plain, non-widget key (:data:`STAGES_STATE`). Widgets
initialise *from* it and write back *to* it on every render. A plain key survives
navigation, which is the whole requirement.
"""

from __future__ import annotations

from typing import Any

import streamlit as st

from .api import FALLBACK_STAGE_ORDER, STAGE_HELP, stage_order
from .settings import base_url

#: Widget key per stage. Shared by every page that draws the toggles.
def toggle_key(stage: str) -> str:
    return f"stage_toggle_{stage}"


#: Widget keys for the tuning controls, same rule.
def param_key(name: str) -> str:
    return f"stage_param_{name}"


#: Session key holding the last completed run, so the Runs page can report what
#: it did and the Archipelago page can say what it is drawing.
LAST_RESULT = "cluster_last_result"

#: The selection itself. Plain keys, not widget keys: these have to survive a
#: page change, and widget state does not.
STAGES_STATE = "cluster_stages"
PARAMS_STATE = "cluster_parameters"

#: Defaults match the pipeline's own: every stage off means Level 0, but a user
#: who has come to run the cascade means to run it, so the UI starts with all on.
DEFAULT_STAGES = True


def stages() -> dict[str, bool]:
    """The current selection, in cascade order, whichever page last set it."""
    order = stage_order(base_url())
    saved = st.session_state.get(STAGES_STATE) or {}
    return {name: bool(saved.get(name, DEFAULT_STAGES)) for name in order}


def selected(stages_map: dict[str, bool] | None = None) -> list[str]:
    chosen = stages_map if stages_map is not None else stages()
    return [name for name, on in chosen.items() if on]


def parameters() -> dict[str, Any]:
    """Only the overrides the user actually moved.

    An untouched control sends nothing, so the pipeline's own default applies and
    the request does not silently pin a value the user never chose.
    """
    return dict(st.session_state.get(PARAMS_STATE) or {})


def cache_key(params: dict[str, Any] | None = None) -> tuple:
    """A hashable form of the parameters, for ``st.cache_data``."""
    return tuple(sorted((params if params is not None else parameters()).items()))


def remember(response) -> None:
    st.session_state[LAST_RESULT] = response


def last_result():
    return st.session_state.get(LAST_RESULT)


# --------------------------------------------------------------------------
# the shared controls
# --------------------------------------------------------------------------

#: name -> widget spec. Names match ``StageParameters`` on the API, field for
#: field, so what is typed here is what the pipeline is configured with.
_TUNABLE: dict[str, dict[str, Any]] = {
    "lsh_hashes": {
        "stage": "lsh", "label": "Hashes", "default": 6, "min": 1, "max": 32, "step": 1,
        "help": "Hashes concatenated into a block key. More means a finer partition.",
    },
    "birch_threshold": {
        "stage": "birch", "label": "CF-tree threshold", "default": 0.0, "min": 0.0,
        "max": 2.0, "step": 0.01,
        "help": "Radius a subcluster may not exceed. 0 leaves it on 'auto', "
                "resolved from the data itself.",
    },
    "birch_branching_factor": {
        "stage": "birch", "label": "Branching factor", "default": 50, "min": 2, "max": 200,
        "step": 1, "help": "Subclusters per CF-tree node.",
    },
    "denstream_epsilon": {
        "stage": "denstream", "label": "Epsilon", "default": 0.0, "min": 0.0, "max": 5.0,
        "step": 0.01,
        "help": "Micro-cluster radius. 0 leaves it on 'auto'.",
    },
    "denstream_mu": {
        "stage": "denstream", "label": "mu", "default": 10.0, "min": 0.1, "max": 50.0,
        "step": 0.5,
        "help": "Weight above which a micro-cluster is core. Raising it prunes MORE.",
    },
    "denstream_half_life": {
        "stage": "denstream", "label": "Half-life (s)", "default": 0.0, "min": 0.0,
        "max": 600.0, "step": 1.0,
        "help": "Time for a contribution to decay by half. 0 leaves it on 'auto'.",
    },
}

#: Values the API takes as the string "auto" rather than a number. A slider
#: cannot hold a string, so 0 is the sentinel and is simply not sent.
_AUTO_AT_ZERO = {"birch_threshold", "denstream_epsilon", "denstream_half_life"}


def stage_toggles(containers=None) -> dict[str, bool]:
    """Draw the three toggles and record the result. The one implementation.

    Both pages call this, so neither can drift from the other. ``value=`` seeds
    the widget from the surviving plain key on the first render after a page
    change; on later reruns of the same page the widget already exists and
    Streamlit ignores ``value=``, which is correct — the user's click wins.

    The write-back at the end is what makes the choice outlive the page.
    """
    order = stage_order(base_url())
    saved = stages()
    row = containers if containers is not None else st.columns(len(order))

    chosen: dict[str, bool] = {}
    for column, name in zip(row, order):
        chosen[name] = column.toggle(
            "LSH" if name == "lsh" else name.capitalize(),
            value=saved[name],
            key=toggle_key(name),
            help=STAGE_HELP.get(name, ""),
        )
    st.session_state[STAGES_STATE] = chosen
    return chosen


def order_caption(chosen: dict[str, bool]) -> None:
    """Say what will run, and that the sequence is not a choice."""
    running = selected(chosen)
    if running:
        st.caption(f"Will execute: `{' → '.join(running)}`")
    else:
        st.caption(
            "Nothing selected — this runs no clustering at all and returns the "
            "Level 0 baseline, one node per location visited."
        )


def parameter_controls(chosen: dict[str, bool]) -> dict[str, Any]:
    """Tuning for the selected stages only.

    Controls for a stage that is not running would be inert, and an inert control
    that still looks live is worse than an absent one.
    """
    running = selected(chosen)
    if not running:
        st.session_state[PARAMS_STATE] = {}
        return {}

    saved = parameters()
    values: dict[str, Any] = {}

    with st.expander("Tune the selected stages"):
        st.caption(
            "Anything left at its default is not sent, so the pipeline's own "
            "default applies. `0` on a threshold means **auto** — resolved from "
            "the data rather than pinned here."
        )
        for stage in running:
            fields = [n for n, spec in _TUNABLE.items() if spec["stage"] == stage]
            if not fields:
                continue
            st.markdown(f"**{'LSH' if stage == 'lsh' else stage.capitalize()}**")
            row = st.columns(len(fields))
            for column, name in zip(row, fields):
                spec = _TUNABLE[name]
                values[name] = column.number_input(
                    spec["label"],
                    min_value=spec["min"],
                    max_value=spec["max"],
                    value=saved.get(name, spec["default"]),
                    step=spec["step"],
                    key=param_key(name),
                    help=spec["help"],
                )

    # Only what was actually moved off its default, so an untouched control does
    # not pin a value the user never chose.
    moved = {n: v for n, v in values.items() if v != _TUNABLE[n]["default"]}
    st.session_state[PARAMS_STATE] = moved
    return moved


def to_request(params: dict[str, Any]) -> dict[str, Any]:
    """Turn the widget values into what the API expects.

    The sentinel zeros become the string ``"auto"`` the pipeline understands;
    everything else passes through unchanged.
    """
    request: dict[str, Any] = {}
    for name, value in params.items():
        if name in _AUTO_AT_ZERO and not value:
            continue  # unset entirely: the pipeline's own "auto" applies
        request[name] = value
    return request

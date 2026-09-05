"""Colour and Plotly styling for the Archipelago frontend.

One place for every colour so the views read as one system. The palette is
bathymetric: deep water ground, soundings teal, and chart magenta reserved --
as on a real navigational chart -- for the thing you must not miss, which here
is a migration.
"""

from __future__ import annotations

import plotly.graph_objects as go
import plotly.io as pio

# --- ground and ink -------------------------------------------------------

DEEP = "#08171F"  # page / plot ground
SURFACE = "#0E2530"  # raised panels
RULE = "#244251"  # hairlines, axis lines
INK = "#DDE8E9"  # primary text
INK_SOFT = "#9CB2B7"  # secondary text
INK_FAINT = "#708A91"  # axis ticks, captions

# --- semantic accents -----------------------------------------------------

TEAL = "#4FBFB3"  # the single accent
MIGRATION = "#FF4D9D"  # chart magenta: migration edges only
MIGRATION_SOFT = "rgba(255, 77, 157, 0.42)"  # the same, for dense 3D overlays
ISLAND_BEST = "#FFD166"  # gold star markers
TRAJECTORY = "rgba(150, 170, 180, 0.16)"  # within-island edges, deliberately quiet

#: Per-island categorical colours. Chosen to stay separable on the dark ground
#: and to avoid colliding with MIGRATION or ISLAND_BEST.
ISLAND_COLOURS = (
    "#5AC8B8",  # aqua
    "#F2A65A",  # amber
    "#7FA7E8",  # sky
    "#C88BE0",  # lilac
    "#8FD16A",  # green
    "#E8756B",  # coral
)


def island_colour(island_id: int) -> str:
    """Stable colour for an island id, wrapping if there are more than six."""
    return ISLAND_COLOURS[int(island_id) % len(ISLAND_COLOURS)]


def register_template() -> None:
    """Register and select the ``archipelago`` Plotly template."""
    axis = dict(
        showgrid=True,
        gridcolor=RULE,
        gridwidth=1,
        zeroline=False,
        linecolor=RULE,
        tickfont=dict(color=INK_FAINT, size=11),
        title=dict(font=dict(color=INK_SOFT, size=12)),
    )

    pio.templates["archipelago"] = go.layout.Template(
        layout=go.Layout(
            paper_bgcolor=DEEP,
            plot_bgcolor=DEEP,
            font=dict(
                color=INK,
                family="Archivo, Segoe UI, Helvetica Neue, sans-serif",
                size=13,
            ),
            title=dict(font=dict(color=INK, size=15), x=0, xanchor="left"),
            xaxis=axis,
            yaxis=axis,
            colorway=list(ISLAND_COLOURS),
            margin=dict(l=56, r=24, t=48, b=48),
            hoverlabel=dict(
                bgcolor=SURFACE,
                bordercolor=RULE,
                font=dict(color=INK, size=12),
            ),
            legend=dict(
                bgcolor="rgba(0,0,0,0)",
                font=dict(color=INK_SOFT, size=12),
                borderwidth=0,
            ),
        )
    )
    pio.templates.default = "archipelago"


def scene_axis(title: str, *, show_ticks: bool = True) -> dict:
    """Axis config for a 3D scene -- grid dialled almost off."""
    return dict(
        title=dict(text=title, font=dict(color=INK_SOFT, size=11)),
        backgroundcolor=DEEP,
        gridcolor="rgba(36, 66, 81, 0.55)",
        zeroline=False,
        showbackground=True,
        showticklabels=show_ticks,
        tickfont=dict(color=INK_FAINT, size=9),
    )


#: Injected once per page. Streamlit's own chrome is what reads as unpolished;
#: the charts were never the problem.
CSS = f"""
<style>
  /* Two very faint pools of light, so the ground has depth instead of being a
     flat fill. Fixed, so they do not swim while the page scrolls. */
  .stApp {{
      background:
        radial-gradient(900px 520px at 12% -8%, rgba(79,191,179,.055), transparent 62%),
        radial-gradient(760px 480px at 92% 6%, rgba(255,77,157,.032), transparent 60%),
        {DEEP};
      background-attachment: fixed;
  }}

  section[data-testid="stSidebar"] {{
      background: {SURFACE};
      border-right: 1px solid {RULE};
  }}

  h1, h2, h3, h4 {{
      font-family: Archivo, "Segoe UI", sans-serif !important;
      letter-spacing: -0.01em;
      color: {INK} !important;
  }}
  h1 {{ font-weight: 700 !important; }}

  /* Kill the default top padding so a page starts at the top of the frame. */
  .block-container {{ padding-top: 2.6rem; padding-bottom: 4rem; max-width: 1320px; }}

  /* Metric tiles: flat panels, not cards with shadows. */
  div[data-testid="stMetric"] {{
      background: linear-gradient(180deg, rgba(79,191,179,.05), rgba(0,0,0,0) 58%), {SURFACE};
      border: 1px solid {RULE};
      border-radius: 4px;
      padding: 12px 16px;
      position: relative;
      overflow: hidden;
      transition: border-color .18s ease, transform .18s ease;
  }}
  /* A hairline of accent along the top edge -- the only ornament on the tile. */
  div[data-testid="stMetric"]::before {{
      content: "";
      position: absolute; inset: 0 0 auto 0; height: 1px;
      background: linear-gradient(90deg, {TEAL}, rgba(79,191,179,0) 72%);
      opacity: .55;
  }}
  div[data-testid="stMetric"]:hover {{
      border-color: rgba(79,191,179,.34);
      transform: translateY(-1px);
  }}
  div[data-testid="stMetricLabel"] p {{
      font-size: 10.5px !important;
      letter-spacing: .11em;
      text-transform: uppercase;
      color: {INK_FAINT} !important;
  }}
  div[data-testid="stMetricValue"] {{
      font-size: 25px !important;
      font-variant-numeric: tabular-nums;
      color: {INK} !important;
  }}

  .stDataFrame {{ border: 1px solid {RULE}; border-radius: 3px; }}

  /* An eyebrow above a page title. */
  .eyebrow {{
      font-size: 11px; font-weight: 600; letter-spacing: .15em;
      text-transform: uppercase; color: {TEAL};
      margin: 0 0 2px 0;
  }}
  .deck {{
      color: {INK_SOFT}; font-size: 16px; line-height: 1.55;
      max-width: 74ch; margin: 4px 0 22px 0;
  }}
  .caption {{
      color: {INK_FAINT}; font-size: 13px; line-height: 1.55;
      max-width: 80ch; margin: 8px 0 0 0;
  }}
  .caption code {{ color: {TEAL}; background: rgba(79,191,179,.10); padding: 1px 5px; border-radius: 3px; }}

  /* Version badge, so every screenshot is self-dating. */
  .badge {{
      display: inline-block; font-size: 10.5px; font-weight: 600;
      letter-spacing: .1em; text-transform: uppercase;
      color: {TEAL}; background: rgba(79,191,179,.12);
      border: 1px solid rgba(79,191,179,.30);
      padding: 3px 9px; border-radius: 3px;
  }}

  /* --- interaction: everything that responds should say so ---------------- */

  .stTabs [data-baseweb="tab"] {{
      transition: color .16s ease;
      letter-spacing: .01em;
  }}
  .stTabs [aria-selected="true"] {{ color: {TEAL} !important; }}

  /* Sidebar nav: a left rail marks the active page. */
  section[data-testid="stSidebar"] a[data-testid="stSidebarNavLink"] {{
      border-left: 2px solid transparent;
      border-radius: 0 3px 3px 0;
      transition: background .16s ease, border-color .16s ease;
  }}
  section[data-testid="stSidebar"] a[data-testid="stSidebarNavLink"]:hover {{
      background: rgba(79,191,179,.07);
  }}
  section[data-testid="stSidebar"] a[aria-current="page"] {{
      border-left-color: {TEAL};
      background: rgba(79,191,179,.10);
  }}

  div[data-testid="stExpander"] details {{
      border: 1px solid {RULE};
      border-radius: 4px;
      background: rgba(14,37,48,.55);
      transition: border-color .18s ease;
  }}
  div[data-testid="stExpander"] details:hover {{ border-color: rgba(79,191,179,.28); }}

  /* Plotly and the upload dropzone get the same panel treatment. */
  div[data-testid="stPlotlyChart"] {{
      border: 1px solid {RULE};
      border-radius: 4px;
      overflow: hidden;
      background: {DEEP};
  }}
  section[data-testid="stFileUploaderDropzone"] {{
      background: rgba(14,37,48,.6);
      border: 1px dashed {RULE};
      border-radius: 4px;
      transition: border-color .18s ease, background .18s ease;
  }}
  section[data-testid="stFileUploaderDropzone"]:hover {{
      border-color: rgba(79,191,179,.45);
      background: rgba(79,191,179,.05);
  }}

  /* The version badge, quietly alive. */
  .badge {{ transition: box-shadow .3s ease; }}
  .badge:hover {{ box-shadow: 0 0 0 3px rgba(79,191,179,.08); }}

  /* Keyboard focus must stay visible -- the transitions above must not eat it. */
  :focus-visible {{ outline: 2px solid rgba(79,191,179,.65); outline-offset: 2px; }}

  @media (prefers-reduced-motion: reduce) {{
      * {{ transition: none !important; animation: none !important; }}
      div[data-testid="stMetric"]:hover {{ transform: none; }}
  }}

  hr {{ border-color: {RULE}; }}
</style>
"""

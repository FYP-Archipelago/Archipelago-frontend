/**
 * The two palettes, for code that cannot read CSS custom properties -- the
 * three.js scene, mainly. Values must match `tokens.css`.
 *
 * Dark is the default and is the bathymetric palette the app has always had.
 * Light is not a white theme: it is built from light tints of the same deep
 * teal-slate, so the two modes read as one identity at two exposures. Its ground
 * is the dark theme's own ink, #DDE8E9. Island colours are deepened in light mode
 * so they keep their contrast against a pale ground.
 */

export type ThemeName = "dark" | "light";

export interface ScenePalette {
  /** Clear colour behind everything. */
  canvas: number;
  /** The three back walls of the plot box, as Plotly drew them. */
  wall: number;
  wallOpacity: number;
  grid: number;
  rule: number;
  label: string;
  /** Node colours, as CSS hex -- the node shader writes them straight out. */
  islands: readonly string[];
  /** Where each island finished: the old app's gold diamond. */
  islandBest: string;
  migration: number;
  /** Trajectory edge opacity at intensity 1. */
  edgeOpacity: number;
}

export const ISLAND_CSS: Record<ThemeName, readonly string[]> = {
  dark: ["#5AC8B8", "#F2A65A", "#7FA7E8", "#C88BE0", "#8FD16A", "#E8756B"],
  light: ["#23877A", "#C06E17", "#3A68BA", "#8550B3", "#4A8B2D", "#BD4439"],
};

export const SCENE: Record<ThemeName, ScenePalette> = {
  dark: {
    canvas: 0x08171f,
    wall: 0x0e2530,
    wallOpacity: 0.6,
    grid: 0x1e3b48,
    rule: 0x2b4d5d,
    label: "#8aa3a9",
    islands: ISLAND_CSS.dark,
    islandBest: "#FFD166",
    migration: 0xff4d9d,
    edgeOpacity: 0.07,
  },
  light: {
    canvas: 0xdde8e9,
    wall: 0xcddbdd,
    wallOpacity: 0.7,
    grid: 0xb6c9cc,
    rule: 0xa3b9bc,
    label: "#4f666d",
    islands: ISLAND_CSS.light,
    islandBest: "#C58A0A",
    migration: 0xcc2d77,
    edgeOpacity: 0.075,
  },
};

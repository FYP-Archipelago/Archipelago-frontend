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
  canvas: number;
  rule: number;
  grid: number;
  label: string;
  islands: readonly number[];
  start: number;
  end: number;
  best: number;
  shared: number;
  migration: number;
  /**
   * Edges on a dark ground add light, so dense routes glow. On a light ground
   * adding light only washes toward white, so edges there lay down colour with
   * ordinary blending instead.
   */
  additiveEdges: boolean;
}

export const ISLAND_CSS: Record<ThemeName, readonly string[]> = {
  dark: ["#5AC8B8", "#F2A65A", "#7FA7E8", "#C88BE0", "#8FD16A", "#E8756B"],
  light: ["#23877A", "#C06E17", "#3A68BA", "#8550B3", "#4A8B2D", "#BD4439"],
};

const hex = (css: string) => Number.parseInt(css.slice(1), 16);

export const SCENE: Record<ThemeName, ScenePalette> = {
  dark: {
    canvas: 0x08171f,
    rule: 0x244251,
    grid: 0x16303c,
    label: "#708a91",
    islands: ISLAND_CSS.dark.map(hex),
    start: 0xfbbf24, // STN Analytics' start box
    end: 0xdde8e9, // STN draws ends dark; on a dark ground that vanishes, so ink
    best: 0xef4444, // STN's best node
    shared: 0x9aa7ad,
    migration: 0xff4d9d,
    additiveEdges: true,
  },
  light: {
    canvas: 0xdde8e9,
    rule: 0xa9bec1,
    grid: 0xc6d6d8,
    label: "#5a7178",
    islands: ISLAND_CSS.light.map(hex),
    start: 0xd99a0e,
    end: 0x0c2630, // STN's own light-mode end colour: dark
    best: 0xd23434,
    shared: 0x74878d,
    migration: 0xcc2d77,
    additiveEdges: false,
  },
};

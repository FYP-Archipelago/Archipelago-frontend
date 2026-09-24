/**
 * The current value of a design token.
 *
 * SVG presentation attributes do not resolve `var(--x)`, and chart colour
 * scales need real colours to interpolate between, so charts read the token at
 * render time and redraw when the theme changes.
 */
export function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || "#888888";
}

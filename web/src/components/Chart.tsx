/**
 * An Observable Plot figure that fills its box and follows the theme.
 *
 * Plot renders SVG in `currentColor`, so axes, ticks and grid take the page's
 * ink from CSS and switch with the theme without a second theme object. Only
 * data colours -- the islands -- are passed in explicitly.
 */

import { useEffect, useRef } from "react";

interface ChartProps {
  /** Build the figure for a given width. Re-run when the box resizes or deps change. */
  render: (width: number) => SVGSVGElement | HTMLElement;
  height: number;
  /** Anything the figure depends on besides width. */
  deps: readonly unknown[];
  label: string;
}

export function Chart({ render, height, deps, label }: ChartProps) {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const host = ref.current;
    if (host === null) return;
    let frame = 0;
    const draw = () => {
      const width = Math.max(host.clientWidth, 240);
      host.replaceChildren(render(width));
    };
    draw();
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(draw);
    });
    observer.observe(host);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
    // `render` is rebuilt on every parent render; `deps` says when it matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return <div className="chart" ref={ref} style={{ minHeight: height }} role="img" aria-label={label} />;
}

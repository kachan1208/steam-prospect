import { CSS_VAR } from "../../lib/palette";

/**
 * Compact trend sparkline for a watchlist row (Stat-tile "trend" contract: a
 * de-emphasis-hue line with the current/latest point picked out in the
 * accent hue). Plain SVG rather than Recharts — this mounts once per
 * watchlist row and needs no axes, grid, or tooltip; the raw latest count
 * renders next to it in the caller (WatchlistPage) so the value is never
 * chart-only.
 */
export function WatchlistSparkline({
  values,
  width = 90,
  height = 26,
}: {
  values: number[];
  width?: number;
  height?: number;
}) {
  if (values.length < 2) {
    return <span className="text-xs text-ink-muted">Not enough history</span>;
  }
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const range = max - min || 1;
  const pad = 3;
  const stepX = (width - pad * 2) / (values.length - 1);
  const points = values.map((v, i) => {
    const x = pad + i * stepX;
    const y = pad + (1 - (v - min) / range) * (height - pad * 2);
    return [x, y] as const;
  });
  const path = points.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const [lastX, lastY] = points[points.length - 1];
  const latest = values[values.length - 1];

  return (
    <svg
      width={width}
      height={height}
      role="img"
      aria-label={`Review-velocity trend over the last ${values.length} months, latest ${latest} sampled reviews`}
    >
      <polyline
        points={path}
        fill="none"
        stroke="var(--text-muted)"
        strokeWidth={1.5}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      <circle cx={lastX} cy={lastY} r={3} fill={CSS_VAR.demand} stroke="var(--surface-1)" strokeWidth={1.5} />
    </svg>
  );
}

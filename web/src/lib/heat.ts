import type { CSSProperties } from "react";

/**
 * Heat tint for magnitude cells in dense tables — the number stays normal ink, the cell
 * background carries the percentile, so a column reads as a gradient (same job as the
 * seasonality heatmap, but with text on top: tint alpha is capped at 42% so ink contrast
 * survives in both themes; color-mix against transparent keeps it theme-aware for free).
 *
 * Log-scaled: revenue/reviews/owners are log-distributed, so a linear ramp would leave
 * every non-outlier row at ~0 and one megahit fully saturated.
 */
export function heatStyle(
  value: number | null | undefined,
  min: number,
  max: number,
): CSSProperties | undefined {
  if (value == null || !Number.isFinite(value) || value <= 0) return undefined;
  const lo = Math.log10(Math.max(1, min));
  const hi = Math.log10(Math.max(1, max));
  if (hi <= lo) return undefined;
  const t = Math.max(0, Math.min(1, (Math.log10(value) - lo) / (hi - lo)));
  const pct = Math.round(t * 42);
  if (pct < 4) return undefined; // below the ramp floor a tint just reads as dirt
  return { backgroundColor: `color-mix(in srgb, var(--series-1) ${pct}%, transparent)` };
}

/** Min/max over the non-null positive values of one column — feed to heatStyle per row. */
export function heatDomain<T>(rows: T[], pick: (row: T) => number | null | undefined): [number, number] {
  let min = Infinity;
  let max = -Infinity;
  for (const r of rows) {
    const v = pick(r);
    if (v != null && Number.isFinite(v) && v > 0) {
      if (v < min) min = v;
      if (v > max) max = v;
    }
  }
  return min <= max ? [min, max] : [0, 0];
}

/**
 * Verdict color for Steam positive-review ratio (0..1) — the one magnitude with a
 * universally understood good/bad reading. Yellow is banned on text (contrast), so the
 * middle band stays neutral ink; color marks only the clear verdicts.
 */
export function positiveRatioClass(ratio: number | null | undefined): string {
  if (ratio == null) return "";
  if (ratio >= 0.8) return "text-status-good";
  if (ratio < 0.7) return "text-status-serious";
  return "";
}

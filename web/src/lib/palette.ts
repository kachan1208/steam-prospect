import type { Theme } from "./theme";

/**
 * Prospect color tokens — mirrors web/src/index.css, validated with the dataviz
 * skill's validate_palette.js (categorical 3-hue + scatter pair, both modes: all
 * PASS; light-mode aqua/yellow carry a contrast WARN, mitigated below by never
 * putting those hues on text — only on marks with a legend/label alongside).
 *
 * Fixed categorical order used throughout the app:
 *   slot 1 (blue) = demand, slot 2 (aqua) = competition, slot 3 (yellow) = quality_gap
 * Scatter (Boxleiter reviews->owners): blue (points) + aqua (fitted band).
 */
export const CSS_VAR = {
  demand: "var(--series-1)",
  competition: "var(--series-2)",
  qualityGap: "var(--series-3)",
  scatterPoint: "var(--series-1)",
  scatterBand: "var(--series-2)",
  // Diverging pair (Game Teardown praise/complaint bars): blue<->red, the app's
  // documented diverging pair (color-formula.md) — reuses series-1/series-6 so it's
  // already validated (validate_palette.js, both modes, worst-pair CVD ΔE 66-75, well
  // clear of the >=12 target) rather than introducing new hex values. Sentiment
  // (agree/disagree, praise/complaint) is the reference example for the diverging job,
  // not status: it's two magnitudes on one baseline (n_pos vs n_neg), not a single
  // system-state indicator, and it matches this same page's existing convention of
  // rendering "positive review share" in blue (see ReviewsTimelineChart).
  praise: "var(--series-1)",
  complaint: "var(--series-6)",
  good: "var(--status-good)",
  warning: "var(--status-warning)",
  serious: "var(--status-serious)",
  critical: "var(--status-critical)",
  textPrimary: "var(--text-primary)",
  textSecondary: "var(--text-secondary)",
  textMuted: "var(--text-muted)",
  gridline: "var(--gridline)",
  baseline: "var(--baseline)",
  surface: "var(--surface-1)",
} as const;

// Literal hex mirrors of index.css — needed where a library wants a computed JS
// color (e.g. per-bucket sequential fills), not a CSS custom property string.
const SEQUENTIAL_LIGHT = [
  "#cde2fb",
  "#b7d3f6",
  "#9ec5f4",
  "#86b6ef",
  "#6da7ec",
  "#5598e7",
  "#3987e5",
  "#2a78d6",
  "#256abf",
  "#1c5cab",
  "#184f95",
  "#104281",
  "#0d366b",
]; // low -> high magnitude (light -> dark), light-mode anchor

// Dark mode flips the anchor: "near zero" must sit close to the dark surface
// (#1a1a19) instead of the light surface, and "high" must pop bright. We drop the
// two darkest steps (650/700) because they're nearly invisible on #1a1a19.
const SEQUENTIAL_DARK = [
  "#184f95",
  "#1c5cab",
  "#256abf",
  "#2a78d6",
  "#3987e5",
  "#5598e7",
  "#6da7ec",
  "#86b6ef",
  "#9ec5f4",
  "#b7d3f6",
  "#cde2fb",
]; // low -> high magnitude (dark/dim -> light/bright), dark-mode anchor

export function sequentialScale(theme: Theme): string[] {
  return theme === "dark" ? SEQUENTIAL_DARK : SEQUENTIAL_LIGHT;
}

/** Map a value in [0,1] to a step in the theme's sequential ramp. */
export function sequentialColorAt(t: number, theme: Theme): string {
  const scale = sequentialScale(theme);
  const clamped = Math.max(0, Math.min(1, Number.isFinite(t) ? t : 0));
  const idx = Math.round(clamped * (scale.length - 1));
  return scale[idx];
}

// Dev-tier ordinal ramp (4 ordered tiers -> one hue, monotone lightness), reusing
// the sequential steps at fixed indices so the order reads in the color.
const TIER_STEPS_LIGHT = ["#86b6ef", "#3987e5", "#256abf", "#0d366b"];
const TIER_STEPS_DARK = ["#184f95", "#2a78d6", "#5598e7", "#cde2fb"];
const TIER_LABELS = ["Hobby", "Small", "Middle", "Triple-I"];

export function tierColor(tier: string, theme: Theme): string {
  const idx = TIER_LABELS.indexOf(tier);
  const steps = theme === "dark" ? TIER_STEPS_DARK : TIER_STEPS_LIGHT;
  return steps[idx >= 0 ? idx : 0];
}

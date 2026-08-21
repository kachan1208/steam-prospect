import type { Theme } from "./theme";

/**
 * Prospect color tokens — mirrors web/src/index.css.
 *
 * design_handoff_prospect_dark_ui/README.md is explicit that trend verdicts and aspect
 * sentiment are MONO STEEL, never hue-coded ("Up = accent-300, down/flat = paper 55%.
 * Never red/green" · 4c: aspect bars "positive accent-300, negative paper 50%"). Two
 * independent mockup screens (4a's Niche Finder D/C/Q bars and 4b's "Why 87.4" panel —
 * both rendered by OpportunityBars.tsx) confirm this extends to the demand/competition/
 * quality_gap trio too: demand and quality_gap (both "good for the opportunity score")
 * render accent-300; competition (crowding — the downside) renders paper ~50%. Every
 * mark in every mockup screen is either accent-300 or a paper alpha EXCEPT marketing-
 * channel identity (5 simultaneous platforms — genuinely categorical, kept below) and
 * the sequential heatmap ramp (magnitude, not identity — untouched in this file).
 *
 * So CSS_VAR.demand/competition/qualityGap/praise/complaint moved OFF the categorical
 * --series-N slots onto this two-tone mono language:
 *   "good" (demand, quality_gap, praise, scatter points) -> accent-300
 *   "muted/downside" (competition, complaint)             -> paper ~50%
 * This never collides: no chart plots demand AND quality_gap as two marks needing to be
 * told apart (they're always separate single-series charts, or — in OpportunityBars —
 * intentionally the same color because they share the same polarity), and every chart
 * that plots demand/qualityGap concurrently WITH competition (GameTrendsChart panel 1,
 * GameMetricDrilldown's avg/peak players, TimingBars' congestion chart) keeps its two
 * series distinguishable because paper-alpha and accent-300 are never the same value.
 *
 * MONO below is the shared vocabulary so every chart file draws the same "receded" tone
 * instead of each hand-rolling its own color-mix() percentage.
 */
export const MONO = {
  /** Up / positive / primary series. */
  primary: "var(--accent-300)",
  /** Two/three-series overlays (CompareTrendsChart): decreasing recession by rank. */
  paper75: "color-mix(in srgb, var(--text-primary) 75%, transparent)",
  paper55: "color-mix(in srgb, var(--text-primary) 55%, transparent)", // == --text-muted
  /** Down / negative / "the downside" — competition, complaint, D/C/Q's Competition bar. */
  paper50: "color-mix(in srgb, var(--text-primary) 50%, transparent)",
  /** Secondary series in a two-series trend line (dashed 4 3 per the line-chart spec). */
  paper45: "color-mix(in srgb, var(--text-primary) 45%, transparent)",
  paper35: "color-mix(in srgb, var(--text-primary) 35%, transparent)",
} as const;

/**
 * Fixed slot order used throughout the app for the opportunity-score trio. Values are
 * mono (see module doc above), not hue — kept as named CSS_VAR keys (rather than
 * inlining MONO.primary/paper50 at each of the dozen+ call sites) so every chart that
 * reads "demand" still reads as one concept if a future redesign wants it back on a hue.
 */
export const CSS_VAR = {
  demand: MONO.primary,
  competition: MONO.paper50,
  qualityGap: MONO.primary,
  // Scatter (Boxleiter reviews->owners) — unused today (no scatter chart exists yet in
  // components/charts), kept in the same mono language for whenever one is built: points
  // are the primary mark, the fitted band is a receded area wash.
  scatterPoint: MONO.primary,
  scatterBand: "color-mix(in srgb, var(--text-primary) 25%, transparent)",
  // Aspect sentiment (Game Teardown praise/complaint bars) — README 4c, verbatim:
  // "positive accent-300, negative paper 50%". Direction reads from the glyph/label/
  // position (which side of the 100%-stacked bar, the +/- sign), never from hue.
  praise: MONO.primary,
  complaint: MONO.paper50,
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

// Genre/tag chip tints (lib/heat.ts genreTintStyle) — a DOCUMENTED EXCEPTION to the
// fixed-order rule above: slots are hash-assigned per genre name because the genre set is
// open-ended (hundreds of tags, 7 usable slots — collisions are the norm, so same hue ≠
// same genre). Safe because color there is tint-only (13% bg / 55% border) under neutral
// ink text (measured 6.06–6.83:1 light, 7.44–7.99:1 dark across all slots), is never the
// sole encoding (the chip always prints the name), and slot 4 is excluded as visually
// near status-good. Any future non-tint use of hashed slots must go through the validator.

// Marketing channel categorical order (Track M) — fixed order, reuses the app's existing
// validated series slots (never a generated/ad-hoc hue) rather than each platform's own
// brand color, per the dataviz skill's "assign categorical hues in fixed order" rule. Slots
// chosen loosely toward each platform's brand hue family where the app's own ramp has one
// (YouTube/red -> series-6, Reddit/orange -> series-8, Twitch/purple -> series-5) purely as
// a mnemonic.
//
// RE-VALIDATED for this redesign's steel ground (#1d2d3d), per the dataviz skill's
// validate_palette.js — the palette.ts docstring's old "ALL PASS" claim did not survive
// re-running the script (it was checked, at some point, against different pairs/order
// than what's below; re-running it now is what the redesign asked for):
//
//   node scripts/validate_palette.js "#c98500,#e66767,#d95926,#9085e9,#008300" \
//     --mode dark --surface "#1d2d3d" --pairs all
//
// `x` was series-4 (#008300, green) — that FAILS contrast on the new steel ground
// (2.84:1, was >=3:1 on the old near-black #0e0f11) — the one genuine regression the
// ground-color change caused here. Reassigned to series-2 (#199e70, teal): passes
// contrast in both modes and — verified by brute-force pairwise ΔE over every 5-of-8
// slot combination — is the only replacement that adds ZERO new CVD/normal-vision
// collisions against the other four (press/youtube/reddit/twitch) already in use.
//
// What re-running the validator could NOT fix: youtube (series-6, #e66767 red) and
// reddit (series-8, #d95926 orange) fail the normal-vision floor (ΔE 7.1, needs >=15) —
// and that failure is PRE-EXISTING, reproducible on the OLD surface too, not something
// this redesign introduced. A pairwise sweep of all 21 five-of-eight-slot combinations
// (excluding the contrast-failing green) proves the largest mutually-clean set the
// current 8-slot --series-N ramp can support is 3, not 5 — so no reassignment within
// the existing ramp can seat five simultaneous channel identities without at least one
// close pair. Flagged for the lead: fixing this for real needs a 9th validated hue (or
// fewer simultaneous channel colors); the standing mitigation is that ChannelShareBars
// always prints the channel name next to its swatch, so identity is never color-alone
// even where two channels' hues sit close together.
const CHANNEL_ORDER = ["press", "youtube", "reddit", "twitch", "x"] as const;
export type MarketingChannel = (typeof CHANNEL_ORDER)[number];

const CHANNEL_COLOR_LIGHT: Record<MarketingChannel, string> = {
  press: "var(--series-3)",
  youtube: "var(--series-6)",
  reddit: "var(--series-8)",
  twitch: "var(--series-5)",
  x: "var(--series-2)",
};

export function channelColor(channel: string): string {
  return CHANNEL_COLOR_LIGHT[channel as MarketingChannel] ?? "var(--text-muted)";
}

const CHANNEL_LABELS: Record<MarketingChannel, string> = {
  press: "Press",
  youtube: "YouTube",
  reddit: "Reddit",
  twitch: "Twitch",
  x: "X",
};

export function channelLabel(channel: string): string {
  return CHANNEL_LABELS[channel as MarketingChannel] ?? channel.charAt(0).toUpperCase() + channel.slice(1);
}

export function channelSortOrder(channel: string): number {
  const idx = CHANNEL_ORDER.indexOf(channel as MarketingChannel);
  return idx === -1 ? CHANNEL_ORDER.length : idx;
}

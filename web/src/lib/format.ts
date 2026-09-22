/* ─────────────────────────────────────────────────────────────────────────────────────
 * THE UNIT IS CHOSEN AFTER ROUNDING (2026-09-22).
 *
 * Every compact formatter here used to pick its unit from the RAW value and round second,
 * so a value just under a threshold rounded up to the next unit's size while keeping the
 * smaller unit's suffix:
 *
 *   fmtUsd(999_950)          "$1000.0K"   (should be "$1.0M")
 *   fmtUsd(999.6)            "$1000"      (should be "$1.0K")
 *   fmtUsd(9.999)            "$10.00"     (should be "$10" — the ≥$10 rung has no cents)
 *   fmtCompact(999_960)      "1000.0K"    (should be "1.0M")
 *   fmtAxisCompact(99_960)   "100.0K"     (six glyphs — the width the axis rung exists to avoid)
 *   fmtMinutes(59.6)         "60m"        (should be "1.0h")
 *
 * and none of them guarded ±Infinity, so a divide-by-zero upstream printed "$InfinityB".
 *
 * `ladder()` below is the one fix: each formatter is a list of rungs (unit, divisor, decimal
 * count), and a value that ROUNDS into the next rung's range is printed in that rung's unit.
 * Promotion can never overshoot, because every ladder's rungs get coarser as they climb.
 * Non-finite input — null, undefined, NaN, ±Infinity — prints MISSING; `formatWith()` and
 * `missingReason()` tell a caller WHY, so a sentinel can be marked instead of left bare.
 * ───────────────────────────────────────────────────────────────────────────────────── */

/** The one string every formatter prints for a value it cannot print as a number. */
export const MISSING = "—";

/** Why a value cannot be printed as a number. */
export type MissingReason = "missing" | "not-a-number" | "infinite";

/** null when `value` is a printable (finite) number, else why it is not. */
export function missingReason(value: number | null | undefined): MissingReason | null {
  if (value === null || value === undefined) return "missing";
  if (Number.isNaN(value)) return "not-a-number";
  if (!Number.isFinite(value)) return "infinite";
  return null;
}

/** Type guard: a real, finite number (not null/undefined/NaN/±Infinity). */
export function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** A formatted value that remembers why it could not be printed — the sentinel-friendly
 * form of every formatter here. `missing` is null for a real number. */
export interface Formatted {
  text: string;
  missing: MissingReason | null;
}

/** Run any formatter, keeping the reason a value was not printable, so the caller can mark
 * the sentinel ("no data", "not computable") instead of showing a bare dash:
 * `formatWith(row.p90_rev, fmtUsd)` -> `{ text: "$1.2M", missing: null }`. */
export function formatWith(
  value: number | null | undefined,
  format: (v: number) => string,
): Formatted {
  const missing = missingReason(value);
  return missing ? { text: MISSING, missing } : { text: format(value as number), missing: null };
}

/** Plain-language wording for a MissingReason, for sentinel markers and tooltips. */
export const MISSING_REASON_TEXT: Record<MissingReason, string> = {
  missing: "no data",
  "not-a-number": "not computable",
  infinite: "not computable (divide by zero)",
};

interface Rung {
  /** Smallest absolute value (in base units) this rung prints. */
  min: number;
  div: number;
  digits: number;
  suffix: string;
  /** en-US thousands grouping ("1,284"). */
  group?: boolean;
}

/** Format a NON-NEGATIVE finite number on a unit ladder, choosing the rung after rounding. */
function ladder(abs: number, rungs: readonly Rung[]): string {
  let i = 0;
  for (let k = 0; k < rungs.length; k++) if (abs >= rungs[k].min) i = k;
  for (;;) {
    const r = rungs[i];
    const rounded = Number((abs / r.div).toFixed(r.digits));
    const next = rungs[i + 1];
    if (next && rounded * r.div >= next.min) {
      i += 1;
      continue;
    }
    const body = r.group
      ? rounded.toLocaleString("en-US", { minimumFractionDigits: r.digits, maximumFractionDigits: r.digits })
      : rounded.toFixed(r.digits);
    return body + r.suffix;
  }
}

/** Signed wrapper around ladder(): the sign is decided AFTER rounding, so a value that
 * rounds to zero never prints "-0" / "-$0.00". */
function signedLadder(value: number, rungs: readonly Rung[], prefix = ""): string {
  const body = ladder(Math.abs(value), rungs);
  const isZero = Number(body.replace(/[^0-9.]/g, "")) === 0;
  return `${value < 0 && !isZero ? "-" : ""}${prefix}${body}`;
}

const USD_RUNGS: readonly Rung[] = [
  { min: 0, div: 1, digits: 2, suffix: "" },
  { min: 10, div: 1, digits: 0, suffix: "" },
  { min: 1_000, div: 1_000, digits: 1, suffix: "K" },
  { min: 1_000_000, div: 1_000_000, digits: 1, suffix: "M" },
  { min: 1_000_000_000, div: 1_000_000_000, digits: 1, suffix: "B" },
  { min: 1_000_000_000_000, div: 1_000_000_000_000, digits: 1, suffix: "T" },
];

/** Compact currency: $9.50, $249, $12.4K, $1.2M, $3.4B. */
export function fmtUsd(value: number | null | undefined): string {
  if (!isFiniteNumber(value)) return MISSING;
  return signedLadder(value, USD_RUNGS, "$");
}

/**
 * Is this title free, for revenue-display purposes? Pass the row; use `isFreeTitle(row)` rather
 * than testing a price by hand.
 *
 * Two shapes mean free, and only ONE of them was handled until 2026-09-13:
 *   * price_initial === 0 — the explicit $0 list price.
 *   * price_initial == null AND is_free — Steam returns NO price_overview at all for a free game,
 *     so the scraper stores NULL, not 0. DOGWALK (appid 3775050, Blender Studio, 2,942 reviews)
 *     is one: every revenue cell rendered an empty "—", which reads as "we don't know" when the
 *     answer is "there is no box revenue to know". 12,898 games in the 2026-09-11 mart are in
 *     this state (3,395 with 50+ reviews).
 *
 * The is_free flag ALONE is still not enough, which is why price wins when it is known: some
 * F2P-flagged titles sell paid editions with real box revenue (Rainbow Six Siege, is_free yet
 * $19.99 / ~$920M est.) and must keep showing their number.
 */
export function isFreeTitle(row: {
  price_initial?: number | null;
  is_free?: number | boolean | null;
}): boolean {
  if (row.price_initial === 0) return true;
  return row.price_initial == null && Boolean(row.is_free);
}

/**
 * Per-game estimated revenue for display. Free titles read "Free" instead of a misleading "$0" or
 * a blank — box revenue is $0 at a $0 price (the Boxleiter method models box sales, not the
 * MTX / battle-pass income F2P games actually run on). Pass isFree = isFreeTitle(row).
 */
export function fmtRevenue(value: number | null | undefined, isFree: boolean): string {
  if (isFree) return "Free";
  return fmtUsd(value);
}

const COMPACT_RUNGS: readonly Rung[] = [
  { min: 0, div: 1, digits: 0, suffix: "", group: true },
  { min: 10_000, div: 1_000, digits: 1, suffix: "K" },
  { min: 1_000_000, div: 1_000_000, digits: 1, suffix: "M" },
  { min: 1_000_000_000, div: 1_000_000_000, digits: 1, suffix: "B" },
  { min: 1_000_000_000_000, div: 1_000_000_000_000, digits: 1, suffix: "T" },
];

/** Compact count: 1,284 / 12.9K / 4.2M / 1.5B. */
export function fmtCompact(value: number | null | undefined): string {
  if (!isFiniteNumber(value)) return MISSING;
  return signedLadder(value, COMPACT_RUNGS);
}

/** Axis rungs drop the decimal once a number reaches three integer digits. */
const AXIS_COMPACT_RUNGS: readonly Rung[] = [
  { min: 0, div: 1, digits: 0, suffix: "", group: true },
  { min: 10_000, div: 1_000, digits: 1, suffix: "K" },
  { min: 100_000, div: 1_000, digits: 0, suffix: "K" },
  { min: 1_000_000, div: 1_000_000, digits: 1, suffix: "M" },
  { min: 100_000_000, div: 1_000_000, digits: 0, suffix: "M" },
  { min: 1_000_000_000, div: 1_000_000_000, digits: 1, suffix: "B" },
  { min: 100_000_000_000, div: 1_000_000_000, digits: 0, suffix: "B" },
  { min: 1_000_000_000_000, div: 1_000_000_000_000, digits: 1, suffix: "T" },
];

/**
 * Axis-tick variant of fmtCompact. Same units, but the decimal is dropped once the number
 * reaches three integer digits ("240K", not "240.0K"): chart YAxis columns are a fixed
 * 36-44px and recharts CLIPS overflowing tick labels from the LEFT — "240.0K" shipped
 * rendering as "40.0K", silently mislabeling every chart whose peak crossed 100K.
 */
export function fmtAxisCompact(value: number | null | undefined): string {
  if (!isFiniteNumber(value)) return MISSING;
  return signedLadder(value, AXIS_COMPACT_RUNGS);
}

const AXIS_USD_RUNGS: readonly Rung[] = [
  { min: 0, div: 1, digits: 0, suffix: "" },
  { min: 1_000, div: 1_000, digits: 1, suffix: "K" },
  { min: 100_000, div: 1_000, digits: 0, suffix: "K" },
  { min: 1_000_000, div: 1_000_000, digits: 1, suffix: "M" },
  { min: 100_000_000, div: 1_000_000, digits: 0, suffix: "M" },
  { min: 1_000_000_000, div: 1_000_000_000, digits: 1, suffix: "B" },
  { min: 100_000_000_000, div: 1_000_000_000, digits: 0, suffix: "B" },
  { min: 1_000_000_000_000, div: 1_000_000_000_000, digits: 1, suffix: "T" },
];

/** Axis-tick variant of fmtUsd — same clipping guard as fmtAxisCompact, plus "$0" instead
 * of fmtUsd's "$0.00" at the zero anchor (axis ticks are round dollars, not prices). */
export function fmtAxisUsd(value: number | null | undefined): string {
  if (!isFiniteNumber(value)) return MISSING;
  return signedLadder(value, AXIS_USD_RUNGS, "$");
}

export function fmtInt(value: number | null | undefined): string {
  if (!isFiniteNumber(value)) return MISSING;
  // `+ 0` folds -0 (Math.round(-0.4)) into 0, which toLocaleString would print as "-0".
  return (Math.round(value) + 0).toLocaleString("en-US");
}

/* ─────────────────────────────────────────────────────────────────────────────────────
 * ONE AXIS, ONE UNIT (2026-09-01).
 *
 * fmtAxisCompact/fmtAxisUsd decide their unit PER VALUE, which is right for a table cell
 * and wrong for a tick, because ticks are read as a column. Measured on production:
 *
 *   /timing price distribution, y: "28.0K / 21.0K / 14.0K / 7,000 / 0"   K vs comma-grouping
 *   /timing price distribution, x: "$0.00 / $5.00 / $10 / $13 / $1.9K"   2dp vs 0dp vs K
 *   /games/1962700 review velocity: "0 / 30.0K / 60.0K / 90.0K / 120K"   1dp vs 0dp
 *   /entity release trajectory:     "$0 / $250M / $500M / $750M / $1.0B" M vs B mid-scale
 *
 * Every one of those is the same bug: a per-value ladder crossing one of its own
 * thresholds partway up a single axis, which makes evenly-spaced ticks read as an
 * irregular scale (the /entity axis' "$550M -> $1.1B" steps ARE regular — it is the unit
 * switch that makes them look otherwise).
 *
 * axisFormatter() takes the whole set of values an axis will print and returns ONE
 * formatter pinned to a single unit and a single decimal count. It is deliberately not a
 * fourth vocabulary: the units, the "$" prefix and the K/M/B suffixes are exactly
 * fmtAxisCompact/fmtAxisUsd's, so an axis and the tooltip beside it still speak the same
 * language — the only thing that changes is that the axis stops changing its mind.
 * ───────────────────────────────────────────────────────────────────────────────────── */

export type AxisKind = "count" | "usd" | "pct";

const AXIS_UNITS: { div: number; suffix: string }[] = [
  { div: 1, suffix: "" },
  { div: 1_000, suffix: "K" },
  { div: 1_000_000, suffix: "M" },
  { div: 1_000_000_000, suffix: "B" },
];

/** Decimals (0..2) needed to print `v` without rounding it. -1 when 2 is not enough. */
function decimalsFor(v: number): number {
  for (let d = 0; d <= 2; d++) {
    if (Math.abs(v - Number(v.toFixed(d))) < 1e-9) return d;
  }
  return -1;
}

/**
 * The largest unit that can print EVERY value exactly within `maxDecimals`, and never one
 * bigger than the data itself. Exactness is the whole point: stepping up to "B" because
 * the top tick is $1.0B is what turns $250M into either "$0.3B" (a rounding lie) or
 * "$0.25B" (a second decimal nothing else on the axis uses).
 */
function pickAxisUnit(values: number[], maxDecimals: number): { div: number; suffix: string } {
  const nonZero = values.filter((v) => Number.isFinite(v)).map(Math.abs).filter((v) => v > 0);
  if (nonZero.length === 0) return AXIS_UNITS[0];
  const max = Math.max(...nonZero);
  let best = AXIS_UNITS[0];
  for (const unit of AXIS_UNITS) {
    // Only abbreviate once the TOP tick is comfortably inside the unit. Without this an
    // axis topping out at 2,000 would read "0.5K / 1.0K / 1.5K / 2.0K" — technically one
    // unit, but four ticks all pretending to be fractions of a thousand.
    if (max / unit.div < 4) break;
    const d = nonZero.map((v) => decimalsFor(v / unit.div));
    if (d.every((x) => x >= 0 && x <= maxDecimals)) best = unit;
  }
  return best;
}

function groupInt(n: number, decimals: number): string {
  return n.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

/**
 * A tick formatter pinned to the unit and decimal count that fit ALL of `values`.
 *
 * Zero prints bare ("0", "$0", "0%") rather than "0K" — that is the one universally read
 * exception, and it is what every axis in the app already did at its origin.
 */
export function axisFormatter(
  values: number[],
  kind: AxisKind = "count",
  /** Ticks want at most one decimal; a PRICE axis needs two, or $19.99 rounds to $20.0. */
  maxDecimals = 1,
): (v: number | null | undefined) => string {
  const finite = values.filter((v) => Number.isFinite(v));
  // One decimal count for the WHOLE axis: "20%" beside "32%", never "20.0%" beside "32%".
  const decimalsOver = (xs: number[]) =>
    Math.max(0, ...xs.map((v) => Math.max(0, Math.min(maxDecimals, decimalsFor(Math.abs(v))))));

  if (kind === "pct") {
    // Percent values arrive already scaled to 0..100 on these charts — no unit ladder,
    // just the shared decimal count.
    const decimals = decimalsOver(finite);
    return (v) => {
      if (!isFiniteNumber(v)) return MISSING;
      return `${v.toFixed(decimals)}%`;
    };
  }

  const prefix = kind === "usd" ? "$" : "";
  const nonZero = finite.map(Math.abs).filter((v) => v > 0);
  const span = nonZero.length > 0 ? Math.max(...nonZero) / Math.min(...nonZero) : 1;

  // A LOG/decade-spaced axis cannot be pinned to one unit and stay readable: the niche
  // revenue histogram's edges run $1K -> $100M, and "one unit" would print the top of it
  // as "$100,000K". Past three decades of span, changing unit per decade IS the consistent
  // vocabulary (that is what a log axis means), so each label takes the largest unit that
  // keeps its mantissa >= 1 and the fewest decimals that print it exactly:
  // "$1K / $10K / $100K / $1M / $10M / $100M".
  if (span >= 1000) {
    return (v) => {
      if (!isFiniteNumber(v)) return MISSING;
      if (v === 0) return `${prefix}0`;
      const abs = Math.abs(v);
      const unit = [...AXIS_UNITS].reverse().find((u) => abs / u.div >= 1) ?? AXIS_UNITS[0];
      const d = Math.max(0, Math.min(maxDecimals, decimalsFor(abs / unit.div)));
      return `${v < 0 ? "-" : ""}${prefix}${groupInt(abs / unit.div, d)}${unit.suffix}`;
    };
  }

  const unit = pickAxisUnit(finite, maxDecimals);
  const decimals = decimalsOver(finite.map((v) => v / unit.div));
  return (v) => {
    if (!isFiniteNumber(v)) return MISSING;
    if (v === 0) return `${prefix}0`;
    const sign = v < 0 ? "-" : "";
    return `${sign}${prefix}${groupInt(Math.abs(v) / unit.div, decimals)}${unit.suffix}`;
  };
}

/**
 * Evenly spaced ticks for a [0, max] axis. Needed wherever we hand recharts a formatter
 * built from a known value set: recharts picks its own ticks otherwise, and could land on
 * values the formatter never saw (and so never sized its unit for).
 *
 * Steps come from the 1/2/2.5/5 x 10^n family; we take the SMALLEST that covers `max` in
 * at most `count` intervals, so the top tick hugs the data instead of leaving a magnitude
 * of dead headroom above the tallest bar.
 */
export function niceAxisTicks(max: number, count = 5): number[] {
  if (!Number.isFinite(max) || max <= 0 || count < 2) return [0];
  const target = max / count;
  const exp = Math.floor(Math.log10(target));
  let step = 0;
  outer: for (let e = exp; e <= exp + 2; e++) {
    const mag = Math.pow(10, e);
    for (const m of [1, 2, 2.5, 5]) {
      const s = m * mag;
      if (s >= target - 1e-12 && Math.ceil(max / s - 1e-9) <= count) {
        step = s;
        break outer;
      }
    }
  }
  if (step <= 0) return [0, max];
  const ticks: number[] = [];
  const last = Math.ceil(max / step - 1e-9);
  for (let i = 0; i <= last; i++) ticks.push(Number((step * i).toPrecision(12)));
  return ticks;
}

/**
 * The whole numeric-axis contract in one call: the ticks, the domain those ticks imply,
 * and the single-unit formatter sized for exactly those ticks. Pass all three to a
 * recharts <YAxis> so the axis it draws and the axis we formatted are the same axis.
 */
export function axisScale(
  max: number,
  kind: AxisKind = "count",
  count = 5,
): { ticks: number[]; domain: [number, number]; format: (v: number | null | undefined) => string } {
  const ticks = niceAxisTicks(max, count);
  return {
    ticks,
    domain: [0, ticks[ticks.length - 1] ?? 0],
    format: axisFormatter(ticks, kind),
  };
}

/** A 0–1 fraction as a percentage: 0.5 -> "50.0%". A value that rounds to zero prints
 * unsigned ("0.0%", never "-0.0%"). */
export function fmtPct(value: number | null | undefined, digits = 1): string {
  if (!isFiniteNumber(value)) return MISSING;
  const text = Math.abs(value * 100).toFixed(digits);
  return `${value < 0 && Number(text) !== 0 ? "-" : ""}${text}%`;
}

/** A 0–1 fraction as a SIGNED percentage: 0.05 -> "+5.0%", -0.05 -> "-5.0%". The sign is
 * read after rounding — a change that rounds to zero is "0.0%", not "+0.0%" or "-0.0%". */
export function fmtSigned(value: number | null | undefined, digits = 1): string {
  if (!isFiniteNumber(value)) return MISSING;
  const text = Math.abs(value * 100).toFixed(digits);
  const sign = Number(text) === 0 ? "" : value > 0 ? "+" : "-";
  return `${sign}${text}%`;
}

export function fmtPrice(value: number | null | undefined): string {
  if (!isFiniteNumber(value)) return MISSING;
  return value === 0 ? "Free" : `$${value.toFixed(2)}`;
}

/**
 * A percentile RANK (0–100 scale, e.g. mart_game.rev_pct_in_genre) for display.
 *
 * Floors, never rounds: a game ranked 99.6 beat 99.6% of its peers, and rounding printed
 * that as "P100" — a claim that it beat every one of them. The two ends read as words
 * ("top 1%", "bottom 1%") because "P0" is exactly the bare zero that twice got mistaken for
 * missing data, and "P99"/"P100" would each overclaim the top. Out-of-range input is
 * clamped to 0–100; non-finite input prints MISSING.
 */
export function fmtPercentile(value: number | null | undefined): string {
  if (!isFiniteNumber(value)) return MISSING;
  const v = Math.min(100, Math.max(0, value));
  if (v >= 99) return "top 1%";
  if (v < 1) return "bottom 1%";
  return `P${Math.floor(v)}`;
}

const MONTH_NAMES = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];
export function monthName(m: number): string {
  return MONTH_NAMES[(m - 1 + 12) % 12] ?? String(m);
}

// SQLite/DuckDB dayofweek-style convention verified against the API: weekday 0 =
// Monday .. 6 = Sunday (median_rev peaks on weekday 1/2, matching the cited
// "Tuesday" launch-day benchmark).
const WEEKDAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
export function weekdayName(w: number): string {
  return WEEKDAY_NAMES[w % 7] ?? String(w);
}

export function titleCase(s: string): string {
  return s.replace(/\w\S*/g, (t) => t[0].toUpperCase() + t.slice(1));
}

const MONTH_RUNGS: readonly Rung[] = [
  { min: 0, div: 1, digits: 0, suffix: " mo" },
  { min: 24, div: 12, digits: 1, suffix: " yr" },
];

/** Lifetime in months -> "14 mo" under 2 years, "3.2 yr" (one decimal) at 24+. A value that
 * rounds up to 24 months (23.6) is already "2.0 yr", never "24 mo". */
export function fmtMonths(value: number | null | undefined): string {
  if (!isFiniteNumber(value)) return MISSING;
  return signedLadder(value, MONTH_RUNGS);
}

const MINUTE_RUNGS: readonly Rung[] = [
  { min: 0, div: 1, digits: 0, suffix: "m" },
  { min: 60, div: 60, digits: 1, suffix: "h" },
  { min: 6_000, div: 60, digits: 0, suffix: "h" },
];

/** Playtime in minutes -> compact "142h" / "1.5h" / "35m" (Steam's own hour-first
 * convention). Negative input clamps to 0; 59.6 minutes is "1.0h", never "60m". */
export function fmtMinutes(value: number | null | undefined): string {
  if (!isFiniteNumber(value)) return MISSING;
  return ladder(Math.max(0, value), MINUTE_RUNGS);
}

/** Compact currency: $249, $12.4K, $1.2M, $3.4B. */
export function fmtUsd(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  const sign = value < 0 ? "-" : "";
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000) return `${sign}$${(abs / 1_000_000_000).toFixed(1)}B`;
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(1)}K`;
  return `${sign}$${abs.toFixed(abs < 10 ? 2 : 0)}`;
}

/**
 * Per-game estimated revenue for display. Titles with a $0 list price read "Free" instead of a
 * misleading "$0" — box revenue is $0 at a $0 price (the Boxleiter method models box sales, not the
 * MTX / battle-pass income F2P games actually run on). Pass isFree = (price_initial === 0), NOT the
 * is_free flag: some F2P-flagged titles also sell paid editions with real box revenue (e.g. Rainbow
 * Six Siege, is_free yet $19.99 / ~$920M est.), which should keep showing their number.
 */
export function fmtRevenue(value: number | null | undefined, isFree: boolean): string {
  if (isFree) return "Free";
  return fmtUsd(value);
}

/** Compact count: 1,284 / 12.9K / 4.2M. */
export function fmtCompact(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (abs >= 10_000) return `${(value / 1_000).toFixed(1)}K`;
  return value.toLocaleString("en-US", { maximumFractionDigits: 0 });
}

/**
 * Axis-tick variant of fmtCompact. Same units, but the decimal is dropped once the number
 * reaches three integer digits ("240K", not "240.0K"): chart YAxis columns are a fixed
 * 36-44px and recharts CLIPS overflowing tick labels from the LEFT — "240.0K" shipped
 * rendering as "40.0K", silently mislabeling every chart whose peak crossed 100K.
 */
export function fmtAxisCompact(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  const abs = Math.abs(value);
  if (abs >= 100_000_000) return `${Math.round(value / 1_000_000)}M`;
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (abs >= 100_000) return `${Math.round(value / 1_000)}K`;
  if (abs >= 10_000) return `${(value / 1_000).toFixed(1)}K`;
  return value.toLocaleString("en-US", { maximumFractionDigits: 0 });
}

/** Axis-tick variant of fmtUsd — same clipping guard as fmtAxisCompact, plus "$0" instead
 * of fmtUsd's "$0.00" at the zero anchor (axis ticks are round dollars, not prices). */
export function fmtAxisUsd(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  const sign = value < 0 ? "-" : "";
  const abs = Math.abs(value);
  if (abs >= 100_000_000_000) return `${sign}$${Math.round(abs / 1_000_000_000)}B`;
  if (abs >= 1_000_000_000) return `${sign}$${(abs / 1_000_000_000).toFixed(1)}B`;
  if (abs >= 100_000_000) return `${sign}$${Math.round(abs / 1_000_000)}M`;
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 100_000) return `${sign}$${Math.round(abs / 1_000)}K`;
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(1)}K`;
  return `${sign}$${Math.round(abs)}`;
}

export function fmtInt(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  return Math.round(value).toLocaleString("en-US");
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
      if (v === null || v === undefined || Number.isNaN(v)) return "—";
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
      if (v === null || v === undefined || Number.isNaN(v)) return "—";
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
    if (v === null || v === undefined || Number.isNaN(v)) return "—";
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

export function fmtPct(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  return `${(value * 100).toFixed(digits)}%`;
}

export function fmtSigned(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  const pct = value * 100;
  const sign = pct > 0 ? "+" : "";
  return `${sign}${pct.toFixed(digits)}%`;
}

export function fmtPrice(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  return value === 0 ? "Free" : `$${value.toFixed(2)}`;
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

/** Lifetime in months -> "14 mo" under 2 years, "3.2 yr" (one decimal) at 24+. */
export function fmtMonths(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  if (value < 24) return `${Math.round(value)} mo`;
  return `${(value / 12).toFixed(1)} yr`;
}

/** Playtime in minutes -> compact "142.0h" / "35m" (Steam's own hour-first convention). */
export function fmtMinutes(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  const mins = Math.max(0, value);
  if (mins < 60) return `${Math.round(mins)}m`;
  const hours = mins / 60;
  return `${hours < 100 ? hours.toFixed(1) : Math.round(hours)}h`;
}

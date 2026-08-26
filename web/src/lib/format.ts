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

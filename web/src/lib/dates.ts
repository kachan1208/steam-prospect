import { monthName } from "./format";

/**
 * ONE DATE VOCABULARY for the game page and its charts (2026-09-23).
 *
 * The game page printed four date dialects side by side: "2024-02-20" in the header,
 * "Aug 24" / "Aug 24, 2026" in the price chart, "2024-02-19 – 2025-04-11" on the press
 * footprint and "Nov 2024" in the velocity caption. Everything a reader sees now goes through
 * these two shapes — a day is "Feb 20, 2024", a month is "Feb 2024" — the same form the app
 * shell's data-age line already prints ("Data as of Sep 21, 2026", lib/dataAge.ts).
 *
 * Every input here is a server-side calendar DATE ('YYYY-MM-DD', a DuckDB timestamp string
 * 'YYYY-MM-DD HH:MM:SS', or an ISO timestamp), so the parts are read off the string, never
 * through `new Date(...)` in the viewer's timezone — which would print Feb 19 for a
 * '2024-02-20' in any zone west of UTC.
 */

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})/;
const MONTH_RE = /^(\d{4})-(\d{2})/;

/** 'YYYY-MM-DD…' -> "Feb 20, 2024"; null/unparseable -> null. */
export function fmtDay(value: string | null | undefined): string | null {
  if (!value) return null;
  const m = DAY_RE.exec(value.trim());
  if (!m) return null;
  const month = Number(m[2]);
  if (month < 1 || month > 12) return null;
  return `${monthName(month)} ${Number(m[3])}, ${m[1]}`;
}

/** 'YYYY-MM…' -> "Feb 2024"; null/unparseable -> null. */
export function fmtMonth(value: string | null | undefined): string | null {
  if (!value) return null;
  const m = MONTH_RE.exec(value.trim());
  if (!m) return null;
  const month = Number(m[2]);
  if (month < 1 || month > 12) return null;
  return `${monthName(month)} ${m[1]}`;
}

/** 'YYYY-MM' of a date-ish string, or null. */
export function monthKey(value: string | null | undefined): string | null {
  if (!value) return null;
  const m = MONTH_RE.exec(value.trim());
  return m ? `${m[1]}-${m[2]}` : null;
}

/** 'YYYY-MM' of a Date, read in UTC (a server build date) — or in local time for "now". */
export function monthOfDate(d: Date, utc = true): string {
  const y = utc ? d.getUTCFullYear() : d.getFullYear();
  const m = (utc ? d.getUTCMonth() : d.getMonth()) + 1;
  return `${y}-${String(m).padStart(2, "0")}`;
}

/** 'YYYY-MM' + n months. */
export function addMonths(period: string, n: number): string {
  const y = Number(period.slice(0, 4));
  const m = Number(period.slice(5, 7)) - 1 + n;
  const yy = y + Math.floor(m / 12);
  const mm = ((m % 12) + 12) % 12;
  return `${yy}-${String(mm + 1).padStart(2, "0")}`;
}

/** Every 'YYYY-MM' from `first` to `last` inclusive (empty when last < first). */
export function monthRange(first: string, last: string): string[] {
  const out: string[] = [];
  for (let p = first; p <= last && out.length < 2400; p = addMonths(p, 1)) out.push(p);
  return out;
}

/**
 * A monthly series with its EMPTY months put back.
 *
 * The press and review marts only emit months that had something in them, and a category
 * axis draws what it is given evenly spaced: Hollow Knight's press timeline was 41 bars
 * standing for 108 months, the 67 silent months simply gone, so a 2017 burst and a 2026 one
 * sat side by side as neighbours. `fill(period)` builds the row for a missing month (a zero
 * count, in practice). Rows keep their order; a period that is not 'YYYY-MM' is left as is.
 */
export function fillMonthlyGaps<T extends { period: string }>(points: readonly T[], fill: (period: string) => T): T[] {
  if (points.length < 2) return [...points];
  const byPeriod = new Map(points.map((p) => [p.period, p]));
  const first = points[0].period;
  const last = points[points.length - 1].period;
  if (!MONTH_RE.test(first) || !MONTH_RE.test(last) || last < first) return [...points];
  return monthRange(first, last).map((p) => byPeriod.get(p) ?? fill(p));
}

/**
 * The month on a monthly chart that is still being counted, or null.
 *
 * The data only runs to its as-of date (the mart's build day): when the chart's last month is
 * the as-of month, that bar holds a fraction of a month — Sep 2026 built on Sep 21 is 21 days
 * of 30 — and reads as a collapse next to the full months before it. Without an as-of date
 * (health not answered yet) the viewer's own month stands in: a bar for the current calendar
 * month is certainly incomplete.
 */
export function partialMonth(lastPeriod: string | null | undefined, asOf: Date | null | undefined, now: Date = new Date()): string | null {
  if (!lastPeriod) return null;
  const current = asOf ? monthOfDate(asOf, true) : monthOfDate(now, false);
  return lastPeriod === current ? lastPeriod : null;
}

/** Day-of-month the as-of date reached, for "partial (21 of 30 days)" copy; null without one. */
export function daysIntoMonth(asOf: Date | null | undefined): { day: number; of: number } | null {
  if (!asOf) return null;
  const y = asOf.getUTCFullYear();
  const m = asOf.getUTCMonth();
  const of = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return { day: asOf.getUTCDate(), of };
}

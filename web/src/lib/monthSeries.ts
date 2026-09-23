/**
 * Monthly series on a category axis must not skip months (2026-09-23).
 *
 * The niche press timeline arrives SPARSE — only months that had an article — and its chart
 * draws months as categories, so a year with no coverage simply vanished: two bars twelve
 * months apart sat side by side as if consecutive, and a quiet period read as a busy one.
 * fillMonthGaps() inserts an explicit zero for every calendar month between the first and
 * the last point (never before or after them — no invented history, no invented future), so
 * equal spacing on the axis means equal time again.
 */

/** "YYYY-MM" -> [year, month(1-12)], or null when it isn't one. */
function parseMonth(m: string): [number, number] | null {
  const match = /^(\d{4})-(\d{2})/.exec(m);
  if (!match) return null;
  const y = Number(match[1]);
  const mo = Number(match[2]);
  return mo >= 1 && mo <= 12 ? [y, mo] : null;
}

function fmtMonth(y: number, m: number): string {
  return `${y}-${String(m).padStart(2, "0")}`;
}

/**
 * Every calendar month from the first point's to the last point's, in order, with `zero(m)`
 * standing in for the months the series skipped. Points whose month can't be parsed are
 * dropped; duplicates keep the first occurrence.
 */
export function fillMonthGaps<T>(points: readonly T[], monthOf: (p: T) => string, zero: (month: string) => T): T[] {
  const byMonth = new Map<string, T>();
  for (const p of points) {
    const ym = parseMonth(monthOf(p));
    if (!ym) continue;
    const key = fmtMonth(ym[0], ym[1]);
    if (!byMonth.has(key)) byMonth.set(key, p);
  }
  const months = [...byMonth.keys()].sort();
  if (months.length === 0) return [];
  const [y0, m0] = parseMonth(months[0])!;
  const [y1, m1] = parseMonth(months[months.length - 1])!;
  const out: T[] = [];
  let [y, m] = [y0, m0];
  while (y < y1 || (y === y1 && m <= m1)) {
    const key = fmtMonth(y, m);
    out.push(byMonth.get(key) ?? zero(key));
    if (m === 12) {
      y += 1;
      m = 1;
    } else {
      m += 1;
    }
  }
  return out;
}

/** "YYYY-MM" of a date, read in UTC (data dates identify a server-side build). */
export function monthOfDate(d: Date): string {
  return fmtMonth(d.getUTCFullYear(), d.getUTCMonth() + 1);
}

/** The series' last month when it is the data's own, still-running month (so its bar holds
 * only part of a month), else null. */
export function partialMonth(months: readonly string[], asOf: Date | null): string | null {
  if (!asOf || months.length === 0) return null;
  const last = [...months].sort()[months.length - 1];
  return last.slice(0, 7) === monthOfDate(asOf) ? last : null;
}

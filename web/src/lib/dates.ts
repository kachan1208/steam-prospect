import { fmtIsoDate, fmtIsoMonth, MISSING } from "./format";

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

const MONTH_RE = /^(\d{4})-(\d{2})/;

/** 'YYYY-MM-DD…' -> "Feb 20, 2024"; null/unparseable -> null. lib/format's fmtIsoDate (the
 * app's one date format) with a null instead of a dash, so a caller can decide what an
 * absent date says. */
export function fmtDay(value: string | null | undefined): string | null {
  const s = fmtIsoDate(value);
  return s === MISSING ? null : s;
}

/** 'YYYY-MM…' -> "Feb 2024"; null/unparseable -> null (lib/format's fmtIsoMonth). */
export function fmtMonth(value: string | null | undefined): string | null {
  const s = fmtIsoMonth(value);
  return s === MISSING ? null : s;
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

export interface LaunchFacts {
  /** "ea-graduate": went Early Access -> 1.0; "released": one launch date; "unknown": no date. */
  kind: "ea-graduate" | "released" | "unknown";
  /** The first day the game was buyable: "Dec 10, 2019", or "~Aug 2018" when only the month is
   * known. Null when there is no date. */
  firstPublic: string | null;
  /** The 1.0 date for a graduate ("Sep 17, 2020"), else null. */
  fullRelease: string | null;
  /** The date "since launch" counts from ('YYYY-MM-DD'): the first public date when served,
   * else the release date. */
  launchDate: string | null;
  /** Only the month of the first public date is known. */
  approximate: boolean;
  /** The one-line header text. */
  line: string;
  /** Where the date came from, in words — for the ⓘ. */
  source: string | null;
}

/**
 * When the game launched, EARLY ACCESS INCLUDED (2026-09-23).
 *
 * The rebuilt mart dates a game from its FIRST PUBLIC day — the Early Access start for a
 * graduate (Hades: Steam Early Access Dec 10, 2019, 1.0 on Sep 17, 2020) — where the old one
 * used Steam's store date, the 1.0. A graduate is read as both dates; a date known only to
 * the month (dated from the month of its first review) prints "~Aug 2018", never a fake day.
 * Every field is gated: on a mart without them this falls back to `release_date`.
 */
export function launchFacts(p: {
  release_date?: string | null;
  first_public_date?: string | null;
  release_date_1_0?: string | null;
  is_ea_graduate?: boolean | null;
  release_date_source?: string | null;
}): LaunchFacts {
  const raw = p.first_public_date ?? p.release_date ?? null;
  const approximate = p.release_date_source === "first_review_month";
  const firstPublic = raw ? (approximate ? (fmtMonth(raw) ? `~${fmtMonth(raw)}` : null) : fmtDay(raw)) : null;
  const source =
    p.release_date_source === "first_review_month"
      ? "dated from the month of its first Steam review — accurate to the month only"
      : p.release_date_source === "first_review"
        ? "dated from its first Steam review, which came before the store page's date"
        : p.release_date_source === "store"
          ? "the date on the Steam store page"
          : null;
  const oneZero = p.release_date_1_0 ? fmtDay(p.release_date_1_0) : null;
  if (!firstPublic) {
    return { kind: "unknown", firstPublic: null, fullRelease: null, launchDate: null, approximate, line: "Release date unknown", source };
  }
  if (p.is_ea_graduate === true && oneZero && p.release_date_1_0 !== raw) {
    return {
      kind: "ea-graduate",
      firstPublic,
      fullRelease: oneZero,
      launchDate: raw,
      approximate,
      line: `Early Access since ${firstPublic} · 1.0 on ${oneZero}`,
      source,
    };
  }
  return { kind: "released", firstPublic, fullRelease: null, launchDate: raw, approximate, line: `Released ${firstPublic}`, source };
}

/** Day-of-month the as-of date reached, for "partial (21 of 30 days)" copy; null without one. */
export function daysIntoMonth(asOf: Date | null | undefined): { day: number; of: number } | null {
  if (!asOf) return null;
  const y = asOf.getUTCFullYear();
  const m = asOf.getUTCMonth();
  const of = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return { day: asOf.getUTCDate(), of };
}

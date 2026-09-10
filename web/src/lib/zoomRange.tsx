/**
 * ONE date window, shared by every chart on the page.
 *
 * Drag-to-zoom started per-chart, and the first thing reported about it was that it should
 * not be: "in case we select range of dates on one graph - same range of dates should be
 * selected on all graphs." That is right — a game page or a niche page is one story told by
 * a stack of charts, and zooming the review velocity to a launch window while the price
 * history beside it still shows all time is two different arguments on one screen.
 *
 * WHY THE SHARED STATE IS DATES AND NOT INDICES. The charts do not agree on granularity:
 * `period`/`month` are "YYYY-MM", `date`/`captured_on` are "YYYY-MM-DD", `year` is the
 * NUMBER 2014, and a studio's release trajectory is keyed "#seq" with a release date beside
 * it. An index range means nothing across those. A date interval means the same thing to
 * all of them, so each chart converts its own buckets to spans and keeps the ones that
 * overlap — a month bucket survives if any day of it falls in the window, which is what
 * makes a monthly and a daily chart agree about "Feb 2024 to Aug 2025".
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { useLocation } from "react-router-dom";

/** Inclusive ISO day bounds. */
export interface DateRange {
  from: string;
  to: string;
}

interface ZoomRangeApi {
  range: DateRange | null;
  setRange: (r: DateRange | null) => void;
}

const ZoomRangeContext = createContext<ZoomRangeApi>({ range: null, setRange: () => {} });

/** Last day of a month, leap years included. */
function endOfMonth(year: number, month: number): string {
  const d = new Date(Date.UTC(year, month, 0)); // month is 1-based; day 0 = last of prev
  return `${year}-${String(month).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

/**
 * The calendar span a chart bucket covers, as inclusive ISO days — or null when the value
 * is not a date at all (a genre name, a revenue bucket), which is how a chart opts out of
 * the shared window without knowing anything about it.
 *
 * ISO strings compare correctly with `<` and `>`, so every comparison downstream is a plain
 * string compare and no Date objects are constructed per row.
 */
export function bucketSpan(value: unknown): [string, string] | null {
  if (value == null) return null;
  const s = String(value).trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) return [s, s];
  m = /^(\d{4})-(\d{2})$/.exec(s);
  if (m) {
    const y = Number(m[1]);
    const mo = Number(m[2]);
    if (mo < 1 || mo > 12) return null;
    return [`${s}-01`, endOfMonth(y, mo)];
  }
  m = /^(\d{4})$/.exec(s);
  if (m) return [`${s}-01-01`, `${s}-12-31`];
  return null;
}

/** Do two inclusive spans share any day? */
export function spansOverlap(span: [string, string], range: DateRange): boolean {
  return span[0] <= range.to && span[1] >= range.from;
}

/** The window covering both buckets — the union of their spans. */
export function spanUnion(a: [string, string], b: [string, string]): DateRange {
  return { from: a[0] < b[0] ? a[0] : b[0], to: a[1] > b[1] ? a[1] : b[1] };
}

/**
 * Human label for the window, at the coarsest unit that still describes it exactly: a whole
 * year reads "2024", a whole month "Feb 2024", anything else the two endpoints. The banner
 * has to say what is selected in the vocabulary the axes use, or it is just two ISO strings.
 */
export function formatRange(r: DateRange): string {
  const [fy, fm] = [r.from.slice(0, 4), r.from.slice(5, 7)];
  const [ty, tm] = [r.to.slice(0, 4), r.to.slice(5, 7)];
  const month = (y: string, m: string) =>
    `${["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][Number(m)]} ${y}`;
  const wholeYears = r.from.endsWith("-01-01") && r.to.endsWith("-12-31");
  if (wholeYears) return fy === ty ? fy : `${fy} – ${ty}`;
  const wholeMonths = r.from.endsWith("-01") && r.to === bucketSpan(`${ty}-${tm}`)?.[1];
  if (wholeMonths) {
    return fy === ty && fm === tm ? month(fy, fm) : `${month(fy, fm)} – ${month(ty, tm)}`;
  }
  return `${r.from} – ${r.to}`;
}

export function ZoomRangeProvider({ children }: { children: ReactNode }) {
  const [range, setRange] = useState<DateRange | null>(null);
  const { pathname } = useLocation();

  // A window drawn on a game's charts means nothing on the next game's, and carrying it
  // across would silently hide data on a page the reader has not zoomed.
  useEffect(() => {
    setRange(null);
  }, [pathname]);

  // Escape clears from anywhere on the page, not only over a chart — the drag is over by
  // the time the reader decides to undo it, and their pointer has moved on.
  useEffect(() => {
    if (!range) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setRange(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [range]);

  const value = useMemo(() => ({ range, setRange }), [range]);
  return <ZoomRangeContext.Provider value={value}>{children}</ZoomRangeContext.Provider>;
}

export function useZoomRange(): ZoomRangeApi {
  return useContext(ZoomRangeContext);
}

/** Clear helper for controls that only need to undo. */
export function useClearZoom(): () => void {
  const { setRange } = useZoomRange();
  return useCallback(() => setRange(null), [setRange]);
}

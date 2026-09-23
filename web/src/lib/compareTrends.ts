import type { GameTrendPoint } from "./api";
import { fmtCompact, fmtUsd, monthName } from "./format";
import { launchAnchor, monthOrdinal, type LaunchAnchor, type LifecycleFields } from "./lifecycle";

/**
 * /compare's reads of Steam's own MONTHLY REVIEW HISTOGRAM (GET /api/games/{id}/trends).
 *
 * That histogram is each game's full review history — not our recency-biased review sample —
 * so it is the honest source for "how fast did it start": the API's n_reviews_first_30d /
 * _90d / _365d come from the SAMPLE (stg_review), which for an older hit is a sliver of the
 * truth (Slay the Spire: 44 sampled reviews in its first 30 days, against thousands a month in
 * the histogram). Month granularity is the price: "first 3 months" is the launch month and
 * the two after it, the launch month itself partial.
 */

/** 'YYYY-MM' of a month ordinal. */
export function periodOf(ordinal: number): string {
  const y = Math.floor(ordinal / 12);
  const m = ordinal - y * 12 + 1;
  return `${y}-${String(m).padStart(2, "0")}`;
}

/** "Aug 2026" for a 'YYYY-MM' period. */
export function periodLabel(period: string): string {
  const o = monthOrdinal(period);
  if (o === null) return period;
  return `${monthName((o % 12) + 1)} ${Math.floor(o / 12)}`;
}

/**
 * The month the data is still IN — its reviews are partial, so drawing it makes every line
 * dive at the right edge. The data's as-of month, unless the as-of date is that month's last
 * day; without an as-of date, the current UTC month.
 */
export function partialPeriodOf(asOf: Date | null, now: Date = new Date()): string {
  const d = asOf ?? now;
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  if (asOf && d.getUTCDate() === lastDay) return periodOf(y * 12 + m + 1);
  return periodOf(y * 12 + m);
}

/** A game's points without the partial month. */
export function completeMonths(points: readonly GameTrendPoint[], partial: string | null): GameTrendPoint[] {
  return partial ? points.filter((p) => p.period < partial) : [...points];
}

export interface LaunchWindow {
  /** Reviews in the window's complete months (null when there is no anchor). */
  total: number | null;
  /** Months of the window that are over; < `months` for a game launched recently. */
  monthsCovered: number;
  months: number;
  /** Reviews posted BEFORE the anchor month — the game was on sale earlier (Early Access)
   * while the anchor is its release date. */
  before: number;
  anchor: LaunchAnchor | null;
  /** The window's months, oldest first, with their counts — for the worked line. */
  parts: { period: string; n: number }[];
}

/** Reviews in a game's first `months` calendar months, counted from its launch anchor (the
 * first public date when the mart has one, else the release date). */
export function launchWindowReviews(
  points: readonly GameTrendPoint[],
  game: LifecycleFields,
  months: number,
  partial: string | null,
): LaunchWindow {
  const anchor = launchAnchor(game);
  const start = anchor ? monthOrdinal(anchor.iso) : null;
  if (anchor === null || start === null) {
    return { total: null, monthsCovered: 0, months, before: 0, anchor: null, parts: [] };
  }
  const partialOrd = partial ? monthOrdinal(partial) : null;
  const byOrd = new Map<number, number>();
  let before = 0;
  for (const p of points) {
    const o = monthOrdinal(p.period);
    if (o === null) continue;
    if (o < start) before += p.n_reviews;
    else byOrd.set(o, p.n_reviews);
  }
  const parts: { period: string; n: number }[] = [];
  let total = 0;
  let covered = 0;
  for (let o = start; o < start + months; o++) {
    if (partialOrd !== null && o >= partialOrd) break; // not over yet
    covered += 1;
    const n = byOrd.get(o) ?? 0;
    total += n;
    parts.push({ period: periodOf(o), n });
  }
  return { total, monthsCovered: covered, months, before, anchor, parts };
}

/** The worked line for a launch window: "Feb–Apr 2024: 10,384 + 13,110 + 6,631 = 30,125". */
export function launchWindowWorked(name: string, w: LaunchWindow): string | null {
  if (w.total === null || w.parts.length === 0) return null;
  const first = periodLabel(w.parts[0].period);
  const last = periodLabel(w.parts[w.parts.length - 1].period);
  const span = w.parts.length === 1 ? first : `${first} – ${last}`;
  const sum =
    w.parts.length <= 4
      ? `${w.parts.map((p) => p.n.toLocaleString("en-US")).join(" + ")} = ${w.total.toLocaleString("en-US")}`
      : `${w.parts.length} months = ${w.total.toLocaleString("en-US")}`;
  return `${name}: ${span}: ${sum}`;
}

// ---- align by launch -----------------------------------------------------------------------

export interface AlignedRow {
  /** Months since the launch month (0 = launch month; negative = before it). */
  offset: number;
  [key: string]: number | string | null;
}

/**
 * Merge per-game series on "months since launch" instead of the calendar, so a 2017 hit and a
 * 2024 hit can be compared launch-for-launch. Each row carries `g{id}` = reviews and `p{id}` =
 * the calendar period it came from (for the tooltip). Games without an anchor are left out
 * (the caller says so).
 */
export function alignByLaunch(
  series: Map<number, readonly GameTrendPoint[]>,
  anchors: Map<number, LaunchAnchor | null>,
): AlignedRow[] {
  const rows = new Map<number, AlignedRow>();
  for (const [id, points] of series) {
    const anchor = anchors.get(id);
    const start = anchor ? monthOrdinal(anchor.iso) : null;
    if (start === null) continue;
    for (const p of points) {
      const o = monthOrdinal(p.period);
      if (o === null) continue;
      const offset = o - start;
      const row = rows.get(offset) ?? { offset };
      row[`g${id}`] = p.n_reviews;
      row[`p${id}`] = p.period;
      rows.set(offset, row);
    }
  }
  const out = [...rows.values()].sort((a, b) => a.offset - b.offset);
  // Every series key present on every row (null = no data that month), so the lines break
  // at gaps instead of bridging them.
  const ids = [...series.keys()].filter((id) => anchors.get(id));
  for (const r of out) for (const id of ids) if (!(`g${id}` in r)) r[`g${id}`] = null;
  return out;
}

// ---- the takeaway ------------------------------------------------------------------------

export interface TakeawayGame {
  name: string;
  /** Est. revenue, null for free / unknown-price / unestimated games. */
  revenue: number | null;
  /** 7-day players trend in PERCENT (−0.55 = −0.55%), null when not measured. */
  trend7d: number | null;
  /** Reviews in the first 3 months (histogram), null when unknown. */
  first3: number | null;
  /** True when the first-3-month window is complete. */
  first3Complete: boolean;
}

function signedPct(v: number): string {
  return `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(1)}%`;
}

function listNames(names: string[]): string {
  if (names.length <= 1) return names.join("");
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * One plain line on top of the grid — BEARISH READING FIRST (the owner's rule): who is losing
 * players this week, then who earned the most and by how much, then who started fastest.
 * Returns null when there is nothing comparable to say.
 */
export function compareTakeaway(games: readonly TakeawayGame[]): string | null {
  if (games.length < 2) return null;
  const parts: string[] = [];

  const measured = games.filter((g) => g.trend7d !== null);
  const falling = measured.filter((g) => (g.trend7d as number) < 0);
  const rising = measured.filter((g) => (g.trend7d as number) > 0);
  if (measured.length >= 2 && falling.length === measured.length) {
    const vals = falling.map((g) => g.trend7d as number);
    const lo = Math.min(...vals);
    const hi = Math.max(...vals);
    parts.push(
      `${measured.length === games.length ? `All ${games.length}` : `All ${measured.length} measured`} are losing players this week (${
        lo === hi ? signedPct(lo) : `${signedPct(hi)} to ${signedPct(lo)}`
      }).`,
    );
  } else if (falling.length > 0) {
    parts.push(
      `${listNames(falling.map((g) => g.name))} ${falling.length === 1 ? "is" : "are"} losing players this week${
        rising.length > 0 ? `; ${listNames(rising.map((g) => g.name))} ${rising.length === 1 ? "is" : "are"} growing` : ""
      }.`,
    );
  }

  const earning = games.filter((g) => g.revenue !== null && (g.revenue as number) > 0);
  if (earning.length >= 2) {
    const sorted = [...earning].sort((a, b) => (b.revenue as number) - (a.revenue as number));
    const top = sorted[0];
    const low = sorted[sorted.length - 1];
    const ratio = (top.revenue as number) / (low.revenue as number);
    parts.push(
      `${top.name} has earned the most (est. ${fmtUsd(top.revenue)}${
        ratio >= 1.1 ? `, ${ratio.toFixed(1)}× ${low.name}` : ", about level with the rest"
      }).`,
    );
  }

  const started = games.filter((g) => g.first3 !== null && g.first3Complete);
  if (started.length >= 2) {
    const fastest = [...started].sort((a, b) => (b.first3 as number) - (a.first3 as number))[0];
    parts.push(`${fastest.name} started fastest (${fmtCompact(fastest.first3)} reviews in its first 3 months).`);
  }

  return parts.length > 0 ? parts.join(" ") : null;
}

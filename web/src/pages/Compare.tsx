import { useEffect, useMemo, type CSSProperties, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useQueries } from "@tanstack/react-query";
import clsx from "clsx";

import {
  CompareTrendsChart,
  SeriesKey,
  compareSeriesColor,
  seriesShapePath,
  type CompareAlign,
} from "../components/charts/CompareTrendsChart";
import { Segmented } from "../components/search/Segmented";
import { EmptyState } from "../components/ui/EmptyState";
import { RetryButton } from "../components/ui/ErrorState";
import { MetricTip } from "../components/ui/InfoTip";
import type { InfoTipContent } from "../components/ui/InfoTipBase";
import { Loading } from "../components/ui/Loading";
import { SentinelTag } from "../components/ui/SentinelTag";
import { TableScroll } from "../components/ui/TableScroll";
import {
  errorMessage,
  gameProfileQueryOptions,
  isNotFound,
  useGameTrendsWithComps,
  type GameProfile,
  type GameTrendPoint,
} from "../lib/api";
import {
  compareTakeaway,
  completeMonths,
  launchWindowReviews,
  launchWindowWorked,
  partialPeriodOf,
  periodLabel,
  periodOf,
  type LaunchWindow,
} from "../lib/compareTrends";
import { COMPARE_CAP, removeFromCompare, useCompareList } from "../lib/compareList";
import { useDataAge } from "../lib/dataAge";
import { estimatedUnits } from "../lib/estimates";
import {
  fmtCompact,
  fmtInt,
  fmtMinutes,
  fmtPct,
  fmtPercentile,
  fmtPrice,
  fmtPriceFor,
  fmtUsd,
  isFiniteNumber,
  PRICE_UNKNOWN,
  PRICE_UNKNOWN_NOTE,
  priceKind,
} from "../lib/format";
import { glossary, type GlossaryKey } from "../lib/glossary";
import { launchAnchor, monthOrdinal, releaseCaption, type LaunchAnchor } from "../lib/lifecycle";
import { compareSeries } from "../lib/palette";
import { useMinWidth } from "../lib/useMinWidth";
import { usePageTitle } from "../lib/usePageTitle";

/**
 * Side-by-side comparison for 2-6 games (mockup 4d). The ids ride the URL (?ids=1,2,3) so a
 * comparison is shareable/bookmarkable; with no ids param the page falls back to the
 * stored compare list and immediately normalizes the URL (replace) to match. Column
 * order = id order; the trends overlay uses game 1 as the primary with the rest as
 * ?comps= (one request).
 *
 * Blueprint grammar: hairline frames with "+" corner marks, square corners, condensed
 * headings, mono-steel verdict language (accent-300 up / paper-muted down, never red-
 * green). The overlay chart is CompareTrendsChart, already on the house chart tokens;
 * this page renders the one legend inline with the panel title (mockup 4d) and passes
 * hideLegend so the chart doesn't repeat it.
 *
 * EVERY ROW EXPLAINS ITSELF (2026-09-23): none of the grid's metric rows had an explanation.
 * Each now carries the glossary's ⓘ with the formula worked through for EACH game ("Balatro:
 * 198,820 × 30 × $14.99 = $89.4M"), sentinels are tagged ("Price unknown", "not measured"),
 * and the grid opens on a one-line takeaway, bearish reading first.
 */

// Hairline alphas the mockup calls that don't already have a named Tailwind token
// (--border is 22%, --border-strong is 35%) — built the same way index.css builds every
// other hairline: color-mix against the theme's own foreground, so it tracks light/dark
// and any accent swap instead of a hardcoded paper rgba.
const PANEL_BORDER = "color-mix(in srgb, var(--text-primary) 25%, transparent)";
const ROW_RULE = "color-mix(in srgb, var(--text-primary) 12%, transparent)";
const STRIPE_THUMB =
  "repeating-linear-gradient(45deg, color-mix(in srgb, var(--text-primary) 12%, transparent), " +
  "color-mix(in srgb, var(--text-primary) 12%, transparent) 4px, transparent 4px, transparent 8px)";
// Condensed 600 is automatic on <h1>-<h6> (index.css applies it by element); anything else
// that reads condensed in the mockup (buttons, column names, big values) needs it inline.
const CONDENSED: CSSProperties = { fontFamily: '"Barlow Condensed", "Barlow", system-ui, sans-serif' };

/** Below this width the column-per-game table became a 340px scroller showing one game of
 * three (measured 2026-09-22), so the grid turns metric-major: one block per metric, every
 * game's value in it — the comparison stays side by side, just vertical. */
const TABLE_MIN_WIDTH = 640;

const ALIGNS: readonly { value: CompareAlign; label: string; title: string }[] = [
  { value: "calendar", label: "Calendar", title: "Each game's reviews by calendar month" },
  { value: "launch", label: "Since launch", title: "Months since each game went on sale — launch against launch" },
];

/** GameProfile plus the fields the API serves once the mart carries them (optional: absent on
 * today's mart). Declared here rather than on the shared interface the game page owns. */
type CompareProfile = GameProfile & {
  first_public_date?: string | null;
  release_date_1_0?: string | null;
  is_ea_graduate?: boolean | null;
  release_date_source?: string | null;
  price_status?: string | null;
  /** The whole Steam panel's 7-day change over the same days, in percent. */
  players_trend_7d_market_pct?: number | null;
  /** players_trend_7d_pct − the market's, in percentage points. */
  players_trend_7d_rel_pct?: number | null;
};

function parseIds(raw: string | null): number[] {
  if (!raw) return [];
  const out: number[] = [];
  const seen = new Set<number>();
  for (const tok of raw.split(",")) {
    const v = Number(tok.trim());
    if (!Number.isInteger(v) || v <= 0 || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
    if (out.length >= COMPARE_CAP) break;
  }
  return out;
}

// ---- the metric rows -------------------------------------------------------------------

/** One game's cell in a row. */
interface Cell {
  /** What the cell shows (a number, a word, or a tagged sentinel). */
  node: ReactNode;
  /** The value as DISPLAYED — ties are judged on this, so three "top 1%" cells tie even when
   * the ranks behind them are 99.6, 99.8 and 99.6. null = not comparable (a sentinel). */
  shown: string | null;
  /** The number behind it, for the best-in-row pick. */
  num: number | null;
  /** A second, smaller line under the value. */
  note?: ReactNode;
}

interface RowCtx {
  windows3: Map<number, LaunchWindow>;
  windows12: Map<number, LaunchWindow>;
  /** Reviews in the last full month, per game. */
  lastFull: Map<number, number | null>;
  lastFullPeriod: string | null;
  /** True once the trends request has answered (so an absent series is a real "no data"). */
  trendsReady: boolean;
}

interface StatRowDef {
  key: string;
  label: string | ((ctx: RowCtx) => string);
  term?: GlossaryKey;
  info?: Partial<InfoTipContent>;
  cell: (p: CompareProfile, ctx: RowCtx, id: number) => Cell;
  /** Highest shown value wins the accent (ties all win; a row where every game ties has no
   * winner). Omit for rows where more is not better (playtime, genre). */
  best?: boolean;
  /** Trend rows: ▲/▼ coloured by direction instead of a best-in-row accent. */
  verdict?: boolean;
  /** This game's numbers worked through the row's formula. */
  worked?: (p: CompareProfile, name: string, ctx: RowCtx, id: number) => string | null;
}

function tagged(tag: string, note?: ReactNode): Cell {
  return { node: <SentinelTag>{tag}</SentinelTag>, shown: null, num: null, note };
}

function plain(text: string, num: number | null): Cell {
  return { node: text, shown: text, num };
}

function signedPct(v: number): string {
  return `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(1)}%`;
}

function signedPts(v: number): string {
  return `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(1)} pts`;
}

function windowCell(w: LaunchWindow | undefined, ctx: RowCtx): Cell {
  if (!ctx.trendsReady) return { node: "…", shown: null, num: null };
  if (!w) return tagged("no monthly data");
  if (w.total === null) return tagged("no release date");
  const complete = w.monthsCovered >= w.months;
  const eaBefore = w.before > 0 && w.anchor?.source === "release";
  const note = eaBefore ? <SentinelTag>from 1.0 — sold in EA before</SentinelTag> : undefined;
  if (!complete) {
    return {
      node: fmtCompact(w.total),
      shown: null, // not comparable with a finished window
      num: null,
      note: (
        <SentinelTag>
          {w.monthsCovered} of {w.months} months so far
        </SentinelTag>
      ),
    };
  }
  return { node: fmtCompact(w.total), shown: fmtCompact(w.total), num: w.total, note };
}

const LAUNCH_WINDOW_INFO = (months: number): Partial<InfoTipContent> => ({
  label: `Reviews, first ${months} months`,
  meaning: `How fast the game started: the reviews it collected in its launch month and the ${months - 1} after it — a proxy for launch sales.`,
  formula: `sum of the monthly reviews from the launch month through month ${months - 1} after it (launch = the first public date when the data has it, else the release date)`,
  notes:
    "From Steam's own monthly review histogram — every review, not our sample. The API's first-30/90/365-day counts come from our recency-biased review SAMPLE, which misses most of an older hit's launch (Slay the Spire: 44 sampled reviews in its first 30 days), so this row doesn't use them. Month granularity: the launch month itself is partial. An Early Access game aligned on its 1.0 date is tagged — its EA months aren't in the window.",
  source: "Steam's own per-month review histogram (full history, uncapped)",
});

const STAT_ROWS: StatRowDef[] = [
  {
    key: "revenue",
    label: glossary("est_revenue").label,
    term: "est_revenue",
    info: { notes: `${glossary("est_revenue").notes ?? ""} ${PRICE_UNKNOWN_NOTE}` },
    cell: (p) => {
      const kind = priceKind(p);
      if (kind === "free") return { node: "Free", shown: null, num: null };
      if (kind === "unknown") return tagged(PRICE_UNKNOWN);
      if (p.est_rev_reviews == null) return tagged("no estimate");
      return plain(fmtUsd(p.est_rev_reviews), p.est_rev_reviews);
    },
    best: true,
    worked: (p, name) => {
      const kind = priceKind(p);
      if (kind === "free") return `${name}: free — no box revenue to estimate`;
      if (kind === "unknown") return `${name}: price unknown — no estimate`;
      if (p.total_reviews == null || p.est_rev_reviews == null) return null;
      return `${name}: ${fmtInt(p.total_reviews)} reviews × 30 × ${fmtPrice(p.price_initial)} = ${fmtUsd(p.est_rev_reviews)}`;
    },
  },
  // Units come from the SAME reviews-based estimator as the revenue row above (lib/estimates.ts),
  // never from the owners-based owners_mid. Pairing the two estimators in one column pair is what
  // let this grid show a game with MORE units AND LESS revenue at a HIGHER price — Silksong vs
  // Hollow Knight — a comparison no reader can act on. Now units × price === the revenue printed
  // one row up, for every paid title in the grid.
  {
    key: "units",
    label: glossary("units").label,
    term: "units",
    cell: (p) => {
      const u = estimatedUnits(p.est_rev_reviews, p.price_initial, p.total_reviews);
      return u == null ? tagged("no reviews") : plain(fmtCompact(u), u);
    },
    best: true,
    worked: (p, name) => {
      const u = estimatedUnits(p.est_rev_reviews, p.price_initial, p.total_reviews);
      if (u == null || p.total_reviews == null) return null;
      return `${name}: ${fmtInt(p.total_reviews)} reviews × 30 = ${fmtCompact(u)}`;
    },
  },
  {
    key: "rating",
    label: glossary("positive_ratio").label,
    term: "positive_ratio",
    cell: (p) => (p.positive_ratio == null ? tagged("no reviews") : plain(fmtPct(p.positive_ratio), p.positive_ratio)),
    best: true,
    worked: (p, name) =>
      p.positive_ratio == null ? null : `${name}: ${fmtPct(p.positive_ratio)} of ${fmtInt(p.total_reviews)} reviews positive`,
  },
  // The mart has no tracked PEAK CCU — live_players is an explicit point sample at the
  // nightly capture, NOT a daily peak — so this row is "Players now", never "Peak CCU".
  {
    key: "live_players",
    label: glossary("players_now").label,
    term: "players_now",
    cell: (p) => (p.live_players == null ? tagged("not measured") : plain(fmtCompact(p.live_players), p.live_players)),
    best: true,
  },
  {
    key: "players_7d",
    label: glossary("players_trend_7d_pct").label,
    term: "players_trend_7d_pct",
    verdict: true,
    // The arrow and its colour follow the MARKET-RELATIVE reading when the data carries it
    // (a +0.4% week in a +0.8% Steam week is an underperformance); the raw % stays printed.
    cell: (p) => {
      const v = p.players_trend_7d_pct;
      if (v == null) return tagged("not measured");
      const rel = p.players_trend_7d_rel_pct;
      const market = p.players_trend_7d_market_pct;
      const dir = rel ?? v;
      return {
        node: `${dir > 0 ? "▲" : dir < 0 ? "▼" : "■"} ${signedPct(v)}`,
        shown: signedPct(v),
        num: dir,
        note:
          rel != null && market != null ? (
            <span className="text-[11px] text-ink-muted">
              vs Steam {signedPct(market)}: {signedPts(rel)}
            </span>
          ) : undefined,
      };
    },
    worked: (p, name) => {
      const v = p.players_trend_7d_pct;
      if (v == null) return null;
      if (p.players_trend_7d_market_pct != null && p.players_trend_7d_rel_pct != null) {
        return `${name}: ${signedPct(v)} − Steam ${signedPct(p.players_trend_7d_market_pct)} = ${signedPts(p.players_trend_7d_rel_pct)}`;
      }
      return `${name}: ${signedPct(v)} (the Steam-wide week isn't in this data build — a sale or a holiday moves every game)`;
    },
  },
  {
    key: "reviews",
    label: glossary("reviews").label,
    term: "reviews",
    cell: (p) => (p.total_reviews == null ? tagged("no data") : plain(fmtInt(p.total_reviews), p.total_reviews)),
    best: true,
  },
  {
    key: "rev_pct",
    label: "Revenue rank vs genre",
    term: "percentile_vs_genre",
    info: { label: "Revenue rank vs genre" },
    // fmtPercentile floors and words the ends: a 99.6 is "top 1%", never "P100" — which is
    // what three different ranks all printed before, with one of them highlighted "best".
    cell: (p) =>
      !isFiniteNumber(p.rev_pct_in_genre) ? tagged("not ranked") : plain(fmtPercentile(p.rev_pct_in_genre), p.rev_pct_in_genre),
    best: true,
    worked: (p, name) =>
      !isFiniteNumber(p.rev_pct_in_genre)
        ? null
        : `${name} beats ${p.rev_pct_in_genre.toFixed(1)}% of ${p.primary_genre ?? "its genre's"} games with 50+ reviews → ${fmtPercentile(p.rev_pct_in_genre)}`,
  },
  {
    key: "first3",
    label: "Reviews, first 3 months",
    term: "review_velocity",
    info: LAUNCH_WINDOW_INFO(3),
    cell: (_p, ctx, id) => windowCell(ctx.windows3.get(id), ctx),
    best: true,
    worked: (_p, name, ctx, id) => {
      const w = ctx.windows3.get(id);
      return w ? launchWindowWorked(name, w) : null;
    },
  },
  {
    key: "first12",
    label: "Reviews, first 12 months",
    term: "review_velocity",
    info: LAUNCH_WINDOW_INFO(12),
    cell: (_p, ctx, id) => windowCell(ctx.windows12.get(id), ctx),
    best: true,
    worked: (_p, name, ctx, id) => {
      const w = ctx.windows12.get(id);
      return w ? launchWindowWorked(name, w) : null;
    },
  },
  // Was "Reviews · trailing 30d (sampled)" — a count off our review SAMPLE. The histogram
  // has the same momentum read, uncapped, for the last month that is over.
  {
    key: "last_month",
    label: (ctx) => (ctx.lastFullPeriod ? `Reviews, ${periodLabel(ctx.lastFullPeriod)}` : "Reviews, last full month"),
    term: "review_velocity",
    info: {
      label: "Reviews, last full month",
      meaning: "Current momentum: the reviews the game collected in the most recent month that is over — a proxy for how much it is still selling.",
      formula: "reviews posted in that calendar month (Steam's own monthly histogram)",
      notes: "The month still running is left out: a partial month always reads as a drop.",
    },
    cell: (_p, ctx, id) => {
      if (!ctx.trendsReady) return { node: "…", shown: null, num: null };
      const n = ctx.lastFull.get(id);
      return n == null ? tagged("no data") : plain(fmtInt(n), n);
    },
    best: true,
    worked: (_p, name, ctx, id) => {
      const n = ctx.lastFull.get(id);
      return n == null || !ctx.lastFullPeriod ? null : `${name}: ${fmtInt(n)} reviews in ${periodLabel(ctx.lastFullPeriod)}`;
    },
  },
  {
    key: "playtime",
    label: "Median playtime",
    info: {
      label: "Median playtime",
      meaning:
        "How long the middle reviewer had played when they wrote their review — a read on how much game there is and how long it holds people. More is not “better” for your plan: it is scope.",
      formula: "median of reviewers' total playtime at review time",
      source: "our review sample (recency-biased)",
    },
    cell: (p) => (p.playtime_p50 == null ? tagged("no sample") : plain(fmtMinutes(p.playtime_p50), p.playtime_p50)),
  },
  {
    key: "genre",
    label: "Primary genre",
    info: {
      label: "Primary genre",
      meaning: "Steam's primary genre for the game — the peer group every “rank vs genre” above is computed against.",
    },
    cell: (p) => (p.primary_genre ? plain(p.primary_genre, null) : tagged("no genre")),
  },
];

/** The ids whose cell wins the row: every game tied on the best DISPLAYED value, or none when
 * every game ties (nobody is best) or fewer than two are comparable. */
export function bestOf(cells: { id: number; cell: Cell }[]): Set<number> {
  const comparable = cells.filter((c) => c.cell.num !== null && c.cell.shown !== null);
  if (comparable.length < 2) return new Set();
  const max = Math.max(...comparable.map((c) => c.cell.num as number));
  const maxShown = comparable.find((c) => c.cell.num === max)!.cell.shown;
  const winners = comparable.filter((c) => c.cell.shown === maxShown).map((c) => c.id);
  return winners.length === cells.length ? new Set() : new Set(winners);
}

/** The blueprint frame: hairline + "+" corner marks. The class draws two marks itself; the
 * other two come from the one .bp-corner child (see index.css). */
function Panel({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={clsx("blueprint", className)} style={{ borderColor: PANEL_BORDER }}>
      <i className="bp-corner" />
      {children}
    </div>
  );
}

/** The series mark that ties a column (or a line in a mobile block) to its trend line. It
 * carries the line's SHAPE as well as its colour, because two columns can otherwise wear
 * near-identical tones. */
function SeriesMark({ i }: { i: number }) {
  return (
    <svg aria-hidden width={10} height={10} viewBox="0 0 10 10" className="shrink-0 overflow-visible">
      <path d={seriesShapePath(compareSeries(i).shape, 5, 5, 3.6)} fill={compareSeriesColor(i)} />
    </svg>
  );
}

export default function Compare() {
  usePageTitle("Compare");
  const [searchParams, setSearchParams] = useSearchParams();
  const stored = useCompareList();
  const wide = useMinWidth(TABLE_MIN_WIDTH);
  const dataAge = useDataAge();

  const idsParam = searchParams.get("ids");
  const ids = useMemo(() => parseIds(idsParam), [idsParam]);
  const align: CompareAlign = searchParams.get("align") === "launch" ? "launch" : "calendar";

  // No ids in the URL but a stored list exists → normalize the URL so it's shareable.
  useEffect(() => {
    if (!idsParam && stored.length > 0) {
      setSearchParams({ ids: stored.map((e) => e.appid).join(",") }, { replace: true });
    }
  }, [idsParam, stored, setSearchParams]);

  const results = useQueries({ queries: ids.map((id) => gameProfileQueryOptions(id)) });
  const anyLoading = results.some((r) => r.isLoading);
  const profiles = new Map<number, CompareProfile>();
  results.forEach((r, i) => {
    if (r.data) profiles.set(ids[i], r.data as CompareProfile);
  });

  // The same request CompareTrendsChart makes (same query key → one fetch, one cache
  // entry): the launch-window rows and the takeaway read the monthly histogram too.
  const trendsQ = useGameTrendsWithComps(ids.length >= 2 ? ids[0] : null, ids.slice(1));
  const partialPeriod = partialPeriodOf(dataAge.asOf);

  // A column with no profile has two very different causes and this page used to print the
  // same words for both: with the API unreachable it labelled every column
  // "App 730 · Not in catalog" (measured on production 2026-09-01) — asserting that
  // Counter-Strike 2 is absent from Steam because a fetch failed. Only a 404 licenses that
  // claim; everything else is "we couldn't ask", which is retryable and is not about the
  // game. Keyed by appid so a column reads its OWN query's outcome.
  const failedById = new Map<number, unknown>();
  results.forEach((r, i) => {
    if (r.isError && !r.data) failedById.set(ids[i], r.error);
  });
  const unreachable = [...failedById.values()].some((e) => !isNotFound(e));
  const retryFailed = () => {
    for (const r of results) if (r.isError && !r.data) void r.refetch();
  };

  // Remove from BOTH the URL ids and the stored tray list, so the two stay in step.
  function remove(appid: number) {
    removeFromCompare(appid);
    const next = ids.filter((id) => id !== appid);
    setSearchParams((prev) => {
      const sp = new URLSearchParams(prev);
      if (next.length > 0) sp.set("ids", next.join(","));
      else sp.delete("ids");
      return sp;
    });
  }

  function setAlign(next: CompareAlign) {
    setSearchParams((prev) => {
      const sp = new URLSearchParams(prev);
      if (next === "launch") sp.set("align", "launch");
      else sp.delete("align");
      return sp;
    });
  }

  const names = new Map<number, string>();
  for (const id of ids) {
    const p = profiles.get(id);
    const fallback = stored.find((e) => e.appid === id)?.name;
    names.set(id, p?.name ?? fallback ?? `App ${id}`);
  }

  // Tags appearing on 2+ of the compared games — the overlap that makes them competitors.
  const profileStamp = results.map((r) => r.dataUpdatedAt).join(",");
  const sharedTags = useMemo(() => {
    const counts = new Map<string, number>();
    for (const p of profiles.values()) {
      for (const t of new Set(p.top_tags)) counts.set(t, (counts.get(t) ?? 0) + 1);
    }
    return new Set([...counts.entries()].filter(([, n]) => n >= 2).map(([t]) => t));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profileStamp]);

  // The histogram reads: launch windows (first 3 / 12 months) and the last full month.
  const anchors = new Map<number, LaunchAnchor | null>();
  for (const id of ids) {
    const p = profiles.get(id);
    anchors.set(id, p ? launchAnchor(p) : null);
  }
  const series = new Map<number, GameTrendPoint[]>();
  if (trendsQ.data?.eligible && ids[0] !== undefined) series.set(ids[0], trendsQ.data.points);
  for (const s of trendsQ.data?.comps?.series ?? []) series.set(s.appid, s.points);
  const lastFullOrd = monthOrdinal(partialPeriod);
  const lastFullPeriod = lastFullOrd === null ? null : periodOf(lastFullOrd - 1);
  const ctx: RowCtx = {
    windows3: new Map(),
    windows12: new Map(),
    lastFull: new Map(),
    lastFullPeriod,
    trendsReady: !!trendsQ.data || trendsQ.isError,
  };
  for (const id of ids) {
    const p = profiles.get(id);
    const pts = series.get(id);
    if (!p || !pts) continue;
    ctx.windows3.set(id, launchWindowReviews(pts, p, 3, partialPeriod));
    ctx.windows12.set(id, launchWindowReviews(pts, p, 12, partialPeriod));
    const complete = completeMonths(pts, partialPeriod);
    ctx.lastFull.set(id, lastFullPeriod ? complete.find((pt) => pt.period === lastFullPeriod)?.n_reviews ?? 0 : null);
  }

  const takeaway = compareTakeaway(
    ids
      .filter((id) => profiles.has(id))
      .map((id) => {
        const p = profiles.get(id)!;
        const w = ctx.windows3.get(id);
        return {
          name: names.get(id)!,
          revenue: priceKind(p) === "paid" ? p.est_rev_reviews : null,
          trend7d: p.players_trend_7d_pct ?? null,
          rel7d: p.players_trend_7d_market_pct != null ? p.players_trend_7d_rel_pct ?? null : null,
          first3: w?.total ?? null,
          first3Complete: !!w && w.monthsCovered >= w.months,
        };
      }),
  );

  if (ids.length === 0) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeading ids={ids} />
        <Panel className="p-8">
          <EmptyState
            title="Nothing to compare yet"
            description={
              <>
                Add games with the <span className="font-semibold">+</span> button on any search result row or the
                “+ Compare” button on a game profile — up to {COMPARE_CAP} at once. The tray at the bottom of the
                screen collects them; hit “Compare” there to land here.
              </>
            }
            action={
              <Link
                to="/games"
                style={CONDENSED}
                className="bg-brand px-3 py-1.5 text-xs font-semibold text-brand-fg transition-colors hover:bg-brand-hover"
              >
                Browse games
              </Link>
            }
          />
        </Panel>
      </div>
    );
  }

  const rows = STAT_ROWS.map((row) => {
    const cells = ids.map((id) => {
      const p = profiles.get(id);
      const cell: Cell = p
        ? row.cell(p, ctx, id)
        : {
            node: (
              <SentinelTag>
                {anyLoading ? "loading" : isNotFound(failedById.get(id)) ? "not in catalog" : "couldn't load"}
              </SentinelTag>
            ),
            shown: null,
            num: null,
          };
      return { id, cell };
    });
    const best = row.best ? bestOf(cells) : new Set<number>();
    const allTied =
      !!row.best &&
      best.size === 0 &&
      cells.length >= 2 &&
      cells.every((c) => c.cell.shown !== null && c.cell.shown === cells[0].cell.shown);
    const workedLines = row.worked
      ? ids
          .map((id) => {
            const p = profiles.get(id);
            return p ? row.worked!(p, names.get(id)!, ctx, id) : null;
          })
          .filter((l): l is string => !!l)
      : [];
    const label = typeof row.label === "function" ? row.label(ctx) : row.label;
    return { row, label, cells, best, allTied, workedLines };
  });

  return (
    <div className="flex flex-col gap-6">
      <PageHeading ids={ids} />

      {/* One banner rather than a retry per column: when the API is unreachable EVERY
          column fails at once, and six identical retry buttons would be six ways to do the
          same thing. The grid below still renders — a comparison with one unloadable column
          is worth reading — this just stops the dashes from being unexplained. */}
      {unreachable && (
        <div className="flex flex-wrap items-center gap-3 border border-verdict-serious/40 px-4 py-3 text-xs text-ink-secondary">
          <span className="text-verdict-serious">
            {failedById.size === ids.length
              ? "Couldn't load any of these games."
              : `Couldn't load ${failedById.size} of ${ids.length} games.`}{" "}
            {errorMessage([...failedById.values()].find((e) => !isNotFound(e)))}
          </span>
          <RetryButton onClick={retryFailed} />
        </div>
      )}

      {ids.length === 1 && (
        <Panel className="p-8">
          <EmptyState
            title={`Only one game selected — ${names.get(ids[0])}`}
            description="A comparison needs at least two games. Add a competitor from search (the + button on any row) or from its profile page; its comparables table is a good place to find candidates."
            action={
              <div className="flex items-center gap-2">
                <Link
                  to="/games"
                  style={CONDENSED}
                  className="bg-brand px-3 py-1.5 text-xs font-semibold text-brand-fg transition-colors hover:bg-brand-hover"
                >
                  Find a competitor
                </Link>
                <Link
                  to={`/games/${ids[0]}`}
                  style={CONDENSED}
                  className="border border-borderstrong px-3 py-1.5 text-xs text-ink-primary transition-colors hover:bg-ink-primary/[0.08]"
                >
                  Open its profile
                </Link>
              </div>
            }
          />
        </Panel>
      )}

      {ids.length >= 2 && (
        <>
          {/* One plain line first — the bearish reading leads. Two lines' height is held
              while the games load, so the chart below doesn't jump when it arrives. */}
          <div className="min-h-[3.25rem]">
            {!anyLoading && takeaway && (
              <p className="max-w-4xl text-[15px] leading-relaxed text-ink-primary" data-testid="compare-takeaway">
                {takeaway}
              </p>
            )}
          </div>

          <Panel className="px-4 py-5 sm:px-6">
            <div className="mb-3.5 flex flex-wrap items-center gap-x-4 gap-y-2">
              <h2 className="text-[16px] text-ink-primary">Monthly reviews</h2>
              <MetricTip label="Monthly reviews" term="review_velocity" />
              <Segmented options={ALIGNS} value={align} onChange={setAlign} ariaLabel="Line the games up by" />
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 sm:ml-auto">
                {ids.map((id, i) => (
                  <span key={id} className="inline-flex items-center gap-1.5 text-[11px] text-ink-muted">
                    {/* Was a flat 14x2 colour bar. Two of the three games rendered it in
                        greys 1.25:1 apart, so the legend was as unreadable as the chart —
                        it now repeats the line's dash and marker too (SeriesKey). */}
                    <SeriesKey style={compareSeries(i)} />
                    {names.get(id)}
                  </span>
                ))}
              </div>
            </div>
            {/* hideLegend: the ONE legend lives inline with the title above (mockup 4d);
                without it CompareTrendsChart repeats the same legend under the chart. */}
            <CompareTrendsChart
              ids={ids}
              names={names}
              hideLegend
              align={align}
              // Only once every profile has answered: a half-loaded anchor map would draw the
              // loaded games and call the rest "not drawn" for a moment.
              anchors={anyLoading ? undefined : anchors}
              partialPeriod={partialPeriod}
            />
          </Panel>

          <Panel>
            {anyLoading && <Loading label="Loading games…" className="p-6 text-sm" />}
            {!anyLoading && wide && (
              <CompareTable ids={ids} names={names} profiles={profiles} rows={rows} sharedTags={sharedTags} onRemove={remove} anyLoading={anyLoading} failedById={failedById} />
            )}
            {!anyLoading && !wide && (
              <CompareStack ids={ids} names={names} profiles={profiles} rows={rows} sharedTags={sharedTags} onRemove={remove} />
            )}
          </Panel>
        </>
      )}
    </div>
  );
}

type BuiltRow = {
  row: StatRowDef;
  label: string;
  cells: { id: number; cell: Cell }[];
  best: Set<number>;
  allTied: boolean;
  workedLines: string[];
};

/** The row label and its ⓘ, worked through for every game in the comparison. */
function RowLabel({ r }: { r: BuiltRow }) {
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-1.5 text-ink-muted">
      <span>{r.label}</span>
      <MetricTip
        label={r.label}
        term={r.row.term}
        info={{ label: r.label, ...r.row.info }}
        worked={
          r.workedLines.length > 0 ? (
            <span className="flex flex-col gap-0.5">
              {r.workedLines.map((l) => (
                <span key={l}>{l}</span>
              ))}
            </span>
          ) : undefined
        }
      />
      {r.allTied && <span className="text-[10px] text-ink-muted">(all tied)</span>}
    </span>
  );
}

function CellValue({ r, id, cell }: { r: BuiltRow; id: number; cell: Cell }) {
  const isBest = r.best.has(id);
  const up = r.row.verdict && cell.num !== null && cell.num > 0;
  return (
    <span className="flex min-w-0 flex-col gap-0.5">
      <span
        className={clsx(
          "tabular",
          r.row.verdict
            ? cell.num === null
              ? "text-ink-primary"
              : up
                ? "text-brand"
                : "text-ink-muted"
            : isBest
              ? "font-semibold text-brand"
              : "text-ink-primary",
        )}
      >
        {cell.node}
        {isBest && <span className="sr-only"> (best in this row)</span>}
      </span>
      {cell.note}
    </span>
  );
}

function TagsExplainer() {
  return (
    <MetricTip
      label="Top tags"
      info={{
        label: "Top tags",
        meaning:
          "Each game's most-voted Steam tags. Highlighted = on two or more of the games compared here — the overlap that makes them competitors; the rest are plain.",
      }}
    />
  );
}

/** Column-per-game table (≥ 640px). */
function CompareTable({
  ids,
  names,
  profiles,
  rows,
  sharedTags,
  onRemove,
  anyLoading,
  failedById,
}: {
  ids: number[];
  names: Map<number, string>;
  profiles: Map<number, CompareProfile>;
  rows: BuiltRow[];
  sharedTags: Set<string>;
  onRemove: (id: number) => void;
  anyLoading: boolean;
  failedById: Map<number, unknown>;
}) {
  const grid = { gridTemplateColumns: `1.2fr repeat(${ids.length}, 1fr)` };
  return (
    <TableScroll>
      {/* `relative` matters: the sr-only "(best in this row)" spans are absolutely
          positioned, and without a positioned ancestor INSIDE this scroll container
          they resolve against the .blueprint panel — landing past the page edge and
          giving the whole page a horizontal scrollbar at 390px. */}
      <div className="relative" style={{ minWidth: `${220 + ids.length * 150}px` }}>
        <div className="grid items-end gap-3.5 border-b px-5 py-3.5" style={{ ...grid, borderColor: PANEL_BORDER }}>
          <span />
          {ids.map((id, i) => {
            const p = profiles.get(id);
            return (
              <div key={id} className="flex flex-col gap-1.5">
                <div className="flex items-start justify-between gap-1">
                  <span className="mt-1">
                    <SeriesMark i={i} />
                  </span>
                  <RemoveButton name={names.get(id)!} onRemove={() => onRemove(id)} />
                </div>
                {p?.header_image ? (
                  <img src={p.header_image} alt="" className="h-10 w-full object-cover" />
                ) : (
                  <div aria-hidden className="h-10 w-full" style={{ background: STRIPE_THUMB }} />
                )}
                <Link
                  to={`/games/${id}`}
                  style={{ ...CONDENSED, fontWeight: 600 }}
                  className="text-[17px] leading-tight text-ink-primary hover:text-brand hover:underline"
                >
                  {names.get(id)}
                </Link>
                {p ? (
                  <GameCaption p={p} />
                ) : (
                  <span className="text-[11px] text-verdict-serious">
                    {anyLoading ? "Loading…" : isNotFound(failedById.get(id)) ? "Not in catalog" : "Couldn't load"}
                  </span>
                )}
              </div>
            );
          })}
        </div>

        {rows.map((r) => (
          <div
            key={r.row.key}
            className="grid gap-3.5 border-b px-5 py-[11px] text-sm"
            style={{ ...grid, borderColor: ROW_RULE }}
            data-testid={`compare-row-${r.row.key}`}
          >
            <RowLabel r={r} />
            {r.cells.map(({ id, cell }) => (
              <CellValue key={id} r={r} id={id} cell={cell} />
            ))}
          </div>
        ))}

        <div className="grid gap-3.5 px-5 py-[11px]" style={grid}>
          <span className="flex items-start gap-1.5 text-sm text-ink-muted">
            <span>
              Top tags
              <span className="mt-0.5 block text-[11px] font-normal">(shared highlighted)</span>
            </span>
            <TagsExplainer />
          </span>
          {ids.map((id) => (
            <TagList key={id} tags={(profiles.get(id)?.top_tags ?? []).slice(0, 8)} shared={sharedTags} />
          ))}
        </div>
      </div>
    </TableScroll>
  );
}

/** Metric-per-block list (< 640px): every game's value for a metric sits together. */
function CompareStack({
  ids,
  names,
  profiles,
  rows,
  sharedTags,
  onRemove,
}: {
  ids: number[];
  names: Map<number, string>;
  profiles: Map<number, CompareProfile>;
  rows: BuiltRow[];
  sharedTags: Set<string>;
  onRemove: (id: number) => void;
}) {
  return (
    <div className="flex flex-col" data-testid="compare-stack">
      <ul className="flex flex-col gap-2 border-b px-4 py-3.5" style={{ borderColor: PANEL_BORDER }}>
        {ids.map((id, i) => {
          const p = profiles.get(id);
          return (
            <li key={id} className="flex items-center gap-2.5">
              <SeriesMark i={i} />
              {p?.header_image ? (
                <img src={p.header_image} alt="" className="h-8 w-16 shrink-0 object-cover" />
              ) : (
                <span aria-hidden className="h-8 w-16 shrink-0" style={{ background: STRIPE_THUMB }} />
              )}
              <span className="flex min-w-0 flex-1 flex-col">
                <Link
                  to={`/games/${id}`}
                  style={{ ...CONDENSED, fontWeight: 600 }}
                  className="truncate text-[16px] leading-tight text-ink-primary hover:text-brand"
                >
                  {names.get(id)}
                </Link>
                {p && <GameCaption p={p} />}
              </span>
              <RemoveButton name={names.get(id)!} onRemove={() => onRemove(id)} />
            </li>
          );
        })}
      </ul>
      {rows.map((r) => (
        <div
          key={r.row.key}
          className="flex flex-col gap-1.5 border-b px-4 py-3 text-sm"
          style={{ borderColor: ROW_RULE }}
          data-testid={`compare-row-${r.row.key}`}
        >
          <RowLabel r={r} />
          <ul className="flex flex-col gap-1">
            {r.cells.map(({ id, cell }) => (
              <li key={id} className="flex items-start justify-between gap-3">
                <span className="flex min-w-0 items-center gap-1.5 text-[13px] text-ink-secondary">
                  <SeriesMark i={ids.indexOf(id)} />
                  <span className="truncate">{names.get(id)}</span>
                </span>
                <span className="shrink-0 text-right">
                  <CellValue r={r} id={id} cell={cell} />
                </span>
              </li>
            ))}
          </ul>
        </div>
      ))}
      <div className="flex flex-col gap-2 px-4 py-3">
        <span className="flex items-center gap-1.5 text-sm text-ink-muted">
          Top tags <span className="text-[11px]">(shared highlighted)</span>
          <TagsExplainer />
        </span>
        {ids.map((id, i) => (
          <div key={id} className="flex flex-col gap-1">
            <span className="flex items-center gap-1.5 text-[12px] text-ink-secondary">
              <SeriesMark i={i} />
              {names.get(id)}
            </span>
            <TagList tags={(profiles.get(id)?.top_tags ?? []).slice(0, 8)} shared={sharedTags} />
          </div>
        ))}
      </div>
    </div>
  );
}

function RemoveButton({ name, onRemove }: { name: string; onRemove: () => void }) {
  return (
    <button
      type="button"
      onClick={onRemove}
      aria-label={`Remove ${name} from comparison`}
      title="Remove from comparison"
      className="-m-1 flex h-6 w-6 shrink-0 items-center justify-center text-xs text-ink-muted transition-colors hover:bg-ink-primary/[0.08] hover:text-ink-primary"
    >
      ✕
    </button>
  );
}

/** "Feb 2024 · $14.99" — the release (EA → 1.0 when it was Early Access) and the price, in
 * the app's one date format; an unknown price is tagged, not printed as "Free". */
function GameCaption({ p }: { p: CompareProfile }) {
  const released = releaseCaption(p);
  const kind = priceKind(p);
  return (
    <span className="flex flex-wrap items-center gap-1 text-[11px] text-ink-muted">
      {released ?? <SentinelTag>no release date</SentinelTag>}
      <span aria-hidden>·</span>
      {kind === "unknown" ? <SentinelTag>{PRICE_UNKNOWN}</SentinelTag> : fmtPriceFor(p)}
    </span>
  );
}

/**
 * A game's top tags. Shared tags (on 2+ compared games) wear the brand highlight — the one
 * signal on this row. The rest are PLAIN: they used to wear categorical genre tints, whose red
 * and orange outlines read as warnings nobody could explain (the review's "unexplained red
 * borders"); a tag's hash colour carried no information here.
 */
function TagList({ tags, shared }: { tags: string[]; shared: Set<string> }) {
  return (
    <div className="flex flex-wrap gap-1">
      {tags.map((t) => (
        <span
          key={t}
          className={clsx(
            "border px-1.5 py-0.5 text-[10px]",
            shared.has(t) ? "border-brand bg-brand-tint font-medium text-brand" : "border-ink-primary/[0.18] text-ink-secondary",
          )}
        >
          {t}
          {shared.has(t) && <span className="sr-only"> (shared)</span>}
        </span>
      ))}
    </div>
  );
}

function PageHeading({ ids }: { ids: number[] }) {
  const n = ids.length;
  const capReached = n >= COMPARE_CAP;
  return (
    <div className="flex flex-wrap items-baseline gap-3.5">
      <h1 className="text-[25px] leading-none text-ink-primary">Compare</h1>
      {n > 0 && (
        <span className="text-[13px] text-ink-muted">
          {n} of {COMPARE_CAP} slots · share this view by URL
        </span>
      )}
      {n > 0 && !capReached && (
        <Link
          to="/games"
          style={CONDENSED}
          className="ml-auto border border-borderstrong px-3 py-1 text-xs text-ink-primary transition-colors hover:bg-ink-primary/[0.08]"
        >
          + Add game
        </Link>
      )}
    </div>
  );
}

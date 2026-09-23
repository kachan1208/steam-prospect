import { fmtCompact, fmtInt, fmtPrice, fmtSigned, fmtUsd, priceKind, type PricedRow } from "./format";

/**
 * THE GAME PAGE'S ESTIMATES, WITH THEIR REASONS (2026-09-23).
 *
 * One pure derivation of what the Estimates panel prints — and, just as important, of WHY a
 * figure is absent — so the panel never shows a placeholder as a value. Before this, a
 * 0-review game read "Gross revenue $0.00 · $0.00 – $0.00" and "Units sold 0", and CS2 (free
 * to play) read "Units sold 296.1M": reviews × 30 evaluated for a game nobody buys.
 *
 * The estimator is the one the mart runs (etl/build_marts.py): Est. revenue = reviews × 30
 * owners-per-review × launch price, with a ×20–×55 range; Est. units = the same before the
 * price multiply, so revenue ÷ price = units exactly. The rebuilt mart gives free and
 * unknown-price games NO estimate (NULL, not $0) — this module says the same thing in words.
 */

/** The cited Boxleiter owners-per-review band (/api/market/benchmarks cited.boxleiter_…). The
 * constants are the fallback; the page passes the served band when it has it. */
export interface OwnersPerReviewBand {
  min: number;
  mid: number;
  max: number;
}
export const BOXLEITER_BAND: OwnersPerReviewBand = { min: 20, mid: 30, max: 55 };

/** Under this many reviews an estimate is printed but flagged: the mart's own analysis floor
 * (MIN_REVIEWS_DEFAULT) and the genre-rank population start at 50. */
export const SMALL_SAMPLE_REVIEWS = 50;

export type EstimateStatus = "estimated" | "free" | "price-unknown" | "no-reviews" | "no-data";

export interface GameEstimate {
  status: EstimateStatus;
  reviews: number | null;
  price: number | null;
  /** Est. revenue, and its ×min / ×max range (null unless estimated). */
  mid: number | null;
  low: number | null;
  high: number | null;
  /** Est. units sold = mid ÷ price (null unless estimated). */
  units: number | null;
  /** Estimated, but on fewer than SMALL_SAMPLE_REVIEWS reviews. */
  smallSample: boolean;
  /** "198,820 reviews × 30 × $14.99 = $89.4M" */
  revenueWorked: string | null;
  /** "× 20 = $59.6M … × 55 = $163.9M" */
  rangeWorked: string | null;
  /** "198,820 reviews × 30 = 6.0M = $89.4M ÷ $14.99" */
  unitsWorked: string | null;
}

export interface EstimateInput extends PricedRow {
  total_reviews?: number | null;
  est_rev_reviews?: number | null;
}

export function gameEstimate(row: EstimateInput, band: OwnersPerReviewBand = BOXLEITER_BAND): GameEstimate {
  const status0 = priceKind(row);
  const reviews = typeof row.total_reviews === "number" && Number.isFinite(row.total_reviews) ? row.total_reviews : null;
  const price = typeof row.price_initial === "number" && row.price_initial > 0 ? row.price_initial : null;
  const empty = {
    reviews,
    price,
    mid: null,
    low: null,
    high: null,
    units: null,
    smallSample: false,
    revenueWorked: null,
    rangeWorked: null,
    unitsWorked: null,
  };
  if (status0 === "free") return { ...empty, status: "free" };
  if (status0 === "unknown" || price === null) return { ...empty, status: "price-unknown" };
  if (reviews === null) return { ...empty, status: "no-data" };
  if (reviews <= 0) return { ...empty, status: "no-reviews" };

  const served = typeof row.est_rev_reviews === "number" && Number.isFinite(row.est_rev_reviews) && row.est_rev_reviews > 0 ? row.est_rev_reviews : null;
  const mid = served ?? reviews * band.mid * price;
  const low = reviews * band.min * price;
  const high = reviews * band.max * price;
  const units = mid / price;
  return {
    status: "estimated",
    reviews,
    price,
    mid,
    low,
    high,
    units,
    smallSample: reviews < SMALL_SAMPLE_REVIEWS,
    revenueWorked: `${fmtInt(reviews)} reviews × ${band.mid} × ${fmtPrice(price)} = ${fmtUsd(mid)}`,
    rangeWorked: `× ${band.min} = ${fmtUsd(low)} … × ${band.max} = ${fmtUsd(high)}`,
    unitsWorked: `${fmtInt(reviews)} reviews × ${band.mid} = ${fmtCompact(units)} = ${fmtUsd(mid)} ÷ ${fmtPrice(price)}`,
  };
}

/** The sentence that replaces an absent estimate — never "$0.00" and never a bare dash. */
export function missingEstimateText(e: GameEstimate, what: "revenue" | "units"): string {
  switch (e.status) {
    case "free":
      return what === "units" ? "Free to play — no unit sales" : "Free to play — no box sales to estimate";
    case "price-unknown":
      return "Price unknown — the estimate needs a list price";
    case "no-reviews":
      return "Not enough reviews to estimate (0 reviews)";
    case "no-data":
      return "No review count — nothing to estimate from";
    default:
      return "";
  }
}

/** The short flag beside an absent or shaky estimate, for SentinelTag. */
export function estimateSentinel(e: GameEstimate): string | null {
  switch (e.status) {
    case "free":
      return "not applicable";
    case "price-unknown":
    case "no-reviews":
    case "no-data":
      return "not estimated";
    default:
      return e.smallSample ? "small sample" : null;
  }
}

/** 0.9783 -> "97.8%", 1 -> "100%", 0.5 -> "50%": one decimal, never a trailing ".0". */
export function fmtShareTrim(v: number | null | undefined): string {
  if (typeof v !== "number" || !Number.isFinite(v)) return "—";
  const s = (v * 100).toFixed(1);
  return `${s.endsWith(".0") ? s.slice(0, -2) : s}%`;
}

/** A trend already in PERCENT (players_trend_7d_pct = -5.35 means -5.35%): "-5.4%" / "+2.0%"
 * — lib/format's fmtSigned on the fraction, so the page speaks one sign convention. */
export function fmtTrendPct(v: number | null | undefined): string | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  return fmtSigned(v / 100, 1);
}

/** Percentage points, signed the same way: "-3.4 pts", "+2.2 pts", "0.0 pts". */
export function fmtPts(v: number | null | undefined): string | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  return fmtSigned(v / 100, 1).replace(/%$/, " pts");
}

export interface PlayersTrendRead {
  /** "-5.4% vs the prior 7 days" */
  trend: string | null;
  /** "Steam overall -2.0% → -3.4 pts vs market" (only when the market fields are served) */
  market: string | null;
  /** The ⓘ arithmetic: "-5.4% (this game) − -2.0% (all of Steam) = -3.4 pts" */
  worked: string | null;
}

/** The 7-day trend read against the market when the rebuilt mart serves the market trend. The
 * relative figure is printed only when it is the game minus the market (to rounding), so a
 * served number the page can't reproduce is shown as served, not re-derived. */
export function playersTrendRead(row: {
  players_trend_7d_pct?: number | null;
  players_trend_7d_market_pct?: number | null;
  players_trend_7d_rel_pct?: number | null;
}): PlayersTrendRead {
  const g = row.players_trend_7d_pct;
  const m = row.players_trend_7d_market_pct;
  const rel = row.players_trend_7d_rel_pct;
  const trendText = fmtTrendPct(g);
  if (trendText === null) return { trend: null, market: null, worked: null };
  const trend = `${trendText} vs the prior 7 days`;
  if (typeof m !== "number" || !Number.isFinite(m)) return { trend, market: null, worked: null };
  const relValue = typeof rel === "number" && Number.isFinite(rel) ? rel : (g as number) - m;
  const reproduces = Math.abs(relValue - ((g as number) - m)) <= 0.011;
  const market = `Steam overall ${fmtTrendPct(m)} → ${fmtPts(relValue)} vs market`;
  const worked = reproduces
    ? `${fmtTrendPct(g)} (this game) − ${fmtTrendPct(m)} (all of Steam) = ${fmtPts(relValue)}`
    : `this game ${fmtTrendPct(g)}, all of Steam ${fmtTrendPct(m)}; served relative trend ${fmtPts(relValue)}`;
  return { trend, market, worked };
}

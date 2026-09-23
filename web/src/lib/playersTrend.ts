/**
 * THE 7-DAY PLAYERS TREND, READ AGAINST THE MARKET (2026-09-23).
 *
 * A niche's players_trend_7d_pct is "average players over the last 7 days vs the 7 before",
 * over the games measured in both weeks. Read alone it mostly measures STEAM: a sale, a
 * holiday or a weekend moves every niche at once — on the 2026-09-21 build the median niche
 * was at −4.9%, so Souls-like's −17.7% was a 12.8-point underperformance, not a −17.7% one.
 *
 * The rebuilt mart serves the market's own figure and the niche's trend relative to it
 * (players_trend_7d_market_pct / players_trend_7d_rel_pct, percentage points). Every surface
 * that prints a niche's 7-day trend goes through this module so they all say it the same way:
 *
 *   −17.7% vs market −4.9% (−12.8 pts)     when the market fields exist
 *   −17.7% · no market figure yet          when they don't — and the ⓘ says why that matters
 *
 * All three inputs are PERCENT units (−17.7 means −17.7%); the relative figure is in
 * percentage points.
 */

import { isFiniteNumber } from "./format";

export interface PlayersTrendInput {
  players_trend_7d_pct?: number | null;
  players_trend_7d_market_pct?: number | null;
  players_trend_7d_rel_pct?: number | null;
}

export interface PlayersTrendRead {
  /** The niche's own trend, "▼ −17.7%" — null when unknown. */
  value: string | null;
  /** "vs market −4.9% (−12.8 pts)" — null when the market fields are absent. */
  vsMarket: string | null;
  /** The relative figure alone, "−12.8 pts" — null when absent. */
  relative: string | null;
  /** The worked arithmetic, "−17.7% − (−4.9%) = −12.8 pts" — only when it reproduces the
   * served relative figure (to its one decimal). */
  worked: string | null;
  /** True when the market fields are served — callers pick the glossary term with it. */
  hasMarket: boolean;
  /** The niche trend's sign, for colouring (up = accent, down recedes). */
  up: boolean | null;
}

/** "+4.0%" / "−17.7%" from percent units, with a real minus sign. */
export function fmtPctPoints(v: number, digits = 1): string {
  const text = Math.abs(v).toFixed(digits);
  const sign = Number(text) === 0 ? "" : v > 0 ? "+" : "−";
  return `${sign}${text}%`;
}

/** "+2.5 pts" / "−12.8 pts". */
export function fmtPts(v: number, digits = 1): string {
  const text = Math.abs(v).toFixed(digits);
  const sign = Number(text) === 0 ? "" : v > 0 ? "+" : "−";
  return `${sign}${text} pts`;
}

export function readPlayersTrend(row: PlayersTrendInput | null | undefined): PlayersTrendRead {
  const own = row?.players_trend_7d_pct;
  const market = row?.players_trend_7d_market_pct;
  const rel = row?.players_trend_7d_rel_pct;
  const hasOwn = isFiniteNumber(own);
  const hasMarket = isFiniteNumber(market) && isFiniteNumber(rel);
  let worked: string | null = null;
  if (hasOwn && hasMarket && Math.abs(own - market - rel) <= 0.051) {
    worked = `${fmtPctPoints(own)} − (${fmtPctPoints(market)}) = ${fmtPts(own - market)}`;
  }
  return {
    value: hasOwn ? `${own >= 0 ? "▲" : "▼"} ${fmtPctPoints(own)}` : null,
    vsMarket: hasMarket ? `vs market ${fmtPctPoints(market)} (${fmtPts(rel)})` : null,
    relative: hasMarket ? fmtPts(rel) : null,
    worked,
    hasMarket,
    up: hasOwn ? own >= 0 : null,
  };
}

/**
 * The ⓘ note for a trend WITHOUT a market figure: says that a Steam-wide week moves every
 * niche, and — when the caller knows how the typical niche moved this week (the median of the
 * rows it has on screen) — says how far, so a reader can do the subtraction themselves.
 */
export function noMarketNote(medianNicheTrendPct?: number | null): string {
  const base =
    "No market comparison in this data build yet: sales, weekends and holidays move every niche at once, so read the figure against other niches before calling it momentum.";
  if (!isFiniteNumber(medianNicheTrendPct) || Math.abs(medianNicheTrendPct) < 2) return base;
  return `${base} This week the median niche moved ${fmtPctPoints(medianNicheTrendPct)} — most of any single niche's move is the market.`;
}

/** Median of the finite players_trend_7d_pct values in `rows` — the "typical niche this
 * week" read for noMarketNote(); null with fewer than 10 values (too thin to call). */
export function medianNicheTrend(rows: readonly PlayersTrendInput[]): number | null {
  const v = rows.map((r) => r.players_trend_7d_pct).filter(isFiniteNumber).sort((a, b) => a - b);
  if (v.length < 10) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

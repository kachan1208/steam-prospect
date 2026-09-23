/**
 * PAID-ONLY REVENUE STATS, AND WHEN THEY ARE WITHHELD (2026-09-23 contract, ETL PR #178).
 *
 * The rebuilt mart splits a cut's n_games into n_paid + n_free + n_price_unknown. Every
 * revenue, price, top-5%-share and hit-rate column is computed over the PAID games only — a
 * free game has no box revenue, and an unknown price can't be multiplied — and is NULL when
 * fewer than PAID_MIN of them exist: a median over a dozen games is noise, and the mart
 * refuses to print it.
 *
 * The owner's rule for sentinels applies: that NULL is never shown bare (a "—" reads as
 * "we lost it") nor as 0 (a claim). It is marked "withheld: only 12 paid games", with the
 * reason in the ⓘ. On a mart that predates the split (n_paid absent) a NULL stays "no data".
 */

import { fmtInt, isFiniteNumber } from "./format";

/** The mart's floor for paid-only stats (etl/build_marts.py). */
export const PAID_MIN = 30;

export interface PaidCounts {
  n_games?: number | null;
  n_paid?: number | null;
  n_free?: number | null;
  n_price_unknown?: number | null;
}

/**
 * The cut's paid games: `n_paid` when served, else derived from the mart's own invariant
 * n_paid + n_free + n_price_unknown = n_games (the API serves n_free and n_price_unknown but,
 * as of 2026-09-23, not n_paid itself). Null on a mart that predates the split.
 */
export function paidCount(row: PaidCounts | null | undefined): number | null {
  if (isFiniteNumber(row?.n_paid)) return row!.n_paid!;
  if (isFiniteNumber(row?.n_games) && isFiniteNumber(row?.n_free) && isFiniteNumber(row?.n_price_unknown)) {
    return Math.max(0, row!.n_games! - row!.n_free! - row!.n_price_unknown!);
  }
  return null;
}

/** True when the row's paid-only stats were withheld for too few paid games. */
export function paidWithheld(row: PaidCounts | null | undefined): boolean {
  const n = paidCount(row);
  return n !== null && n < PAID_MIN;
}

/**
 * The sentinel for a NULL paid-only stat: "withheld: only N paid games" when the mart held it
 * back, else "no data". Undefined when the value is real.
 */
export function paidStatSentinel(
  row: PaidCounts | null | undefined,
  value: number | null | undefined,
): { tag: string; detail: string } | string | undefined {
  if (isFiniteNumber(value)) return undefined;
  if (paidWithheld(row)) {
    const n = paidCount(row)!;
    return {
      tag: `withheld: only ${fmtInt(n)} paid game${n === 1 ? "" : "s"}`,
      detail: `Revenue, price and hit-rate figures count paid games only, and are withheld below ${PAID_MIN} of them — ${fmtInt(
        n,
      )} is too few to read.`,
    };
  }
  return "no data";
}

/**
 * "paid games only — 12 free and 3 unknown-price games left out" (or the older-mart form
 * "excludes 12 free games"), for the footnotes of revenue figures. Null when nothing is left
 * out or the counts are unknown.
 */
export function paidOnlyNote(row: PaidCounts | null | undefined): string | null {
  const free = isFiniteNumber(row?.n_free) ? row!.n_free! : 0;
  const unknown = isFiniteNumber(row?.n_price_unknown) ? row!.n_price_unknown! : 0;
  if (free + unknown <= 0) return null;
  const parts = [free > 0 ? `${fmtInt(free)} free` : null, unknown > 0 ? `${fmtInt(unknown)} unknown-price` : null]
    .filter((p): p is string => p !== null)
    .join(" and ");
  const noun = free + unknown === 1 ? "game" : "games";
  return paidCount(row) !== null ? `paid games only — ${parts} ${noun} left out` : `excludes ${parts} ${noun}`;
}

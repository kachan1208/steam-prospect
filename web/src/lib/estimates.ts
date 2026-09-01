/**
 * The ONE derivation of the "how many copies / how much money" pair a reader is shown, so the
 * two numbers printed side by side can never again come from two different estimators.
 *
 * The catalog carries TWO independent estimators per game (etl/build_marts.py, mart_game.sql):
 *
 *   reviews-based (Boxleiter)  est_rev_reviews = total_reviews x 30 x price_initial.
 *                              The units it implies are total_reviews x 30.
 *   owners-based (SteamSpy)    owners_mid      = SteamSpy's bucket midpoint, once SteamSpy has
 *                              resolved the game above its 0-20k catch-all bucket (below that
 *                              the ETL substitutes a genre-fitted reviews estimate), and
 *                              est_rev_owners  = owners_mid x price_initial.
 *
 * Each estimator is internally consistent: its revenue / its units == the launch price. MIXING
 * them is not. The profile's Estimates panel used to print the reviews-based revenue next to the
 * owners-based unit count — Hollow Knight (367520) read $251.5M gross against 7.5M units at a
 * $14.99 list price, i.e. $33.53 a copy, contradicting the formula printed directly underneath
 * ("reviews x owners-per-review x launch price"). /compare inherited the same mismatch, which is
 * how a comparison could show one game with MORE units AND LESS revenue at a HIGHER price.
 *
 * We show the REVIEWS-based estimator, because it is already the app's revenue spine: /compare's
 * revenue column, the profile's comparables heat table, mart_niche's median_rev/total_rev,
 * mart_market's revenue distribution and the profile's own owners/revenue drilldown curves are
 * all est_rev_reviews (or the identical cumulative-reviews x owners-per-review curve). Moving the
 * headline to the owners estimator would have squared this one row and broken agreement with all
 * of those. owners_mid is still surfaced on the profile — labelled as the other method, beside
 * the pair rather than inside it.
 */

/**
 * Boxleiter owners-per-review MID. Keep in sync with etl/build_marts.py's BOXLEITER_MID (which
 * builds est_rev_reviews) and with /market/benchmarks' cited boxleiter_owners_per_review.mid.
 * Only ever used as a fallback: whenever a revenue figure and a price exist, units are derived
 * BY DIVISION from the revenue actually on screen, so no constant can drift the pair apart.
 */
export const BOXLEITER_OWNERS_PER_REVIEW_MID = 30;

/**
 * Units behind a displayed reviews-based gross-revenue figure.
 *
 * For any paid game this is `revenue / price`, so `units x price === revenue` holds exactly for
 * the numbers on screen — the arithmetic a reader does in their head.
 *
 * Free-to-play (price 0) has no box revenue to divide, so the same estimator is evaluated
 * directly as reviews x owners-per-review; the revenue row says "no box revenue at $0" beside it,
 * so the two are not read as a quotient anyway. `ownersPerReview` lets a caller pass the live
 * benchmark ratio instead of the constant.
 *
 * @param revenue  The gross-revenue figure being DISPLAYED (not necessarily est_rev_reviews —
 *                 the profile shows a mid-of-range that may be derived from benchmarks).
 */
export function estimatedUnits(
  revenue: number | null | undefined,
  price: number | null | undefined,
  totalReviews: number | null | undefined,
  ownersPerReview: number | null | undefined = null,
): number | null {
  if (revenue != null && price != null && price > 0) return revenue / price;
  if (totalReviews != null) return totalReviews * (ownersPerReview ?? BOXLEITER_OWNERS_PER_REVIEW_MID);
  return null;
}

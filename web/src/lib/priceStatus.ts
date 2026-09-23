import { fmtPrice } from "./format";

/**
 * FREE IS NOT THE SAME AS "NO PRICE" (2026-09-23).
 *
 * Steam hands the catalog a $0 (or no price at all) for two very different games:
 *
 *   free   the game IS free to play — Steam's own is_free flag is set (CS2, The Finals);
 *   unknown there is no price we can read — delisted, region-locked, unreleased or never
 *          priced — and Steam does NOT call it free (GTA V Legacy, Rocket League, Forza
 *          Horizon 4: price 0 with is_free = 0). 9,001 mart rows are $0-and-not-free.
 *
 * lib/format.ts `isFreeTitle` reads every $0 as free (its contract predates is_free riding
 * with every priced row), so a delisted $59.99 game printed "Free" and its revenue "Free".
 * The API now guarantees is_free next to every price (price 0 with is_free 0 = UNKNOWN), and
 * the rebuilt mart gives both free and unknown-price games a NULL revenue estimate — so the
 * two need two different sentences, and neither is "$0".
 *
 * A price above $0 always wins, is_free or not: some F2P-flagged titles sell paid editions
 * with real box revenue (Rainbow Six Siege: is_free, $19.99, ~$932M est.).
 */
export type PriceStatus = "paid" | "free" | "unknown";

export function priceStatus(row: { price_initial?: number | null; is_free?: number | boolean | null }): PriceStatus {
  const price = row.price_initial;
  if (typeof price === "number" && Number.isFinite(price) && price > 0) return "paid";
  if (row.is_free === true || row.is_free === 1) return "free";
  return "unknown";
}

/** The price as a reader should see it: "$14.99", "Free", or "Price unknown". */
export function fmtListPrice(row: { price_initial?: number | null; is_free?: number | boolean | null }): string {
  const status = priceStatus(row);
  if (status === "paid") return fmtPrice(row.price_initial);
  return status === "free" ? "Free" : "Price unknown";
}

/** Why a revenue estimate is absent, in the words the page prints — null for a paid game. */
export function noRevenueReason(status: PriceStatus): string | null {
  if (status === "free") return "free to play — no box sales to estimate";
  if (status === "unknown") return "price unknown — revenue needs a list price";
  return null;
}

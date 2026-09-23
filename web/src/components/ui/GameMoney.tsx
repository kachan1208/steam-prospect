import { fmtPriceFor, fmtUsd, PRICE_UNKNOWN, priceKind, type PricedRow } from "../../lib/format";
import { SentinelTag } from "./SentinelTag";

/**
 * A game's list price and Est. revenue as table cells print them — read through
 * priceKind(), the one price reading every page shares (lib/format.ts, 2026-09-23): a $0
 * price Steam doesn't flag free is "Price unknown", not "Free", and neither sentinel is
 * ever a bare dash or a fabricated $0.
 */

/** "$14.99", "Free", or the flagged "Price unknown". */
export function PriceText({ row }: { row: PricedRow }) {
  if (priceKind(row) === "unknown") return <SentinelTag>{PRICE_UNKNOWN}</SentinelTag>;
  return <>{fmtPriceFor(row)}</>;
}

/** "$1.2M", "Free" (no box revenue to estimate), the flagged "Price unknown", or the
 * flagged "no estimate" for a priced game the mart didn't estimate. */
export function RevenueText({ row, value }: { row: PricedRow; value: number | null | undefined }) {
  const kind = priceKind(row);
  if (kind === "unknown") return <SentinelTag>{PRICE_UNKNOWN}</SentinelTag>;
  if (kind === "free") return <>Free</>;
  if (value == null || !Number.isFinite(value)) return <SentinelTag>no estimate</SentinelTag>;
  return <>{fmtUsd(value)}</>;
}

/** True when a revenue cell holds a real dollar figure (so a heat tint may colour it). */
export function hasRevenueFigure(row: PricedRow, value: number | null | undefined): boolean {
  return priceKind(row) === "paid" && value != null && Number.isFinite(value);
}

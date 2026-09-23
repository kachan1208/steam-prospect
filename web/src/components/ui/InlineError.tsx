import clsx from "clsx";

import { errorMessage } from "../../lib/api";
import { RetryButton } from "./ErrorState";

/**
 * A failed section inside a card that otherwise works — one line saying WHAT could not load
 * and why, plus Retry — where ErrorState's centred icon-and-heading block would be too big.
 *
 * Why it exists (2026-09-23): the game page handled errors for two of its eleven queries.
 * When reviews-summary, comparables, the launch curve or the price history failed, their
 * cards simply rendered empty — a blank frame reads as "no data", which is a claim, not an
 * absence. The dashed warning frame is the same "flagged, not a value" grammar as
 * SentinelTag.
 */
export function InlineError({
  what,
  error,
  onRetry,
  className,
}: {
  /** What failed, as a noun phrase: "the review history", "comparable games". */
  what: string;
  error: unknown;
  /** Wire to the query's own `refetch`. */
  onRetry?: () => void;
  className?: string;
}) {
  return (
    <div
      role="alert"
      className={clsx("flex flex-wrap items-center gap-x-3 gap-y-2 border border-dashed px-3 py-2.5 text-xs", className)}
      style={{ borderColor: "var(--status-warning)" }}
    >
      <span className="min-w-0 flex-1">
        <span className="font-medium text-ink-primary">Couldn&apos;t load {what}.</span>{" "}
        <span className="text-ink-muted">{errorMessage(error)}</span>
      </span>
      {onRetry && <RetryButton onClick={onRetry} />}
    </div>
  );
}

import type { ReactNode } from "react";

import { EmptyState } from "./EmptyState";
import { errorMessage, isTransportFailure } from "../../lib/api";

/**
 * The one place a failed query becomes words on screen.
 *
 * Two things every error surface in this app got wrong before it existed (all measured on
 * production 2026-09-01 by aborting `**\/api\/**`):
 *
 *  1. Raw exception strings reached the user — `String(error)` on a dropped connection is
 *     "TypeError: Failed to fetch", which /timing printed verbatim on four cards, and
 *     `error.message` did the same on /games, /niches, /studios and /compare's trends panel.
 *  2. Nothing offered a way to try again, so a blip was a dead end on every one of the
 *     seven routes checked.
 *
 * errorMessage() handles (1); `onRetry` handles (2). The title defaults to naming the
 * CAUSE — "can't reach" vs "the API failed" — because that is the part the reader can act
 * on; pages that own a better noun ("Couldn't load this game") pass their own.
 */
export function ErrorState({
  title,
  error,
  onRetry,
  action,
  className,
}: {
  title?: string;
  error: unknown;
  /** Wire this to the query's own `refetch`. Omit only where a retry is meaningless. */
  onRetry?: () => void;
  /** An extra escape hatch (e.g. "Back to search") rendered beside Retry. */
  action?: ReactNode;
  className?: string;
}) {
  const offline = isTransportFailure(error);
  return (
    <EmptyState
      icon={<AlertIcon />}
      title={title ?? (offline ? "Can't reach the API" : "That request failed")}
      description={errorMessage(error)}
      className={className}
      action={
        onRetry || action ? (
          <div className="flex flex-wrap items-center justify-center gap-2">
            {onRetry && <RetryButton onClick={onRetry} />}
            {action}
          </div>
        ) : undefined
      }
    />
  );
}

/**
 * The retry affordance, on its own so pages with a fixed layout (a table header row, a
 * chart card's corner) can place it without the surrounding EmptyState block.
 */
export function RetryButton({ onClick, label = "Retry" }: { onClick: () => void; label?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="border border-borderstrong px-3 py-1.5 text-xs font-medium text-ink-primary transition-colors hover:bg-ink-primary/[0.08]"
    >
      {label}
    </button>
  );
}

function AlertIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
      <path d="M12 9v4M12 17h.01" />
    </svg>
  );
}

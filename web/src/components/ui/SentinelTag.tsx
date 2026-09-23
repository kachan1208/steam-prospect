import type { ReactNode } from "react";
import clsx from "clsx";

/**
 * An inline marker that says a value is a SENTINEL, not a measurement — "floored at 0",
 * "capped", "not scored", "no data", "unknown → ×1.00".
 *
 * The owner's rule: a sentinel is never shown bare. A bare 0.0 was twice mistaken for
 * missing data, and a bare "—" can't say whether the number is unknown, not applicable or
 * clamped. The dashed warning-hued frame reads as "flagged" at a glance; the words carry the
 * meaning (colour is reinforcement only, like everywhere else in the blueprint grammar).
 */
export type Sentinel = string | { tag: string; detail: ReactNode };

/** The short marker text for a Sentinel prop. */
export function sentinelTag(s: Sentinel): string {
  return typeof s === "string" ? s : s.tag;
}

/** The longer explanation for a Sentinel prop (the InfoTip's "Flagged value" line). */
export function sentinelDetail(s: Sentinel): ReactNode {
  return typeof s === "string" ? s : s.detail;
}

export function SentinelTag({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span
      data-sentinel=""
      className={clsx(
        "inline-flex shrink-0 items-center whitespace-nowrap border border-dashed px-1 text-[10px] font-medium normal-case leading-[14px] tracking-normal text-ink-secondary",
        className,
      )}
      style={{ borderColor: "var(--status-warning)" }}
    >
      {children}
    </span>
  );
}

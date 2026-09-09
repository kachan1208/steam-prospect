import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import clsx from "clsx";

// Condensed heading stack, matching the global h1–h6 / .kicker rule in index.css — applied
// inline here because these are <span>s inside a result row, not heading elements.
export const HEADING_FONT = '"Barlow Condensed", "Barlow", system-ui, sans-serif';

/**
 * Below which breakpoint the lead cell and the metric group stack instead of sharing a
 * line. The 4e mock (an 880px desktop canvas) doesn't specify mobile behaviour, so this is
 * an extrapolation, not a pictured requirement: /games' four metric cells fit beside the
 * title from `sm`; /studios' seven do not until `lg`. Tailwind needs the full class string
 * per variant, hence the tables below rather than a computed prefix.
 */
export type StackBelow = "sm" | "lg";

const HEADER_CLS: Record<StackBelow, string> = {
  sm: "hidden items-center gap-4 px-1 pb-2 text-[11px] uppercase tracking-[0.08em] text-ink-secondary sm:flex",
  lg: "hidden items-center gap-4 px-1 pb-2 text-[11px] uppercase tracking-[0.08em] text-ink-secondary lg:flex",
};
const ROW_CLS: Record<StackBelow, string> = {
  sm: "flex cursor-pointer flex-col gap-2 border-t border-line-grid px-1 py-3.5 transition-colors hover:bg-surface2 sm:flex-row sm:items-center sm:gap-4",
  lg: "flex cursor-pointer flex-col gap-2 border-t border-line-grid px-1 py-3.5 transition-colors hover:bg-surface2 lg:flex-row lg:items-center lg:gap-4",
};
const LEAD_CLS: Record<StackBelow, string> = {
  sm: "flex min-w-0 items-center gap-4 sm:flex-1",
  lg: "flex min-w-0 items-center gap-4 lg:flex-1",
};
// The stacked (below-breakpoint) metric group spreads across the row; the `lg` variant also
// wraps, because seven fixed-width cells outrun a phone-width row where four do not.
const METRICS_CLS: Record<StackBelow, string> = {
  sm: "flex items-center justify-between gap-4 sm:ml-auto sm:w-auto sm:shrink-0 sm:justify-end",
  lg: "flex flex-wrap items-center justify-between gap-4 lg:ml-auto lg:w-auto lg:shrink-0 lg:justify-end",
};

/** Result rows — hairline top rules, not cards (4e). */
export function ResultList({ children }: { children: ReactNode }) {
  return <div className="border-b border-line-grid">{children}</div>;
}

/**
 * Column headers. 4e draws none — it shows one annotated row on a designer's canvas, where
 * "86% · 9.8M / $464.6M / 841.9K live" is legible because the annotations are on the
 * artboard. Shipped, they aren't: a cold visitor got four unlabelled numbers and an <h1>
 * that is sr-only (measured on production 2026-09-01), so every metric column is labelled
 * and explained on hover — the pattern /niches already used. The header's cell widths and
 * gaps must mirror the row's metric group EXACTLY — change one, change both. Hidden below
 * the stacking breakpoint for the same reason the row itself stacks there: there is no
 * column layout to head.
 */
export function ResultHeader({
  lead,
  children,
  stackBelow = "sm",
}: {
  /** The lead column's label ("Game", "Studio"). */
  lead: ReactNode;
  /** The metric column labels, each sized exactly like its cell below. */
  children: ReactNode;
  stackBelow?: StackBelow;
}) {
  return (
    <div className={HEADER_CLS[stackBelow]} style={{ fontFamily: HEADING_FONT }}>
      <span className="flex-1">{lead}</span>
      <div className="flex items-center justify-end gap-4">{children}</div>
    </div>
  );
}

/**
 * One result row: a click anywhere opens it (`onOpen`), the lead cell holds the title (and
 * on /games the capsule), the metric group holds the fixed-width cells. Lead and metrics
 * stack below the breakpoint instead of clipping.
 */
export function ResultRow({
  onOpen,
  lead,
  metrics,
  stackBelow = "sm",
}: {
  onOpen: () => void;
  lead: ReactNode;
  metrics: ReactNode;
  stackBelow?: StackBelow;
}) {
  return (
    <div onClick={onOpen} className={ROW_CLS[stackBelow]}>
      <div className={LEAD_CLS[stackBelow]}>{lead}</div>
      <div className={METRICS_CLS[stackBelow]}>{metrics}</div>
    </div>
  );
}

/**
 * The two-line title: name on line one, a "·"-joined meta caption on line two. A real link
 * (not a navigate() button) so middle-click / cmd-click "open in new tab" works — opening
 * several candidates in tabs IS the research workflow; the click stops so the row's own
 * onOpen doesn't fire a second navigation.
 */
export function ResultTitle({ to, name, meta }: { to: string; name: ReactNode; meta: ReactNode }) {
  return (
    <Link to={to} onClick={(e) => e.stopPropagation()} className="min-w-0 flex-1">
      <span
        className="block truncate text-[17px] font-semibold text-ink-primary hover:text-brand hover:underline"
        style={{ fontFamily: HEADING_FONT }}
      >
        {name}
      </span>
      <span className="block truncate text-xs text-ink-secondary">{meta}</span>
    </Link>
  );
}

/**
 * The headline money cell: condensed, semibold, and accent-coloured on the TOP row of the
 * first page only — one number per page in accent, the rest in primary ink, so the eye
 * lands on the leader rather than on a column of highlights. `width` is the Tailwind width
 * class the header cell above it must repeat: /games' "Est. gross" fits w-20, /studios'
 * "Total est. revenue" label does not.
 */
export function RevenueCell({
  top,
  width = "w-20",
  title,
  children,
}: {
  top: boolean;
  width?: string;
  /** Hover explanation for the stacked (below-breakpoint) layout, where the header is hidden. */
  title?: string;
  children: ReactNode;
}) {
  return (
    <span
      className={clsx(width, "shrink-0 truncate text-[16px] font-semibold", top ? "text-brand" : "text-ink-primary")}
      style={{ fontFamily: HEADING_FONT }}
      title={title}
    >
      {children}
    </span>
  );
}

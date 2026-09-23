import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import clsx from "clsx";

// Condensed heading stack, matching the global h1–h6 / .kicker rule in index.css — applied
// inline here because these are <span>s inside a result row, not heading elements.
export const HEADING_FONT = '"Barlow Condensed", "Barlow", system-ui, sans-serif';

/**
 * Below which breakpoint the lead cell and the metric group stack instead of sharing a
 * line. The 4e mock (an 880px desktop canvas) doesn't specify mobile behaviour, so this is
 * an extrapolation, not a pictured requirement: /games' five metric cells fit beside the
 * title and its capsule from `md`; /studios' seven, each with its ⓘ, leave a studio name
 * room to read only from `xl` (at 1024px they truncated it to "Facepunch…"). Tailwind needs
 * the full class string per variant, hence the tables below rather than a computed prefix.
 */
export type StackBelow = "sm" | "md" | "lg" | "xl";

const HEADER_CLS: Record<StackBelow, string> = {
  sm: "hidden items-center gap-4 px-1 pb-2 text-[11px] uppercase tracking-[0.08em] text-ink-secondary sm:flex",
  md: "hidden items-center gap-4 px-1 pb-2 text-[11px] uppercase tracking-[0.08em] text-ink-secondary md:flex",
  lg: "hidden items-center gap-4 px-1 pb-2 text-[11px] uppercase tracking-[0.08em] text-ink-secondary lg:flex",
  xl: "hidden items-center gap-4 px-1 pb-2 text-[11px] uppercase tracking-[0.08em] text-ink-secondary xl:flex",
};
const ROW_CLS: Record<StackBelow, string> = {
  sm: "flex cursor-pointer flex-col gap-2 border-t border-line-grid px-1 py-3.5 transition-colors hover:bg-surface2 sm:flex-row sm:items-center sm:gap-4",
  md: "flex cursor-pointer flex-col gap-2 border-t border-line-grid px-1 py-3.5 transition-colors hover:bg-surface2 md:flex-row md:items-center md:gap-4",
  lg: "flex cursor-pointer flex-col gap-2 border-t border-line-grid px-1 py-3.5 transition-colors hover:bg-surface2 lg:flex-row lg:items-center lg:gap-4",
  xl: "flex cursor-pointer flex-col gap-2 border-t border-line-grid px-1 py-3.5 transition-colors hover:bg-surface2 xl:flex-row xl:items-center xl:gap-4",
};
const LEAD_CLS: Record<StackBelow, string> = {
  sm: "flex min-w-0 items-center gap-4 sm:flex-1",
  md: "flex min-w-0 items-center gap-4 md:flex-1",
  lg: "flex min-w-0 items-center gap-4 lg:flex-1",
  xl: "flex min-w-0 items-center gap-4 xl:flex-1",
};
// The stacked (below-breakpoint) metric group spreads across the row and WRAPS: a phone-width
// row cannot hold five or seven fixed cells on one line, and a group that doesn't wrap
// pushes the page sideways.
const METRICS_CLS: Record<StackBelow, string> = {
  sm: "flex flex-wrap items-start justify-between gap-x-4 gap-y-2 sm:ml-auto sm:w-auto sm:shrink-0 sm:flex-nowrap sm:items-center sm:justify-end",
  md: "flex flex-wrap items-start justify-between gap-x-4 gap-y-2 md:ml-auto md:w-auto md:shrink-0 md:flex-nowrap md:items-center md:justify-end",
  lg: "flex flex-wrap items-start justify-between gap-x-4 gap-y-2 lg:ml-auto lg:w-auto lg:shrink-0 lg:flex-nowrap lg:items-center lg:justify-end",
  xl: "flex flex-wrap items-start justify-between gap-x-4 gap-y-2 xl:ml-auto xl:w-auto xl:shrink-0 xl:flex-nowrap xl:items-center xl:justify-end",
};
// The per-cell label a STACKED row prints above each value: below the breakpoint the header
// row is hidden, and a hover `title` was the only name the numbers had — nothing on a phone.
const CELL_LABEL_CLS: Record<StackBelow, string> = {
  sm: "block text-[10px] uppercase tracking-[0.08em] text-ink-muted sm:hidden",
  md: "block text-[10px] uppercase tracking-[0.08em] text-ink-muted md:hidden",
  lg: "block text-[10px] uppercase tracking-[0.08em] text-ink-muted lg:hidden",
  xl: "block text-[10px] uppercase tracking-[0.08em] text-ink-muted xl:hidden",
};
/**
 * One metric cell of a result row. At and above the stacking breakpoint it takes `width` —
 * the SAME Tailwind width class its header cell carries — and prints just the value; below
 * it the header row is hidden, so the cell prints its own `label` above the value instead
 * of leaving a bare number (the only name it used to have there was a hover `title`).
 * Tailwind can't see a class built at runtime, so `width` is passed WITHOUT the breakpoint
 * prefix and must be one of the literal classes listed in RESPONSIVE_WIDTHS below.
 */
export function MetricCell({
  label,
  width,
  stackBelow = "sm",
  className,
  children,
}: {
  label: string;
  width: ResponsiveWidth;
  stackBelow?: StackBelow;
  className?: string;
  children: ReactNode;
}) {
  return (
    <span
      data-metric-cell=""
      className={clsx("min-w-0 shrink-0 text-[13px]", RESPONSIVE_WIDTHS[stackBelow][width], className)}
    >
      <span className={CELL_LABEL_CLS[stackBelow]} style={{ fontFamily: HEADING_FONT }}>
        {label}
      </span>
      <span className="block truncate">{children}</span>
    </span>
  );
}

/** The widths a MetricCell may take, spelled out per breakpoint so Tailwind generates them. */
export type ResponsiveWidth = "w-14" | "w-16" | "w-[72px]" | "w-20" | "w-[84px]" | "w-24" | "w-28" | "w-[220px]";
const RESPONSIVE_WIDTHS: Record<StackBelow, Record<ResponsiveWidth, string>> = {
  sm: {
    "w-14": "sm:w-14",
    "w-16": "sm:w-16",
    "w-[72px]": "sm:w-[72px]",
    "w-20": "sm:w-20",
    "w-[84px]": "sm:w-[84px]",
    "w-24": "sm:w-24",
    "w-28": "sm:w-28",
    "w-[220px]": "sm:w-[220px]",
  },
  md: {
    "w-14": "md:w-14",
    "w-16": "md:w-16",
    "w-[72px]": "md:w-[72px]",
    "w-20": "md:w-20",
    "w-[84px]": "md:w-[84px]",
    "w-24": "md:w-24",
    "w-28": "md:w-28",
    "w-[220px]": "md:w-[220px]",
  },
  lg: {
    "w-14": "lg:w-14",
    "w-16": "lg:w-16",
    "w-[72px]": "lg:w-[72px]",
    "w-20": "lg:w-20",
    "w-[84px]": "lg:w-[84px]",
    "w-24": "lg:w-24",
    "w-28": "lg:w-28",
    "w-[220px]": "lg:w-[220px]",
  },
  xl: {
    "w-14": "xl:w-14",
    "w-16": "xl:w-16",
    "w-[72px]": "xl:w-[72px]",
    "w-20": "xl:w-20",
    "w-[84px]": "xl:w-[84px]",
    "w-24": "xl:w-24",
    "w-28": "xl:w-28",
    "w-[220px]": "xl:w-[220px]",
  },
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
 * — and, since 2026-09-23, explained by an accessible ⓘ (components/ui/HeaderLabel) rather
 * than a hover-only `title`. The header's cell widths and gaps must mirror the row's metric
 * group EXACTLY — change one, change both. Hidden below the stacking breakpoint for the
 * same reason the row itself stacks there: there is no column layout to head (each
 * MetricCell prints its own label there instead).
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
 * lands on the leader rather than on a column of highlights. `width` is the width the
 * header cell above it repeats (see MetricCell); `label` is what a stacked row prints above
 * the value — the page's one revenue name, "Est. revenue" (lib/glossary.ts).
 */
export function RevenueCell({
  top,
  width = "w-24",
  label = "Est. revenue",
  stackBelow = "sm",
  children,
}: {
  top: boolean;
  width?: ResponsiveWidth;
  label?: string;
  stackBelow?: StackBelow;
  children: ReactNode;
}) {
  return (
    <MetricCell label={label} width={width} stackBelow={stackBelow}>
      <span
        className={clsx("text-[16px] font-semibold", top ? "text-brand" : "text-ink-primary")}
        style={{ fontFamily: HEADING_FONT }}
      >
        {children}
      </span>
    </MetricCell>
  );
}

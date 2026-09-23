import { useId, type ReactNode } from "react";
import clsx from "clsx";

import { glossary } from "../../lib/glossary";
import { MetricTip, type MetricExplainProps } from "./InfoTip";
import { SentinelTag, sentinelTag } from "./SentinelTag";

/**
 * A KPI card. Passing `onClick` turns it into a toggle (used to open a per-metric drilldown
 * below a grid); `active` marks the currently-selected metric (brand border/tint, same
 * convention as the page's tab pills). Omitting `onClick` renders the plain, inert tile.
 *
 * EXPLAINS ITSELF (2026-09-22). `help` (the old plain-language string) and the new glossary
 * `term`, `worked` and `sentinel` props all feed ONE accessible ⓘ beside the label
 * (components/ui/InfoTip) — it opens on hover, focus and tap. The old implementation put
 * `help` in the tile's `title=` (hover-only, unreachable by keyboard and touch) next to a
 * decorative, aria-hidden ⓘ that did nothing when pressed.
 *
 * The interactive tile is a real <button> stretched over the card (its ::after covers the
 * tile), not a div with role="button": a role=button element's children are presentational,
 * so the ⓘ — itself a button — could not live inside one. The ⓘ sits above the stretched
 * layer (z-10) and swallows its own clicks, so pressing it never toggles the tile.
 */
export function StatTile({
  label,
  value,
  sub,
  className,
  valueClassName,
  onClick,
  active,
  term,
  info,
  help,
  worked,
  sentinel,
}: {
  /** Visible label. Optional when `term` is given (the glossary label is used). */
  label?: string;
  value: ReactNode;
  sub?: ReactNode;
  className?: string;
  /** Extra classes on the value line — hero-metric accent or verdict color. */
  valueClassName?: string;
  onClick?: () => void;
  active?: boolean;
} & MetricExplainProps) {
  const interactive = onClick !== undefined;
  const shown = label ?? (term ? glossary(term).label : "");
  const valueId = useId();
  const subId = useId();

  const labelRow = (
    <div className="kicker flex min-w-0 items-center gap-1 text-[10px] text-ink-muted">
      {interactive ? (
        <button
          type="button"
          aria-pressed={active ?? false}
          aria-describedby={sub ? `${valueId} ${subId}` : valueId}
          onClick={onClick}
          className={clsx(
            "kicker min-w-0 text-left focus-visible:outline-none",
            // The stretched hit area: the whole tile is this button.
            "after:absolute after:inset-0 after:content-['']",
            "focus-visible:after:outline focus-visible:after:outline-2 focus-visible:after:outline-offset-2 focus-visible:after:outline-brand",
          )}
        >
          {shown}
        </button>
      ) : (
        <span className="min-w-0">{shown}</span>
      )}
      <MetricTip
        label={shown}
        term={term}
        info={info}
        help={help}
        worked={worked}
        sentinel={sentinel}
        className={interactive ? "z-10" : undefined}
      />
      {sentinel != null && <SentinelTag className="ml-auto">{sentinelTag(sentinel)}</SentinelTag>}
    </div>
  );

  return (
    <div
      className={clsx(
        "rounded-none border bg-surface p-4 transition-colors",
        interactive && "relative",
        active ? "border-brand bg-brand-tint" : "border-chartborder",
        interactive && !active && "cursor-pointer hover:border-brand-hover hover:bg-page",
        className,
      )}
    >
      {labelRow}
      <div
        id={valueId}
        // The default ink color only applies when the caller doesn't pass its own —
        // stacking both leaves the winner to stylesheet order, which silently ate
        // valueClassName colors like text-brand while letting others through.
        className={clsx("mt-1 text-[28px] font-semibold leading-none", valueClassName || "text-ink-primary")}
        style={{ fontFamily: '"Barlow Condensed", "Barlow", system-ui, sans-serif' }}
      >
        {value}
      </div>
      {sub && (
        <div id={subId} className="mt-1.5 text-xs text-ink-secondary">
          {sub}
        </div>
      )}
    </div>
  );
}

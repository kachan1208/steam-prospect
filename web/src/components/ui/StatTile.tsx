import type { KeyboardEvent, ReactNode } from "react";
import clsx from "clsx";

/**
 * A KPI card. Passing `onClick` turns it into a toggle button (used by GameProfile's stat
 * row to open a per-metric time-series drilldown below the grid) — div-based (not a native
 * <button>) so it keeps the plain-tile box styling other callers rely on, with role/tabIndex/
 * onKeyDown added only in that mode so keyboard users get the same affordance as a click.
 * `active` marks the currently-selected metric (brand border/tint, same convention as the
 * page's tab pills). Omitting `onClick` renders exactly the old, inert tile.
 */
export function StatTile({
  label,
  value,
  sub,
  help,
  className,
  valueClassName,
  onClick,
  active,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  /** Plain-language "how to read this" — rendered as a hover tooltip (title) plus a
   * small ⓘ affordance next to the label so users know there IS an explanation. */
  help?: string;
  className?: string;
  /** Extra classes on the value line — hero-metric accent or verdict color. */
  valueClassName?: string;
  onClick?: () => void;
  active?: boolean;
}) {
  const interactive = onClick !== undefined;

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (!interactive) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onClick?.();
    }
  }

  return (
    <div
      role={interactive ? "button" : undefined}
      tabIndex={interactive ? 0 : undefined}
      aria-pressed={interactive ? active ?? false : undefined}
      onClick={onClick}
      onKeyDown={onKeyDown}
      title={help}
      className={clsx(
        "rounded-none border bg-surface p-4 transition-colors",
        active ? "border-brand bg-brand-tint" : "border-chartborder",
        interactive && !active && "cursor-pointer hover:border-brand-hover hover:bg-page",
        className,
      )}
    >
      <div className="kicker text-[10px] text-ink-muted">
        {label}
        {help && (
          <span aria-hidden className="ml-1 cursor-help text-[10px] normal-case tracking-normal text-ink-muted/70">
            ⓘ
          </span>
        )}
      </div>
      <div
        // The default ink color only applies when the caller doesn't pass its own —
        // stacking both leaves the winner to stylesheet order, which silently ate
        // valueClassName colors like text-brand while letting others through.
        className={clsx("mt-1 text-[28px] font-semibold leading-none", valueClassName || "text-ink-primary")}
        style={{ fontFamily: '"Barlow Condensed", "Barlow", system-ui, sans-serif' }}
      >
        {value}
      </div>
      {sub && <div className="mt-1.5 text-xs text-ink-secondary">{sub}</div>}
    </div>
  );
}

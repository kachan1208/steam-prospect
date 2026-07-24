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
  className,
  onClick,
  active,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  className?: string;
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
      className={clsx(
        "rounded-card border bg-surface p-4 transition-colors",
        active ? "border-brand bg-brand-tint" : "border-chartborder",
        interactive && !active && "cursor-pointer hover:border-brand-hover hover:bg-page",
        className,
      )}
    >
      <div className="text-xs text-ink-muted">{label}</div>
      <div className="mt-1 text-2xl font-semibold text-ink-primary">{value}</div>
      {sub && <div className="mt-1 text-xs text-ink-secondary">{sub}</div>}
    </div>
  );
}

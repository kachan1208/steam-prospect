import { Link } from "react-router-dom";
import clsx from "clsx";

/**
 * The most frequent values across `rows` — each row contributes its first `perRow` values
 * once, the top `max` come back most-common first. Feeds ResultChipRow from the page's own
 * results (a game's top_tags, a studio's top_genres).
 */
export function topValues<T>(
  rows: readonly T[],
  pick: (row: T) => readonly string[],
  perRow = 5,
  max = 12,
): string[] {
  const counts = new Map<string, number>();
  for (const r of rows) {
    for (const t of pick(r).slice(0, perRow)) counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, max)
    .map(([t]) => t);
}

/**
 * Quick pivots sourced from the current page's own rows — "Tags in these results:" on
 * /games, "Genres in these results:" on /studios — the exact strings present in what is on
 * screen, not a global vocabulary. Not pictured in 4e (which ends at the result rows), so
 * both pages sit it below the rows rather than between the chip row and the list. Items
 * are buttons when the pivot stays on the page (`onPick`, /games' ?tag= filter) and real
 * links when it leaves it (`href`), so middle-click works where there is somewhere to go.
 * Renders nothing with no items, so an empty page has no orphaned label.
 */
export function ResultChipRow({
  label,
  items,
  active,
  onPick,
  href,
}: {
  label: string;
  items: readonly string[];
  /** The item currently applied as a filter — wears the accent outline. */
  active?: string;
  onPick?: (item: string) => void;
  href?: (item: string) => string;
}) {
  if (items.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-xs">
      <span className="text-ink-muted">{label}</span>
      {items.map((t) => {
        const className = clsx(
          "border px-2 py-0.5 text-[10px] font-medium transition-colors",
          active === t
            ? "border-brand text-brand"
            : "border-chartborder text-ink-muted hover:border-borderstrong hover:text-ink-secondary",
        );
        return href ? (
          <Link key={t} to={href(t)} className={className}>
            {t}
          </Link>
        ) : (
          <button key={t} type="button" onClick={() => onPick?.(t)} className={className}>
            {t}
          </button>
        );
      })}
    </div>
  );
}

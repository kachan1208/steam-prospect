import type { ReactNode } from "react";

/** Active-filter chip — outline accent, accent TEXT (mockup 4e's "released 24m" chip: both
 * the border and the label itself carry accent-300, not paper). Every chip rendered here
 * represents a filter that IS applied, so it always wears the "active" state; the mockup's
 * "inactive" paper-30% chips describe categories with nothing set, which the pages already
 * represent by omitting the chip entirely — an empty row is a more honest read than a row
 * of chips reading "any". The ✕ (remove) isn't pictured but keeps the chip functional. */
export function FilterChip({ label, onClear }: { label: string; onClear: () => void }) {
  return (
    <button
      type="button"
      onClick={onClear}
      title="Remove filter"
      className="group inline-flex items-center gap-1 border border-brand px-2 py-0.5 text-[11px] font-medium text-brand transition-colors hover:bg-brand-tint"
    >
      {label}
      <span aria-hidden className="text-ink-muted group-hover:text-brand">✕</span>
    </button>
  );
}

/** One applied filter, as the chip row wants it: a stable key, the label, and how to undo it. */
export interface ActiveFilter {
  key: string;
  label: string;
  onClear: () => void;
}

/**
 * The filter chip row (4e): active filters as accent chips + "Clear all", with the
 * "sorted by …" control right-aligned. `leading` sits BEFORE the chips — /studios puts its
 * Publishers | Developers choice there, /games has nothing; `trailing` is the right-hand
 * cluster (/games' "More filters", then the sort control on both pages). With no chips the
 * row is just its two ends, which is exactly what the mock draws for an unfiltered page.
 */
export function FilterBar({
  chips,
  onClearAll,
  leading,
  trailing,
}: {
  chips: readonly ActiveFilter[];
  onClearAll: () => void;
  leading?: ReactNode;
  trailing?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      {leading}
      {chips.length > 0 && (
        <>
          <span className="text-ink-muted">Filter:</span>
          {chips.map((c) => (
            <FilterChip key={c.key} label={c.label} onClear={c.onClear} />
          ))}
          <button
            type="button"
            onClick={onClearAll}
            className="text-ink-muted underline decoration-dotted hover:text-ink-primary"
          >
            Clear all
          </button>
        </>
      )}
      <span className="ml-auto flex items-center gap-3">{trailing}</span>
    </div>
  );
}

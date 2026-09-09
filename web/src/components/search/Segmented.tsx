import clsx from "clsx";

/**
 * Chip-style segmented choice for the filter chip row — the same square hairline track as
 * the Niche Finder's segmented filters and /games' Any/yes/no toggles: hairline dividers
 * between segments, selected = accent fill + accent-fg text, sized to sit level with the
 * row's other controls ("More filters", the chips). The UNSELECTED segments are live
 * controls, not decoration, so they wear ink-secondary rather than ink-muted (measured
 * under AA on /studios' previous pill, 2026-09-01) — the same call ViewToggle makes.
 * `onChange` fires only on an actual change, so callers can hang URL writes off it directly.
 */
export function Segmented<V extends string>({
  options,
  value,
  onChange,
  ariaLabel,
}: {
  options: readonly { value: V; label: string; title?: string }[];
  value: V;
  onChange: (value: V) => void;
  ariaLabel: string;
}) {
  return (
    <span role="group" aria-label={ariaLabel} className="inline-flex border border-chartborder">
      {options.map((o, i) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={value === o.value}
          title={o.title}
          onClick={() => {
            if (o.value !== value) onChange(o.value);
          }}
          className={clsx(
            "px-2.5 py-1 text-[11px] font-medium transition-colors",
            i > 0 && "border-l border-chartborder",
            value === o.value ? "bg-brand text-brand-fg" : "text-ink-secondary hover:text-ink-primary",
          )}
        >
          {o.label}
        </button>
      ))}
    </span>
  );
}

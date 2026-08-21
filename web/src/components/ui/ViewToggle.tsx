import clsx from "clsx";

import type { DetailView } from "../../lib/viewMode";

const OPTIONS: { value: DetailView; label: string; title: string }[] = [
  { value: "simple", label: "Simple", title: "Just the decision-critical reads, in plain language" },
  { value: "detailed", label: "Detailed", title: "Every metric, chart and table" },
];

/** Simple/Detailed segmented control — blueprint grammar (mockup 4a's segmented filter
 * row): square hairline-bordered track, hairline dividers between segments, active
 * segment = accent fill + ground-coloured text, inactive = plain paper text. Dumb
 * component: onChange fires only on an actual change, so callers can hang analytics off
 * it directly. */
export function ViewToggle({ value, onChange }: { value: DetailView; onChange: (v: DetailView) => void }) {
  return (
    <div role="group" aria-label="Detail level" className="inline-flex border border-chartborder">
      {OPTIONS.map((o, i) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={value === o.value}
          title={o.title}
          onClick={() => {
            if (o.value !== value) onChange(o.value);
          }}
          className={clsx(
            "px-3 py-1.5 text-xs font-medium transition-colors",
            i > 0 && "border-l border-chartborder",
            value === o.value
              ? "bg-brand font-semibold text-brand-fg"
              : "text-ink-secondary hover:text-ink-primary",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

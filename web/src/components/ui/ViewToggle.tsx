import clsx from "clsx";

import type { DetailView } from "../../lib/viewMode";

const OPTIONS: { value: DetailView; label: string; title: string }[] = [
  { value: "simple", label: "Simple", title: "Just the decision-critical reads, in plain language" },
  { value: "detailed", label: "Detailed", title: "Every metric, chart and table" },
];

/** Simple/Detailed segmented control — same visual language as NicheFinder's Segmented
 * chip group (rounded-lg track, active chip lifted onto the surface). Dumb component:
 * onChange fires only on an actual change, so callers can hang analytics off it directly. */
export function ViewToggle({ value, onChange }: { value: DetailView; onChange: (v: DetailView) => void }) {
  return (
    <div role="group" aria-label="Detail level" className="flex items-center gap-0.5 rounded-lg bg-surface2 p-0.5">
      {OPTIONS.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={value === o.value}
          title={o.title}
          onClick={() => {
            if (o.value !== value) onChange(o.value);
          }}
          className={clsx(
            "rounded-md px-3 py-1.5 text-xs font-medium transition-all",
            value === o.value ? "bg-surface text-ink-primary shadow-xs" : "text-ink-muted hover:text-ink-secondary",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

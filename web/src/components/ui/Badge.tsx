import type { ReactNode } from "react";

/** A neutral-text pill with a colored identity dot — color never lands on the text itself. */
export function Badge({ color, children }: { color?: string; children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-chartborder bg-page px-2 py-0.5 text-xs text-ink-secondary">
      {color && <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: color }} />}
      {children}
    </span>
  );
}

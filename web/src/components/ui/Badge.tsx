import type { ReactNode } from "react";

/**
 * An outline tag — blueprint grammar (square, hairline, transparent), matching the
 * mockups' `.tag`/tier-chip look: colored border + colored text when `color` is given
 * (e.g. tier chips, status chips), a neutral muted outline otherwise. Square corners
 * always; no fill, no dot — the border alone carries the identity.
 */
export function Badge({ color, children }: { color?: string; children: ReactNode }) {
  return (
    <span
      className="inline-flex items-center whitespace-nowrap border px-2.5 py-0.5 text-[11px] tracking-wide"
      style={{
        borderColor: color ?? "var(--border-strong)",
        color: color ?? "var(--text-secondary)",
      }}
    >
      {children}
    </span>
  );
}

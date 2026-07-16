import type { BuzzTermRow } from "../../lib/api";
import { fmtInt, titleCase } from "../../lib/format";
import { CSS_VAR } from "../../lib/palette";
import { BuzzSparkline } from "./BuzzSparkline";

/**
 * Ranked rising/cooling term list with a mini sparkline per row. Color (blue rising / red
 * cooling — the app's diverging pair) sits only on the arrow glyph and the sparkline
 * itself, never on the numeric text (mark spec: text stays in neutral ink; a colored mark
 * beside it carries identity) — the row's own arrow + "Rising"/"Cooling" section title are
 * the real identity signal, color is reinforcing.
 */
export function BuzzTrendsList({ items }: { items: BuzzTermRow[] }) {
  if (items.length === 0) {
    return <div className="flex h-24 items-center justify-center text-xs text-ink-muted">No terms found.</div>;
  }
  // Shared month axis across every row so sparklines align column-for-column.
  const periods = [...new Set(items.flatMap((it) => it.series.map((p) => p.period)))].sort();

  return (
    <div className="flex flex-col divide-y divide-chartborder/60">
      {items.map((it) => {
        const color = it.direction === "rising" ? CSS_VAR.praise : it.direction === "cooling" ? CSS_VAR.complaint : CSS_VAR.textMuted;
        const arrow = it.direction === "rising" ? "▲" : it.direction === "cooling" ? "▼" : "—";
        return (
          <div key={it.term} className="flex items-center gap-3 py-2">
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium text-ink-primary">{titleCase(it.term)}</div>
              <div className="tabular text-[11px] text-ink-muted">
                {fmtInt(it.total_mentions)} mentions total · {it.prior_avg.toFixed(1)} → {it.recent_avg.toFixed(1)}/mo
              </div>
            </div>
            <BuzzSparkline series={it.series} periods={periods} direction={it.direction} />
            <span className="tabular flex w-20 shrink-0 items-center justify-end gap-1.5 text-xs">
              <span aria-hidden="true" style={{ color }}>
                {arrow}
              </span>
              <span className="font-semibold text-ink-primary">
                {it.slope > 0 ? "+" : ""}
                {it.slope.toFixed(1)}
              </span>
            </span>
          </div>
        );
      })}
    </div>
  );
}

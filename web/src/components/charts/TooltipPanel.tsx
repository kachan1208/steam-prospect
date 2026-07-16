/**
 * Shared Recharts tooltip content: a surface-toned panel, value-leads-label rows,
 * line-key swatches (a short stroke, not a filled box). Used as the `content` render
 * prop on every <Tooltip> in the app so hover styling stays consistent.
 */
export interface TooltipRow {
  label: string;
  value: string;
  color?: string;
}

export function TooltipPanel({ title, rows }: { title?: string; rows: TooltipRow[] }) {
  if (rows.length === 0) return null;
  return (
    <div className="rounded-md border border-chartborder bg-surface px-3 py-2 text-xs shadow-lg">
      {title && <div className="mb-1 font-medium text-ink-secondary">{title}</div>}
      <div className="flex flex-col gap-1">
        {rows.map((r, i) => (
          <div key={`${r.label}-${i}`} className="flex items-center gap-2">
            {r.color && <span className="inline-block h-0.5 w-3 shrink-0" style={{ backgroundColor: r.color }} />}
            <span className="text-ink-secondary">{r.label}</span>
            <span className="tabular ml-auto pl-3 font-semibold text-ink-primary">{r.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

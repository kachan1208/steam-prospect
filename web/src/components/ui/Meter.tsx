/** A single-value meter: filled track (0-100 scale) against a neutral, recessive rail. */
export function Meter({ value, max = 100, color }: { value: number | null; max?: number; color: string }) {
  const pct = value === null ? 0 : Math.max(0, Math.min(100, (value / max) * 100));
  return (
    <span className="block h-1.5 w-full overflow-hidden rounded-full bg-line-grid">
      <span className="block h-full rounded-full" style={{ width: `${pct}%`, backgroundColor: color }} />
    </span>
  );
}

/** A bullet-style meter: filled bar to `value` (fraction 0-1) plus an optional reference tick. */
export function BulletMeter({
  label,
  value,
  benchmark,
  benchmarkLabel,
  color,
  valueLabel,
}: {
  label: string;
  value: number | null;
  benchmark?: number;
  benchmarkLabel?: string;
  color: string;
  valueLabel: string;
}) {
  const pct = value === null ? 0 : Math.max(0, Math.min(100, value * 100));
  const benchPct = benchmark === undefined ? undefined : Math.max(0, Math.min(100, benchmark * 100));
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between text-xs">
        <span className="text-ink-secondary">{label}</span>
        <span className="tabular font-medium text-ink-primary">{valueLabel}</span>
      </div>
      <div className="relative h-2.5 rounded-full bg-line-grid">
        <div className="h-full rounded-full" style={{ width: `${pct}%`, backgroundColor: color }} />
        {benchPct !== undefined && (
          <div
            className="absolute -top-[3px] h-[16px] w-[2px] bg-ink-primary"
            style={{ left: `calc(${benchPct}% - 1px)` }}
            title={benchmarkLabel}
          />
        )}
      </div>
    </div>
  );
}

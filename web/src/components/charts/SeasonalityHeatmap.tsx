import { Fragment, useMemo, useState } from "react";

import type { SeasonalityCell } from "../../lib/api";
import { fmtCompact, fmtUsd, monthName, weekdayName } from "../../lib/format";
import { sequentialColorAt, sequentialScale } from "../../lib/palette";
import { useTheme } from "../../lib/theme";

type Measure = "median_rev" | "n_releases";

const MEASURES: { key: Measure; label: string; format: (n: number) => string }[] = [
  { key: "median_rev", label: "Median revenue", format: fmtUsd },
  { key: "n_releases", label: "Releases", format: fmtCompact },
];

export function SeasonalityHeatmap({ cells }: { cells: SeasonalityCell[] }) {
  const { theme } = useTheme();
  const [measureKey, setMeasureKey] = useState<Measure>("median_rev");
  const [hovered, setHovered] = useState<{ month: number; weekday: number } | null>(null);
  const measure = MEASURES.find((m) => m.key === measureKey) ?? MEASURES[0];

  const grid = useMemo(() => {
    const byCell = new Map<string, SeasonalityCell>();
    for (const c of cells) {
      if (c.month === null || c.weekday === null) continue;
      byCell.set(`${c.month}-${c.weekday}`, c);
    }
    return byCell;
  }, [cells]);

  const values = cells.map((c) => c[measureKey]).filter((v): v is number => v !== null && Number.isFinite(v));
  const min = values.length ? Math.min(...values) : 0;
  const max = values.length ? Math.max(...values) : 1;

  const weekdays = [0, 1, 2, 3, 4, 5, 6];
  const months = Array.from({ length: 12 }, (_, i) => i + 1);
  const legendGradient = `linear-gradient(to right, ${sequentialScale(theme).join(",")})`;
  const hoveredCell = hovered ? grid.get(`${hovered.month}-${hovered.weekday}`) : undefined;

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1">
          {MEASURES.map((m) => (
            <button
              key={m.key}
              type="button"
              onClick={() => setMeasureKey(m.key)}
              className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                m.key === measureKey ? "bg-page text-ink-primary" : "text-ink-muted hover:text-ink-secondary"
              }`}
            >
              {m.label}
            </button>
          ))}
        </div>
        <div className="text-xs text-ink-secondary">
          {hoveredCell ? (
            <span>
              <span className="font-medium text-ink-primary">
                {monthName(hoveredCell.month ?? 0)} · {weekdayName(hoveredCell.weekday ?? 0)}
              </span>
              {" — "}
              {measure.label}:{" "}
              <span className="tabular font-medium text-ink-primary">
                {hoveredCell[measureKey] !== null ? measure.format(hoveredCell[measureKey] as number) : "—"}
              </span>
              <span className="mx-1.5">·</span>
              Releases: <span className="tabular">{fmtCompact(hoveredCell.n_releases)}</span>
            </span>
          ) : (
            <span className="text-ink-muted">Hover a cell for details</span>
          )}
        </div>
      </div>
      <div className="overflow-x-auto">
        <div className="inline-grid grid-cols-[40px_repeat(7,minmax(34px,1fr))] gap-[2px]" style={{ minWidth: 380 }}>
          <div />
          {weekdays.map((w) => (
            <div key={w} className="pb-1 text-center text-[10px] text-ink-muted">
              {weekdayName(w)}
            </div>
          ))}
          {months.map((mo) => (
            <Fragment key={mo}>
              <div className="flex items-center pr-1 text-[10px] text-ink-muted">{monthName(mo)}</div>
              {weekdays.map((w) => {
                const cell = grid.get(`${mo}-${w}`);
                const v = cell ? cell[measureKey] : null;
                const t = v !== null && v !== undefined && max > min ? (v - min) / (max - min) : 0;
                const color = v === null || v === undefined ? "var(--gridline)" : sequentialColorAt(t, theme);
                const isHovered = hovered?.month === mo && hovered?.weekday === w;
                return (
                  <button
                    type="button"
                    key={`${mo}-${w}`}
                    className="aspect-square rounded-[3px]"
                    style={{
                      backgroundColor: color,
                      outline: isHovered ? "2px solid var(--text-primary)" : "none",
                      outlineOffset: -1,
                    }}
                    onMouseEnter={() => setHovered({ month: mo, weekday: w })}
                    onFocus={() => setHovered({ month: mo, weekday: w })}
                    onMouseLeave={() => setHovered(null)}
                    aria-label={`${monthName(mo)} ${weekdayName(w)}: ${measure.label} ${
                      v !== null && v !== undefined ? measure.format(v) : "no data"
                    }`}
                  />
                );
              })}
            </Fragment>
          ))}
        </div>
      </div>
      <div className="mt-3 flex items-center gap-2 text-[10px] text-ink-muted">
        <span>Low</span>
        <span className="h-2 max-w-[160px] flex-1 rounded-full" style={{ background: legendGradient }} />
        <span>High</span>
      </div>
    </div>
  );
}

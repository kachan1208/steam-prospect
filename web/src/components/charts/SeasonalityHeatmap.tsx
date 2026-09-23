import { Fragment, useMemo, useState } from "react";

import type { SeasonalityCell } from "../../lib/api";
import { fmtCompact, fmtInt, fmtUsd, monthName, weekdayName } from "../../lib/format";
import { sequentialColorAt, sequentialScale } from "../../lib/palette";
import { useTheme } from "../../lib/theme";
import { InfoTip } from "../ui/InfoTip";
import { SentinelTag } from "../ui/SentinelTag";
import { TableScroll } from "../ui/TableScroll";

type Measure = "median_rev" | "n_releases";

const MEASURES: { key: Measure; label: string; format: (n: number) => string }[] = [
  { key: "median_rev", label: "Median revenue", format: fmtUsd },
  { key: "n_releases", label: "Releases", format: fmtCompact },
];

/** Columns Monday-first (the API's weekday is DuckDB's dayofweek: 0 = Sunday). */
const WEEKDAYS = [1, 2, 3, 4, 5, 6, 0];

/** Below this many games with 50+ reviews a cell's median is flagged — a median of a
 * handful of games is one or two games. */
export const HEATMAP_MIN_SCORED = 30;

/**
 * Release day × month heatmap. Explains itself (2026-09-23): the legend prints the VALUES at
 * its ends and middle — it read "Low → High", which cannot be read off — the measure has an
 * ⓘ with its formula, and a cell whose median rests on few games says so.
 */
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
  const mid = (min + max) / 2;
  const totalReleases = cells.reduce((s, c) => s + (c.n_releases ?? 0), 0);

  const months = Array.from({ length: 12 }, (_, i) => i + 1);
  const legendGradient = `linear-gradient(to right, ${sequentialScale(theme).join(",")})`;
  const hoveredCell = hovered ? grid.get(`${hovered.month}-${hovered.weekday}`) : undefined;
  const thin = (c: SeasonalityCell | undefined) => !!c && measureKey === "median_rev" && c.n_scored < HEATMAP_MIN_SCORED;

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1">
          {MEASURES.map((m) => (
            <button
              key={m.key}
              type="button"
              onClick={() => setMeasureKey(m.key)}
              aria-pressed={m.key === measureKey}
              className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                m.key === measureKey ? "bg-page text-ink-primary" : "text-ink-muted hover:text-ink-secondary"
              }`}
            >
              {m.label}
            </button>
          ))}
          {measureKey === "median_rev" ? (
            <InfoTip
              label="Median revenue by release day"
              meaning="The typical outcome of the games that SHIPPED on that weekday of that month — what past releases there earned, not a forecast for yours. A bright cell can simply be where bigger games choose to launch."
              formula="median Est. revenue (reviews × 30 × launch price) of the paid games released on that month × weekday that have 50+ reviews, pooled over recent years"
              worked={`${min > 0 ? fmtUsd(min) : "—"} (dimmest cell) to ${fmtUsd(max)} (brightest)`}
              notes={`A cell resting on fewer than ${HEATMAP_MIN_SCORED} games is flagged. Dates are first-public dates (an Early Access game counts at its EA launch); a date known only to the month is left out of the weekday grid.`}
            />
          ) : (
            <InfoTip
              label="Releases by release day"
              meaning="How many games launched on that weekday of that month — where the catalog piles up, i.e. how much company a launch there has."
              formula="count of games whose first public date falls on that month × weekday, pooled over recent years"
              worked={`${fmtInt(totalReleases)} releases in the grid, ${fmtCompact(min)} to ${fmtCompact(max)} per cell`}
            />
          )}
        </div>
        <div className="min-h-[18px] text-xs text-ink-secondary">
          {hoveredCell ? (
            <span className="flex flex-wrap items-center gap-x-1.5">
              <span className="font-medium text-ink-primary">
                {monthName(hoveredCell.month ?? 0)} · {weekdayName(hoveredCell.weekday ?? 0)}
              </span>
              <span>—</span>
              <span>
                {measure.label}:{" "}
                <span className="tabular font-medium text-ink-primary">
                  {hoveredCell[measureKey] !== null ? measure.format(hoveredCell[measureKey] as number) : "no data"}
                </span>
              </span>
              <span aria-hidden>·</span>
              <span>
                {fmtCompact(hoveredCell.n_releases)} releases, {fmtInt(hoveredCell.n_scored)} with 50+ reviews
              </span>
              {thin(hoveredCell) && <SentinelTag>small sample</SentinelTag>}
            </span>
          ) : (
            <span className="text-ink-muted">Hover or tab to a cell for its numbers</span>
          )}
        </div>
      </div>
      <TableScroll>
        <div className="inline-grid grid-cols-[40px_repeat(7,minmax(34px,1fr))] gap-[2px]" style={{ minWidth: 380 }}>
          <div />
          {WEEKDAYS.map((w) => (
            <div key={w} className="pb-1 text-center text-[10px] text-ink-muted">
              {weekdayName(w)}
            </div>
          ))}
          {months.map((mo) => (
            <Fragment key={mo}>
              <div className="flex items-center pr-1 text-[10px] text-ink-muted">{monthName(mo)}</div>
              {WEEKDAYS.map((w) => {
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
                      // A thin-sample median is shown, but visibly dashed — the owner's rule
                      // is that a flagged value is never passed off as a plain one.
                      border: thin(cell) ? "1px dashed var(--status-warning)" : undefined,
                    }}
                    onMouseEnter={() => setHovered({ month: mo, weekday: w })}
                    onFocus={() => setHovered({ month: mo, weekday: w })}
                    onMouseLeave={() => setHovered(null)}
                    aria-label={`${monthName(mo)} ${weekdayName(w)}: ${measure.label} ${
                      v !== null && v !== undefined ? measure.format(v) : "no data"
                    }${cell ? `, ${cell.n_scored} games with 50+ reviews` : ""}${thin(cell) ? " (small sample)" : ""}`}
                  />
                );
              })}
            </Fragment>
          ))}
        </div>
      </TableScroll>
      {/* The legend prints the scale's VALUES — "Low → High" could not be read off. */}
      <div className="mt-3 flex max-w-[380px] flex-col gap-1 text-[10px] text-ink-muted" data-testid="heatmap-legend">
        <span className="h-2 w-full rounded-full" style={{ background: legendGradient }} />
        <span className="tabular flex justify-between">
          <span>{measure.format(min)}</span>
          <span>{measure.format(mid)}</span>
          <span>{measure.format(max)}</span>
        </span>
        {measureKey === "median_rev" && (
          <span>
            Dashed outline = median of fewer than {HEATMAP_MIN_SCORED} games (small sample).
          </span>
        )}
      </div>
    </div>
  );
}

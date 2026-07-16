import { Fragment, useMemo, useState } from "react";

import type { PressCoverageRow } from "../../lib/api";
import { fmtInt, fmtPct, fmtUsd } from "../../lib/format";
import { sequentialColorAt, sequentialScale } from "../../lib/palette";
import { useTheme } from "../../lib/theme";

type Measure = "n_articles" | "median_est_rev" | "median_positive_ratio";

const MEASURES: { key: Measure; label: string; format: (n: number) => string }[] = [
  { key: "n_articles", label: "Articles", format: fmtInt },
  { key: "median_est_rev", label: "Median est. revenue", format: fmtUsd },
  { key: "median_positive_ratio", label: "Median positive rating", format: (n) => fmtPct(n, 0) },
];

// Fixed display order (roughly corpus size) + a short label for the narrow column header —
// the full name still appears in the hover detail line via sourceLabel-equivalent below.
const SOURCE_ORDER = ["eurogamer", "pcgamer", "ign", "gamesindustry", "gamedeveloper", "dou_gamedev"];
const SOURCE_LABEL: Record<string, string> = {
  eurogamer: "Eurogamer",
  pcgamer: "PC Gamer",
  gamesindustry: "GamesIndustry",
  ign: "IGN",
  gamedeveloper: "Game Developer",
  dou_gamedev: "DOU (Gamedev)",
};
function sourceLabel(s: string): string {
  return SOURCE_LABEL[s] ?? s;
}

/**
 * Outlet x genre coverage heatmap — same interaction shape as SeasonalityHeatmap
 * (measure toggle, hover-for-detail, sequential ramp) applied to a different pair of
 * categorical axes. Rows = genre (sorted by total coverage, most-covered first so the
 * signal clusters at the top), columns = outlet (fixed order, roughly corpus size).
 */
export function PressCoverageHeatmap({ rows }: { rows: PressCoverageRow[] }) {
  const { theme } = useTheme();
  const [measureKey, setMeasureKey] = useState<Measure>("n_articles");
  const [hovered, setHovered] = useState<{ source: string; genre: string } | null>(null);
  const measure = MEASURES.find((m) => m.key === measureKey) ?? MEASURES[0];

  const { grid, genres, sources } = useMemo(() => {
    const byCell = new Map<string, PressCoverageRow>();
    const totalByGenre = new Map<string, number>();
    const sourceSet = new Set<string>();
    for (const r of rows) {
      byCell.set(`${r.source}-${r.genre}`, r);
      totalByGenre.set(r.genre, (totalByGenre.get(r.genre) ?? 0) + r.n_articles);
      sourceSet.add(r.source);
    }
    const genreList = [...totalByGenre.keys()].sort((a, b) => (totalByGenre.get(b) ?? 0) - (totalByGenre.get(a) ?? 0));
    const sourceList = SOURCE_ORDER.filter((s) => sourceSet.has(s));
    return { grid: byCell, genres: genreList, sources: sourceList };
  }, [rows]);

  const values = rows.map((r) => r[measureKey]).filter((v): v is number => v !== null && Number.isFinite(v));
  const min = values.length ? Math.min(...values) : 0;
  const max = values.length ? Math.max(...values) : 1;
  const legendGradient = `linear-gradient(to right, ${sequentialScale(theme).join(",")})`;
  const hoveredCell = hovered ? grid.get(`${hovered.source}-${hovered.genre}`) : undefined;

  if (rows.length === 0) {
    return <div className="flex h-24 items-center justify-center text-xs text-ink-muted">No coverage data.</div>;
  }

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
                {sourceLabel(hoveredCell.source)} · {hoveredCell.genre}
              </span>
              {" — "}
              {measure.label}:{" "}
              <span className="tabular font-medium text-ink-primary">
                {hoveredCell[measureKey] !== null ? measure.format(hoveredCell[measureKey] as number) : "—"}
              </span>
              <span className="mx-1.5">·</span>
              {fmtInt(hoveredCell.n_articles)} articles · {fmtInt(hoveredCell.n_games_covered)} games covered
            </span>
          ) : (
            <span className="text-ink-muted">Hover a cell for details</span>
          )}
        </div>
      </div>
      <div className="overflow-x-auto">
        <div
          className="inline-grid gap-[2px]"
          style={{ gridTemplateColumns: `128px repeat(${sources.length}, minmax(72px,1fr))`, minWidth: 128 + sources.length * 72 }}
        >
          <div />
          {sources.map((s) => (
            <div key={s} className="flex items-end justify-center pb-1 text-center text-[10px] leading-tight text-ink-muted">
              {sourceLabel(s)}
            </div>
          ))}
          {genres.map((g) => (
            <Fragment key={g}>
              <div className="flex items-center truncate pr-2 text-[11px] text-ink-secondary" title={g}>
                {g}
              </div>
              {sources.map((s) => {
                const cell = grid.get(`${s}-${g}`);
                const v = cell ? cell[measureKey] : null;
                const t = v !== null && v !== undefined && max > min ? (v - min) / (max - min) : 0;
                const color = v === null || v === undefined ? "var(--gridline)" : sequentialColorAt(t, theme);
                const isHovered = hovered?.source === s && hovered?.genre === g;
                return (
                  <button
                    type="button"
                    key={`${s}-${g}`}
                    className="h-7 rounded-[3px] disabled:cursor-default"
                    disabled={!cell}
                    style={{
                      backgroundColor: color,
                      outline: isHovered ? "2px solid var(--text-primary)" : "none",
                      outlineOffset: -1,
                    }}
                    onMouseEnter={() => cell && setHovered({ source: s, genre: g })}
                    onFocus={() => cell && setHovered({ source: s, genre: g })}
                    onMouseLeave={() => setHovered(null)}
                    aria-label={`${sourceLabel(s)}, ${g}: ${measure.label} ${
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
        <span className="ml-3 inline-flex items-center gap-1">
          <span className="h-2 w-2 rounded-[2px]" style={{ backgroundColor: "var(--gridline)" }} />
          No confidence-filtered coverage
        </span>
      </div>
    </div>
  );
}

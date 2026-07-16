import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

import type { PressBySource } from "../../lib/api";
import { fmtInt } from "../../lib/format";
import { CSS_VAR } from "../../lib/palette";
import { TooltipPanel } from "./TooltipPanel";

// Scraper source codes -> display names (articles.source). Steam News is excluded
// upstream (mart_game_teardown.sql) — this list is journalist/trade-press outlets only.
const SOURCE_LABELS: Record<string, string> = {
  eurogamer: "Eurogamer",
  pcgamer: "PC Gamer",
  gamesindustry: "GamesIndustry.biz",
  ign: "IGN",
  gamedeveloper: "Game Developer",
  dou_gamedev: "DOU (Gamedev)",
};

export function sourceLabel(source: string): string {
  return SOURCE_LABELS[source] ?? source.charAt(0).toUpperCase() + source.slice(1);
}

/**
 * Press mentions by outlet — the same "magnitude compare across nominal categories,
 * single hue, sorted descending" shape as LanguageSplitChart / PriceByGenreChart.
 */
export function PressBySourceChart({ data, height }: { data: PressBySource[]; height?: number }) {
  if (data.length === 0) {
    return <div className="flex h-24 items-center justify-center text-xs text-ink-muted">No press coverage found.</div>;
  }
  const sorted = [...data].sort((a, b) => b.n_mentions - a.n_mentions);
  const h = height ?? Math.max(100, sorted.length * 28);
  return (
    <ResponsiveContainer width="100%" height={h}>
      <BarChart data={sorted} layout="vertical" margin={{ top: 4, right: 28, left: 8, bottom: 4 }}>
        <CartesianGrid stroke="var(--gridline)" horizontal={false} />
        <XAxis
          type="number"
          tick={{ fontSize: 10 }}
          tickFormatter={(v: number) => fmtInt(v)}
          tickLine={false}
          axisLine={{ stroke: "var(--baseline)" }}
          allowDecimals={false}
        />
        <YAxis
          type="category"
          dataKey="source"
          tickFormatter={(s: string) => sourceLabel(s)}
          tick={{ fontSize: 11 }}
          tickLine={false}
          axisLine={false}
          width={112}
        />
        <Tooltip
          cursor={{ fill: "var(--gridline)", opacity: 0.5 }}
          content={({ active, payload }) => {
            if (!active || !payload || payload.length === 0) return null;
            const p = payload[0].payload as PressBySource;
            return (
              <TooltipPanel
                title={sourceLabel(p.source)}
                rows={[{ label: "Mentions", value: fmtInt(p.n_mentions), color: CSS_VAR.competition }]}
              />
            );
          }}
        />
        <Bar dataKey="n_mentions" fill={CSS_VAR.competition} radius={[0, 4, 4, 0]} maxBarSize={18} />
      </BarChart>
    </ResponsiveContainer>
  );
}

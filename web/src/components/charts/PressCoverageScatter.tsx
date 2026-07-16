import { CartesianGrid, ResponsiveContainer, Scatter, ScatterChart, Tooltip, XAxis, YAxis, ZAxis } from "recharts";

import type { PressCoverageRow } from "../../lib/api";
import { fmtInt, fmtUsd } from "../../lib/format";
import { CSS_VAR } from "../../lib/palette";
import { TooltipPanel } from "./TooltipPanel";

/**
 * Coverage volume vs. covered-games' median outcome, one point per (outlet, genre) cell —
 * NOT a claim that press causes revenue (label it, in the caller's Card subtitle/caveat:
 * correlation != causation, selection bias runs the other way too — successful games
 * attract more coverage). Single hue (scatterPoint, same token BoxleiterFitChart uses for
 * its point layer) rather than coloring by outlet: the outlet identity is already the
 * heatmap's job above this chart; this chart's job is just the overall shape of the
 * relationship. Log scale on both axes: both measures are heavy-tailed (~2 orders of
 * magnitude between the thinnest and richest cells).
 */
export function PressCoverageScatter({ rows }: { rows: PressCoverageRow[] }) {
  const data = rows.filter((r) => r.median_est_rev !== null && r.median_est_rev > 0 && r.n_articles > 0);
  if (data.length === 0) {
    return <div className="flex h-40 items-center justify-center text-xs text-ink-muted">Not enough data to plot.</div>;
  }
  return (
    <ResponsiveContainer width="100%" height={280}>
      <ScatterChart margin={{ top: 8, right: 16, left: 4, bottom: 24 }}>
        <CartesianGrid stroke="var(--gridline)" />
        <XAxis
          type="number"
          dataKey="n_articles"
          name="Articles"
          scale="log"
          domain={["auto", "auto"]}
          tick={{ fontSize: 10 }}
          tickFormatter={(v: number) => fmtInt(v)}
          tickLine={false}
          axisLine={{ stroke: "var(--baseline)" }}
          label={{ value: "Articles (coverage volume, log scale)", position: "insideBottom", offset: -14, fontSize: 10, fill: "var(--text-muted)" }}
        />
        <YAxis
          type="number"
          dataKey="median_est_rev"
          name="Median est. revenue"
          scale="log"
          domain={["auto", "auto"]}
          tick={{ fontSize: 10 }}
          tickFormatter={(v: number) => fmtUsd(v)}
          tickLine={false}
          axisLine={false}
          width={54}
          // No rotated axis title here (unlike BoxleiterFitChart's "Owners"): that pattern
          // collides with these longer $-prefixed tick labels ("$300.0K" vs. a bare
          // "500K") when placed insideLeft. The Card title/subtitle + $-formatted ticks +
          // tooltip already say "revenue" without it.
        />
        <ZAxis range={[42, 42]} />
        <Tooltip
          cursor={{ strokeDasharray: "3 3", stroke: "var(--baseline)" }}
          content={({ active, payload }) => {
            if (!active || !payload || payload.length === 0) return null;
            const p = payload[0].payload as PressCoverageRow;
            return (
              <TooltipPanel
                title={`${p.source} · ${p.genre}`}
                rows={[
                  { label: "Articles", value: fmtInt(p.n_articles), color: CSS_VAR.scatterPoint },
                  { label: "Games covered", value: fmtInt(p.n_games_covered) },
                  { label: "Median est. revenue", value: fmtUsd(p.median_est_rev) },
                ]}
              />
            );
          }}
        />
        <Scatter data={data} fill={CSS_VAR.scatterPoint} fillOpacity={0.75} />
      </ScatterChart>
    </ResponsiveContainer>
  );
}

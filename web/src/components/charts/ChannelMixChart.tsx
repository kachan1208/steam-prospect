import { useMemo, useState } from "react";
import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

import type { ChannelMixRow } from "../../lib/api";
import { fmtInt, fmtPct } from "../../lib/format";
import { channelColor, channelLabel, channelSortOrder } from "../../lib/palette";
import { TooltipPanel } from "./TooltipPanel";

type Measure = "share_reach_weighted" | "share_mentions";

const MEASURES: { key: Measure; label: string }[] = [
  { key: "share_reach_weighted", label: "By reach" },
  { key: "share_mentions", label: "By mention count" },
];

/**
 * Channel-mix chart — "share of attention across a nominal category" (channel), the same
 * magnitude-compare shape as PressBySourceChart but colored by CHANNEL IDENTITY (fixed
 * categorical order, see lib/palette's channelColor) rather than a single hue, since here
 * the category itself — which channel — is the point of the chart, not just a ranked list
 * of one thing. Color follows the channel, never its rank: re-sorting by measure never
 * repaints a bar. A legend row names every channel (color is reinforcing, not the only
 * identity signal — the Y-axis category label already names it too).
 */
export function ChannelMixChart({ rows }: { rows: ChannelMixRow[] }) {
  const [measure, setMeasure] = useState<Measure>("share_reach_weighted");

  const data = useMemo(
    () =>
      [...rows]
        .filter((r) => r[measure] !== null)
        .sort((a, b) => (b[measure] ?? 0) - (a[measure] ?? 0)),
    [rows, measure],
  );

  if (rows.length === 0) {
    return (
      <div className="flex h-32 flex-col items-center justify-center gap-1 text-center text-xs text-ink-muted">
        <span>No channel data yet for this genre.</span>
        <span>Run the channel scrapers (or pick another genre) to populate this.</span>
      </div>
    );
  }

  const h = Math.max(100, data.length * 32);
  return (
    <div>
      <div className="mb-3 flex items-center gap-1">
        {MEASURES.map((m) => (
          <button
            key={m.key}
            type="button"
            onClick={() => setMeasure(m.key)}
            className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
              m.key === measure ? "bg-surface2 text-ink-primary" : "text-ink-muted hover:text-ink-secondary"
            }`}
          >
            {m.label}
          </button>
        ))}
      </div>
      <ResponsiveContainer width="100%" height={h}>
        <BarChart data={data} layout="vertical" margin={{ top: 4, right: 36, left: 8, bottom: 4 }}>
          <CartesianGrid stroke="var(--gridline)" horizontal={false} />
          <XAxis
            type="number"
            domain={[0, "dataMax"]}
            tick={{ fontSize: 10 }}
            tickFormatter={(v: number) => fmtPct(v, 0)}
            tickLine={false}
            axisLine={{ stroke: "var(--baseline)" }}
          />
          <YAxis
            type="category"
            dataKey="channel"
            tickFormatter={(c: string) => channelLabel(c)}
            tick={{ fontSize: 11 }}
            tickLine={false}
            axisLine={false}
            width={72}
          />
          <Tooltip
            cursor={{ fill: "var(--gridline)", opacity: 0.5 }}
            content={({ active, payload }) => {
              if (!active || !payload || payload.length === 0) return null;
              const p = payload[0].payload as ChannelMixRow;
              return (
                <TooltipPanel
                  title={channelLabel(p.channel)}
                  rows={[
                    { label: "Share (reach-weighted)", value: fmtPct(p.share_reach_weighted, 1), color: channelColor(p.channel) },
                    { label: "Share (mentions)", value: fmtPct(p.share_mentions, 1) },
                    { label: "Mentions", value: fmtInt(p.n_mentions) },
                  ]}
                />
              );
            }}
          />
          <Bar dataKey={measure} radius={[0, 4, 4, 0]} maxBarSize={20}>
            {data.map((r) => (
              <Cell key={r.channel} fill={channelColor(r.channel)} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[10px] text-ink-muted">
        {[...rows].sort((a, b) => channelSortOrder(a.channel) - channelSortOrder(b.channel)).map((r) => (
          <span key={r.channel} className="inline-flex items-center gap-1.5">
            <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: channelColor(r.channel) }} />
            {channelLabel(r.channel)}
          </span>
        ))}
      </div>
    </div>
  );
}

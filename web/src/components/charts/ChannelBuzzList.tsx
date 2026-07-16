import type { ChannelBuzzRow } from "../../lib/api";
import { fmtCompact, fmtInt, titleCase } from "../../lib/format";
import { channelColor, channelLabel, CSS_VAR } from "../../lib/palette";
import { ChannelBuzzSparkline } from "./ChannelBuzzSparkline";

/**
 * Ranked rising/cooling channel-buzz term list — same shape as BuzzTrendsList (arrow +
 * slope in neutral ink, sparkline colored by direction) plus a per-term channel-breakdown
 * row (small colored dots, fixed categorical channel order) showing which channel(s) are
 * actually driving the term, since that's the whole point of folding every channel into
 * one signal — see mart_channel_buzz.sql's reach-weighting caveat.
 */
export function ChannelBuzzList({ items }: { items: ChannelBuzzRow[] }) {
  if (items.length === 0) {
    return <div className="flex h-24 items-center justify-center text-xs text-ink-muted">No terms found.</div>;
  }
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
                {fmtCompact(it.total_weighted)} reach-weighted · {fmtInt(it.total_mentions)} mentions
              </div>
              <div className="mt-1 flex flex-wrap gap-1.5">
                {it.by_channel.slice(0, 5).map((cb) => (
                  <span key={cb.channel} className="inline-flex items-center gap-1 text-[10px] text-ink-secondary">
                    <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: channelColor(cb.channel) }} />
                    {channelLabel(cb.channel)}
                  </span>
                ))}
              </div>
            </div>
            <ChannelBuzzSparkline series={it.series} periods={periods} direction={it.direction} />
            <span className="tabular flex w-20 shrink-0 items-center justify-end gap-1.5 text-xs">
              <span aria-hidden="true" style={{ color }}>
                {arrow}
              </span>
              <span className="font-semibold text-ink-primary">
                {it.slope_weighted > 0 ? "+" : ""}
                {fmtCompact(it.slope_weighted)}
              </span>
            </span>
          </div>
        );
      })}
    </div>
  );
}

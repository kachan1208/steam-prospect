import { Bar, BarChart, CartesianGrid, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

import type { HistBucket, PercentilePoint } from "../../lib/api";
import { axisFormatter, axisScale, fmtInt, fmtPct, fmtPrice } from "../../lib/format";
import { CSS_VAR } from "../../lib/palette";
import { InfoTip } from "../ui/InfoTip";
import { TooltipPanel } from "./TooltipPanel";

/**
 * /timing's price distribution, on an axis whose spacing is honest (2026-09-23).
 *
 * It used to go through the generic Histogram, which draws the buckets the API sends as
 * evenly spaced CATEGORIES — right for the log-binned revenue histograms, wrong here: the
 * price histogram is linear $2.50 bins, and the API omits empty ones, so the axis ran
 * "$87.50 → $107.50 → $122.50 → … → $1,900" at equal spacing, drawing a $1,800 stretch as
 * wide as a $2.50 one. Here every bin from $0 to a cap is drawn — an empty bin is a zero
 * bar, not a missing category — so equal spacing IS equal dollars, and the handful of games
 * priced past the cap are counted in words instead of stretching the axis.
 */

export interface PriceBin {
  lo: number;
  hi: number;
  count: number;
  /** The category key (unique per bin) — the bin's lower edge. */
  key: string;
}

/** Where the drawn axis stops: $70 covers the $59.99 / $69.99 AAA price points, and a
 * pricier genre (99th percentile above $50) gets room past its own 99th percentile. */
export function priceCap(p99: number | null | undefined): number {
  const base = p99 != null && Number.isFinite(p99) ? Math.ceil(p99 / 10) * 10 + 20 : 70;
  return Math.max(70, base);
}

/** Every bin from $0 to `cap` (zeros filled in), plus the tail past it. */
export function priceBins(
  buckets: readonly HistBucket[],
  cap: number,
): { bins: PriceBin[]; width: number; tail: { count: number; maxPrice: number | null } } {
  const width =
    buckets.length > 0 && buckets[0].x_max > buckets[0].x_min ? buckets[0].x_max - buckets[0].x_min : 2.5;
  const byLo = new Map<number, number>();
  let tailCount = 0;
  let maxPrice: number | null = null;
  for (const b of buckets) {
    if (b.x_min >= cap) {
      tailCount += b.count;
      maxPrice = maxPrice === null ? b.x_min : Math.max(maxPrice, b.x_min);
    } else {
      const lo = Math.round(b.x_min / width) * width;
      byLo.set(lo, (byLo.get(lo) ?? 0) + b.count);
    }
  }
  const bins: PriceBin[] = [];
  for (let i = 0; i * width < cap - 1e-9; i++) {
    const lo = Number((i * width).toFixed(2));
    bins.push({ lo, hi: Number((lo + width).toFixed(2)), count: byLo.get(lo) ?? 0, key: String(lo) });
  }
  return { bins, width, tail: { count: tailCount, maxPrice } };
}

/** Plain words for the API's percentile keys — never "P10".."P99" on screen. */
export const PRICE_PERCENTILE_WORDS: Record<string, { label: string; side: "below" | "mid" | "above"; share: number }> = {
  p10: { label: "Cheapest 10%", side: "below", share: 0.1 },
  p25: { label: "Cheapest quarter", side: "below", share: 0.25 },
  p50: { label: "Median", side: "mid", share: 0.5 },
  p75: { label: "Dearest quarter", side: "above", share: 0.75 },
  p90: { label: "Dearest 10%", side: "above", share: 0.9 },
  p95: { label: "Dearest 5%", side: "above", share: 0.95 },
  p99: { label: "Dearest 1%", side: "above", share: 0.99 },
};

/** "Half of paid games cost $5.99 or less; only 1 in 10 costs $19.99 or more." */
export function priceTakeaway(percentiles: readonly PercentilePoint[]): string | null {
  const at = (k: string) => percentiles.find((p) => p.pctile.toLowerCase() === k)?.value;
  const p50 = at("p50");
  const p90 = at("p90");
  if (p50 == null || p90 == null) return null;
  return `Half of paid games cost ${fmtPrice(p50)} or less; only 1 in 10 costs ${fmtPrice(p90)} or more.`;
}

export function PriceDistributionChart({
  buckets,
  percentiles,
  n,
  marks = [],
  genreLabel,
  height = 240,
}: {
  buckets: HistBucket[];
  percentiles: PercentilePoint[];
  /** Paid games behind the histogram. */
  n: number;
  marks?: { label: string; value: number }[];
  /** "All genres" / "Strategy" — for the explanation. */
  genreLabel: string;
  height?: number;
}) {
  if (buckets.length === 0) {
    return (
      <div className="flex items-center justify-center text-xs text-ink-muted" style={{ height }}>
        No priced games in this slice.
      </div>
    );
  }
  const p99 = percentiles.find((p) => p.pctile.toLowerCase() === "p99")?.value;
  const cap = priceCap(p99);
  const { bins, width, tail } = priceBins(buckets, cap);
  const y = axisScale(Math.max(0, ...bins.map((b) => b.count)), "count");
  // Labels every $10 (every 4th $2.50 bin), in one vocabulary for the whole axis.
  const every = Math.max(1, Math.round(10 / width));
  const labelFormat = axisFormatter(
    bins.filter((_, i) => i % every === 0).map((b) => b.lo),
    "usd",
  );
  const keyFor = (value: number) => {
    const hit = bins.find((b) => value >= b.lo && value < b.hi);
    return hit ? hit.key : null;
  };
  const median = percentiles.find((p) => p.pctile.toLowerCase() === "p50")?.value;
  const lines = [
    ...(median != null ? [{ label: `median ${fmtPrice(median)}`, value: median }] : []),
    ...marks,
  ]
    .map((m) => ({ ...m, key: keyFor(m.value) }))
    .filter((m): m is { label: string; value: number; key: string } => m.key !== null);

  return (
    <div>
      <ResponsiveContainer width="100%" height={height}>
        <BarChart data={bins} margin={{ top: 30, right: 12, left: 4, bottom: 4 }} barCategoryGap={1}>
          <CartesianGrid stroke="var(--gridline)" vertical={false} />
          <XAxis
            dataKey="key"
            tick={{ fontSize: 10 }}
            interval={every - 1}
            tickFormatter={(k: string) => labelFormat(Number(k))}
            tickLine={false}
            axisLine={{ stroke: "var(--baseline)" }}
          />
          <YAxis
            tick={{ fontSize: 10 }}
            ticks={y.ticks}
            interval={0}
            domain={y.domain}
            tickFormatter={(v: number) => y.format(v)}
            tickLine={false}
            axisLine={false}
            width={40}
            allowDecimals={false}
          />
          <Tooltip
            cursor={{ fill: "var(--gridline)", opacity: 0.5 }}
            content={({ active, payload }) => {
              if (!active || !payload || payload.length === 0) return null;
              const b = payload[0].payload as PriceBin;
              return (
                <TooltipPanel
                  title={`${fmtPrice(b.lo === 0 ? 0.01 : b.lo)} to under ${fmtPrice(b.hi)}`}
                  rows={[
                    { label: "Games", value: fmtInt(b.count), color: CSS_VAR.demand },
                    { label: "Share of paid games", value: fmtPct(n > 0 ? b.count / n : null) },
                  ]}
                />
              );
            }}
          />
          <Bar dataKey="count" fill={CSS_VAR.demand} radius={[2, 2, 0, 0]} />
          {lines.map((m, i) => (
            <ReferenceLine
              key={m.label}
              x={m.key}
              stroke="var(--text-muted)"
              strokeDasharray="3 4"
              label={{
                value: m.label,
                position: "top",
                fill: "var(--text-secondary)",
                fontSize: 10,
                dy: (i % 2) * 12 - 12,
              }}
            />
          ))}
        </BarChart>
      </ResponsiveContainer>
      <p className="mt-1 text-[11px] text-ink-muted">
        Each bar is a {fmtPrice(width)} band of list price, drawn to scale from $0 to {fmtPrice(cap)}.
        {tail.count > 0 && (
          <>
            {" "}
            Not drawn: {fmtInt(tail.count)} game{tail.count === 1 ? "" : "s"} priced {fmtPrice(cap)} or more (
            {fmtPct(n > 0 ? tail.count / n : null)}), the dearest at about ${fmtInt(tail.maxPrice)}.
          </>
        )}{" "}
        Genre: {genreLabel}.
      </p>
    </div>
  );
}

/** The percentile strip, in plain words: "Cheapest 10%: $1.99 or less" … never "P10". */
export function PricePercentiles({ percentiles, n }: { percentiles: PercentilePoint[]; n: number }) {
  const rows = percentiles
    .map((p) => ({ p, words: PRICE_PERCENTILE_WORDS[p.pctile.toLowerCase()] }))
    .filter((r) => r.words);
  if (rows.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
      {rows.map(({ p, words }) => (
        <span key={p.pctile} className="text-ink-secondary">
          <span className="text-ink-muted">{words.label}:</span>{" "}
          <span className="tabular font-medium text-ink-primary">{fmtPrice(p.value)}</span>
          {words.side === "below" ? " or less" : words.side === "above" ? " or more" : ""}
        </span>
      ))}
      <InfoTip
        label="Price percentiles"
        meaning="Where paid games' list prices fall: the cheapest 10% charge this much or less, the median game this, the dearest 10% this much or more. List price, not what buyers paid after discounts."
        formula="each figure = the list price at that rank of all paid games in the slice, interpolated between the two nearest games (the 10th, 25th, 50th, 75th, 90th, 95th and 99th percentiles)"
        worked={`over ${fmtInt(n)} paid games with at least one review`}
        notes="Free games are left out (they have no list price to rank); so are games whose price is unknown."
      />
    </div>
  );
}

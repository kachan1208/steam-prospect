import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  ReferenceArea,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import type { TrendPoint } from "../../lib/api";
import { axisScale, fmtCompact, fmtInt, fmtUsd, monthName } from "../../lib/format";
import { CSS_VAR } from "../../lib/palette";
import { useDragZoom } from "../../lib/useDragZoom";
import { SELECTION_AREA_PROPS, ZoomFrame } from "./ZoomFrame";
import { TooltipPanel } from "./TooltipPanel";

/**
 * RELEASES AND TOP-10% REVENUE, BY YEAR — two aligned small multiples (2026-09-23).
 *
 * This replaced the niche page's dual-axis "Demand vs. pipeline, by year" chart, which drew
 * dollars and release counts on two different scales in one frame and then needed a caption
 * apologising that "where the lines cross means nothing". Two panels, one unit each, stacked
 * on the SAME year axis (identical margins and axis widths, so a year sits at the same x in
 * both) — and each opens with a one-line takeaway computed from the data, so the chart says
 * what it shows instead of leaving the reader to eyeball two slopes.
 *
 * THE PARTIAL YEAR. A yearly series ends on a still-running year for most of the calendar,
 * and that year's bar holds a few months of releases beside twelve-month neighbours. It is
 * marked in both panels (a "partial" rule, a faded bar, "· partial" in the tooltip) and the
 * takeaway describes it CONDITIONALLY: "so far — already above last year" when it is, and
 * "the rest of the year is still to come" only when it is below. The old copy called every
 * partial year a "drop", which Roguelike Deckbuilder's rising 2026 made plainly false.
 */

/** The year in a yearly series that is still being filled in (the data's own year), or null
 * when the series stops before it. */
export function partialTrendYear(points: { year: number }[], asOf: Date = new Date()): number | null {
  const current = asOf.getUTCFullYear();
  return points.some((p) => p.year === current) ? current : null;
}

type Direction = "rising" | "falling" | "flat";

function direction(change: number): Direction {
  if (Math.abs(change) < 0.05) return "flat";
  return change > 0 ? "rising" : "falling";
}

function fmtChange(change: number): string {
  const pct = Math.abs(change * 100).toFixed(0);
  if (Number(pct) === 0) return "±0%";
  return `${change > 0 ? "+" : "−"}${pct}%`;
}

/** "to Sep 21" — how far into the partial year the data runs. */
function partialThrough(asOf: Date): string {
  return `to ${monthName(asOf.getUTCMonth() + 1)} ${asOf.getUTCDate()}`;
}

export interface TrendTakeaways {
  releases: string | null;
  revenue: string | null;
  /** The partial-year sentence, conditional on its direction; null without a partial year. */
  partial: string | null;
  partialYear: number | null;
  revenueLabel: string;
}

/**
 * The one-line takeaways — pure, so every branch is testable. Compares the last two FULL
 * years (the partial year is described on its own), and says which way the partial year is
 * heading only as far as the data allows.
 */
export function trendTakeaways(points: TrendPoint[], asOf: Date = new Date()): TrendTakeaways {
  const hasP90 = points.some((p) => p.p90_rev != null);
  const revenueLabel = hasP90 ? "Top-10% revenue" : "Median revenue";
  const rev = (p: TrendPoint) => (hasP90 ? (p.p90_rev ?? null) : p.median_rev);
  const partialYear = partialTrendYear(points, asOf);
  const full = [...points].filter((p) => p.year !== partialYear).sort((a, b) => a.year - b.year);
  const [prev, last] = full.slice(-2);

  let releases: string | null = null;
  if (prev && last && prev.n_releases > 0) {
    const change = (last.n_releases - prev.n_releases) / prev.n_releases;
    const dir = direction(change);
    releases =
      dir === "flat"
        ? `Releases held steady: ${fmtInt(last.n_releases)} in ${last.year} vs ${fmtInt(prev.n_releases)} in ${prev.year} (${fmtChange(change)}).`
        : `Releases are ${dir}: ${fmtInt(last.n_releases)} in ${last.year} vs ${fmtInt(prev.n_releases)} in ${prev.year} (${fmtChange(change)}).`;
  }

  let revenue: string | null = null;
  const rLast = last ? rev(last) : null;
  const rPrev = prev ? rev(prev) : null;
  if (last && prev && rLast != null && rPrev != null && rPrev > 0) {
    const change = (rLast - rPrev) / rPrev;
    const dir = direction(change);
    const verb = dir === "flat" ? "held steady" : dir === "rising" ? "rose" : "fell";
    // Bearish caveat first-class: revenue here is LIFETIME revenue by RELEASE year, so the
    // newest cohorts have had the least time to earn — a fall there is partly just age.
    revenue = `${revenueLabel} of each year's releases ${verb}: ${fmtUsd(rLast)} for ${last.year} vs ${fmtUsd(rPrev)} for ${prev.year} (${fmtChange(change)}). Newer games have had less time to earn, so recent years read low.`;
  }

  let partial: string | null = null;
  const p = partialYear != null ? points.find((x) => x.year === partialYear) : undefined;
  if (p && partialYear != null) {
    const through = partialThrough(asOf);
    if (last && p.n_releases >= last.n_releases) {
      partial = `${partialYear} is a partial year (${through}), and its ${fmtInt(p.n_releases)} releases already exceed ${last.year}'s ${fmtInt(last.n_releases)} — the pipeline is still growing.`;
    } else if (last) {
      partial = `${partialYear} is a partial year (${through}): ${fmtInt(p.n_releases)} releases so far against ${last.year}'s ${fmtInt(last.n_releases)} — the rest of the year is still to come, so its lower bar is not a drop.`;
    } else {
      partial = `${partialYear} is a partial year (${through}).`;
    }
  }
  return { releases, revenue, partial, partialYear, revenueLabel };
}

// Identical geometry in both panels, so a year sits at the same x in each.
const MARGIN = { top: 6, right: 8, left: 0, bottom: 0 } as const;
const Y_AXIS_W = 52;

export function SaturationTrend({ points, asOf }: { points: TrendPoint[]; asOf?: Date | null }) {
  // One hook for both panels: they plot the same years, so a range dragged on either must
  // move the other — two independent zooms on a shared axis would be a lie.
  const zoom = useDragZoom(points, "year");
  if (points.length === 0) {
    return (
      <div className="flex h-32 items-center justify-center text-xs text-ink-muted">No yearly trend for this niche.</div>
    );
  }
  const at = asOf ?? new Date();
  const t = trendTakeaways(points, at);
  const hasP90 = points.some((p) => p.p90_rev != null);
  const revKey = hasP90 ? "p90_rev" : "median_rev";
  // Each small multiple gets its own single-unit axis (lib/format.ts axisScale).
  const releasesAxis = axisScale(Math.max(0, ...points.map((p) => p.n_releases ?? 0)), "count", 4);
  const revAxis = axisScale(
    Math.max(0, ...points.map((p) => (typeof p[revKey] === "number" ? (p[revKey] as number) : 0))),
    "usd",
    4,
  );
  const partialTitle = (year: number | string) =>
    `${year}${t.partialYear !== null && Number(year) === t.partialYear ? ` · partial year (${partialThrough(at)})` : ""}`;
  const partialRule =
    t.partialYear !== null ? (
      <ReferenceLine
        x={t.partialYear}
        stroke="var(--text-muted)"
        strokeDasharray="2 3"
        label={{ value: "partial", position: "insideTopRight", fontSize: 9, fill: "var(--text-muted)" }}
      />
    ) : null;

  return (
    <div className="flex flex-col gap-4" data-testid="yearly-trend">
      <section aria-label="Releases per year">
        <div className="mb-1 flex items-baseline gap-2">
          <span className="kicker text-[11px] text-ink-primary">Releases per year</span>
          <span className="text-[11px] text-ink-muted">every game in the niche, any review count</span>
        </div>
        {t.releases && (
          <p className="mb-1.5 text-[12px] text-ink-secondary" data-testid="takeaway-releases">
            {t.releases}
          </p>
        )}
        <ZoomFrame zoomed={zoom.zoomed} dragging={zoom.dragging} outOfRange={zoom.outOfRange} onReset={zoom.reset}>
          <ResponsiveContainer width="100%" height={130}>
            <BarChart data={zoom.data} margin={MARGIN} {...zoom.handlers}>
              <CartesianGrid stroke="var(--gridline)" vertical={false} />
              <XAxis dataKey="year" tick={{ fontSize: 10 }} tickLine={false} axisLine={{ stroke: "var(--baseline)" }} />
              <YAxis
                tick={{ fontSize: 10 }}
                ticks={releasesAxis.ticks}
                interval={0}
                domain={releasesAxis.domain}
                tickFormatter={(v: number) => releasesAxis.format(v)}
                tickLine={false}
                axisLine={false}
                width={Y_AXIS_W}
                allowDecimals={false}
              />
              <Tooltip
                cursor={{ fill: "var(--gridline)", opacity: 0.5 }}
                content={({ active, payload, label }) => {
                  if (!active || !payload || payload.length === 0) return null;
                  const p = payload[0].payload as TrendPoint;
                  return (
                    <TooltipPanel
                      title={partialTitle(label as number)}
                      rows={[
                        { label: "Releases", value: fmtCompact(p.n_releases), color: CSS_VAR.competition },
                        { label: "With 50+ reviews (scored)", value: fmtCompact(p.n_scored) },
                      ]}
                    />
                  );
                }}
              />
              <Bar dataKey="n_releases" radius={[4, 4, 0, 0]} maxBarSize={20} isAnimationActive={false}>
                {zoom.data.map((p) => (
                  <Cell
                    key={p.year}
                    fill={CSS_VAR.competition}
                    // The partial year's bar is a few months of data: drawn faded, not full.
                    fillOpacity={p.year === t.partialYear ? 0.45 : 1}
                  />
                ))}
              </Bar>
              {partialRule}
              {zoom.selection && <ReferenceArea x1={zoom.selection.x1} x2={zoom.selection.x2} {...SELECTION_AREA_PROPS} />}
            </BarChart>
          </ResponsiveContainer>
        </ZoomFrame>
      </section>

      <section aria-label={`${t.revenueLabel} by release year`}>
        <div className="mb-1 flex items-baseline gap-2">
          <span className="kicker text-[11px] text-ink-primary">{t.revenueLabel}, by release year</span>
          <span className="text-[11px] text-ink-muted">lifetime Est. revenue of that year&rsquo;s games with 50+ reviews</span>
        </div>
        {t.revenue && (
          <p className="mb-1.5 text-[12px] text-ink-secondary" data-testid="takeaway-revenue">
            {t.revenue}
          </p>
        )}
        <ZoomFrame zoomed={zoom.zoomed} dragging={zoom.dragging} outOfRange={zoom.outOfRange} onReset={zoom.reset}>
          <ResponsiveContainer width="100%" height={130}>
            <LineChart data={zoom.data} margin={MARGIN} {...zoom.handlers}>
              <CartesianGrid stroke="var(--gridline)" vertical={false} />
              <XAxis dataKey="year" tick={{ fontSize: 10 }} tickLine={false} axisLine={{ stroke: "var(--baseline)" }} />
              <YAxis
                tick={{ fontSize: 10 }}
                ticks={revAxis.ticks}
                interval={0}
                domain={revAxis.domain}
                tickFormatter={(v: number) => revAxis.format(v)}
                tickLine={false}
                axisLine={false}
                width={Y_AXIS_W}
              />
              <Tooltip
                cursor={{ stroke: "var(--baseline)" }}
                content={({ active, payload, label }) => {
                  if (!active || !payload || payload.length === 0) return null;
                  const p = payload[0].payload as TrendPoint;
                  return (
                    <TooltipPanel
                      title={partialTitle(label as number)}
                      rows={
                        hasP90
                          ? [
                              { label: "Top-10% revenue", value: fmtUsd(p.p90_rev ?? null), color: CSS_VAR.demand },
                              { label: "Median revenue", value: fmtUsd(p.median_rev) },
                            ]
                          : [{ label: "Median revenue", value: fmtUsd(p.median_rev), color: CSS_VAR.demand }]
                      }
                    />
                  );
                }}
              />
              <Line
                type="linear"
                dataKey={revKey}
                stroke={CSS_VAR.demand}
                strokeWidth={1.5}
                dot={{ r: 3, fill: CSS_VAR.demand, strokeWidth: 0 }}
                connectNulls
                isAnimationActive={false}
              />
              {partialRule}
              {zoom.selection && <ReferenceArea x1={zoom.selection.x1} x2={zoom.selection.x2} {...SELECTION_AREA_PROPS} />}
            </LineChart>
          </ResponsiveContainer>
        </ZoomFrame>
      </section>

      {t.partial && (
        <p className="text-[11px] text-ink-muted" data-testid="takeaway-partial">
          {t.partial}
        </p>
      )}
    </div>
  );
}

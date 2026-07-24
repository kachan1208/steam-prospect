import { useState } from "react";
import { useQueries } from "@tanstack/react-query";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import clsx from "clsx";

import { LaunchShapeBars } from "../components/charts/LaunchShapeBars";
import { Histogram } from "../components/charts/Histogram";
import { SeasonalityHeatmap } from "../components/charts/SeasonalityHeatmap";
import { TooltipPanel } from "../components/charts/TooltipPanel";
import { Card } from "../components/ui/Card";
import { launchCurveQueryOptions, useGenres, useMarketDistribution, useSeasonality, type SeasonalityCell } from "../lib/api";
import { fmtUsd, weekdayName } from "../lib/format";
import { CSS_VAR } from "../lib/palette";

const DEFAULT_CURVE_GENRES = ["__all__", "Indie", "Action", "Adventure", "Casual", "Simulation", "Strategy", "RPG"];

function WeekdayBar({ cells }: { cells: SeasonalityCell[] }) {
  const data = [...cells]
    .filter((c) => c.weekday !== null)
    .sort((a, b) => (a.weekday ?? 0) - (b.weekday ?? 0))
    .map((c) => ({ ...c, label: weekdayName(c.weekday ?? 0) }));
  return (
    <ResponsiveContainer width="100%" height={160}>
      <BarChart data={data} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
        <CartesianGrid stroke="var(--gridline)" vertical={false} />
        <XAxis dataKey="label" tick={{ fontSize: 10 }} tickLine={false} axisLine={{ stroke: "var(--baseline)" }} />
        <YAxis
          tick={{ fontSize: 10 }}
          tickFormatter={(v: number) => fmtUsd(v)}
          tickLine={false}
          axisLine={false}
          width={44}
        />
        <Tooltip
          cursor={{ fill: "var(--gridline)", opacity: 0.5 }}
          content={({ active, payload }) => {
            if (!active || !payload || payload.length === 0) return null;
            const p = payload[0].payload as SeasonalityCell;
            return (
              <TooltipPanel
                title={weekdayName(p.weekday ?? 0)}
                rows={[
                  { label: "Median revenue", value: fmtUsd(p.median_rev), color: CSS_VAR.demand },
                  { label: "Releases", value: p.n_releases.toLocaleString() },
                ]}
              />
            );
          }}
        />
        <Bar dataKey="median_rev" fill={CSS_VAR.demand} radius={[4, 4, 0, 0]} maxBarSize={28} />
      </BarChart>
    </ResponsiveContainer>
  );
}

export default function LaunchTiming() {
  const genres = useGenres();
  const [curveGenres, setCurveGenres] = useState<string[]>(DEFAULT_CURVE_GENRES);
  const [seasonGenre, setSeasonGenre] = useState("__all__");

  const curveResults = useQueries({
    queries: curveGenres.map((g) => launchCurveQueryOptions(g)),
  });

  const { data: seasonality, isLoading: seasonalityLoading } = useSeasonality(seasonGenre);

  const [priceGenre, setPriceGenre] = useState("__all__");
  const { data: priceDist, isLoading: priceLoading } = useMarketDistribution("price", priceGenre, "all");

  function toggleGenre(g: string) {
    setCurveGenres((prev) => (prev.includes(g) ? prev.filter((x) => x !== g) : [...prev, g]));
  }

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-lg font-semibold text-ink-primary">Launch &amp; Timing</h1>
        <p className="mt-0.5 text-sm text-ink-muted">
          How first-year revenue accumulates after launch, when to launch, and what the market pays.
        </p>
      </div>

      <Card
        title="Launch shape by genre — when first-year reviews land"
        subtitle="Share of first-year reviews earned in each window after launch — tall left = front-loaded (bet on the splash); flat = slow-burn (sustained marketing pays)"
      >
        <div className="mb-3 flex flex-wrap gap-1.5">
          {genres.map((g) => (
            <button
              key={g.value}
              type="button"
              onClick={() => toggleGenre(g.value)}
              className={clsx(
                "rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors",
                curveGenres.includes(g.value)
                  ? "border-series-1 bg-page text-ink-primary"
                  : "border-chartborder text-ink-muted hover:text-ink-secondary",
              )}
            >
              {g.label}
            </button>
          ))}
        </div>
        <p className="mb-3 text-[11px] text-ink-muted">
          Bars show the median share of a genre&apos;s first-year reviews landing in each window after launch.
        </p>
        {curveGenres.length === 0 && <div className="text-xs text-ink-muted">Pick at least one genre above.</div>}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4" data-tour="tour-timing-launch-shape">
          {curveGenres.map((g, i) => {
            const result = curveResults[i];
            const label = genres.find((opt) => opt.value === g)?.label ?? g;
            return (
              <div key={g} className="rounded-card border border-chartborder p-3">
                <div className="mb-1 flex items-center justify-between">
                  <span className="text-xs font-semibold text-ink-primary">{label}</span>
                  {result?.data && <span className="text-[10px] text-ink-muted">{result.data.points[0]?.n_games ?? 0} games</span>}
                </div>
                {result?.isLoading && <div className="flex h-32 items-center justify-center text-xs text-ink-muted">…</div>}
                {result?.data && <LaunchShapeBars points={result.data.points} height={140} />}
              </div>
            );
          })}
        </div>
      </Card>

      <Card
        title="Seasonality — month × weekday"
        subtitle={seasonality ? `${seasonGenre === "__all__" ? "All genres" : seasonGenre}` : undefined}
        action={
          <select
            value={seasonGenre}
            onChange={(e) => setSeasonGenre(e.target.value)}
            className="rounded-md border border-chartborder bg-page px-2 py-1.5 text-xs text-ink-primary outline-none focus:border-series-1"
          >
            {genres.map((g) => (
              <option key={g.value} value={g.value}>
                {g.label}
              </option>
            ))}
          </select>
        }
      >
        {seasonalityLoading && !seasonality && <div className="flex h-40 items-center justify-center text-xs text-ink-muted">Loading…</div>}
        {seasonality && <SeasonalityHeatmap cells={seasonality.month_weekday} />}
        {seasonality && seasonality.weekday.length > 0 && (
          <div className="mt-4 border-t border-chartborder pt-3">
            <div className="mb-1 text-xs text-ink-muted">Median revenue by launch weekday</div>
            <WeekdayBar cells={seasonality.weekday} />
          </div>
        )}
      </Card>

      <Card
        title="Price distribution"
        subtitle={priceDist ? `${priceDist.n.toLocaleString()} paid games · $2.50 bins` : "What paid games actually charge"}
        action={
          <select
            value={priceGenre}
            onChange={(e) => setPriceGenre(e.target.value)}
            className="rounded-md border border-chartborder bg-page px-2 py-1.5 text-xs text-ink-primary outline-none focus:border-series-1"
          >
            {genres.map((g) => (
              <option key={g.value} value={g.value}>
                {g.label}
              </option>
            ))}
          </select>
        }
      >
        {priceLoading && !priceDist && <div className="flex h-40 items-center justify-center text-xs text-ink-muted">Loading…</div>}
        {priceDist && (
          <>
            <Histogram
              buckets={priceDist.buckets}
              color={CSS_VAR.demand}
              formatX={fmtUsd}
              marks={priceDist.benchmark_marks.map((m) => ({ label: m.label, value: m.value }))}
            />
            <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 border-t border-chartborder pt-3 text-xs">
              {priceDist.percentiles.map((p) => (
                <span key={p.pctile} className="text-ink-secondary">
                  <span className="text-ink-muted">{p.pctile.toUpperCase()}</span>{" "}
                  <span className="tabular font-medium text-ink-primary">{fmtUsd(p.value)}</span>
                </span>
              ))}
            </div>
          </>
        )}
      </Card>
    </div>
  );
}

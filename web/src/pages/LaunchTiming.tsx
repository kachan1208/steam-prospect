import { useState } from "react";
import { useQueries } from "@tanstack/react-query";
import clsx from "clsx";

import { LaunchShapeBars } from "../components/charts/LaunchShapeBars";
import { Histogram } from "../components/charts/Histogram";
import { TimingBars } from "../components/charts/TimingBars";
import { Card } from "../components/ui/Card";
import { EmptyState } from "../components/ui/EmptyState";
import {
  ApiError,
  launchCurveQueryOptions,
  useGenres,
  useMarketDistribution,
  useTimingOverview,
  type TimingOverview,
} from "../lib/api";
import { fmtPct, fmtUsd, monthName } from "../lib/format";
import { CSS_VAR } from "../lib/palette";

const DEFAULT_CURVE_GENRES = ["__all__", "Indie", "Action", "Adventure", "Casual", "Simulation", "Strategy", "RPG"];

/** Shared loading / refreshing / no-data handling for the timing sections. */
function TimingStatus({ isLoading, error }: { isLoading: boolean; error: unknown }) {
  if (isLoading) return <div className="flex h-40 items-center justify-center text-xs text-ink-muted">Loading…</div>;
  if (error instanceof ApiError && error.status === 503) {
    return (
      <EmptyState
        title="Timing data is refreshing"
        description="The launch-timing marts haven't been built yet — they appear after the next nightly ETL run."
      />
    );
  }
  if (error instanceof ApiError && error.status === 404) {
    return (
      <EmptyState
        title="Not enough data for this genre"
        description="This genre is below the per-genre sample floors. Try All genres, or a larger genre."
      />
    );
  }
  if (error) return <EmptyState title="Couldn't load timing data" description={String(error)} />;
  return null;
}

function GenreSelect({
  genres,
  value,
  onChange,
}: {
  genres: { value: string; label: string }[];
  value: string;
  onChange: (g: string) => void;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="rounded-md border border-chartborder bg-page px-2 py-1.5 text-xs text-ink-primary outline-none focus:border-series-1"
    >
      {genres.map((g) => (
        <option key={g.value} value={g.value}>
          {g.label}
        </option>
      ))}
    </select>
  );
}

function RecommendationCard({ overview }: { overview: TimingOverview }) {
  const rec = overview.window_recommendation;
  if (!rec) {
    return (
      <p className="text-xs text-ink-muted">
        No window recommendation for this genre — it needs complete demand and congestion series (12 months of each).
      </p>
    );
  }
  const best = new Set(rec.best_months);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-1.5">
        {rec.best_month_names.map((m) => (
          <span
            key={m}
            className="rounded-full border border-series-1 bg-page px-2.5 py-1 text-xs font-semibold text-ink-primary"
          >
            {m}
          </span>
        ))}
      </div>
      <p className="max-w-3xl text-sm leading-relaxed text-ink-secondary">{rec.rationale}</p>
      <div>
        <div className="mb-1 text-[11px] text-ink-muted">
          Window score by month — demand vs. crowding, recommended months highlighted
        </div>
        <TimingBars
          data={rec.months.map((w) => ({
            label: w.month_name,
            value: w.score,
            highlighted: best.has(w.month),
          }))}
          height={150}
          valueLabel="Score (demand − congestion)"
          formatValue={(v) => v.toFixed(2)}
          referenceY={0}
          dimUnhighlighted
        />
      </div>
      <p className="text-[11px] text-ink-muted">{rec.method}.</p>
    </div>
  );
}

export default function LaunchTiming() {
  const genres = useGenres();
  const [timingGenre, setTimingGenre] = useState("__all__");
  const { data: overview, isLoading: timingLoading, error: timingError } = useTimingOverview(timingGenre);

  const [curveGenres, setCurveGenres] = useState<string[]>(DEFAULT_CURVE_GENRES);
  const curveResults = useQueries({
    queries: curveGenres.map((g) => launchCurveQueryOptions(g)),
  });

  const [priceGenre, setPriceGenre] = useState("__all__");
  const { data: priceDist, isLoading: priceLoading } = useMarketDistribution("price", priceGenre, "all");

  function toggleGenre(g: string) {
    setCurveGenres((prev) => (prev.includes(g) ? prev.filter((x) => x !== g) : [...prev, g]));
  }

  const timingStatus = <TimingStatus isLoading={timingLoading && !overview} error={overview ? null : timingError} />;
  const genreLabel = timingGenre === "__all__" ? "All genres" : timingGenre;
  const bestMonths = new Set(overview?.window_recommendation?.best_months ?? []);
  const decaySummary = overview?.decay_summary;

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-lg font-semibold text-ink-primary">Launch &amp; Timing</h1>
        <p className="mt-0.5 text-sm text-ink-muted">
          When players in a genre actually buy, how crowded each launch window is, and how long a launch pays out —
          from true monthly review counts (~40K games), not launch-month medians.
        </p>
      </div>

      <Card
        title={`Best launch windows — ${genreLabel}`}
        subtitle="Months where player buying outruns release crowding. Transparent score, components charted below."
        action={<GenreSelect genres={genres} value={timingGenre} onChange={setTimingGenre} />}
      >
        {overview ? <RecommendationCard overview={overview} /> : timingStatus}
      </Card>

      <Card
        title="When players buy"
        subtitle={`Share of ${genreLabel === "All genres" ? "the catalog's" : `${genreLabel}'s`} monthly review volume landing in each calendar month — pooled over the last 5 complete years, each game's first 2 months excluded so launch spikes don't read as seasonal demand`}
      >
        {overview ? (
          <>
            <TimingBars
              data={overview.demand.map((d) => ({
                label: monthName(d.month),
                value: d.demand_share === null ? null : d.demand_share * 100,
                highlighted: bestMonths.has(d.month),
              }))}
              height={190}
              valueLabel="Share of yearly buying"
              formatValue={(v) => `${v.toFixed(1)}%`}
              referenceY={100 / 12}
            />
            <p className="mt-2 text-[11px] text-ink-muted">
              Dashed line = an average month (8.3%).{" "}
              {overview.demand[0] ? `${overview.demand[0].n_games.toLocaleString()}+ games contributing per month.` : ""}{" "}
              Reviews proxy sales (Boxleiter) — this is review-writing velocity, uncapped Steam totals.
            </p>
          </>
        ) : (
          timingStatus
        )}
      </Card>

      <Card
        title="How crowded each window is"
        subtitle="Average releases landing in each calendar month over the last 3 complete years — with $200K+ releases on the right axis (the competition that actually takes shelf space)"
      >
        {overview ? (
          overview.congestion.length > 0 ? (
            <>
              <TimingBars
                data={overview.congestion.map((c) => ({
                  label: monthName(c.month),
                  value: c.avg_releases,
                  secondary: c.avg_big_releases,
                }))}
                height={190}
                valueLabel="Releases / yr"
                secondaryLabel="$200K+ releases / yr"
                formatValue={(v) => v.toFixed(0)}
                formatSecondary={(v) => v.toFixed(0)}
                color={CSS_VAR.competition}
                secondaryColor={CSS_VAR.qualityGap}
              />
              <p className="mt-2 text-[11px] text-ink-muted">
                Genre-wide congestion — your actual niche's shelf competition can look different.
              </p>
            </>
          ) : (
            <EmptyState
              title="No congestion data for this genre"
              description="Congestion needs a larger genre (release-count floor). The demand and decay reads above/below still apply."
            />
          )
        ) : (
          timingStatus
        )}
      </Card>

      <Card
        title="How long a launch pays out"
        subtitle="Median share of a game's first-24-months review total landing in each month since release — per-game normalized first, so big games don't dominate"
      >
        {overview ? (
          <>
            {decaySummary && (
              <p className="mb-3 text-sm text-ink-secondary">
                <span className="font-semibold text-ink-primary">
                  {fmtPct(decaySummary.first_3_months_share, 0)} of a game&apos;s two-year review volume lands in the
                  first 3 months
                </span>{" "}
                ({fmtPct(decaySummary.first_12_months_share, 0)} within a year, median of{" "}
                {decaySummary.n_games.toLocaleString()} games) — the window you pick carries real weight, then the tail
                takes over.
              </p>
            )}
            <TimingBars
              data={overview.decay.map((d) => ({
                label: String(d.month_since_release),
                value: d.median_share === null ? null : d.median_share * 100,
              }))}
              height={190}
              valueLabel="Share of first-24m reviews"
              formatValue={(v) => `${v.toFixed(1)}%`}
            />
            <p className="mt-2 text-[11px] text-ink-muted">Months since release (0 = launch month).</p>
          </>
        ) : (
          timingStatus
        )}
      </Card>

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
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
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
        title="Price distribution"
        subtitle={priceDist ? `${priceDist.n.toLocaleString()} paid games · $2.50 bins` : "What paid games actually charge"}
        action={<GenreSelect genres={genres} value={priceGenre} onChange={setPriceGenre} />}
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

      <p className="text-[11px] leading-relaxed text-ink-muted">
        Honest footnotes: review counts proxy sales (Boxleiter method) — nothing here is measured revenue. All reads are
        correlational, not causal, and seasonal effects are second-order versus game quality and wishlist momentum:
        timing tilts odds, it doesn&apos;t rescue a weak game.
      </p>
    </div>
  );
}

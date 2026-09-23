import { useCallback, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useQueries } from "@tanstack/react-query";
import clsx from "clsx";

import { LaunchShapeBars } from "../components/charts/LaunchShapeBars";
import { salesIn, STEAM_EVENTS } from "../components/charts/MonthEventsStrip";
import {
  PriceDistributionChart,
  PricePercentiles,
  priceTakeaway,
} from "../components/charts/PriceDistributionChart";
import { SeasonalityHeatmap } from "../components/charts/SeasonalityHeatmap";
import { TimingBars } from "../components/charts/TimingBars";
import { Card } from "../components/ui/Card";
import { EmptyState } from "../components/ui/EmptyState";
import { ErrorState, RetryButton } from "../components/ui/ErrorState";
import { InfoTip } from "../components/ui/InfoTip";
import { Loading } from "../components/ui/Loading";
import {
  ApiError,
  errorMessage,
  launchCurveQueryOptions,
  useGenres,
  useMarketDistribution,
  useSeasonality,
  useTimingOverview,
  type TimingOverview,
  type TimingWindowScore,
} from "../lib/api";
import { fmtCompact, fmtInt, fmtPct, monthName } from "../lib/format";
import { CSS_VAR } from "../lib/palette";
import { usePageTitle } from "../lib/usePageTitle";

const DEFAULT_CURVE_GENRES = ["__all__", "Indie", "Action", "Adventure", "Casual", "Simulation", "Strategy", "RPG"];

/** An average month's share of a year: the 1.0 of the buying index. */
const AVERAGE_MONTH = 1 / 12;

/** A loading placeholder that holds the loaded section's height. */
function Placeholder({ minHeight }: { minHeight: number }) {
  return (
    <div className="flex" style={{ minHeight }}>
      <Loading className="flex-1 text-xs" />
    </div>
  );
}

/**
 * Shared loading / refreshing / no-data handling for the timing sections. The loading
 * placeholder takes the height the loaded section will have (`minHeight`), so the page
 * doesn't jump as each chart arrives — /timing measured a CLS of 0.126 when every card
 * started as a 160px spinner and grew to 300–500px.
 */
function TimingStatus({
  isLoading,
  error,
  onRetry,
  minHeight = 160,
}: {
  isLoading: boolean;
  error: unknown;
  onRetry: () => void;
  minHeight?: number;
}) {
  if (isLoading) return <Placeholder minHeight={minHeight} />;
  if (error instanceof ApiError && error.status === 503) {
    return (
      <EmptyState
        title="Timing data is refreshing"
        description="The launch-timing marts haven't been built yet — they appear after the next data refresh."
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
  // `description={String(error)}` printed "TypeError: Failed to fetch" on four cards of
  // this page at once (measured on production 2026-09-01) — a stack-trace noun shown to a
  // designer looking for a launch month. ErrorState says what happened and offers the
  // retry that the whole page previously lacked.
  if (error) return <ErrorState title="Couldn't load timing data" error={error} onRetry={onRetry} />;
  return null;
}

function GenreSelect({
  genres,
  value,
  onChange,
  ariaLabel,
}: {
  genres: { value: string; label: string }[];
  value: string;
  onChange: (g: string) => void;
  ariaLabel: string;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      aria-label={ariaLabel}
      className="rounded-md border border-chartborder bg-page px-2 py-1.5 text-xs text-ink-primary outline-none focus:border-brand"
    >
      {genres.map((g) => (
        <option key={g.value} value={g.value}>
          {g.label}
        </option>
      ))}
    </select>
  );
}

function signed(v: number, digits = 2): string {
  return `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(digits)}`;
}

/** "Jan, Nov and Dec". */
function listMonths(names: readonly string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** The mean monthly releases — the 1.0 of the crowding index — recovered from the API's
 * own components (avg_releases ÷ congestion_index), so the worked line uses the same number
 * the score did. */
function averageMonthReleases(months: readonly TimingWindowScore[]): number | null {
  const m = months.find((w) => w.avg_releases != null && w.congestion_index != null && w.congestion_index > 0);
  return m ? (m.avg_releases as number) / (m.congestion_index as number) : null;
}

/** The score as the difference of the two indices AS PRINTED (2 decimals each), so the
 * arithmetic on screen adds up: January's 1.1165 − 0.8146 = 0.3019 would otherwise print
 * "1.12 − 0.81 = +0.30". The bars keep the exact score; the two agree to the axis' grain. */
function shownScore(w: TimingWindowScore): { buying: string; crowding: string; score: string } | null {
  if (w.demand_index == null || w.congestion_index == null) return null;
  const b = Number(w.demand_index.toFixed(2));
  const c = Number(w.congestion_index.toFixed(2));
  return { buying: b.toFixed(2), crowding: c.toFixed(2), score: signed(b - c) };
}

/** "Jan: buying 9.3% ÷ 8.33% = 1.12; crowding 1,068 ÷ 1,311 = 0.81; score 1.12 − 0.81 = +0.31" */
function scoreWorked(w: TimingWindowScore, avgReleases: number | null): string | null {
  const s = shownScore(w);
  if (w.demand_share == null || !s) return null;
  const crowd =
    w.avg_releases != null && avgReleases != null
      ? `${fmtInt(w.avg_releases)} ÷ ${fmtInt(avgReleases)} = ${s.crowding}`
      : s.crowding;
  return `${w.month_name}: buying ${fmtPct(w.demand_share)} ÷ 8.33% = ${s.buying}; crowding ${crowd}; score ${s.buying} − ${s.crowding} = ${s.score}`;
}

const SCORE_TIP = {
  label: "Window score",
  meaning:
    "How far a month's player buying outruns its release crowding. Above 0, players buy more than the month is crowded; below 0, the reverse. It tilts the odds — it doesn't rescue a weak game.",
  formula:
    "Buying index − Crowding index. Buying index = the month's share of the year's post-launch reviews ÷ 8.33% (an average month). Crowding index = the month's average releases ÷ the average month's releases.",
  notes:
    "Reviews stand in for sales. Buying leaves out each game's first 2 months, so launch spikes don't read as seasonal demand; crowding counts every release in the genre over the last 3 complete years. Genre-wide — your niche's shelf can look different.",
};

/**
 * The recommendation, BEARISH READING FIRST: which sale season the best months sit in (and
 * what that costs a launch), whether the genre filter changed the answer at all, then the
 * API's rationale and the score chart — every score explained with its own arithmetic.
 */
function RecommendationCard({
  overview,
  catalog,
  genreLabel,
}: {
  overview: TimingOverview;
  /** The whole catalog's overview, when a genre is selected — to say whether the genre
   * changed the answer. */
  catalog: TimingOverview | undefined;
  genreLabel: string;
}) {
  const rec = overview.window_recommendation;
  if (!rec) {
    return (
      <p className="text-xs text-ink-muted">
        No window recommendation for this genre — it needs complete demand and crowding series (12 months of each).
      </p>
    );
  }
  const best = new Set(rec.best_months);
  const avgReleases = averageMonthReleases(rec.months);
  const top = rec.months.find((w) => w.month === rec.best_months[0]);
  const sales = salesIn(rec.best_months);
  const saleMonths = rec.best_month_names.filter((_, i) => sales.some((s) => s.months.includes(rec.best_months[i])));

  const catalogRec = catalog?.window_recommendation;
  const sameAsCatalog =
    catalogRec != null &&
    catalogRec.best_months.length === rec.best_months.length &&
    catalogRec.best_months.every((m) => best.has(m));

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
        <InfoTip {...SCORE_TIP} worked={top ? scoreWorked(top, avgReleases) : undefined} />
      </div>

      {sales.length > 0 && (
        <div
          className="max-w-3xl border-l-2 py-1 pl-3 text-[13px] leading-relaxed text-ink-secondary"
          style={{ borderColor: "var(--status-warning)" }}
          data-testid="sale-season-caveat"
        >
          <span className="font-semibold text-ink-primary">
            {listMonths(saleMonths)} {saleMonths.length === 1 ? "is" : "are"} Steam sale season
          </span>{" "}
          ({sales.map((s) => `${s.label}: ${s.when}`).join("; ")}). Players do buy then — but much of that buying is
          discounted back catalog, a new release competes for the storefront with every hit on sale, and shoppers
          expect a launch discount. Read these months as busy, not easy.
        </div>
      )}

      {catalog && catalogRec && (
        <p className="text-[13px] text-ink-secondary" data-testid="genre-same-answer">
          {sameAsCatalog ? (
            <>
              <span className="font-semibold text-ink-primary">Same months as the whole catalog.</span> For{" "}
              {genreLabel}, the genre filter moves the numbers, not the answer — its calendar is Steam&apos;s calendar.
            </>
          ) : (
            <>
              <span className="font-semibold text-ink-primary">Differs from the whole catalog</span>, whose best months
              are {listMonths(catalogRec.best_month_names)}.
            </>
          )}
        </p>
      )}

      <p className="max-w-3xl text-sm leading-relaxed text-ink-secondary">{rec.rationale}</p>
      <div>
        <div className="mb-1 flex items-center gap-1.5 text-[11px] text-ink-muted">
          Window score by month — buying minus crowding, recommended months highlighted
          <InfoTip {...SCORE_TIP} worked={top ? scoreWorked(top, avgReleases) : undefined} />
        </div>
        <TimingBars
          data={rec.months.map((w) => {
            const s = shownScore(w);
            return {
              label: w.month_name,
              value: w.score,
              highlighted: best.has(w.month),
              // The hover used to say "Score 0.31" and nothing else: it now shows the two
              // indices the score is made of, and the subtraction.
              valueText: s ? `${s.buying} − ${s.crowding} = ${s.score}` : "not computed",
              details: s
                ? [
                    { label: "Buying index", value: `${s.buying}× an average month` },
                    { label: "Crowding index", value: `${s.crowding}× an average month` },
                  ]
                : undefined,
            };
          })}
          height={150}
          valueLabel="Window score"
          formatValue={(v) => signed(v)}
          axisKind="count"
          referenceY={0}
          dimUnhighlighted
          months
        />
      </div>
    </div>
  );
}

/**
 * BOTH GENRE SELECTS RIDE THE URL (?genre= for the timing sections, ?price_genre= for
 * the price distribution). They were useState, so the reproduction was: set the first to
 * Strategy — the page correctly refetches (GET /api/seasonality?genre=Strategy) — then
 * reload, and both snap back to __all__ with no trace in the address bar. /niches/:dim/:key
 * promises on screen that its filter lives in the URL; "here are the Strategy launch
 * windows" has to be a link you can send, not a click sequence you have to describe.
 *
 * Same contract as /games and /radar: DEFAULT (__all__) IS OMITTED so a pristine /timing
 * stays a clean URL, an unknown genre reads as __all__ rather than throwing (the API
 * would 404 it anyway, and TimingStatus already renders that honestly), and the selects
 * PUSH — each is a deliberate "show me this genre" step the back button should walk,
 * exactly like /games' genre <select>.
 *
 * EVERY NUMBER EXPLAINS ITSELF (2026-09-23): the page had no ⓘ at all, printed the score's
 * formula as code, and hovered "Score 0.31" without the "1.13 − 0.82" it is made of. Each
 * section now opens on a plain takeaway, carries its formula and its own worked numbers,
 * and the month charts carry Steam's sale / Next Fest calendar on the same axis.
 */
export default function LaunchTiming() {
  usePageTitle("Launch timing");
  const genres = useGenres();
  const [searchParams, setSearchParams] = useSearchParams();

  const setGenreParam = useCallback(
    (key: string, value: string) => {
      const next = new URLSearchParams(searchParams);
      if (value === "__all__") next.delete(key);
      else next.set(key, value);
      setSearchParams(next);
    },
    [searchParams, setSearchParams],
  );

  const timingGenre = searchParams.get("genre") || "__all__";
  const setTimingGenre = useCallback((g: string) => setGenreParam("genre", g), [setGenreParam]);
  const {
    data: overview,
    isLoading: timingLoading,
    error: timingError,
    refetch: refetchTiming,
  } = useTimingOverview(timingGenre);
  // The whole catalog's answer, to say whether a genre changed it (a cached request when
  // the page is already on All genres — same query key).
  const { data: catalogOverview } = useTimingOverview("__all__");
  // Seasonality, the launch curves and the price histogram are read for their ERRORS too,
  // not just their data. Rendering only `isLoading` and `data` meant a failed fetch left an
  // empty framed box with no message at all — measured on production 2026-09-01, three of
  // this page's seven cards (Release day × month, Launch shape by genre, Price distribution)
  // sat blank while the other four shouted a TypeError. A silent empty chart is the worse
  // failure: it reads as "no data for this genre", which is a claim about the catalog.
  const {
    data: seasonality,
    isLoading: seasonLoading,
    error: seasonError,
    refetch: refetchSeasonality,
  } = useSeasonality(timingGenre);

  const [curveGenres, setCurveGenres] = useState<string[]>(DEFAULT_CURVE_GENRES);
  const curveResults = useQueries({
    queries: curveGenres.map((g) => launchCurveQueryOptions(g)),
  });

  const priceGenre = searchParams.get("price_genre") || "__all__";
  const setPriceGenre = useCallback((g: string) => setGenreParam("price_genre", g), [setGenreParam]);
  const {
    data: priceDist,
    isLoading: priceLoading,
    error: priceError,
    refetch: refetchPrice,
  } = useMarketDistribution("price", priceGenre, "all");

  function toggleGenre(g: string) {
    setCurveGenres((prev) => (prev.includes(g) ? prev.filter((x) => x !== g) : [...prev, g]));
  }

  const status = (minHeight: number) => (
    <TimingStatus
      isLoading={timingLoading && !overview}
      error={overview ? null : timingError}
      onRetry={() => void refetchTiming()}
      minHeight={minHeight}
    />
  );
  const genreLabel = timingGenre === "__all__" ? "All genres" : timingGenre;
  const priceGenreLabel = priceGenre === "__all__" ? "All genres" : priceGenre;
  const bestMonths = new Set(overview?.window_recommendation?.best_months ?? []);
  const decaySummary = overview?.decay_summary;

  // Takeaways, computed from the same series the charts draw.
  const demand = (overview?.demand ?? []).filter((d) => d.demand_share != null);
  const yearReviews = demand.reduce((s, d) => s + (d.month_reviews ?? 0), 0);
  const busiest = demand.length ? demand.reduce((a, b) => ((b.demand_share ?? 0) > (a.demand_share ?? 0) ? b : a)) : null;
  const quietest = demand.length ? demand.reduce((a, b) => ((b.demand_share ?? 1) < (a.demand_share ?? 1) ? b : a)) : null;
  const congestion = overview?.congestion ?? [];
  const nYears = congestion[0]?.n_years ?? null;
  const mostCrowded = congestion.length ? congestion.reduce((a, b) => (b.avg_releases > a.avg_releases ? b : a)) : null;
  const leastCrowded = congestion.length ? congestion.reduce((a, b) => (b.avg_releases < a.avg_releases ? b : a)) : null;
  const decayShares = (overview?.decay ?? []).filter((d) => d.median_share != null);
  const decayTotal = decayShares.reduce((s, d) => s + (d.median_share ?? 0), 0);
  const firstThree = decayShares.filter((d) => d.month_since_release < 3);

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-lg font-semibold text-ink-primary">Launch &amp; Timing</h1>
        <p className="mt-0.5 text-sm text-ink-muted">
          When players in a genre actually buy, how crowded each launch window is, and how long a launch pays out —
          from Steam&apos;s own monthly review counts, not launch-month medians. Timing tilts the odds; it doesn&apos;t
          rescue a weak game.
        </p>
      </div>

      <Card
        title={`Best launch windows — ${genreLabel}`}
        subtitle="Months where player buying outruns release crowding — each score's parts in its hover and ⓘ."
        action={<GenreSelect genres={genres} value={timingGenre} onChange={setTimingGenre} ariaLabel="Genre for the timing charts" />}
      >
        {overview ? (
          <RecommendationCard
            overview={overview}
            catalog={timingGenre === "__all__" ? undefined : catalogOverview}
            genreLabel={genreLabel}
          />
        ) : (
          status(470)
        )}
      </Card>

      <Card
        title={`When players buy — ${genreLabel}`}
        subtitle={`Share of ${genreLabel === "All genres" ? "the catalog's" : `${genreLabel}'s`} yearly review volume landing in each calendar month — each game's first 2 months left out, so launch spikes don't read as seasonal demand`}
      >
        {overview ? (
          <>
            {busiest && quietest && (
              <p className="mb-2 text-sm text-ink-secondary" data-testid="demand-takeaway">
                <span className="font-semibold text-ink-primary">
                  {monthName(busiest.month)} is the busiest buying month ({fmtPct(busiest.demand_share)} of the year,{" "}
                  {((busiest.demand_share ?? 0) / AVERAGE_MONTH).toFixed(2)}× an average month)
                </span>
                ; {monthName(quietest.month)} the quietest ({fmtPct(quietest.demand_share)}).
                {salesIn([busiest.month]).length > 0 && (
                  <> {monthName(busiest.month)} is also a Steam sale month — part of that peak is sale buying.</>
                )}
              </p>
            )}
            <div className="mb-1 flex items-center gap-1.5 text-[11px] text-ink-muted">
              Share of yearly buying, by month
              <InfoTip
                label="Share of yearly buying"
                meaning="Of all the reviews the genre's games collected across a year — each game's first 2 months left out — the share posted in each calendar month: when players actually buy. An average month is 8.3%."
                formula="the month's post-launch reviews ÷ the year's post-launch reviews, pooled over the last 5 complete years"
                worked={
                  busiest && yearReviews > 0
                    ? `${monthName(busiest.month)}: ${fmtCompact(busiest.month_reviews)} ÷ ${fmtCompact(yearReviews)} reviews = ${fmtPct(busiest.demand_share)}`
                    : undefined
                }
                notes="Reviews stand in for sales — Steam's own totals, not our sample."
                source="Steam's monthly review histograms"
              />
            </div>
            <TimingBars
              data={overview.demand.map((d) => ({
                label: monthName(d.month),
                value: d.demand_share === null ? null : d.demand_share * 100,
                highlighted: bestMonths.has(d.month),
                details:
                  d.demand_share != null
                    ? [
                        {
                          label: "vs an average month",
                          value: `${(d.demand_share / AVERAGE_MONTH).toFixed(2)}×`,
                        },
                        { label: "Reviews that month", value: fmtCompact(d.month_reviews) },
                      ]
                    : undefined,
              }))}
              height={190}
              valueLabel="Share of yearly buying"
              formatValue={(v) => `${v.toFixed(1)}%`}
              axisKind="pct"
              referenceY={100 / 12}
              months="compact"
            />
            <p className="mt-2 text-[11px] text-ink-muted">
              Dashed line = an average month (8.3%).{" "}
              {overview.demand[0] ? `${overview.demand[0].n_games.toLocaleString()}+ games contributing per month.` : ""}
            </p>
          </>
        ) : (
          status(300)
        )}
      </Card>

      <Card
        title={`How crowded each window is — ${genreLabel}`}
        subtitle={`Releases landing in each calendar month in an average year${nYears ? ` (last ${nYears} complete years)` : ""} — all of them, then the ones that reached $200K+: the competition that actually takes attention`}
      >
        {overview ? (
          overview.congestion.length > 0 ? (
            <>
              {mostCrowded && leastCrowded && (
                <p className="mb-2 text-sm text-ink-secondary" data-testid="crowding-takeaway">
                  <span className="font-semibold text-ink-primary">
                    {monthName(mostCrowded.month)} is the most crowded (~{fmtInt(mostCrowded.avg_releases)} releases a
                    year, ~{fmtInt(mostCrowded.avg_big_releases)} of them reaching $200K+)
                  </span>
                  ; {monthName(leastCrowded.month)} the calmest (~{fmtInt(leastCrowded.avg_releases)}).
                </p>
              )}
              {/* Was ONE chart with two y-axes (all releases left, $200K+ right): two scales on
                  one plot invite comparing bar heights that mean different things. Now two
                  small multiples on the same month axis, each with its own scale. */}
              <div className="mb-1 flex items-center gap-1.5 text-[11px] text-ink-muted">
                All releases per month
                <InfoTip
                  label="Releases per month"
                  meaning="How many games launch in that calendar month in an average year — the company a launch then has on the new-release shelf."
                  formula={`games released in that calendar month over the last ${nYears ?? 3} complete years ÷ ${nYears ?? 3}`}
                  worked={
                    mostCrowded ? `${monthName(mostCrowded.month)}: ~${fmtInt(mostCrowded.avg_releases)} a year` : undefined
                  }
                  notes="Genre-wide: your niche's shelf can look different. Dated by first public date — an Early Access game counts when it opened."
                />
              </div>
              <TimingBars
                data={overview.congestion.map((c) => ({
                  label: monthName(c.month),
                  value: c.avg_releases,
                }))}
                height={150}
                valueLabel="Releases a year"
                formatValue={(v) => `~${fmtInt(v)}`}
                axisKind="count"
                color={CSS_VAR.competition}
              />
              <div className="mb-1 mt-3 flex items-center gap-1.5 text-[11px] text-ink-muted">
                Releases that reached $200K+ per month
                <InfoTip
                  label="$200K+ releases per month"
                  meaning="The releases in that month that went on to earn $200K+ — the ones that actually took players' attention and money."
                  formula={`releases in that calendar month with Est. revenue ≥ $200K over the last ${nYears ?? 3} complete years ÷ ${nYears ?? 3}`}
                  worked={
                    mostCrowded ? `${monthName(mostCrowded.month)}: ~${fmtInt(mostCrowded.avg_big_releases)} a year` : undefined
                  }
                  notes="Est. revenue = reviews × 30 × launch price — an estimate, not reported sales."
                />
              </div>
              <TimingBars
                data={overview.congestion.map((c) => ({
                  label: monthName(c.month),
                  value: c.avg_big_releases,
                }))}
                height={120}
                valueLabel="$200K+ releases a year"
                formatValue={(v) => `~${fmtInt(v)}`}
                axisKind="count"
                color={CSS_VAR.qualityGap}
                months="compact"
              />
            </>
          ) : (
            <EmptyState
              title="No crowding data for this genre"
              description="Crowding needs a larger genre (release-count floor). The buying and payout reads above/below still apply."
            />
          )
        ) : (
          status(380)
        )}
      </Card>

      <Card
        title={`Release day × month — ${genreLabel}`}
        subtitle="Median estimated revenue (or release count) by the calendar month and weekday games shipped — where past releases landed well, and where the catalog piles up"
      >
        {seasonLoading && !seasonality && <Placeholder minHeight={640} />}
        {!seasonality && !seasonLoading && seasonError && (
          <ErrorState
            title="Couldn't load release-date data"
            error={seasonError}
            onRetry={() => void refetchSeasonality()}
          />
        )}
        {seasonality &&
          (seasonality.month_weekday.length > 0 ? (
            <>
              <SeasonalityHeatmap cells={seasonality.month_weekday} />
              <p className="mt-2 text-[11px] text-ink-muted">
                Outcomes by release date, not by when players buy (that&apos;s the buying chart above). Weekday reads are
                mostly about who ships when — big titles favor Thu/Fri — so treat day-of-week as descriptive, not causal.
              </p>
            </>
          ) : (
            <EmptyState
              title="No release-date data for this genre"
              description="This genre is below the seasonality sample floor. Try All genres, or a larger genre."
            />
          ))}
      </Card>

      <Card
        title={`How long a launch pays out — ${genreLabel}`}
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
            <div className="mb-1 flex items-center gap-1.5 text-[11px] text-ink-muted">
              Share of the first 24 months&apos; reviews, by month since release
              <InfoTip
                label="Launch payout curve"
                meaning="How a typical game's first two years of reviews spread over its months since release — month 0 is the launch month. Normalised per game first, so a few big games can't set the shape."
                formula="for each game: its reviews in month m ÷ its first-24-months total; then the median across games, month by month"
                worked={
                  firstThree.length > 0 && decayTotal > 0 && decaySummary
                    ? `months 0–2: ${firstThree
                        .map((d) => fmtPct(d.median_share))
                        .join(" + ")} of the medians' ${fmtPct(decayTotal)} total → ${fmtPct(decaySummary.first_3_months_share, 0)}`
                    : undefined
                }
                notes="Medians don't add up to exactly 100%, so the headline share is taken over their sum."
              />
            </div>
            <TimingBars
              data={overview.decay.map((d) => ({
                label: String(d.month_since_release),
                value: d.median_share === null ? null : d.median_share * 100,
              }))}
              height={190}
              valueLabel="Share of first-24m reviews"
              formatValue={(v) => `${v.toFixed(1)}%`}
              axisKind="pct"
            />
            <p className="mt-2 text-[11px] text-ink-muted">Months since release (0 = launch month).</p>
          </>
        ) : (
          status(300)
        )}
      </Card>

      <Card
        title="Launch shape by genre — when first-year reviews land"
        subtitle="Share of first-year reviews earned in each window after launch — tall left = front-loaded (bet on the splash); flat = slow-burn (sustained marketing pays)"
        action={<InfoTip term="launch_shape" />}
      >
        <div className="mb-3 flex min-h-[30px] flex-wrap gap-1.5">
          {genres.map((g) => (
            <button
              key={g.value}
              type="button"
              onClick={() => toggleGenre(g.value)}
              aria-pressed={curveGenres.includes(g.value)}
              className={clsx(
                "rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors",
                curveGenres.includes(g.value)
                  ? "border-brand bg-page text-ink-primary"
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
                  {result?.data && (
                    <span className="text-[10px] text-ink-muted">
                      {fmtInt(result.data.points[0]?.n_games ?? 0)} games
                    </span>
                  )}
                </div>
                {result?.isLoading && <Loading className="h-[140px] text-xs" />}
                {result?.error && !result.data && (
                  <div className="flex h-[140px] flex-col items-center justify-center gap-2 text-center">
                    <span className="text-[11px] text-verdict-serious">{errorMessage(result.error)}</span>
                    <RetryButton onClick={() => void result.refetch()} />
                  </div>
                )}
                {result?.data && <LaunchShapeBars points={result.data.points} height={140} />}
              </div>
            );
          })}
        </div>
      </Card>

      <Card
        title="Price distribution"
        subtitle={
          priceDist
            ? `${priceDist.n.toLocaleString()} paid games — what they charge, drawn to scale`
            : "What paid games actually charge"
        }
        action={<GenreSelect genres={genres} value={priceGenre} onChange={setPriceGenre} ariaLabel="Genre for the price distribution" />}
      >
        {priceLoading && !priceDist && <Placeholder minHeight={300} />}
        {!priceDist && !priceLoading && priceError && (
          <ErrorState
            title="Couldn't load the price distribution"
            error={priceError}
            onRetry={() => void refetchPrice()}
          />
        )}
        {priceDist && (
          <>
            {priceTakeaway(priceDist.percentiles) && (
              <p className="mb-2 text-sm font-semibold text-ink-primary" data-testid="price-takeaway">
                {priceTakeaway(priceDist.percentiles)}
              </p>
            )}
            <PriceDistributionChart
              buckets={priceDist.buckets}
              percentiles={priceDist.percentiles}
              n={priceDist.n}
              marks={priceDist.benchmark_marks.map((m) => ({ label: m.label, value: m.value }))}
              genreLabel={priceGenreLabel}
            />
            <div className="mt-3 border-t border-chartborder pt-3">
              <PricePercentiles percentiles={priceDist.percentiles} n={priceDist.n} />
            </div>
          </>
        )}
      </Card>

      <p className="text-[11px] leading-relaxed text-ink-muted">
        Honest footnotes: review counts stand in for sales — nothing here is measured revenue. All reads are
        correlational, not causal, and seasonal effects are second-order versus game quality and wishlist momentum:
        timing tilts odds, it doesn&apos;t rescue a weak game. Steam&apos;s event calendar is shown as it usually
        falls ({STEAM_EVENTS.length} recurring events); Valve sets the real dates each year.
      </p>
    </div>
  );
}

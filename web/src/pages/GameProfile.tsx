import { useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import clsx from "clsx";

import { AspectDivergingBars } from "../components/charts/AspectDivergingBars";
import { GameMetricDrilldown, DRILLDOWN_META, type DrilldownMetric, type OwnersPerReview } from "../components/charts/GameMetricDrilldown";
import { LanguageSplitChart } from "../components/charts/LanguageSplitChart";
import { LaunchShapeBars } from "../components/charts/LaunchShapeBars";
import { PressBySourceChart } from "../components/charts/PressBySourceChart";
import { PressTimelineChart } from "../components/charts/PressTimelineChart";
import { ReviewsTimelineChart } from "../components/charts/ReviewsTimelineChart";
import { GameTrendsChart } from "../components/charts/GameTrendsChart";
import { NotableCoverageCard } from "../components/NotableCoverageCard";
import { Badge } from "../components/ui/Badge";
import { Card } from "../components/ui/Card";
import { Meter, BulletMeter } from "../components/ui/Meter";
import { StatTile } from "../components/ui/StatTile";
import {
  useGameComparables,
  useGameProfile,
  useGameReviewsSummary,
  useGameTeardown,
  useLaunchCurve,
  useMarketBenchmarks,
} from "../lib/api";
import { fmtCompact, fmtInt, fmtMinutes, fmtPct, fmtPrice, fmtUsd } from "../lib/format";
import { CSS_VAR } from "../lib/palette";

const TABS = [
  { key: "overview", label: "Overview" },
  { key: "teardown", label: "Why it works" },
] as const;
type TabKey = (typeof TABS)[number]["key"];

/** DuckDB TIMESTAMP strings ("2017-03-06 23:59:53" / "...53.255353") -> "2017-03-06". */
function dateOnly(s: string | null): string {
  return s ? s.slice(0, 10) : "—";
}

export default function GameProfile() {
  const { appid: appidParam } = useParams<{ appid: string }>();
  const navigate = useNavigate();
  const appid = appidParam ? Number(appidParam) : NaN;
  const validAppid = Number.isFinite(appid);
  const [tab, setTab] = useState<TabKey>("overview");
  const [selectedMetric, setSelectedMetric] = useState<DrilldownMetric | null>(null);

  const profileQ = useGameProfile(validAppid ? appid : null);
  const comparablesQ = useGameComparables(validAppid ? appid : null);
  const reviewsQ = useGameReviewsSummary(validAppid ? appid : null);
  const genreCurveQ = useLaunchCurve(profileQ.data?.primary_genre ?? "__all__");
  const benchmarksQ = useMarketBenchmarks();
  const teardownQ = useGameTeardown(validAppid ? appid : null);

  const profile = profileQ.data;

  const revenueRange = useMemo(() => {
    const bx = benchmarksQ.data?.cited.boxleiter_owners_per_review;
    if (!profile || !bx || profile.total_reviews === null || profile.price_initial === null) return null;
    const r = profile.total_reviews;
    const p = profile.price_initial;
    return { low: r * bx.min * p, mid: profile.est_rev_reviews ?? r * bx.mid * p, high: r * bx.max * p };
  }, [profile, benchmarksQ.data]);

  // Owners-per-review ratio for the Owners/Revenue drilldowns — same source + fallback the
  // Owners/Revenue stat tiles themselves imply: the cited Boxleiter mid when benchmarks are
  // loaded, else this game's own owners_mid/total_reviews ratio if both are known.
  const ownersPerReview = useMemo<OwnersPerReview | null>(() => {
    const bx = benchmarksQ.data?.cited.boxleiter_owners_per_review;
    if (bx) return { value: bx.mid, source: "benchmark" };
    if (profile?.owners_mid != null && profile.total_reviews) {
      return { value: profile.owners_mid / profile.total_reviews, source: "game" };
    }
    return null;
  }, [profile, benchmarksQ.data]);

  function toggleMetric(metric: DrilldownMetric) {
    setSelectedMetric((cur) => (cur === metric ? null : metric));
  }

  if (!validAppid) {
    return (
      <Card>
        <div className="py-8 text-center text-sm text-status-serious">Invalid game ID in the URL.</div>
      </Card>
    );
  }

  if (profileQ.isLoading) {
    return <div className="p-6 text-sm text-ink-muted">Loading game…</div>;
  }

  if (profileQ.isError || !profile) {
    return (
      <Card>
        <div className="flex flex-col items-center gap-2 py-8 text-center text-sm">
          <span className="text-status-serious">
            Game not found{profileQ.error instanceof Error ? `: ${profileQ.error.message}` : "."}
          </span>
          <Link to="/games" className="text-series-1 hover:underline">
            Back to search
          </Link>
        </div>
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <Link to="/games" className="text-xs text-ink-muted hover:text-ink-primary">
        ← Back to search
      </Link>

      <Card>
        <div className="flex flex-col gap-4 sm:flex-row">
          {profile.header_image && (
            <img
              src={profile.header_image}
              alt=""
              className="h-32 w-full shrink-0 rounded-card object-cover sm:h-28 sm:w-56"
            />
          )}
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h1 className="text-lg font-semibold text-ink-primary">{profile.name ?? `App ${profile.appid}`}</h1>
                <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-ink-muted">
                  {profile.primary_genre && <Badge color={CSS_VAR.demand}>{profile.primary_genre}</Badge>}
                  <span>{profile.release_date ?? "Release date unknown"}</span>
                  <span>·</span>
                  <span>{fmtPrice(profile.price_initial)}</span>
                  {profile.is_indie === 1 && <Badge>Indie</Badge>}
                  <Badge>{profile.self_published ? "Self-published" : "Publisher"}</Badge>
                </div>
                <div className="mt-1 text-xs text-ink-secondary">
                  {profile.developers ?? "Unknown developer"}
                  {profile.publishers && profile.publishers !== profile.developers ? ` · ${profile.publishers}` : ""}
                </div>
              </div>
            </div>
            {profile.short_description && (
              <p className="mt-3 line-clamp-2 text-xs text-ink-secondary">{profile.short_description}</p>
            )}
            <div className="mt-2 flex flex-wrap gap-1">
              {profile.top_tags.map((t) => (
                <span key={t} className="rounded-full border border-chartborder px-2 py-0.5 text-[10px] text-ink-secondary">
                  {t}
                </span>
              ))}
            </div>
          </div>
        </div>
      </Card>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile
          label="Est. revenue (Boxleiter range)"
          value={revenueRange ? fmtUsd(revenueRange.mid) : fmtUsd(profile.est_rev_reviews)}
          sub={revenueRange ? `${fmtUsd(revenueRange.low)} – ${fmtUsd(revenueRange.high)}` : undefined}
          onClick={() => toggleMetric("revenue")}
          active={selectedMetric === "revenue"}
        />
        <StatTile
          label="Owners (est.)"
          value={fmtCompact(profile.owners_mid)}
          onClick={() => toggleMetric("owners")}
          active={selectedMetric === "owners"}
        />
        <StatTile
          label="Total reviews"
          value={fmtInt(profile.total_reviews)}
          sub={`${fmtInt(profile.n_reviews_trailing_30d)} sampled in trailing 30d`}
          onClick={() => toggleMetric("reviews")}
          active={selectedMetric === "reviews"}
        />
        <StatTile
          label="Positive rating"
          value={fmtPct(profile.positive_ratio)}
          sub={profile.metacritic_score ? `Metacritic ${profile.metacritic_score}` : undefined}
        />
        <StatTile
          label="Live players (now)"
          value={profile.live_players != null ? fmtCompact(profile.live_players) : "—"}
          sub={
            profile.twitch_viewers
              ? `${fmtCompact(profile.twitch_viewers)} watching on Twitch`
              : undefined
          }
          onClick={() => toggleMetric("live_players")}
          active={selectedMetric === "live_players"}
        />
      </div>

      {selectedMetric && (
        <Card
          title={DRILLDOWN_META[selectedMetric].title}
          subtitle={DRILLDOWN_META[selectedMetric].subtitle}
          action={
            <button
              type="button"
              onClick={() => setSelectedMetric(null)}
              aria-label="Close drilldown"
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-ink-secondary hover:bg-page hover:text-ink-primary"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M6 6l12 12M18 6L6 18" />
              </svg>
            </button>
          }
        >
          <GameMetricDrilldown
            appid={profile.appid}
            metric={selectedMetric}
            profile={{
              price_initial: profile.price_initial,
              total_reviews: profile.total_reviews,
              owners_mid: profile.owners_mid,
              live_players: profile.live_players,
              twitch_viewers: profile.twitch_viewers,
            }}
            ownersPerReview={ownersPerReview}
          />
        </Card>
      )}

      <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="Game profile sections">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={tab === t.key}
            onClick={() => setTab(t.key)}
            className={clsx(
              "rounded-full border px-3 py-1.5 text-xs font-medium transition-colors",
              tab === t.key
                ? "border-series-1 bg-page text-ink-primary"
                : "border-chartborder text-ink-muted hover:text-ink-secondary",
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "overview" && (
      <>
      <Card
        title="Percentile vs. genre"
        subtitle={`Rank within ${profile.primary_genre ?? "its genre"} among titles with ≥10 reviews`}
      >
        <div className="flex flex-col gap-3">
          <BulletMeter
            label="Revenue"
            value={profile.rev_pct_in_genre !== null ? profile.rev_pct_in_genre / 100 : null}
            benchmark={0.5}
            benchmarkLabel="Genre median (P50)"
            color={CSS_VAR.demand}
            valueLabel={profile.rev_pct_in_genre !== null ? `P${Math.round(profile.rev_pct_in_genre)}` : "—"}
          />
          <BulletMeter
            label="Review count"
            value={profile.reviews_pct_in_genre !== null ? profile.reviews_pct_in_genre / 100 : null}
            benchmark={0.5}
            benchmarkLabel="Genre median (P50)"
            color={CSS_VAR.demand}
            valueLabel={profile.reviews_pct_in_genre !== null ? `P${Math.round(profile.reviews_pct_in_genre)}` : "—"}
          />
          <BulletMeter
            label="Owners"
            value={profile.owners_pct_in_genre !== null ? profile.owners_pct_in_genre / 100 : null}
            benchmark={0.5}
            benchmarkLabel="Genre median (P50)"
            color={CSS_VAR.demand}
            valueLabel={profile.owners_pct_in_genre !== null ? `P${Math.round(profile.owners_pct_in_genre)}` : "—"}
          />
        </div>
        {profile.is_free === 1 && (
          <p className="mt-3 text-[11px] italic text-ink-muted">
            Revenue percentile isn't meaningful for free-to-play titles (box revenue is $0 at price $0) — read
            review-count and owners percentile instead.
          </p>
        )}
      </Card>

      <Card
        title="Launch shape — front-loaded vs. slow-burn"
        subtitle="How fast games in this genre earn their first-year reviews (a sales-momentum proxy) — tells you whether to bet on a big launch splash or a sustained slow-burn."
      >
        {genreCurveQ.data &&
          (() => {
            const pts = genreCurveQ.data.points;
            const at = (d: number) => pts.find((p) => p.day === d)?.median_cum_fraction ?? null;
            const d30 = at(30);
            if (d30 == null) return null;
            const d7 = at(7);
            const d30pct = Math.round(d30 * 100);
            const d7pct = d7 != null ? Math.round(d7 * 100) : null;
            const shape = d30pct >= 60 ? "Front-loaded" : d30pct <= 45 ? "Slow-burn" : "Balanced";
            const note =
              shape === "Front-loaded"
                ? "sales cluster at launch — the launch splash matters most here."
                : shape === "Slow-burn"
                  ? "sales keep accruing all year — sustained marketing and updates pay off."
                  : "there's a launch spike, but the long tail keeps building — both matter.";
            const genreLabel =
              profile.primary_genre && profile.primary_genre !== "__all__" ? profile.primary_genre : "These";
            return (
              <div className="mb-3 rounded-md border border-chartborder bg-page px-3 py-2 text-xs text-ink-secondary">
                <span className="font-semibold text-ink-primary">{shape}.</span> {genreLabel} games land{" "}
                <span className="font-semibold text-ink-primary">~{d30pct}%</span> of first-year reviews in the first
                30 days{d7pct != null ? ` (${d7pct}% in week one)` : ""} — {note}
              </div>
            );
          })()}
        {genreCurveQ.isLoading && <div className="flex h-40 items-center justify-center text-xs text-ink-muted">Loading…</div>}
        {genreCurveQ.data && <LaunchShapeBars points={genreCurveQ.data.points} height={220} />}
        {genreCurveQ.data && (
          <p className="mt-2 text-[11px] italic text-ink-muted">
            Share of first-year reviews earned in each window after launch — genre median across{" "}
            {(genreCurveQ.data.points[0]?.n_games ?? 0).toLocaleString()} {profile.primary_genre &&
              profile.primary_genre !== "__all__"
              ? profile.primary_genre
              : ""}{" "}
            titles. This older/popular title's own review sample is too recency-biased to chart its individual shape.
          </p>
        )}
      </Card>

      <Card
        title="Review timeline"
        subtitle="From the sampled reviews table (not Steam's full review count) — a recency-biased sample for older/popular titles"
      >
        {reviewsQ.isLoading && <div className="flex h-40 items-center justify-center text-xs text-ink-muted">Loading…</div>}
        {reviewsQ.data && <ReviewsTimelineChart points={reviewsQ.data.timeline} />}
      </Card>

      <Card
        title="Momentum over time"
        subtitle="Monthly review velocity, live players, Twitch viewers, and creator mentions — the signals Prospect tracks over time (CCU/Twitch thicken as snapshots accumulate)"
      >
        <GameTrendsChart appid={profile.appid} />
      </Card>

      <Card title="Language split" subtitle="Share of sampled reviews by language — a localization reference">
        {reviewsQ.isLoading && <div className="flex h-24 items-center justify-center text-xs text-ink-muted">Loading…</div>}
        {reviewsQ.data && <LanguageSplitChart data={reviewsQ.data.language_split} />}
      </Card>

      <Card title="Playtime">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <div className="mb-1 text-xs text-ink-muted">Total playtime, sampled reviewers (all-time)</div>
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
              <span>
                <span className="text-ink-muted">P25</span>{" "}
                <span className="tabular font-medium text-ink-primary">{fmtMinutes(profile.playtime_p25)}</span>
              </span>
              <span>
                <span className="text-ink-muted">P50</span>{" "}
                <span className="tabular font-medium text-ink-primary">{fmtMinutes(profile.playtime_p50)}</span>
              </span>
              <span>
                <span className="text-ink-muted">P75</span>{" "}
                <span className="tabular font-medium text-ink-primary">{fmtMinutes(profile.playtime_p75)}</span>
              </span>
            </div>
          </div>
          <div>
            <div className="mb-1 text-xs text-ink-muted">Playtime at the time of review</div>
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
              {reviewsQ.data?.playtime_at_review.map((p) => (
                <span key={p.pctile}>
                  <span className="text-ink-muted">{p.pctile.toUpperCase()}</span>{" "}
                  <span className="tabular font-medium text-ink-primary">{fmtMinutes(p.value)}</span>
                </span>
              ))}
              {reviewsQ.data && reviewsQ.data.playtime_at_review.length === 0 && (
                <span className="text-ink-muted">Not enough sampled reviews.</span>
              )}
            </div>
          </div>
        </div>
      </Card>

      <Card
        title="Comparables"
        subtitle={
          comparablesQ.data
            ? `Same genre (${comparablesQ.data.primary_genre ?? "—"}) · price band ${fmtPrice(
                comparablesQ.data.price_band.low,
              )}–${fmtPrice(comparablesQ.data.price_band.high)} · ranked by tag overlap (on-demand, not precomputed)`
            : undefined
        }
      >
        {comparablesQ.isLoading && <div className="text-xs text-ink-muted">Loading comparables…</div>}
        {comparablesQ.data && comparablesQ.data.items.length === 0 && (
          <div className="text-xs text-ink-muted">No comparable titles found in this genre/price band.</div>
        )}
        {comparablesQ.data && comparablesQ.data.items.length > 0 && (
          <div className="overflow-x-auto rounded-card border border-chartborder">
            <table className="w-full min-w-[640px] text-xs">
              <thead>
                <tr className="border-b border-chartborder text-left text-ink-muted">
                  <th className="px-2 py-1.5 font-medium">Game</th>
                  <th className="px-2 py-1.5 font-medium">Year</th>
                  <th className="px-2 py-1.5 font-medium">Price</th>
                  <th className="px-2 py-1.5 font-medium">Reviews</th>
                  <th className="px-2 py-1.5 font-medium">Positive</th>
                  <th className="px-2 py-1.5 font-medium">Est. revenue</th>
                  <th className="px-2 py-1.5 font-medium">Tag overlap</th>
                </tr>
              </thead>
              <tbody>
                {comparablesQ.data.items.map((c) => (
                  <tr
                    key={c.appid}
                    className="cursor-pointer border-b border-chartborder/60 last:border-0 hover:bg-page"
                    onClick={() => navigate(`/games/${c.appid}`)}
                  >
                    <td className="max-w-[200px] truncate px-2 py-1.5 font-medium text-ink-primary" title={c.name ?? undefined}>
                      {c.name ?? `App ${c.appid}`}
                    </td>
                    <td className="tabular px-2 py-1.5">{c.release_year ?? "—"}</td>
                    <td className="tabular px-2 py-1.5">{fmtPrice(c.price_initial)}</td>
                    <td className="tabular px-2 py-1.5">{fmtInt(c.total_reviews)}</td>
                    <td className="tabular px-2 py-1.5">{fmtPct(c.positive_ratio)}</td>
                    <td className="tabular px-2 py-1.5">{fmtUsd(c.est_rev_reviews)}</td>
                    <td className="px-2 py-1.5">
                      <div className="flex items-center gap-1.5" title={c.shared_tags.join(", ")}>
                        <Meter value={c.jaccard * 100} color={CSS_VAR.competition} />
                        <span className="tabular w-9 shrink-0 text-ink-secondary">{Math.round(c.jaccard * 100)}%</span>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      </>
      )}

      {tab === "teardown" && (
        <>
          <Card
            title="What players say about each aspect"
            subtitle={
              teardownQ.data
                ? teardownQ.data.eligible_reviews
                  ? `${fmtInt(teardownQ.data.n_reviews_sampled)} sampled English reviews · positive vs. negative from the review TEXT around each aspect (VADER sentiment), with the overall-vote split shown for comparison · sorted by mention volume · badges mark aspects that over-index vs. genre peers`
                  : "Not enough sampled English reviews for aspect mining on this title"
                : undefined
            }
          >
            {teardownQ.isLoading && (
              <div className="flex h-40 items-center justify-center text-xs text-ink-muted">Loading…</div>
            )}
            {teardownQ.isError && (
              <div className="text-xs text-status-serious">
                Failed to load teardown{teardownQ.error instanceof Error ? `: ${teardownQ.error.message}` : "."}
              </div>
            )}
            {teardownQ.data && teardownQ.data.eligible_reviews && (
              <AspectDivergingBars appid={appid} aspects={teardownQ.data.review_aspects} />
            )}
            {teardownQ.data && !teardownQ.data.eligible_reviews && (
              <div className="flex h-24 items-center justify-center text-center text-xs text-ink-muted">
                This game doesn't have enough sampled English reviews with text for aspect mining yet.
              </div>
            )}
          </Card>

          <Card
            title="Press footprint"
            subtitle={
              teardownQ.data && teardownQ.data.press.total_mentions > 0
                ? `${fmtInt(teardownQ.data.press.total_mentions)} filtered mentions across ${teardownQ.data.press.n_sources} outlet${
                    teardownQ.data.press.n_sources === 1 ? "" : "s"
                  }${
                    teardownQ.data.press.first_seen
                      ? ` · ${dateOnly(teardownQ.data.press.first_seen)} – ${dateOnly(teardownQ.data.press.last_seen)}`
                      : ""
                  } · journalist coverage only (Steam News excluded)`
                : undefined
            }
          >
            {teardownQ.isLoading && (
              <div className="flex h-32 items-center justify-center text-xs text-ink-muted">Loading…</div>
            )}
            {teardownQ.data && teardownQ.data.press.total_mentions === 0 && (
              <div className="flex h-24 items-center justify-center text-xs text-ink-muted">
                No press coverage found for this game above the match-confidence floor.
              </div>
            )}
            {teardownQ.data && teardownQ.data.press.total_mentions > 0 && (
              <>
                {teardownQ.data.press.press_pos_share !== null &&
                  (() => {
                    const p = teardownQ.data.press;
                    const posPct = (p.press_pos_share as number) * 100;
                    const mc = p.mean_compound;
                    return (
                      <div className="mb-4">
                        <div className="mb-1 flex items-center justify-between text-xs">
                          <span className="text-ink-muted">Coverage tone (headlines &amp; summaries)</span>
                          <span className="tabular text-ink-secondary">{fmtPct(p.press_pos_share, 0)} positive</span>
                        </div>
                        <div
                          className="relative h-3 rounded-full bg-page"
                          title={`${p.n_pos_articles} positive / ${p.n_neg_articles} negative${
                            p.n_neutral_articles ? ` (${p.n_neutral_articles} neutral excluded)` : ""
                          } of ${p.n_scored_articles} scored articles`}
                        >
                          <div
                            className="absolute inset-y-0 left-0 rounded-l-full"
                            style={{ width: `${posPct}%`, backgroundColor: CSS_VAR.praise }}
                          />
                          <div
                            className="absolute inset-y-0 right-0 rounded-r-full"
                            style={{ width: `${100 - posPct}%`, backgroundColor: CSS_VAR.complaint }}
                          />
                          <div className="absolute inset-y-0 w-[2px] bg-page" style={{ left: `calc(${posPct}% - 1px)` }} />
                        </div>
                        <div className="mt-1 text-[11px] text-ink-muted">
                          {fmtInt(p.n_pos_articles)} positive · {fmtInt(p.n_neg_articles)} negative
                          {p.n_neutral_articles > 0 && <> · {fmtInt(p.n_neutral_articles)} neutral</>}
                          {mc !== null && (
                            <>
                              {" · "}mean <span className="tabular">{mc >= 0 ? "+" : ""}{mc.toFixed(2)}</span>
                            </>
                          )}{" "}
                          · VADER on headlines/summaries (coarse — an outlet's framing, not a verdict)
                        </div>
                      </div>
                    );
                  })()}
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <div>
                    <div className="mb-1 text-xs text-ink-muted">Mentions by outlet</div>
                    <PressBySourceChart data={teardownQ.data.press.by_source} />
                  </div>
                  <div>
                    <div className="mb-1 text-xs text-ink-muted">Coverage over time</div>
                    <PressTimelineChart points={teardownQ.data.press.timeline} />
                  </div>
                </div>
              </>
            )}
          </Card>

          {teardownQ.data && teardownQ.data.press.notable.length > 0 && (
            <NotableCoverageCard press={teardownQ.data.press} />
          )}

          {teardownQ.data && teardownQ.data.caveats.length > 0 && (
            <Card title="Read this with caveats">
              <ul className="flex flex-col gap-1.5 text-xs text-ink-secondary">
                {teardownQ.data.caveats.map((c, i) => (
                  <li key={i} className="flex gap-2">
                    <span className="shrink-0 text-ink-muted">·</span>
                    <span>{c}</span>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </>
      )}
    </div>
  );
}

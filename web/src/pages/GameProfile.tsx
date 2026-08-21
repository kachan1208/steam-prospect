import { useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import clsx from "clsx";

import { AspectDivergingBars } from "../components/charts/AspectDivergingBars";
import { ChannelShareBars } from "../components/charts/ChannelShareBars";
import { GameMetricDrilldown, DRILLDOWN_META, type DrilldownMetric, type OwnersPerReview } from "../components/charts/GameMetricDrilldown";
import { LanguageSplitChart } from "../components/charts/LanguageSplitChart";
import { LaunchShapeBars } from "../components/charts/LaunchShapeBars";
import { PressBySourceChart } from "../components/charts/PressBySourceChart";
import { PressTimelineChart } from "../components/charts/PressTimelineChart";
import { ReviewsTimelineChart } from "../components/charts/ReviewsTimelineChart";
import { GameTrendsChart } from "../components/charts/GameTrendsChart";
import { NotableCoverageCard } from "../components/NotableCoverageCard";
import { Badge } from "../components/ui/Badge";
import { SocialLinks } from "../components/ui/SocialLinks";
import { Meter, BulletMeter } from "../components/ui/Meter";
import { ViewToggle } from "../components/ui/ViewToggle";
import { trackEvent } from "../lib/analytics";
import {
  useGameChannelMix,
  useGameComparables,
  useGameProfile,
  useGameReviewsSummary,
  useGameTeardown,
  useLaunchCurve,
  useMarketBenchmarks,
  useNicheDetail,
} from "../lib/api";
import { COMPARE_CAP, toggleCompare, useCompareList } from "../lib/compareList";
import { splitEntities } from "../lib/entities";
import { fmtCompact, fmtInt, fmtMinutes, fmtMonths, fmtPct, fmtPrice, fmtRevenue, fmtUsd, monthName } from "../lib/format";
import { heatDomain, heatStyle, positiveRatioClass } from "../lib/heat";
import { CSS_VAR } from "../lib/palette";
import { useDetailView } from "../lib/viewMode";

const TABS = [
  { key: "overview", label: "Overview" },
  { key: "teardown", label: "Why it works" },
] as const;
type TabKey = (typeof TABS)[number]["key"];

const CONDENSED: CSSProperties = { fontFamily: '"Barlow Condensed", "Barlow", system-ui, sans-serif' };

/** DuckDB TIMESTAMP strings ("2017-03-06 23:59:53" / "...53.255353") -> "2017-03-06". */
function dateOnly(s: string | null): string {
  return s ? s.slice(0, 10) : "—";
}

/**
 * The blueprint frame — THE signature mark of the Industry identity: a hairline box with
 * four "+" registration marks overhanging the corners (drawn by .blueprint/.bp-corner in
 * index.css, foundation-owned). `accent` swaps the border to accent-300 for the one
 * emphasized frame per screen (here: the Estimates panel) — an inline style, because
 * .blueprint's own `border` shorthand is declared after Tailwind's utility layer and would
 * otherwise beat a `border-*` utility class on specificity ties.
 */
function BlueprintFrame({
  children,
  className,
  accent,
  style,
}: {
  children: ReactNode;
  className?: string;
  accent?: boolean;
  style?: CSSProperties;
}) {
  return (
    <div className={clsx("blueprint relative", className)} style={accent ? { borderColor: "var(--brand)", ...style } : style}>
      <i className="bp-corner" />
      {children}
    </div>
  );
}

/** BlueprintFrame + the Card-shaped title/subtitle/action header this page's sections were
 * already using — kept as a drop-in so every existing section only changes its wrapper, not
 * its content. Card itself (src/components/ui/Card.tsx) can't grow corner marks without
 * editing a file another agent owns, so this local twin carries the blueprint grammar
 * instead of Card for every panel on this page. */
function BlueprintPanel({
  children,
  className,
  title,
  subtitle,
  action,
  accent,
}: {
  children: ReactNode;
  className?: string;
  title?: ReactNode;
  subtitle?: ReactNode;
  action?: ReactNode;
  accent?: boolean;
}) {
  return (
    <BlueprintFrame accent={accent} className={clsx("px-[22px] py-[18px]", className)}>
      {(title || action) && (
        <div className="mb-3.5 flex items-start justify-between gap-3">
          <div>
            {title && <h5 className="text-[16px] text-ink-primary">{title}</h5>}
            {subtitle && <p className="mt-1 text-xs leading-relaxed text-ink-muted">{subtitle}</p>}
          </div>
          {action}
        </div>
      )}
      {children}
    </BlueprintFrame>
  );
}

/** Header add/remove-from-compare toggle — the profile-header twin of the search rows'
 * per-row button. "+ Compare" is the primary action on this screen (accent-300 fill, per
 * the 4c handoff); already-queued flips to a hairline tinted "added" state instead of a
 * second competing fill color. */
function CompareToggle({ appid, name }: { appid: number; name: string | null }) {
  const list = useCompareList();
  const inList = list.some((e) => e.appid === appid);
  const full = !inList && list.length >= COMPARE_CAP;
  return (
    <button
      type="button"
      onClick={() => toggleCompare(appid, name)}
      disabled={full}
      aria-pressed={inList}
      title={
        inList
          ? "Remove from compare list"
          : full
            ? `Compare list is full (max ${COMPARE_CAP})`
            : "Add to the compare list (tray at the bottom of the screen)"
      }
      className={clsx(
        "inline-flex items-center gap-1.5 border px-3.5 py-[7px] text-xs font-semibold transition-colors",
        inList ? "border-brand bg-brand-tint text-brand" : "border-brand bg-brand text-brand-fg hover:bg-brand-hover",
        full && "cursor-not-allowed opacity-40",
      )}
    >
      {inList ? "✓ Comparing" : "+ Compare"}
    </button>
  );
}

/** "+ Watchlist" — the mockup's secondary header action (4c) and the trigger for the
 * Watchlist feature (4f). That page is still a shell (src/pages/Watchlist.tsx — another
 * agent's file) with no persisted store behind it yet, and wiring one up isn't this page's
 * to build (it would live in src/lib/*, also out of scope here) — so this renders the
 * correct hairline affordance but stays honestly inert rather than faking a save. */
function WatchlistButton() {
  return (
    <button
      type="button"
      disabled
      title="Watchlist is coming soon — not yet wired to persistent storage."
      className="inline-flex cursor-not-allowed items-center gap-1.5 border border-chartborder px-3.5 py-[7px] text-xs font-semibold text-ink-secondary opacity-50"
    >
      + Watchlist
    </button>
  );
}

/** The credit line's comma-joined developers/publishers string as per-entity links to
 * /entity/:role?name=… — split via splitEntities (suffix-aware; "Studio, Inc." stays ONE
 * link), never a naive split(","). */
function CreditLinks({ role, joined }: { role: "developer" | "publisher"; joined: string }) {
  return (
    <>
      {splitEntities(joined).map((n, i) => (
        <span key={`${n}-${i}`}>
          {i > 0 && ", "}
          <Link
            to={`/entity/${role}?name=${encodeURIComponent(n)}`}
            title={`View ${role} profile`}
            className="underline decoration-chartborder decoration-dotted underline-offset-2 hover:text-ink-primary hover:decoration-solid"
          >
            {n}
          </Link>
        </span>
      ))}
    </>
  );
}

/** One row of the sidebar Estimates panel — label left / condensed value right, doubling as
 * the click target for the metric drilldown when `onClick` is given (same tiles → chart
 * convention the old StatTile grid used, just laid out as list rows per the 4c mock). */
function EstimateRow({
  label,
  value,
  valueClassName,
  sub,
  onClick,
  active,
  help,
}: {
  label: string;
  value: ReactNode;
  valueClassName?: string;
  sub?: ReactNode;
  onClick?: () => void;
  active?: boolean;
  help?: string;
}) {
  const interactive = onClick !== undefined;
  return (
    <div
      role={interactive ? "button" : undefined}
      tabIndex={interactive ? 0 : undefined}
      aria-pressed={interactive ? (active ?? false) : undefined}
      onClick={onClick}
      onKeyDown={(e) => {
        if (!interactive) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick?.();
        }
      }}
      title={help}
      className={clsx(interactive && "-mx-1 cursor-pointer px-1 py-0.5 transition-colors hover:bg-page", active && "bg-brand-tint")}
    >
      <div className="flex items-baseline gap-3">
        <span className="text-[13.5px] text-ink-secondary">
          {label}
          {help && <span aria-hidden className="ml-1 text-[10px] text-ink-muted/70">ⓘ</span>}
        </span>
        <span className={clsx("ml-auto shrink-0 text-[17px] font-semibold", valueClassName ?? "text-ink-primary")} style={CONDENSED}>
          {value}
        </span>
      </div>
      {sub && <div className="mt-0.5 text-[11px] text-ink-muted">{sub}</div>}
    </div>
  );
}

export default function GameProfile() {
  const { appid: appidParam } = useParams<{ appid: string }>();
  const navigate = useNavigate();
  const appid = appidParam ? Number(appidParam) : NaN;
  const validAppid = Number.isFinite(appid);
  const [tab, setTab] = useState<TabKey>("overview");
  const [selectedMetric, setSelectedMetric] = useState<DrilldownMetric | null>(null);
  const [view, setView] = useDetailView();

  const profileQ = useGameProfile(validAppid ? appid : null);
  const comparablesQ = useGameComparables(validAppid ? appid : null);
  const reviewsQ = useGameReviewsSummary(validAppid ? appid : null);
  const genreCurveQ = useLaunchCurve(profileQ.data?.primary_genre ?? "__all__");
  const benchmarksQ = useMarketBenchmarks();
  const teardownQ = useGameTeardown(validAppid ? appid : null);
  const channelMixQ = useGameChannelMix(validAppid ? appid : null);

  // "In niches" (sidebar, §4c) — up to 3 of the game's own top tags, resolved to their real
  // niche opportunity score via the SAME endpoint the Niche Finder/deep-dive use. Fixed-count
  // hook calls (not one per tag in a loop) so the Rules of Hooks hold before `profile` exists.
  const nicheTag0 = profileQ.data?.top_tags?.[0] ?? null;
  const nicheTag1 = profileQ.data?.top_tags?.[1] ?? null;
  const nicheTag2 = profileQ.data?.top_tags?.[2] ?? null;
  const niche0Q = useNicheDetail("tag", nicheTag0);
  const niche1Q = useNicheDetail("tag", nicheTag1);
  const niche2Q = useNicheDetail("tag", nicheTag2);
  const inNiches = [
    { tag: nicheTag0, q: niche0Q },
    { tag: nicheTag1, q: niche1Q },
    { tag: nicheTag2, q: niche2Q },
  ]
    .filter((e): e is { tag: string; q: typeof niche0Q } => e.tag !== null)
    .map((e) => {
      const variant = e.q.data?.variants.find((v) => v.window === "24m") ?? e.q.data?.variants[0];
      return { tag: e.tag, opp: variant?.opportunity_v2 ?? null };
    })
    .filter((e) => e.opp !== null);

  const profile = profileQ.data;

  const revenueRange = useMemo(() => {
    const bx = benchmarksQ.data?.cited.boxleiter_owners_per_review;
    if (!profile || !bx || profile.total_reviews === null || profile.price_initial === null) return null;
    const r = profile.total_reviews;
    const p = profile.price_initial;
    return { low: r * bx.min * p, mid: profile.est_rev_reviews ?? r * bx.mid * p, high: r * bx.max * p };
  }, [profile, benchmarksQ.data]);

  // Owners-per-review ratio for the Owners/Revenue drilldowns — same source + fallback the
  // Owners/Revenue rows themselves imply: the cited Boxleiter mid when benchmarks are
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
      <BlueprintPanel>
        <div className="py-8 text-center text-sm text-verdict-serious">Invalid game ID in the URL.</div>
      </BlueprintPanel>
    );
  }

  if (profileQ.isLoading) {
    return <div className="p-6 text-sm text-ink-muted">Loading game…</div>;
  }

  if (profileQ.isError || !profile) {
    return (
      <BlueprintPanel>
        <div className="flex flex-col items-center gap-2 py-8 text-center text-sm">
          <span className="text-verdict-serious">
            Game not found{profileQ.error instanceof Error ? `: ${profileQ.error.message}` : "."}
          </span>
          <Link to="/games" className="text-brand hover:underline">
            Back to search
          </Link>
        </div>
      </BlueprintPanel>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <Link to="/games" className="text-xs text-ink-muted hover:text-ink-primary">
        ← Back to search
      </Link>

      {/* Header — capsule + facts/tags/credits+socials/badges, unframed (per the 4c mock the
          blueprint treatment belongs to the capsule image and the content panels below, not
          the hero text block itself). */}
      <div className="flex flex-col gap-5 sm:flex-row">
        <BlueprintFrame className="h-32 w-full shrink-0 overflow-hidden sm:h-[86px] sm:w-[184px]">
          {profile.header_image ? (
            <img src={profile.header_image} alt="" className="h-full w-full object-cover" />
          ) : (
            <div
              className="grid h-full w-full place-items-center text-center text-[10px] uppercase tracking-[0.08em] text-ink-muted"
              style={{
                ...CONDENSED,
                backgroundImage:
                  "repeating-linear-gradient(45deg, color-mix(in srgb, var(--text-primary) 10%, transparent) 0 5px, transparent 5px 10px)",
              }}
            >
              Capsule 616×353
            </div>
          )}
        </BlueprintFrame>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                <h1 className="text-[32px] leading-[1.12] text-ink-primary">{profile.name ?? `App ${profile.appid}`}</h1>
                <a
                  href={`https://store.steampowered.com/app/${profile.appid}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs text-brand hover:underline"
                >
                  View on Steam ↗
                </a>
              </div>
              {/* The header used to put ALL of this on one wrapping line at one weight: genre
                  badge, date, price, "Indie", "Self-published", catalog provenance, the
                  lifetime badge, "Demo", and the four social icons — ten heterogeneous things
                  competing as equals, so nothing was findable. Split by what each answers, and
                  badges are now spent only on the two that are a SIGNAL rather than a label. */}

              {/* What is this game: when, how much, what kind. */}
              <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-ink-secondary">
                <span>{profile.release_date ?? "Release date unknown"}</span>
                <span aria-hidden="true">·</span>
                <span>{fmtPrice(profile.price_initial)}</span>
                {profile.primary_genre && (
                  <>
                    <span aria-hidden="true">·</span>
                    <span>{profile.primary_genre}</span>
                  </>
                )}
                {profile.is_indie === 1 && (
                  <>
                    <span aria-hidden="true">·</span>
                    <span>Indie</span>
                  </>
                )}
                {/* When WE first saw the game — provenance about our own coverage, not a fact
                    about the game, so it is the quietest thing here and it is dropped below
                    `sm`. On a phone it otherwise wrapped to a line of its own led by an
                    orphaned separator, spending a whole row on the least useful item. */}
                {profile.first_seen && !Number.isNaN(Date.parse(profile.first_seen)) && (
                  <span
                    className="hidden items-center gap-x-2 text-ink-muted sm:inline-flex"
                    title={`First seen in our catalog: ${profile.first_seen}`}
                  >
                    <span aria-hidden="true">·</span>
                    <span>
                      in catalog since{" "}
                      {new Date(profile.first_seen).toLocaleDateString(undefined, { year: "numeric", month: "short" })}
                    </span>
                  </span>
                )}
              </div>

              {/* Outline accent tags — the game's own top tags, square-cornered accent-300
                  outline per the 4c mock. Reused verbatim (same tags/order) by the "In niches"
                  sidebar panel below, so header and sidebar read as the same set. */}
              {profile.top_tags.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {profile.top_tags.map((t) => (
                    <span key={t} className="border border-brand px-2 py-0.5 text-[11px] text-brand">
                      {t}
                    </span>
                  ))}
                </div>
              )}

              {/* Who made it — with their channels attached to them, instead of floating among
                  unrelated badges where they read as just more chrome. */}
              <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-ink-secondary">
                {profile.developers ? (
                  <CreditLinks role="developer" joined={profile.developers} />
                ) : (
                  "Unknown developer"
                )}
                {profile.publishers && profile.publishers !== profile.developers && (
                  <>
                    <span aria-hidden="true">·</span>
                    <CreditLinks role="publisher" joined={profile.publishers} />
                  </>
                )}
                {/* Only when it SAYS something. "Self-published" is a real signal about who
                    carries the risk; "Has a publisher" appended to a line that already names
                    three of them is words for nothing — and on a phone it cost the line an
                    extra wrap. */}
                {profile.self_published === 1 && (
                  <>
                    <span aria-hidden="true">·</span>
                    <span>Self-published</span>
                  </>
                )}
                <SocialLinks
                  x={profile.dev_x_handle}
                  xUrl={profile.dev_x_url}
                  discordUrl={profile.dev_discord_url}
                  youtubeUrl={profile.dev_youtube_url}
                  bluesky={profile.dev_bluesky_handle}
                  blueskyUrl={profile.dev_bluesky_url}
                />
              </div>

              {/* Badges, and only here: a playable demo, and whether the audience survived.
                  Both are findings a reader would act on. The row disappears entirely when
                  neither applies, rather than leaving an empty gutter. */}
              {(profile.has_demo === true ||
                (profile.lifetime_alive === true && profile.lifetime_first_100_month) ||
                (profile.lifetime_alive === false && profile.lifetime_months != null)) && (
                <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                  {profile.lifetime_alive === true && profile.lifetime_first_100_month && (
                    <span title="Reached a monthly average of 100+ concurrent players then and still averages 10+ (steamcharts monthly history, top-8k coverage).">
                      <Badge color={CSS_VAR.demand}>
                        Audience alive since {monthName(Number(profile.lifetime_first_100_month.slice(5, 7)))}{" "}
                        {profile.lifetime_first_100_month.slice(0, 4)}
                      </Badge>
                    </span>
                  )}
                  {profile.lifetime_alive === false && profile.lifetime_months != null && (
                    <span title="Audience lifetime: months from the game's first month averaging 100+ concurrent players to its first full month averaging under 10 (steamcharts monthly history, top-8k coverage).">
                      <Badge color="var(--status-critical)">
                        Audience: {fmtMonths(profile.lifetime_months)} (100+ → &lt;10)
                      </Badge>
                    </span>
                  )}
                  {profile.has_demo === true && (
                    <a
                      href={`https://store.steampowered.com/app/${profile.demo_appid ?? profile.appid}`}
                      target="_blank"
                      rel="noreferrer"
                      title="Has a playable demo on Steam (from the game's own store metadata)"
                      className="hover:underline"
                    >
                      <Badge color={CSS_VAR.demand}>Demo</Badge>
                    </a>
                  )}
                </div>
              )}
            </div>

            {/* Actions: "+ Watchlist" (hairline) / "+ Compare" (primary) — right-aligned per
                the 4c mock's header row. */}
            <div className="flex shrink-0 items-center gap-2.5">
              <WatchlistButton />
              <CompareToggle appid={profile.appid} name={profile.name} />
            </div>
          </div>
          {profile.short_description && (
            <p className="mt-3 line-clamp-2 text-xs text-ink-secondary">{profile.short_description}</p>
          )}
        </div>
      </div>

      {/* Plain toggled buttons, not ARIA tabs — the full tabs contract (tabpanel ids,
          arrow-key nav) isn't implemented, and half a tab widget is worse for screen
          readers than honest pressed-state buttons. */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap gap-1.5" aria-label="Game profile sections">
          {TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              aria-pressed={tab === t.key}
              onClick={() => setTab(t.key)}
              className={clsx(
                "border px-3 py-1.5 text-xs font-medium transition-colors",
                tab === t.key ? "border-brand bg-brand text-brand-fg" : "border-chartborder text-ink-muted hover:text-ink-secondary",
              )}
            >
              {t.label}
            </button>
          ))}
        </div>
        {/* Simple/Detailed governs the Overview content only — hidden on the teardown tab
            so there's never a dead control on screen. */}
        {tab === "overview" && (
          <ViewToggle
            value={view}
            onChange={(v) => {
              setView(v);
              trackEvent("detail_view_toggle");
            }}
          />
        )}
      </div>

      {tab === "overview" && (
        <>
          {/* Body split — 1.7fr main / 1fr sidebar, gap 22px (§4c). Below `lg` it collapses to
              one column; the sidebar stays put above the main column's charts on a phone. */}
          <div className="grid grid-cols-1 gap-[22px] lg:grid-cols-[1.7fr_1fr] lg:items-start">
            <div className="flex min-w-0 flex-col gap-[22px]">
              <BlueprintPanel
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
                {/* Keyed on price, not is_free — fmtRevenue's R6-Siege case: is_free can be set on
                    titles with a real price and real revenue. */}
                {profile.price_initial === 0 && (
                  <p className="mt-3 text-[11px] italic text-ink-muted">
                    Revenue percentile isn't meaningful for free-to-play titles (box revenue is $0 at price $0) — read
                    review-count and owners percentile instead.
                  </p>
                )}
              </BlueprintPanel>

              {/* The chart-heavy expert cards live under the Detailed toggle; Simple keeps the
                  plain-language reads (header, percentile, comparables) only. */}
              {view === "detailed" && (
                <>
                  <BlueprintPanel
                    title="Review timeline"
                    subtitle="From the sampled reviews table (not Steam's full review count) — a recency-biased sample for older/popular titles"
                  >
                    {reviewsQ.isLoading && (
                      <div className="flex h-40 items-center justify-center text-xs text-ink-muted">Loading…</div>
                    )}
                    {reviewsQ.data && <ReviewsTimelineChart points={reviewsQ.data.timeline} />}
                  </BlueprintPanel>

                  <BlueprintPanel
                    title="Momentum over time"
                    subtitle="Monthly review velocity, live players, Twitch viewers, and creator mentions — the signals Prospect tracks over time (CCU/Twitch thicken as snapshots accumulate)"
                  >
                    <GameTrendsChart appid={profile.appid} />
                  </BlueprintPanel>

                  {/* Genre-level benchmark card sits AFTER the game's own timeline/momentum — a game
                      profile should lead with the game's own story, then the genre yardstick. */}
                  <BlueprintPanel
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
                          <div className="mb-3 border border-chartborder bg-page px-3 py-2 text-xs text-ink-secondary">
                            <span className="font-semibold text-ink-primary">{shape}.</span> {genreLabel} games land{" "}
                            <span className="font-semibold text-ink-primary">~{d30pct}%</span> of first-year reviews in the first
                            30 days{d7pct != null ? ` (${d7pct}% in week one)` : ""} — {note}
                          </div>
                        );
                      })()}
                    {genreCurveQ.isLoading && (
                      <div className="flex h-40 items-center justify-center text-xs text-ink-muted">Loading…</div>
                    )}
                    {genreCurveQ.data && <LaunchShapeBars points={genreCurveQ.data.points} height={220} />}
                    {genreCurveQ.data && (
                      <p className="mt-2 text-[11px] italic text-ink-muted">
                        Share of first-year reviews earned in each window after launch — genre median across{" "}
                        {(genreCurveQ.data.points[0]?.n_games ?? 0).toLocaleString()} {profile.primary_genre &&
                          profile.primary_genre !== "__all__"
                          ? profile.primary_genre
                          : ""}{" "}
                        titles — a benchmark for this title's own month-by-month trajectory, shown on the Momentum card above.
                      </p>
                    )}
                  </BlueprintPanel>

                  {/* Genre-level like Launch shape above: the channel mix is a property of the genre
                      (per-game channel data is too sparse), so it sits with the genre yardsticks. Hidden
                      entirely (no empty card) when the genre has no channel rows or the mart predates
                      the channel-mix ETL — same pattern as NotableCoverageCard on the teardown tab. */}
                  {channelMixQ.data && channelMixQ.data.channels.length > 0 && (
                    <BlueprintPanel
                      title="Where this genre gets attention"
                      subtitle={`Marketing-channel mix for ${channelMixQ.data.genre} — each channel's share of tracked coverage (press articles + YouTube/Reddit/Twitch/X creator mentions), a genre-level read, not this game's own footprint`}
                    >
                      <ChannelShareBars channels={channelMixQ.data.channels} />
                      <p className="mt-3 text-[11px] italic text-ink-muted">
                        One press article = one creator mention = one unit of volume. Hover a channel for its audience-weighted
                        share — that read skews almost entirely toward big-subscriber channels, since a creator mention counts
                        their whole audience while a press article counts 1.
                      </p>
                    </BlueprintPanel>
                  )}

                  <BlueprintPanel title="Language split" subtitle="Share of sampled reviews by language — a localization reference">
                    {reviewsQ.isLoading && (
                      <div className="flex h-24 items-center justify-center text-xs text-ink-muted">Loading…</div>
                    )}
                    {reviewsQ.data && <LanguageSplitChart data={reviewsQ.data.language_split} />}
                  </BlueprintPanel>

                  <BlueprintPanel title="Playtime">
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
                  </BlueprintPanel>
                </>
              )}

              <BlueprintPanel
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
                  <div className="overflow-x-auto border border-chartborder">
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
                        {comparablesQ.data.items.map((c, _i, all) => (
                          <tr
                            key={c.appid}
                            className="cursor-pointer border-b border-chartborder/60 last:border-0 hover:bg-page"
                            onClick={() => navigate(`/games/${c.appid}`)}
                          >
                            <td className="max-w-[200px] truncate px-2 py-1.5 font-medium" title={c.name ?? undefined}>
                              {/* Focusable link so the table is keyboard-reachable; row onClick stays as a
                                  mouse convenience. */}
                              <Link
                                to={`/games/${c.appid}`}
                                onClick={(e) => e.stopPropagation()}
                                className="text-ink-primary hover:text-brand hover:underline"
                              >
                                {c.name ?? `App ${c.appid}`}
                              </Link>
                            </td>
                            <td className="tabular px-2 py-1.5">{c.release_year ?? "—"}</td>
                            <td className="tabular px-2 py-1.5">{fmtPrice(c.price_initial)}</td>
                            <td className="tabular px-2 py-1.5">{fmtInt(c.total_reviews)}</td>
                            <td className={clsx("tabular px-2 py-1.5", positiveRatioClass(c.positive_ratio))}>
                              {fmtPct(c.positive_ratio)}
                            </td>
                            <td className="tabular px-2 py-1.5">
                              <span
                                className="px-1.5 py-0.5"
                                style={heatStyle(c.est_rev_reviews, ...heatDomain(all, (x) => x.est_rev_reviews))}
                              >
                                {fmtRevenue(c.est_rev_reviews, c.price_initial === 0)}
                              </span>
                            </td>
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
              </BlueprintPanel>
            </div>

            {/* Sidebar — Estimates (the one accent-300-bordered frame) then In niches. Sticky
                on desktop so it stays visible while the main column's charts scroll. */}
            <div className="flex flex-col gap-[22px] lg:sticky lg:top-4">
              <BlueprintFrame accent className="flex flex-col gap-2.5 px-[22px] py-[18px]">
                <div className="kicker text-[11px] text-brand">Estimates</div>
                <div className="flex flex-col gap-2.5">
                  <EstimateRow
                    label="Gross revenue"
                    help="Estimated lifetime GROSS revenue: reviews × an owners-per-review ratio (~20-55, genre-fitted) × launch price. An estimate with real error bars. Not net of Steam's cut, refunds or discounts."
                    value={fmtRevenue(revenueRange ? revenueRange.mid : profile.est_rev_reviews, profile.price_initial === 0)}
                    sub={
                      profile.price_initial === 0
                        ? "Free-to-play — no box revenue at $0 price"
                        : revenueRange
                          ? `${fmtUsd(revenueRange.low)} – ${fmtUsd(revenueRange.high)}`
                          : undefined
                    }
                    onClick={() => toggleMetric("revenue")}
                    active={selectedMetric === "revenue"}
                  />
                  <EstimateRow
                    label="Units sold"
                    help="Estimated copies owned (SteamSpy midpoint, review-modeled for coarse buckets). Owned ≠ played ≠ paid full price."
                    value={fmtCompact(profile.owners_mid)}
                    onClick={() => toggleMetric("owners")}
                    active={selectedMetric === "owners"}
                  />
                  <EstimateRow
                    label="Reviews"
                    help="The game's true Steam review count and positive share. Below ~80% positive starts costing visibility (Steam's 'Mostly Positive' threshold)."
                    value={
                      <span className={positiveRatioClass(profile.positive_ratio)}>
                        {fmtInt(profile.total_reviews)} · {fmtPct(profile.positive_ratio)}
                      </span>
                    }
                    sub={[
                      `${fmtInt(profile.n_reviews_trailing_30d)} sampled in trailing 30d`,
                      profile.metacritic_score
                        ? profile.metacritic_url
                          ? undefined // link rendered separately below to stay clickable
                          : `Metacritic ${profile.metacritic_score}`
                        : null,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                    onClick={() => toggleMetric("reviews")}
                    active={selectedMetric === "reviews"}
                  />
                  {profile.metacritic_score && profile.metacritic_url && (
                    <a
                      href={profile.metacritic_url}
                      target="_blank"
                      rel="noreferrer"
                      className="-mt-2 text-[11px] text-ink-muted hover:text-brand hover:underline"
                    >
                      Metacritic {profile.metacritic_score}
                    </a>
                  )}
                  <EstimateRow
                    label="Players now"
                    help="Concurrent players at our last nightly capture (~21-22:00 UTC) — a point sample, NOT the daily peak. Click for the daily history."
                    value={profile.live_players != null ? fmtCompact(profile.live_players) : "—"}
                    valueClassName="text-brand"
                    sub={
                      [
                        profile.players_trend_7d_pct != null
                          ? `${profile.players_trend_7d_pct >= 0 ? "+" : ""}${profile.players_trend_7d_pct.toFixed(1)}% vs prior 7d`
                          : null,
                        profile.twitch_viewers ? `${fmtCompact(profile.twitch_viewers)} watching on Twitch` : null,
                      ]
                        .filter(Boolean)
                        .join(" · ") || undefined
                    }
                    onClick={() => toggleMetric("live_players")}
                    active={selectedMetric === "live_players"}
                  />
                </div>
                <div className="mt-1 border-t border-chartborder pt-2.5 text-[11px] text-ink-muted">
                  Gross revenue = reviews × owners-per-review (genre-fitted) × launch price, lifetime. Units and reviews are
                  point-in-time reads from the catalog, not verified sales data.
                </div>
              </BlueprintFrame>

              {inNiches.length > 0 && (
                <BlueprintPanel title="In niches">
                  <div className="flex flex-col gap-2.5 text-[13px]">
                    {inNiches.map(({ tag, opp }) => (
                      <div key={tag} className="flex items-baseline gap-2">
                        <Link
                          to={`/niches/tag/${encodeURIComponent(tag)}`}
                          className="min-w-0 truncate text-ink-primary hover:text-brand hover:underline"
                        >
                          {tag}
                        </Link>
                        <span className={clsx("ml-auto shrink-0 tabular", (opp as number) >= 70 ? "text-brand" : "text-ink-secondary")}>
                          opp {(opp as number).toFixed(1)}
                        </span>
                      </div>
                    ))}
                  </div>
                </BlueprintPanel>
              )}
            </div>
          </div>

          {selectedMetric && (
            <BlueprintPanel
              title={DRILLDOWN_META[selectedMetric].title}
              subtitle={DRILLDOWN_META[selectedMetric].subtitle}
              action={
                <button
                  type="button"
                  onClick={() => setSelectedMetric(null)}
                  aria-label="Close drilldown"
                  className="flex h-7 w-7 shrink-0 items-center justify-center text-ink-secondary hover:bg-page hover:text-ink-primary"
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
            </BlueprintPanel>
          )}
        </>
      )}

      {tab === "teardown" && (
        <>
          <BlueprintPanel
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
              <div className="text-xs text-verdict-serious">
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
          </BlueprintPanel>

          <BlueprintPanel
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
                {teardownQ.data.press.press_pos_share != null &&
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
                          className="relative h-3 bg-page"
                          title={`${p.n_pos_articles} positive / ${p.n_neg_articles} negative${
                            p.n_neutral_articles ? ` (${p.n_neutral_articles} neutral excluded)` : ""
                          } of ${p.n_scored_articles} scored articles`}
                        >
                          <div className="absolute inset-y-0 left-0" style={{ width: `${posPct}%`, backgroundColor: CSS_VAR.praise }} />
                          <div
                            className="absolute inset-y-0 right-0"
                            style={{ width: `${100 - posPct}%`, backgroundColor: CSS_VAR.complaint }}
                          />
                          <div className="absolute inset-y-0 w-[2px] bg-page" style={{ left: `calc(${posPct}% - 1px)` }} />
                        </div>
                        <div className="mt-1 text-[11px] text-ink-muted">
                          {fmtInt(p.n_pos_articles)} positive · {fmtInt(p.n_neg_articles)} negative
                          {p.n_neutral_articles > 0 && <> · {fmtInt(p.n_neutral_articles)} neutral</>}
                          {typeof mc === "number" && (
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
          </BlueprintPanel>

          {teardownQ.data && teardownQ.data.press.notable.length > 0 && (
            <NotableCoverageCard press={teardownQ.data.press} />
          )}

          {teardownQ.data && teardownQ.data.caveats.length > 0 && (
            <BlueprintPanel title="Read this with caveats">
              <ul className="flex flex-col gap-1.5 text-xs text-ink-secondary">
                {teardownQ.data.caveats.map((c, i) => (
                  <li key={i} className="flex gap-2">
                    <span className="shrink-0 text-ink-muted">·</span>
                    <span>{c}</span>
                  </li>
                ))}
              </ul>
            </BlueprintPanel>
          )}
        </>
      )}
    </div>
  );
}

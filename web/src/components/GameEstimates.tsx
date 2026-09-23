import type { CSSProperties, ReactNode } from "react";
import clsx from "clsx";

import type { GamePlayersResponse, GameProfile } from "../lib/api";
import { fmtDay } from "../lib/dates";
import { fmtCompact, fmtInt, fmtPrice, fmtUsd } from "../lib/format";
import {
  estimateSentinel,
  fmtShareTrim,
  gameEstimate,
  missingEstimateText,
  playersTrendRead,
  SMALL_SAMPLE_REVIEWS,
  type OwnersPerReviewBand,
} from "../lib/gameEstimates";
import { glossary } from "../lib/glossary";
import { positiveRatioClass } from "../lib/heat";
import { InfoTip } from "./ui/InfoTip";
import { SentinelTag } from "./ui/SentinelTag";

const CONDENSED: CSSProperties = { fontFamily: '"Barlow Condensed", "Barlow", system-ui, sans-serif' };

/** The metrics the Estimates panel can open a drilldown for. Est. revenue and Est. units have
 * none: both are the review count × a constant, so over time they are the reviews curve. */
export type EstimateDrilldown = "reviews" | "live_players";

/**
 * One row of the Estimates panel: label + ⓘ left, value (or its sentinel) right, a sub-line
 * under both. With `onClick` the LABEL is a real button stretched over the row (its ::after
 * covers it), so the whole row stays the click target while the ⓘ — a button of its own — can
 * sit above it: a div with role="button" cannot contain another button (its children are
 * presentational), which is how the old row's ⓘ ended up a decorative, unpressable glyph.
 */
export function EstimateRow({
  label,
  value,
  valueClassName,
  sentinel,
  sub,
  tip,
  onClick,
  active,
  testId,
}: {
  label: string;
  /** The figure. Omit it when the row has no value — the sentinel then stands in for it. */
  value?: ReactNode;
  valueClassName?: string;
  /** A flag beside (or instead of) the value: "not estimated", "small sample"… */
  sentinel?: string | null;
  sub?: ReactNode;
  /** The row's <InfoTip>. */
  tip?: ReactNode;
  onClick?: () => void;
  active?: boolean;
  testId?: string;
}) {
  const interactive = onClick !== undefined;
  return (
    <div
      data-testid={testId}
      className={clsx(
        "relative",
        interactive && "-mx-1 px-1 py-0.5 transition-colors hover:bg-page",
        active && "bg-brand-tint",
      )}
    >
      <div className="flex items-baseline gap-3">
        <span className="flex min-w-0 items-center gap-1 text-[13.5px] text-ink-secondary">
          {interactive ? (
            <button
              type="button"
              aria-pressed={active ?? false}
              onClick={onClick}
              className="min-w-0 text-left after:absolute after:inset-0 after:content-[''] hover:text-ink-primary focus-visible:outline-none focus-visible:after:outline focus-visible:after:outline-2 focus-visible:after:outline-brand"
            >
              {label}
            </button>
          ) : (
            <span className="min-w-0">{label}</span>
          )}
          {/* Above the stretched button's ::after, so pressing the ⓘ never toggles the row. */}
          {tip && <span className="relative z-10 inline-flex">{tip}</span>}
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          {sentinel && <SentinelTag>{sentinel}</SentinelTag>}
          {value != null && (
            <span className={clsx("text-[17px] font-semibold", valueClassName ?? "text-ink-primary")} style={CONDENSED}>
              {value}
            </span>
          )}
        </span>
      </div>
      {sub && <div className="mt-0.5 text-[11px] leading-snug text-ink-muted">{sub}</div>}
    </div>
  );
}

/** "Jul 7, 2026", or null. */
function day(value: string | null | undefined): string | null {
  return fmtDay(value ?? null);
}

/**
 * THE ESTIMATES PANEL (2026-09-23). Every figure explains itself in place: a plain label, an
 * ⓘ with what it means, the exact formula and THIS game's numbers worked through it, and a
 * visible flag whenever the value is not a plain measurement — a 0-review game no longer reads
 * "$0.00 · $0.00 – $0.00", a free game no longer sells "296.1M units", and a price Steam
 * doesn't report is "Price unknown", never "Free".
 */
export function GameEstimatesPanel({
  profile,
  band,
  players,
  ownersAsOf,
  selected,
  onSelect,
  className,
}: {
  profile: GameProfile;
  /** The cited owners-per-review band (benchmarks) — defaults to 20 / 30 / 55. */
  band?: OwnersPerReviewBand;
  /** GET /games/{appid}/players, for the capture dates behind Players now. */
  players?: GamePlayersResponse | null;
  /** When the SteamSpy owners snapshot was taken ('YYYY-MM-DD'). */
  ownersAsOf?: string | null;
  selected: EstimateDrilldown | null;
  onSelect: (metric: EstimateDrilldown) => void;
  className?: string;
}) {
  const e = gameEstimate(profile, band);
  const b = band ?? { min: 20, mid: 30, max: 55 };
  const estimated = e.status === "estimated";
  const small = estimated && e.smallSample;
  const smallDetail = `only ${fmtInt(e.reviews)} reviews — under ${SMALL_SAMPLE_REVIEWS}, a handful of reviews moves this a lot`;
  const ownersVintage = day(ownersAsOf);
  const ownersLabel = `Owners (SteamSpy${ownersVintage ? `, as of ${ownersVintage}` : " snapshot, date not reported"})`;

  // ---- reviews ----
  const reviews = profile.total_reviews;
  const pos = profile.positive_ratio;
  const reviewsSmall = reviews != null && reviews > 0 && reviews < SMALL_SAMPLE_REVIEWS;
  const reviewsValue =
    reviews == null ? null : reviews === 0 ? "0 reviews" : `${fmtInt(reviews)} review${reviews === 1 ? "" : "s"}${pos != null ? ` · ${fmtShareTrim(pos)} positive` : ""}`;
  const reviewsSentinel =
    reviews == null ? "no data" : reviews === 0 ? "no rating yet" : pos == null ? "no rating" : reviewsSmall ? "small sample" : null;

  // ---- players ----
  const live = profile.live_players;
  const summary = players?.summary ?? null;
  const lastMeasured = summary?.last_date ?? null;
  const seriesAsOf = players?.data_as_of ?? null;
  const staleCapture =
    lastMeasured && seriesAsOf && Date.parse(seriesAsOf) - Date.parse(lastMeasured) > 2 * 86_400_000 ? lastMeasured : null;
  const trend = playersTrendRead({
    players_trend_7d_pct: profile.players_trend_7d_pct ?? summary?.players_trend_7d_pct,
    players_trend_7d_market_pct: profile.players_trend_7d_market_pct ?? summary?.players_trend_7d_market_pct,
    players_trend_7d_rel_pct: profile.players_trend_7d_rel_pct ?? summary?.players_trend_7d_rel_pct,
  });

  return (
    <div className={clsx("blueprint relative flex flex-col gap-2.5 px-[22px] py-[18px]", className)} style={{ borderColor: "var(--brand)" }}>
      <i className="bp-corner" />
      <div className="kicker text-[11px] text-brand">Estimates</div>
      <div className="flex flex-col gap-2.5">
        <EstimateRow
          testId="est-revenue"
          label={glossary("est_revenue").label}
          value={estimated ? fmtUsd(e.mid) : undefined}
          sentinel={estimateSentinel(e)}
          sub={estimated ? `range ${fmtUsd(e.low)} – ${fmtUsd(e.high)} (reviews × ${b.min} to × ${b.max} × price)` : missingEstimateText(e, "revenue")}
          tip={
            <InfoTip
              term="est_revenue"
              worked={estimated ? `${e.revenueWorked}; range ${e.rangeWorked}` : undefined}
              sentinel={estimated ? (small ? smallDetail : undefined) : missingEstimateText(e, "revenue")}
            />
          }
        />
        <EstimateRow
          testId="est-units"
          label={glossary("units").label}
          value={estimated ? fmtCompact(e.units) : undefined}
          sentinel={estimateSentinel(e)}
          sub={
            <>
              {estimated ? `${fmtUsd(e.mid)} ÷ ${fmtPrice(e.price)} launch price` : missingEstimateText(e, "units")}
              {profile.owners_mid != null && (
                <span className="mt-0.5 flex items-center gap-1">
                  <span>
                    {ownersLabel}: <span className="tabular text-ink-secondary">{fmtCompact(profile.owners_mid)}</span> — a
                    different method
                  </span>
                  <InfoTip
                    term="owners"
                    label={ownersLabel}
                    worked={`${fmtCompact(profile.owners_mid)} owners in the SteamSpy snapshot${ownersVintage ? ` of ${ownersVintage}` : ""}`}
                  />
                </span>
              )}
            </>
          }
          tip={
            <InfoTip
              term="units"
              worked={estimated ? e.unitsWorked : undefined}
              sentinel={estimated ? (small ? smallDetail : undefined) : missingEstimateText(e, "units")}
            />
          }
        />
        <EstimateRow
          testId="est-reviews"
          label="Reviews"
          value={reviewsValue ?? undefined}
          valueClassName={pos != null && !reviewsSmall ? positiveRatioClass(pos) : "text-ink-primary"}
          sentinel={reviewsSentinel}
          sub={
            reviews === 0
              ? "No reviews yet, so nothing below is estimated or ranked."
              : [
                  profile.n_reviews_trailing_30d > 0
                    ? `${fmtInt(profile.n_reviews_trailing_30d)} in our review sample from the last 30 days`
                    : reviews != null
                      ? "none in our review sample from the last 30 days"
                      : null,
                  profile.metacritic_score && !profile.metacritic_url ? `Metacritic ${profile.metacritic_score}` : null,
                ]
                  .filter(Boolean)
                  .join(" · ") || undefined
          }
          tip={
            <InfoTip
              label="Reviews"
              meaning={`${glossary("reviews").meaning} The share is ${glossary("positive_ratio").meaning.charAt(0).toLowerCase()}${glossary("positive_ratio").meaning.slice(1)}`}
              formula={glossary("positive_ratio").formula}
              worked={
                reviews == null
                  ? undefined
                  : reviews === 0
                    ? "0 reviews — no rating yet"
                    : `${fmtInt(reviews)} reviews${pos != null ? `, ${fmtShareTrim(pos)} positive` : ""}${reviewsSmall ? ` — under ${SMALL_SAMPLE_REVIEWS}, too few to rank or to trust the share` : ""}`
              }
              source={glossary("reviews").source}
            />
          }
          onClick={() => onSelect("reviews")}
          active={selected === "reviews"}
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
          testId="est-players"
          label={glossary("players_now").label}
          value={live != null ? fmtCompact(live) : undefined}
          valueClassName="text-brand"
          sentinel={live == null ? "not measured" : staleCapture ? `last measured ${day(staleCapture)}` : null}
          sub={
            live == null ? (
              "No player count captured for this game yet."
            ) : trend.trend ? (
              <>
                {trend.trend}
                {trend.market && <> · {trend.market}</>}
              </>
            ) : undefined
          }
          tip={
            <InfoTip
              term="players_now"
              worked={
                live == null
                  ? undefined
                  : [
                      `${fmtInt(live)} playing at the latest capture${lastMeasured ? ` (${day(lastMeasured)})` : ""}`,
                      trend.worked ? `7-day trend vs Steam: ${trend.worked}` : trend.trend ? `7-day trend: ${trend.trend}` : null,
                    ]
                      .filter(Boolean)
                      .join("; ")
              }
              sentinel={staleCapture ? `not captured since ${day(staleCapture)} — the figure is that day's` : undefined}
            />
          }
          onClick={() => onSelect("live_players")}
          active={selected === "live_players"}
        />
      </div>
      <details className="mt-1 border-t border-chartborder pt-2.5 text-[11px] leading-relaxed text-ink-muted">
        <summary className="cursor-pointer select-none text-ink-secondary hover:text-ink-primary">How this is estimated</summary>
        <p className="mt-1.5">
          Est. revenue = reviews × {b.mid} owners-per-review × launch price, lifetime and gross — one flat catalog-wide ratio (the
          Boxleiter mid), not fitted per genre; the range swaps in {b.min} and {b.max}. Est. units sold is that same estimate
          before the price multiply, so Est. revenue ÷ launch price = units exactly. The owners figure (a SteamSpy snapshot) is a
          separate method, not the partner of this revenue. Free-to-play and unknown-price games get no revenue estimate, and a game
          under {SMALL_SAMPLE_REVIEWS} reviews is flagged. Revenue and units have no chart of their own: both are the review count
          × a constant, so over time they trace the reviews curve exactly — open Reviews for it. Reviews are a point-in-time read
          from the catalog, not verified sales data.
        </p>
      </details>
    </div>
  );
}

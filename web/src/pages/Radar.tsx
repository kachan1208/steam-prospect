import { Link } from "react-router-dom";
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import clsx from "clsx";

import { TooltipPanel } from "../components/charts/TooltipPanel";
import { trackEvent } from "../lib/analytics";
import {
  ApiError,
  useRadarFeed,
  type RadarHero,
  type RadarNicheCard,
  type RadarSparklinePoint,
  type TrendPoint,
} from "../lib/api";
import { fmtInt, fmtSigned, fmtUsd } from "../lib/format";
import { nicheDetailPath } from "./NicheDetail";

/**
 * Radar — the opportunity feed that is now the index route (mockup 3a): a hero "blueprint"
 * plate on the cut's single biggest 90-day demand riser, then a grid of the cut's biggest
 * movers in either direction.
 *
 * THE DATA (read niches.py::radar_feed / _has_demand90 for the full story): the feed ranks
 * on demand_trend_90d_pct, a mart_niche column that landed 2026-08-21 — it is not in the
 * published mart until the next nightly rebuild. The API 503s until then, and this page
 * degrades to an honest "not available yet" message rather than a spinner or an empty grid
 * (see MartPending below). Every number rendered here is real: no series is invented to fill
 * a gap the marts don't cover — see HeroChart's doc for the one deliberate substitution
 * (yearly, not the mockup's monthly, demand-vs-pipeline shape) and Sparkline's doc for why a
 * card can legitimately show no sparkline at all.
 */

const CONDENSED = '"Barlow Condensed", "Barlow", system-ui, sans-serif';

function verdictLabel(v: number, digits = 1): string {
  const up = v >= 0;
  return `${up ? "▲" : "▼"} ${up ? "+" : "−"}${Math.abs(v).toFixed(digits)}%`;
}

export default function Radar() {
  const feedQ = useRadarFeed({ limit: 6 });
  const apiError = feedQ.error instanceof ApiError ? feedQ.error : null;
  // 503 is the EXPECTED state for hours after every deploy that adds a mart column — the
  // nightly rebuild (21:00 UTC) is what materialises demand_trend_90d_pct. Not an error the
  // user caused, and not a spinner: a stated wait, same convention as NicheCombined's
  // martPending / LaunchTiming's 503 handling.
  const martPending = apiError?.status === 503;
  // 404 = the cut has zero niches with a 90-day baseline yet (every prior-90d window was
  // empty) — a real, if unlikely, answer distinct from "not built yet".
  const noBaseline = apiError?.status === 404;

  return (
    <div className="mx-auto flex max-w-[1180px] flex-col gap-[30px]">
      {feedQ.isLoading && (
        <div className="py-10 text-center text-sm text-ink-muted">Loading the opportunity feed…</div>
      )}

      {martPending && (
        <div className="blueprint relative flex flex-col items-center gap-3 border-ink-primary/25 px-6 py-10 text-center">
          <i className="bp-corner" />
          <h2 className="text-ink-primary">The opportunity feed isn’t available yet</h2>
          <p className="max-w-md text-sm text-ink-secondary">
            Radar ranks niches on a 90-day demand trend that just landed in the marts. It appears after the next
            nightly rebuild (21:00 UTC) — nothing below is estimated or guessed in the meantime.
          </p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => feedQ.refetch()}
              disabled={feedQ.isFetching}
              className="border border-ink-primary/35 px-3 py-1.5 text-xs font-medium text-ink-primary transition-colors hover:bg-ink-primary/[0.08] disabled:pointer-events-none disabled:opacity-40"
            >
              {feedQ.isFetching ? "Checking…" : "Check again"}
            </button>
            <Link
              to="/niches"
              className="bg-brand px-3 py-1.5 text-xs font-semibold text-brand-fg transition-colors hover:bg-brand-hover"
            >
              Open Niche Finder
            </Link>
          </div>
        </div>
      )}

      {noBaseline && (
        <div className="blueprint relative border-ink-primary/25 px-6 py-10 text-center">
          <i className="bp-corner" />
          <p className="text-sm text-ink-secondary">
            No niches in this cut have a 90-day trend yet — too few reviews landed in the prior 90-day window for
            any of them.
          </p>
        </div>
      )}

      {feedQ.isError && !martPending && !noBaseline && (
        <div className="py-10 text-center text-sm text-status-serious">
          Failed to load the opportunity feed{feedQ.error instanceof Error ? `: ${feedQ.error.message}` : "."}
        </div>
      )}

      {feedQ.data && (
        <>
          <HeroPlate hero={feedQ.data.hero} />

          <div className="flex flex-wrap items-baseline gap-3">
            <h4 className="text-ink-primary">Moving niches</h4>
            <span className="text-[11px] text-ink-muted">90-day trend · buildable tags only</span>
            <Link to="/niches" className="ml-auto text-[13px] text-brand transition-colors hover:text-brand-hover">
              Open Niche Finder →
            </Link>
          </div>

          <div className="grid grid-cols-1 gap-[22px] sm:grid-cols-2 lg:grid-cols-3">
            {feedQ.data.movers.map((m) => (
              <NicheCard key={`${m.dimension}:${m.key}`} card={m} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function HeroPlate({ hero }: { hero: RadarHero }) {
  const up = hero.demand_trend_90d_pct >= 0;
  const pipelineClause =
    hero.saturation_yoy == null ? "" : hero.saturation_yoy < 0 ? " while its release pipeline shrinks" : " while its release pipeline grows";
  const satClause = hero.saturation_yoy != null ? ` against a ${fmtSigned(hero.saturation_yoy, 0)} saturation YoY` : "";
  const bodyTitle =
    "Sample review velocity: counts come from stg_review, a recency-biased SAMPLE (the review keeper deepens " +
    "toward min(true_total, 20k) per game), not Steam's true totals. The ratio between the two 90-day windows is " +
    "directionally sound; the raw counts are not Steam's absolute numbers.";

  return (
    <div className="blueprint relative flex flex-col border-ink-primary/25 lg:flex-row lg:items-stretch">
      <i className="bp-corner" />
      <div className="flex flex-col gap-2.5 px-6 py-6 lg:flex-1 lg:px-[30px] lg:py-[26px]">
        <div className="kicker text-[10px] tracking-[.12em] text-brand">This week · last 24 months · micro + theme tags</div>
        <h2 className="max-w-[560px] text-balance text-[26px] text-ink-primary sm:text-[32px]">
          {hero.key} demand is {up ? "up" : "down"}
          {pipelineClause}.
        </h2>
        <p className="max-w-[520px] text-sm text-ink-secondary" title={bodyTitle}>
          Sample review velocity {up ? "rose" : "fell"} {Math.abs(hero.demand_trend_90d_pct).toFixed(1)}% over 90
          days{satClause}. {fmtInt(hero.n_games)} scored games
          {hero.p90_rev != null ? `, P90 revenue ${fmtUsd(hero.p90_rev)}` : ""}.
        </p>
        <div className="mt-auto flex gap-2.5 pt-3.5">
          <Link
            to={nicheDetailPath(hero.dimension, hero.key)}
            onClick={() => trackEvent("niche_open")}
            className="bg-brand px-3.5 py-2 text-[13px] font-semibold text-brand-fg transition-colors hover:bg-brand-hover"
          >
            Open deep dive
          </Link>
          <Link
            to={nicheDetailPath(hero.dimension, hero.key, { tab: "games" })}
            onClick={() => trackEvent("niche_open")}
            className="border border-ink-primary/35 px-3.5 py-2 text-[13px] font-medium text-ink-primary transition-colors hover:bg-ink-primary/[0.08]"
          >
            See the {fmtInt(hero.n_games)} games
          </Link>
        </div>
      </div>

      <div className="flex flex-col gap-2 border-t border-ink-primary/25 px-6 py-5 lg:w-[400px] lg:flex-none lg:border-l lg:border-t-0 lg:px-[26px] lg:py-[22px]">
        <div className="flex items-baseline gap-2.5">
          <span
            className={clsx("tabular", up ? "text-brand" : "text-ink-primary/55")}
            style={{ fontFamily: CONDENSED, fontWeight: 600, fontSize: 40 }}
          >
            {verdictLabel(hero.demand_trend_90d_pct)}
          </span>
          <span className="text-[11px] text-ink-muted">demand / 90 days</span>
        </div>
        <HeroChart trend={hero.trend} />
      </div>
    </div>
  );
}

/**
 * The hero chart column. Mockup 3a shows a smooth ~13-point (roughly monthly) two-series
 * curve, but no mart materialises niche review velocity or releases at that granularity —
 * demand_trend_90d_pct itself is only two aggregate 90-day windows, not a series. This
 * reuses the same real, yearly mart_niche_trend series NicheDetail's "Demand vs. pipeline,
 * by year" panel already charts for the identical gap (§4b — "same two-series language as
 * hero", per the handoff) rather than inventing a monthly shape.
 */
function HeroChart({ trend }: { trend: TrendPoint[] }) {
  if (trend.length === 0) {
    return <div className="flex h-[110px] items-center justify-center text-xs text-ink-muted">No yearly trend for this niche.</div>;
  }
  const hasP90Trend = trend.some((p) => p.p90_rev != null);
  return (
    <div className="flex flex-col gap-1.5">
      <ResponsiveContainer width="100%" height={110}>
        <LineChart data={trend} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
          <CartesianGrid stroke="var(--gridline)" vertical={false} />
          <XAxis dataKey="year" hide />
          <YAxis yAxisId="revenue" hide domain={["auto", "auto"]} />
          <YAxis yAxisId="releases" orientation="right" hide domain={[0, "auto"]} />
          <Tooltip
            cursor={{ stroke: "var(--baseline)" }}
            content={({ active, payload, label }) => {
              if (!active || !payload || payload.length === 0) return null;
              const p = payload[0].payload as TrendPoint;
              return (
                <TooltipPanel
                  title={String(label)}
                  rows={[
                    {
                      label: hasP90Trend ? "P90 revenue" : "Median revenue",
                      value: fmtUsd(hasP90Trend ? (p.p90_rev ?? null) : p.median_rev),
                      color: "var(--brand)",
                    },
                    { label: "Releases", value: String(p.n_releases) },
                  ]}
                />
              );
            }}
          />
          <Line
            yAxisId="revenue"
            type="linear"
            dataKey={hasP90Trend ? "p90_rev" : "median_rev"}
            stroke="var(--brand)"
            strokeWidth={1.5}
            dot={false}
            connectNulls
          />
          <Line
            yAxisId="releases"
            type="linear"
            dataKey="n_releases"
            stroke="color-mix(in srgb, var(--text-primary) 45%, transparent)"
            strokeWidth={1.5}
            strokeDasharray="4 3"
            dot={false}
          />
        </LineChart>
      </ResponsiveContainer>
      <div className="flex gap-4 text-[11px] text-ink-muted">
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-[2px] w-3.5 bg-brand" aria-hidden />
          {hasP90Trend ? "P90 revenue" : "Median revenue"}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-[2px] w-3.5 bg-ink-primary/45" aria-hidden />
          Releases (pipeline)
        </span>
      </div>
    </div>
  );
}

/** One "Moving niches" grid card. Verdict/kicker tone follows the SAME up/down rule
 * everywhere: accent-300 when the 90-day trend is up, paper (ink-primary/55) when it's down
 * — never red/green, per the foundation. The opp v2 score bolds accent-300 independently, at
 * the same >=70 "strong" threshold NicheFinder's table already uses. */
function NicheCard({ card }: { card: RadarNicheCard }) {
  const up = card.demand_trend_90d_pct >= 0;
  const tone = up ? "text-brand" : "text-ink-primary/55";
  const strongOpp = card.opportunity_v2 != null && card.opportunity_v2 >= 70;

  return (
    <Link
      to={nicheDetailPath(card.dimension, card.key)}
      onClick={() => trackEvent("niche_open")}
      className="blueprint relative flex flex-col gap-2 border-ink-primary/25 px-5 py-[18px] transition-colors hover:bg-ink-primary/[0.04]"
    >
      <i className="bp-corner" />
      <div className="flex items-baseline">
        <span className={clsx("kicker text-[11px]", tone)}>
          {card.tier ?? "niche"} · {fmtInt(card.n_games)} games
        </span>
        <span className={clsx("tabular ml-auto", tone)} style={{ fontFamily: CONDENSED, fontWeight: 600, fontSize: 20 }}>
          {verdictLabel(card.demand_trend_90d_pct)}
        </span>
      </div>
      <div className="text-ink-primary" style={{ fontFamily: CONDENSED, fontWeight: 600, fontSize: 20 }}>
        {card.key}
      </div>
      <Sparkline points={card.sparkline} up={up} />
      <div className="text-[11px] text-ink-muted">
        P90 rev {card.p90_rev != null ? fmtUsd(card.p90_rev) : "—"} · opp v2{" "}
        <span className={clsx("tabular", strongOpp && "font-semibold text-brand")}>
          {card.opportunity_v2 != null ? card.opportunity_v2.toFixed(1) : "—"}
        </span>
        {card.players_trend_7d_pct != null && (
          <>
            {" "}
            · players 7d {card.players_trend_7d_pct >= 0 ? "+" : "−"}
            {Math.abs(card.players_trend_7d_pct).toFixed(1)}%
          </>
        )}
      </div>
    </Link>
  );
}

/**
 * The card's 44px sparkline: real monthly player history (mart_niche_players_monthly,
 * steamcharts top-8k coverage, years deep) — not an invented curve. Degrades to a flat
 * dashed baseline (never a fabricated shape) when a niche has fewer than two months of
 * history, e.g. because that mart predates the niche or doesn't exist on this build yet.
 */
function Sparkline({ points, up }: { points: RadarSparklinePoint[]; up: boolean }) {
  const w = 260;
  const h = 44;
  if (points.length < 2) {
    return (
      <svg viewBox={`0 0 ${w} ${h}`} className="h-11 w-full" aria-hidden>
        <line x1="0" y1={h - 6} x2={w} y2={h - 6} stroke="var(--gridline)" strokeWidth={1} strokeDasharray="3 3" />
      </svg>
    );
  }
  const stroke = up ? "var(--brand)" : "color-mix(in srgb, var(--text-primary) 45%, transparent)";
  const values = points.map((p) => p.players);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const pad = 4;
  const coords = points
    .map((p, i) => {
      const x = (i / (points.length - 1)) * w;
      const y = pad + (1 - (p.players - min) / span) * (h - pad * 2);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="h-11 w-full" aria-hidden>
      <polyline points={coords} fill="none" stroke={stroke} strokeWidth={1.5} />
    </svg>
  );
}

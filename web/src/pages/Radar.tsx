import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import clsx from "clsx";

import { RadarBoard, type RadarBoardBlip, type RadarSector } from "../components/RadarBoard";
import { TooltipPanel } from "../components/charts/TooltipPanel";
import { trackEvent } from "../lib/analytics";
import {
  ApiError,
  useNiches,
  useRadarFeed,
  type NicheRow,
  type RadarHero,
  type RadarNicheCard,
  type RadarSparklinePoint,
  type TrendPoint,
} from "../lib/api";
import { fmtCompact, fmtInt, fmtSigned, fmtUsd } from "../lib/format";
import { radarVerdict, soloBucket, type SoloBucket } from "../lib/radarVerdict";
import { nicheDetailPath } from "./NicheDetail";

/**
 * Radar — the index route. Two plates, top to bottom:
 *
 * 1. THE BOARD (RadarBoardSection) — a radial tech-radar: every niche in the cut plotted
 *    as a dot in (sector = Genres / Micro-genres / Themes, ring = client-side verdict from
 *    lib/radarVerdict.ts). Fed by the /api/niches LIST endpoint (two cuts: dimension=genre
 *    and dimension=tag tiers=micro,theme), NOT the radar feed — the feed caps at 24 movers.
 *    NicheRow carries demand_trend_24m_pct (last 24 complete months vs the prior 24 — the
 *    same horizon as the board's own pinned 24m cut; it replaced the 12m windows, which had
 *    replaced the spike-prone 90-day trend) on every row, so each blip rings on its own
 *    trend; rows without one (older mart / no baseline) degrade to the verdict lib's
 *    structural rules — documented there, flagged "caution" in the UI. Rows flagged
 *    demand_emerging (young tags with no comparable base) plate in their own Emerging ring
 *    and never headline their %. The stats cut is PINNED (24m × 50+ reviews) and the
 *    solo-viability lens filters/restyles dots without ever moving a ring — see
 *    BOARD_WINDOW's and lib/radarVerdict.ts's docs.
 *
 * 2. The original opportunity feed (mockup 3a): a hero "blueprint" plate on the cut's
 *    single biggest 24-month demand riser, then a grid of the cut's biggest movers in
 *    either direction, then the cut's EMERGING niches as their own mini-list (ranked by
 *    absolute volume — their % has no comparable base) — reflowed under an "Opportunity
 *    feed" section title.
 *
 * THE DATA (read niches.py::radar_feed / _has_demand24m for the full story): the feed ranks
 * on demand_trend_24m_pct, a mart_niche column that is not in the published mart until the
 * nightly rebuild after its deploy. The API 503s until then, and this page
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

// ---- the board --------------------------------------------------------------------------

/**
 * THE BOARD'S STATS CUT IS PINNED — deliberately not a control. mart_niche precomputes its
 * aggregates per (window, min_reviews) POPULATION: a review-floor toggle doesn't filter the
 * display, it swaps in a different population with different medians, different
 * saturation_yoy — and therefore, through radarVerdict(), a different RING for the same
 * niche. A verdict that moves when a display chip is clicked is not a verdict, so the board
 * always reads one cut and says so in its footnote. (NicheFinder keeps the floor chips —
 * there they are honest population controls over a table, not inputs to a verdict.)
 */
const BOARD_WINDOW = "24m";
const BOARD_MIN_REVIEWS = 50;

/** Blip cap so the board stays readable; "top N by opportunity_v2" across all sectors. */
const TOP_N_OPTIONS = [
  { v: 40, label: "40" },
  { v: 80, label: "80" },
  { v: 120, label: "120" },
];
/** Solo-viability lens (see lib/radarVerdict.ts: a LENS, never a ring input). "unknown"
 * (null solo_viability) is its own honest bucket: shown under All only — a filter for
 * solo-friendly must not include niches nobody measured. */
const SOLO_OPTIONS: { v: "all" | SoloBucket; label: string }[] = [
  { v: "all", label: "All" },
  { v: "solo", label: "Solo-friendly" },
  { v: "team", label: "Team-scale" },
];

/** Minimal segmented control in the app's hairline-border language (square, no fills
 * except the active brand chip) — same shape NicheFinder draws locally. Generic over the
 * option value so numeric (Top N) and string (solo lens) rows share one control. */
function SegRow<V extends string | number>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: { v: V; label: string }[];
  value: V;
  onChange: (v: V) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="kicker text-[10px] tracking-[.1em] text-ink-muted">{label}</span>
      <div className="inline-flex border border-ink-primary/30">
        {options.map((o, i) => (
          <button
            key={o.v}
            type="button"
            onClick={() => onChange(o.v)}
            className={clsx(
              "px-2.5 py-1 text-[12px] transition-colors",
              i > 0 && "border-l border-ink-primary/30",
              o.v === value ? "bg-brand font-semibold text-brand-fg" : "text-ink-primary hover:bg-ink-primary/[0.08]",
            )}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * The radial board plate: the pinned stats cut (BOARD_WINDOW × BOARD_MIN_REVIEWS — see
 * that constant's doc), display-only controls (top-N cap, solo lens), verdicts, and the
 * RadarBoard itself. Control state is local — this page has no URL-param convention to
 * reuse (the feed below it is unparameterized too).
 *
 * GET /api/niches carries demand_trend_24m_pct on every row (cut-independent in the mart
 * — neither a stats-floor nor a window change can move a niche's trend), so every blip
 * rings on its OWN 24-month trend. The old best-effort join against the radar feed's 24
 * top movers is gone with the reason it existed. Rows still without a trend (mart
 * predates the column, or no prior-window baseline) degrade in radarVerdict() to
 * structural evidence, caution-flagged — there is no shorter-horizon fallback, because
 * the 90-day/12-month columns this trend replaced are gone from the mart.
 */
function RadarBoardSection() {
  const [topN, setTopN] = useState(80);
  const [solo, setSolo] = useState<"all" | SoloBucket>("all");

  // The board population: the two cuts that make up the three sectors. Each query asks for
  // topN rows by opportunity_v2 so the merged top-N cap can never starve one dimension.
  const genreQ = useNiches({
    dimension: "genre",
    window: BOARD_WINDOW,
    min_reviews: BOARD_MIN_REVIEWS,
    sort: "opportunity_v2",
    order: "desc",
    limit: topN,
    offset: 0,
  });
  const tagQ = useNiches({
    dimension: "tag",
    window: BOARD_WINDOW,
    min_reviews: BOARD_MIN_REVIEWS,
    sort: "opportunity_v2",
    order: "desc",
    tiers: "micro,theme",
    limit: topN,
    offset: 0,
  });

  const blips = useMemo<RadarBoardBlip[]>(() => {
    const rows: RadarBoardBlip[] = [];
    const push = (row: NicheRow) => {
      const sector: RadarSector | null =
        row.dimension === "genre" ? "genre" : row.tier === "micro" ? "micro" : row.tier === "theme" ? "theme" : null;
      if (!sector) return; // tag tiers outside micro/theme have no sector on this board
      // ?? null: the field is absent (undefined) on marts that predate the demand columns.
      const demandTrendPct = row.demand_trend_24m_pct ?? null;
      const demandEmerging = row.demand_emerging === true;
      rows.push({
        dimension: row.dimension,
        key: row.key,
        tier: row.tier,
        sector,
        n_games: row.n_games,
        p90_rev: row.p90_rev ?? null,
        opportunity_v2: row.opportunity_v2,
        demandTrendPct,
        demandEmerging,
        reviews24m: row.reviews_24m ?? null,
        solo_viability: row.solo_viability ?? null,
        verdict: radarVerdict({
          demand_trend_24m_pct: demandTrendPct,
          demand_emerging: demandEmerging,
          saturation_yoy: row.saturation_yoy,
          winner_concentration: row.winner_concentration,
          opportunity_v2: row.opportunity_v2,
        }),
      });
    };
    for (const r of genreQ.data?.items ?? []) push(r);
    for (const r of tagQ.data?.items ?? []) push(r);
    // Solo lens BEFORE the top-N cap, so a solo-friendly board fills back up to N.
    // "unknown" (null) shows under All only — never claimed for either bucket.
    const seen = solo === "all" ? rows : rows.filter((b) => soloBucket(b.solo_viability) === solo);
    seen.sort((a, b) => (b.opportunity_v2 ?? -1) - (a.opportunity_v2 ?? -1) || a.key.localeCompare(b.key));
    return seen.slice(0, topN);
  }, [genreQ.data, tagQ.data, topN, solo]);

  const loading = genreQ.isLoading || tagQ.isLoading;
  const bothFailed = genreQ.isError && tagQ.isError;
  const partialFail = !bothFailed && (genreQ.isError || tagQ.isError);

  return (
    <section className="blueprint relative border-ink-primary/25 px-6 py-6 lg:px-[30px] lg:py-[26px]">
      <i className="bp-corner" />
      <div className="flex flex-wrap items-end gap-x-6 gap-y-3 pb-6">
        <div className="flex flex-col gap-1.5">
          <div className="kicker text-[10px] tracking-[.12em] text-brand">
            Verdict rings · last 24 months · genres + micro + theme tags
          </div>
          <h2 className="text-[26px] text-ink-primary sm:text-[30px]">Niche radar</h2>
        </div>
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 sm:ml-auto">
          <SegRow label="Solo-buildable" options={SOLO_OPTIONS} value={solo} onChange={setSolo} />
          <SegRow label="Top" options={TOP_N_OPTIONS} value={topN} onChange={setTopN} />
        </div>
      </div>

      {loading && <div className="py-16 text-center text-sm text-ink-muted">Plotting the board…</div>}
      {bothFailed && (
        <div className="py-16 text-center text-sm text-status-serious">
          Failed to load the niche cuts{genreQ.error instanceof Error ? `: ${genreQ.error.message}` : "."}
        </div>
      )}
      {!loading && !bothFailed && <RadarBoard blips={blips} />}

      {partialFail && (
        <p className="pt-3 text-[11px] text-ink-muted">
          One dimension failed to load — the board shows what arrived.
        </p>
      )}
      <p className="pt-4 text-[11px] text-ink-muted">
        Stats cut: last 24 months, niches with 50+ review games — pinned, so a display toggle can never move a verdict
        (the mart precomputes each cut as its own population). Demand trend: review inflow over the last 24 months vs
        the prior 24 — the same horizon as the cut itself, a structural read that a release spike or a sale week cannot
        move. Ring verdicts are computed client-side (lib/radarVerdict.ts): Enter now = demand up ≥40% per 24 months
        (~20%/yr) without a flooding pipeline · Watch = demand holding or softening, or score-only evidence · Emerging =
        a young tag (near-zero prior base by construction, or ≥80% of its reviews from games released in the last 24
        months) — its trend % is not representative, so the dot draws a dashed halo and is judged by absolute review
        volume instead · Crowded = releases up &gt;15% YoY against flat-to-down demand, or winner-take-most · Declining
        = demand down ≥30% per 24 months. Every dot rings on its own 24-month demand trend; niches without one (older
        data build, or no prior-window baseline) are placed on structural evidence and marked &ldquo;caution&rdquo; in
        the tooltip. The solo lens filters and restyles dots (hollow = team-scale) — it never changes a ring.
      </p>
    </section>
  );
}

export default function Radar() {
  const feedQ = useRadarFeed({ limit: 6 });
  const apiError = feedQ.error instanceof ApiError ? feedQ.error : null;
  // 503 is the EXPECTED state for hours after every deploy that adds a mart column — the
  // nightly rebuild (21:00 UTC) is what materialises demand_trend_24m_pct. Not an error the
  // user caused, and not a spinner: a stated wait, same convention as NicheCombined's
  // martPending / LaunchTiming's 503 handling.
  const martPending = apiError?.status === 503;
  // 404 = the cut has zero niches with a rankable 24-month baseline yet (every prior-24m
  // window was empty) — a real, if unlikely, answer distinct from "not built yet".
  const noBaseline = apiError?.status === 404;

  return (
    <div className="mx-auto flex max-w-[1180px] flex-col gap-[30px]">
      {/* The board is the page's hero; the original feed reflows below it. */}
      <RadarBoardSection />

      <div className="flex flex-wrap items-baseline gap-3">
        <h4 className="text-ink-primary">Opportunity feed</h4>
        <span className="text-[11px] text-ink-muted">the cut&rsquo;s biggest 24-month demand riser + movers</span>
      </div>

      {feedQ.isLoading && (
        <div className="py-10 text-center text-sm text-ink-muted">Loading the opportunity feed…</div>
      )}

      {martPending && (
        <div className="blueprint relative flex flex-col items-center gap-3 border-ink-primary/25 px-6 py-10 text-center">
          <i className="bp-corner" />
          <h2 className="text-ink-primary">The opportunity feed isn’t available yet</h2>
          <p className="max-w-md text-sm text-ink-secondary">
            Radar ranks niches on a 24-month demand trend that just landed in the marts. It appears after the next
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
            No niches in this cut have a rankable 24-month trend yet — too few reviews landed in the prior 24-month
            window for any of them.
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
            <span className="text-[11px] text-ink-muted">last 24 months vs prior 24 · buildable tags only</span>
            <Link to="/niches" className="ml-auto text-[13px] text-brand transition-colors hover:text-brand-hover">
              Open Niche Finder →
            </Link>
          </div>

          <div className="grid grid-cols-1 gap-[22px] sm:grid-cols-2 lg:grid-cols-3">
            {feedQ.data.movers.map((m) => (
              <NicheCard key={`${m.dimension}:${m.key}`} card={m} />
            ))}
          </div>

          {/* Emerging niches — a visibly separate group, NEVER mixed into the % movers:
              young tags crystallize around new games only, so their prior window is near
              zero by construction and a raw trend % there is the label's age, not demand.
              Ranked by absolute 24-month review volume (the server orders them). */}
          {feedQ.data.emerging.length > 0 && (
            <>
              <div className="flex flex-wrap items-baseline gap-3">
                <h4 className="text-ink-primary">Emerging niches</h4>
                <span className="text-[11px] text-ink-muted">
                  new labels — no comparable base · ranked by review volume, not trend %
                </span>
              </div>
              <div className="grid grid-cols-1 gap-[22px] sm:grid-cols-2 lg:grid-cols-3">
                {feedQ.data.emerging.map((e) => (
                  <EmergingCard key={`${e.dimension}:${e.key}`} card={e} />
                ))}
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}

function HeroPlate({ hero }: { hero: RadarHero }) {
  // The hero is never an emerging niche (the API excludes them from the % ranking), so
  // its trend is always present — ?? 0 only satisfies the shared nullable card type.
  const heroTrendPct = hero.demand_trend_24m_pct ?? 0;
  const up = heroTrendPct >= 0;
  const pipelineClause =
    hero.saturation_yoy == null ? "" : hero.saturation_yoy < 0 ? " while its release pipeline shrinks" : " while its release pipeline grows";
  const satClause = hero.saturation_yoy != null ? ` against a ${fmtSigned(hero.saturation_yoy, 0)} saturation YoY` : "";
  const bodyTitle =
    "Review inflow: Steam's own per-month review totals (review histogram; games with 50+ reviews, ~98% of review " +
    "volume), summed over the last 24 complete months vs the 24 before them. A structural read — a launch " +
    "spike or a sale week cannot move it — that lags reality by up to a month (histograms refresh ~monthly).";

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
          Review inflow {up ? "rose" : "fell"} {Math.abs(heroTrendPct).toFixed(1)}% — last 24 months vs
          the prior 24{satClause}. {fmtInt(hero.n_games)} scored games
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
            {verdictLabel(heroTrendPct)}
          </span>
          <span className="text-[11px] text-ink-muted">demand / last 24 months vs prior 24</span>
        </div>
        <HeroChart trend={hero.trend} />
      </div>
    </div>
  );
}

/**
 * The hero chart column. Mockup 3a shows a smooth ~13-point (roughly monthly) two-series
 * curve, but no mart materialises niche review velocity or releases at that granularity —
 * demand_trend_24m_pct itself is only two aggregate 24-month windows, not a series. This
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
 * everywhere: accent-300 when the 24-month trend is up, paper (ink-primary/55) when it's
 * down — never red/green, per the foundation. The opp v2 score bolds accent-300
 * independently, at the same >=70 "strong" threshold NicheFinder's table already uses.
 * Movers are never emerging (the API splits those out), so the trend is present — ?? 0
 * only satisfies the shared nullable card type. */
function NicheCard({ card }: { card: RadarNicheCard }) {
  const trendPct = card.demand_trend_24m_pct ?? 0;
  const up = trendPct >= 0;
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
          {verdictLabel(trendPct)}
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

/** One "Emerging niches" card. NEVER headlines a trend % — a young tag's prior window is
 * near zero by construction, so its % is the label's age, not demand. The headline number
 * is absolute 24-month review volume; the dashed border echoes the board's dashed
 * emerging halo (Industry constraints hold: radius 0, mono-steel, no red/green). */
function EmergingCard({ card }: { card: RadarNicheCard }) {
  const newSharePct = card.reviews_24m_new_share != null ? Math.round(card.reviews_24m_new_share * 100) : null;
  return (
    <Link
      to={nicheDetailPath(card.dimension, card.key)}
      onClick={() => trackEvent("niche_open")}
      className="relative flex flex-col gap-2 border border-dashed border-ink-primary/35 px-5 py-[18px] transition-colors hover:bg-ink-primary/[0.04]"
      title={
        "Emerging: this tag is young — Steam voters apply new labels to new games only, so its prior " +
        "24-month window is near zero by construction and a trend % would not be representative. " +
        "Judge it by absolute review volume."
      }
    >
      <div className="flex items-baseline">
        <span className="kicker text-[11px] text-ink-primary/70">
          EMERGING · {card.tier ?? "niche"} · {fmtInt(card.n_games)} games
        </span>
        <span
          className="tabular ml-auto text-ink-primary/70"
          style={{ fontFamily: CONDENSED, fontWeight: 600, fontSize: 20 }}
        >
          {fmtCompact(card.reviews_24m)}
        </span>
      </div>
      <div className="text-ink-primary" style={{ fontFamily: CONDENSED, fontWeight: 600, fontSize: 20 }}>
        {card.key}
      </div>
      <Sparkline points={card.sparkline} up={false} />
      <div className="text-[11px] text-ink-muted">
        {fmtInt(card.reviews_24m)} reviews / 24m — new label, no comparable base
        {newSharePct != null ? ` · ${newSharePct}% from games released in the last 24m` : ""}
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

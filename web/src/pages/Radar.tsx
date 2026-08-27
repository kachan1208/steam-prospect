import { useMemo, useRef, useState } from "react";
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
  type RadarFeed,
  type RadarHero,
  type RadarNicheCard,
  type RadarSparklinePoint,
  type TrendPoint,
} from "../lib/api";
import { fmtCompact, fmtInt, fmtSigned, fmtUsd } from "../lib/format";
import { EMERGING_NEW_MASS_SHARE, SOLO_FRIENDLY_MIN, radarVerdictTrace } from "../lib/radarVerdict";
import { nicheDetailPath } from "./NicheDetail";

/**
 * Radar — the index route. ONE INSTRUMENT + ONE FEED (2026-08-27 layout overhaul; the
 * previous page stacked the board, a floating dossier, three loose feed groups and a
 * methodology wall into a long scroll):
 *
 * 1. THE INSTRUMENT (RadarBoardSection) — a single frame: the radial board plate on the
 *    left, the RIGHT RAIL as its only reading pane (the full ranked verdict list, or the
 *    selected niche's dossier — RadarBoard.tsx owns that swap), and ONE toolbar row in
 *    the header carrying every control (Solo-friendly toggle, Top N). Fed by the
 *    /api/niches LIST endpoint (two cuts: dimension=genre and dimension=tag
 *    tiers=micro,theme), NOT the radar feed — the feed caps at 24 movers. The stats cut
 *    is PINNED (24m × 50+ reviews) — see BOARD_WINDOW's doc. The methodology paragraph
 *    is a collapsed-by-default <details> disclosure so the board breathes (full text one
 *    click away, never gone).
 *
 *    POPULATION (user directive, 2026-08-26): the whole radar page is SOLO-FIRST — the
 *    board and the feed default to solo-friendly niches only (singleplayer share
 *    solo_viability >= 0.8, filtered SERVER-side via the API's solo_only param; NULL =
 *    unknown = excluded). One page-level toggle drives both surfaces. Solo never moves a
 *    ring in either mode — see lib/radarVerdict.ts.
 *
 * 2. THE SIGNAL FEED (SignalFeedSection) — the old opportunity feed consolidated into
 *    one frame with one header: the hero lead (the cut's biggest 24-month riser), a
 *    "Movers" row, an "Emerging" row. SHARED SELECTION MODEL: clicking any feed card
 *    whose niche is on the board selects it there (same selection channel as a dot
 *    click) and scrolls the instrument into view; a card whose niche is NOT on the board
 *    (outside the Top-N cut) falls back to its deep-dive navigation.
 *
 * THE DATA (read niches.py::radar_feed / _has_demand24m for the full story): the feed
 * ranks on demand_trend_24m_pct, a mart_niche column that is not in the published mart
 * until the nightly rebuild after its deploy. The API 503s until then, and this page
 * degrades to an honest "not available yet" message rather than a spinner or an empty
 * grid (see the martPending block). Every number rendered here is real: no series is
 * invented to fill a gap the marts don't cover — see HeroChart's doc for the one
 * deliberate substitution (yearly, not the mockup's monthly, demand-vs-pipeline shape)
 * and Sparkline's doc for why a card can legitimately show no sparkline at all.
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
 * always reads one cut and says so in its methodology. (NicheFinder keeps the floor chips —
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
/** The page-level population toggle (default ON — the radar is solo-first). ON asks the
 * SERVER (solo_only) for solo-friendly niches only (singleplayer share >= 0.8, unknown
 * excluded); OFF reveals the full population, where the solo lens draws team-scale dots
 * hollow. */
const SOLO_ONLY_OPTIONS: { v: "on" | "off"; label: string }[] = [
  { v: "on", label: "On" },
  { v: "off", label: "Off" },
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
 * The instrument frame: header (title + the SINGLE toolbar row), the board+rail, and the
 * collapsed Methodology disclosure. Purely presentational — the page owns every piece of
 * state (queries, selection, toggles) so the signal feed can share the selection channel.
 */
function RadarBoardSection({
  sectionRef,
  blips,
  loading,
  bothFailed,
  partialFail,
  errorMessage,
  soloOnly,
  onSoloOnly,
  topN,
  onTopN,
  selectedId,
  onSelect,
}: {
  sectionRef: React.RefObject<HTMLElement | null>;
  blips: RadarBoardBlip[];
  loading: boolean;
  bothFailed: boolean;
  partialFail: boolean;
  errorMessage: string | null;
  soloOnly: boolean;
  onSoloOnly: (v: boolean) => void;
  topN: number;
  onTopN: (v: number) => void;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}) {
  return (
    <section
      ref={sectionRef as React.RefObject<HTMLElement>}
      className="blueprint relative border-ink-primary/25 px-6 py-5 lg:px-[30px] lg:py-[24px]"
    >
      <i className="bp-corner" />
      {/* Header: identity left, THE toolbar right — every board control lives here. */}
      <div className="flex flex-wrap items-end gap-x-6 gap-y-3 pb-5">
        <div className="flex flex-col gap-1.5">
          <div className="kicker text-[10px] tracking-[.12em] text-brand">
            Verdict rings · last 24 months · genres + micro + theme tags
            {soloOnly ? " · solo-friendly only" : ""}
          </div>
          <h2 className="text-[26px] text-ink-primary sm:text-[30px]">Niche radar</h2>
        </div>
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 sm:ml-auto">
          <SegRow
            label="Solo-friendly only"
            options={SOLO_ONLY_OPTIONS}
            value={soloOnly ? "on" : "off"}
            onChange={(v) => onSoloOnly(v === "on")}
          />
          <SegRow label="Top" options={TOP_N_OPTIONS} value={topN} onChange={onTopN} />
        </div>
      </div>

      {loading && <div className="py-16 text-center text-sm text-ink-muted">Plotting the board…</div>}
      {bothFailed && (
        <div className="py-16 text-center text-sm text-status-serious">
          Failed to load the niche cuts{errorMessage ? `: ${errorMessage}` : "."}
        </div>
      )}
      {!loading && !bothFailed && (
        <RadarBoard blips={blips} soloOnly={soloOnly} selectedId={selectedId} onSelect={onSelect} />
      )}

      {partialFail && (
        <p className="pt-3 text-[11px] text-ink-muted">
          One dimension failed to load — the board shows what arrived.
        </p>
      )}

      {/* A5: the methodology, collapsed by default so the board breathes — Industry-styled
          disclosure (hairline top rule, kicker summary, no marker), full text intact. */}
      <details className="group mt-4 border-t border-chartborder">
        <summary className="kicker flex cursor-pointer select-none list-none items-center gap-1.5 py-2 text-[10px] tracking-[.12em] text-ink-muted transition-colors hover:text-ink-primary [&::-webkit-details-marker]:hidden">
          <span aria-hidden className="inline-block text-[9px] transition-transform group-open:rotate-90">
            ▶
          </span>
          Methodology
        </summary>
        <p className="pb-2 text-[11px] text-ink-muted">
          Stats cut: last 24 months, niches with 50+ review games — pinned, so a display toggle can never move a
          verdict (the mart precomputes each cut as its own population). Demand trend: review inflow over the last 24
          months vs the prior 24 — the same horizon as the cut itself, a structural read that a release spike or a sale
          week cannot move. Ring verdicts are computed client-side (lib/radarVerdict.ts): Enter now = demand up ≥40%
          per 24 months (~20%/yr) without a flooding pipeline · Watch = demand holding or softening, or score-only
          evidence · Emerging = no comparable demand base — either a young label (≥80% of its reviews from games
          released in the last 24 months) or a prior base too small for a % read; the dossier names which — so the dot
          draws a dashed halo and is judged by absolute review volume instead · Crowded = releases up &gt;15% YoY
          against flat-to-down demand, or
          winner-take-most · Declining = demand down ≥30% per 24 months. Every dot rings on its own 24-month demand
          trend; niches without one (older data build, or no prior-window baseline) are placed on structural evidence
          and marked &ldquo;caution&rdquo; in the tooltip. Click a dot for its verdict dossier — the same checks that
          placed it, spelled out with the bars they were judged against.{" "}
          {soloOnly
            ? `Population: solo-friendly niches only (singleplayer share ≥ ${SOLO_FRIENDLY_MIN}, filtered server-side; a niche with no solo reading is excluded — unknown is not a claim). Singleplayer share is a no-netcode proxy, not a production-scope measure — the dossier's solo row shows the member evidence behind it. Solo never changes a ring.`
            : `Population: all niches — the solo lens restyles team-scale dots (hollow, singleplayer share < ${SOLO_FRIENDLY_MIN}) without ever changing a ring. Singleplayer share is a no-netcode proxy, not a production-scope measure — the dossier's solo row shows the member evidence behind it.`}
        </p>
      </details>
    </section>
  );
}

export default function Radar() {
  // ONE selection + ONE population toggle for the whole page: the board's two list
  // queries, the rail, and the signal feed all hang off this state, so the page can
  // never show a solo-only board over a full-population feed, and a feed card can select
  // a niche on the board through the same channel a dot click uses.
  const [soloOnly, setSoloOnly] = useState(true);
  const [topN, setTopN] = useState(80);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const boardSectionRef = useRef<HTMLElement | null>(null);

  // The board population: the two cuts that make up the three sectors. Each query asks for
  // topN rows by opportunity_v2 so the merged top-N cap can never starve one dimension.
  // solo_only is SERVER-side (the shared list endpoint's opt-in param — non-radar
  // consumers stay unfiltered): filtering before the limit means a solo-only board always
  // fills back up to N instead of thinning out.
  const soloParam = soloOnly ? (1 as const) : undefined;
  const genreQ = useNiches({
    dimension: "genre",
    window: BOARD_WINDOW,
    min_reviews: BOARD_MIN_REVIEWS,
    sort: "opportunity_v2",
    order: "desc",
    solo_only: soloParam,
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
    solo_only: soloParam,
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
      // One evaluation produces BOTH the ring and the dossier trace (radarVerdictTrace —
      // same booleans, same body), so the panel can never disagree with the dot position.
      const { checks, ...verdict } = radarVerdictTrace({
        demand_trend_24m_pct: demandTrendPct,
        demand_emerging: demandEmerging,
        saturation_yoy: row.saturation_yoy,
        winner_concentration: row.winner_concentration,
        opportunity_v2: row.opportunity_v2,
        entrant_ratio: row.entrant_ratio,
        solo_viability: row.solo_viability ?? null,
        // Solo-evidence trio — the member profile the dossier's solo row renders inline
        // ("0.98 singleplayer · 50% self-pub · 71% indie · median 5.7h content"). Absent
        // (undefined -> null) on marts that predate it: the row omits the evidence.
        self_published_share: row.self_published_share ?? null,
        indie_share: row.indie_share ?? null,
        med_playtime_h: row.med_playtime_h ?? null,
        reviews_24m: row.reviews_24m ?? null,
        reviews_prev_24m: row.reviews_prev_24m ?? null,
        reviews_24m_new_share: row.reviews_24m_new_share ?? null,
      });
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
        reviewsPrev24m: row.reviews_prev_24m ?? null,
        solo_viability: row.solo_viability ?? null,
        verdict,
        trace: checks,
      });
    };
    for (const r of genreQ.data?.items ?? []) push(r);
    for (const r of tagQ.data?.items ?? []) push(r);
    rows.sort((a, b) => (b.opportunity_v2 ?? -1) - (a.opportunity_v2 ?? -1) || a.key.localeCompare(b.key));
    return rows.slice(0, topN);
  }, [genreQ.data, tagQ.data, topN]);

  const blipIds = useMemo(() => new Set(blips.map((b) => `${b.dimension}:${b.key}`)), [blips]);

  const loading = genreQ.isLoading || tagQ.isLoading;
  const bothFailed = genreQ.isError && tagQ.isError;
  const partialFail = !bothFailed && (genreQ.isError || tagQ.isError);

  const feedQ = useRadarFeed({ limit: 6, solo_only: soloOnly ? 1 : 0 });

  /** The feed cards' path into the shared selection model: select the niche on the board
   * (and bring the instrument into view) when it is in the current Top-N population;
   * false = not on the board, the card falls back to its deep-dive navigation. */
  const selectOnBoard = (dimension: string, key: string): boolean => {
    const id = `${dimension}:${key}`;
    if (!blipIds.has(id)) return false;
    setSelectedId(id);
    boardSectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    return true;
  };

  return (
    <div className="mx-auto flex max-w-[1180px] flex-col gap-5">
      <RadarBoardSection
        sectionRef={boardSectionRef}
        blips={blips}
        loading={loading}
        bothFailed={bothFailed}
        partialFail={partialFail}
        errorMessage={genreQ.error instanceof Error ? genreQ.error.message : null}
        soloOnly={soloOnly}
        onSoloOnly={setSoloOnly}
        topN={topN}
        onTopN={setTopN}
        selectedId={selectedId}
        onSelect={setSelectedId}
      />
      <SignalFeedSection feedQ={feedQ} soloOnly={soloOnly} boardIds={blipIds} onCardOpen={selectOnBoard} />
    </div>
  );
}

// ---- the signal feed --------------------------------------------------------------------

/**
 * The consolidated feed frame: ONE section, ONE header, then the hero lead + a "Movers"
 * row + an "Emerging" row (labeled hairline rows inside the frame, not sibling sections).
 * Cards share the board's selection model via onCardOpen — see the page doc.
 */
function SignalFeedSection({
  feedQ,
  soloOnly,
  boardIds,
  onCardOpen,
}: {
  feedQ: ReturnType<typeof useRadarFeed>;
  soloOnly: boolean;
  boardIds: Set<string>;
  onCardOpen: (dimension: string, key: string) => boolean;
}) {
  const apiError = feedQ.error instanceof ApiError ? feedQ.error : null;
  // 503 is the EXPECTED state for hours after every deploy that adds a mart column — the
  // nightly rebuild (21:00 UTC) is what materialises demand_trend_24m_pct. Not an error the
  // user caused, and not a spinner: a stated wait, same convention as NicheCombined's
  // martPending / LaunchTiming's 503 handling.
  const martPending = apiError?.status === 503;
  // 404 = the cut has zero niches with a rankable 24-month baseline yet (every prior-24m
  // window was empty) — a real, if unlikely, answer distinct from "not built yet".
  const noBaseline = apiError?.status === 404;
  const data: RadarFeed | undefined = feedQ.data;

  return (
    <section className="blueprint relative border-ink-primary/25 px-6 py-5 lg:px-[30px] lg:py-[24px]">
      <i className="bp-corner" />
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 pb-4">
        <div className="kicker text-[10px] tracking-[.12em] text-brand">Signal feed</div>
        <h4 className="text-ink-primary">Biggest 24-month demand riser, movers &amp; emerging labels</h4>
        <span className="text-[11px] text-ink-muted">{soloOnly ? "solo-friendly only" : "full population"}</span>
        <Link to="/niches" className="ml-auto text-[13px] text-brand transition-colors hover:text-brand-hover">
          Open Niche Finder →
        </Link>
      </div>

      {feedQ.isLoading && (
        <div className="py-10 text-center text-sm text-ink-muted">Loading the signal feed…</div>
      )}

      {martPending && (
        <div className="flex flex-col items-center gap-3 px-6 py-10 text-center">
          <h2 className="text-ink-primary">The signal feed isn’t available yet</h2>
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
        <p className="px-6 py-10 text-center text-sm text-ink-secondary">
          No niches in this cut have a rankable 24-month trend yet — too few reviews landed in the prior 24-month
          window for any of them.
        </p>
      )}

      {feedQ.isError && !martPending && !noBaseline && (
        <div className="py-10 text-center text-sm text-status-serious">
          Failed to load the signal feed{feedQ.error instanceof Error ? `: ${feedQ.error.message}` : "."}
        </div>
      )}

      {data && (
        <div className="flex flex-col gap-4">
          <HeroLead hero={data.hero} boardIds={boardIds} onCardOpen={onCardOpen} />

          <FeedRow label="Movers" caption={`last 24 months vs prior 24 · ranked by |trend| · hero first${soloOnly ? " · solo-friendly only" : ""}`}>
            <div className="grid grid-cols-1 gap-[18px] sm:grid-cols-2 lg:grid-cols-3">
              {data.movers.map((m) => (
                <NicheCard key={`${m.dimension}:${m.key}`} card={m} onCardOpen={onCardOpen} />
              ))}
            </div>
          </FeedRow>

          {/* Emerging niches — a visibly separate row, NEVER mixed into the % movers:
              young tags crystallize around new games only, so their prior window is near
              zero by construction and a raw trend % there is the label's age, not demand.
              Ranked by absolute 24-month review volume (the server orders them). */}
          {data.emerging.length > 0 && (
            <FeedRow label="Emerging" caption="new labels — no comparable base · ranked by review volume, not trend %">
              <div className="grid grid-cols-1 gap-[18px] sm:grid-cols-2 lg:grid-cols-3">
                {data.emerging.map((e) => (
                  <EmergingCard key={`${e.dimension}:${e.key}`} card={e} onCardOpen={onCardOpen} />
                ))}
              </div>
            </FeedRow>
          )}
        </div>
      )}
    </section>
  );
}

/** One labeled hairline row inside the feed frame — replaces the old sibling sections. */
function FeedRow({ label, caption, children }: { label: string; caption: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-3 border-t border-chartborder pt-3">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="kicker text-[11px] tracking-[.08em] text-ink-primary">{label}</span>
        <span className="text-[11px] text-ink-muted">{caption}</span>
      </div>
      {children}
    </div>
  );
}

function HeroLead({
  hero,
  boardIds,
  onCardOpen,
}: {
  hero: RadarHero;
  boardIds: Set<string>;
  onCardOpen: (dimension: string, key: string) => boolean;
}) {
  // The hero is never an emerging niche (the API excludes them from the % ranking), so
  // its trend is always present — ?? 0 only satisfies the shared nullable card type.
  const heroTrendPct = hero.demand_trend_24m_pct ?? 0;
  const up = heroTrendPct >= 0;
  const pipelineClause =
    hero.saturation_yoy == null ? "" : hero.saturation_yoy < 0 ? " while its release pipeline shrinks" : " while its release pipeline grows";
  const satClause = hero.saturation_yoy != null ? ` against a ${fmtSigned(hero.saturation_yoy, 0)} saturation YoY` : "";
  const onBoard = boardIds.has(`${hero.dimension}:${hero.key}`);
  const bodyTitle =
    "Review inflow: Steam's own per-month review totals (review histogram; games with 50+ reviews, ~98% of review " +
    "volume), summed over the last 24 complete months vs the 24 before them. A structural read — a launch " +
    "spike or a sale week cannot move it — that lags reality by up to a month (histograms refresh ~monthly).";

  return (
    <div className="flex flex-col lg:flex-row lg:items-stretch">
      <div className="flex flex-col gap-2 lg:flex-1 lg:pr-7">
        <div className="kicker text-[10px] tracking-[.12em] text-brand">This week · last 24 months · micro + theme tags</div>
        <h2 className="max-w-[560px] text-balance text-[24px] text-ink-primary sm:text-[28px]">
          {hero.key} demand is {up ? "up" : "down"}
          {pipelineClause}.
        </h2>
        <p className="max-w-[520px] text-sm text-ink-secondary" title={bodyTitle}>
          Review inflow {up ? "rose" : "fell"} {Math.abs(heroTrendPct).toFixed(1)}% — last 24 months vs
          the prior 24{satClause}. {fmtInt(hero.n_games)} scored games
          {hero.p90_rev != null ? `, P90 revenue ${fmtUsd(hero.p90_rev)}` : ""}.
        </p>
        <div className="mt-auto flex flex-wrap gap-2.5 pt-3">
          {onBoard && (
            <button
              type="button"
              onClick={() => onCardOpen(hero.dimension, hero.key)}
              className="border border-ink-primary/35 px-3.5 py-2 text-[13px] font-medium text-ink-primary transition-colors hover:bg-ink-primary/[0.08]"
            >
              ↑ Verdict dossier
            </button>
          )}
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

      <div className="mt-4 flex flex-col gap-2 border-t border-chartborder pt-4 lg:mt-0 lg:w-[380px] lg:flex-none lg:border-l lg:border-t-0 lg:pl-7 lg:pt-0">
        <div className="flex items-baseline gap-2.5">
          <span
            className={clsx("tabular", up ? "text-brand" : "text-ink-primary/55")}
            style={{ fontFamily: CONDENSED, fontWeight: 600, fontSize: 36 }}
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
 *
 * isAnimationActive={false} on both lines (A3, 2026-08-27): recharts re-runs its draw
 * animation whenever ResponsiveContainer re-measures — and opening the rail dossier (or
 * any click that pops a scrollbar in) resizes the page, so a screenshot taken right after
 * a click caught the lines mid-animation, i.e. EMPTY. The chart is static data; there is
 * nothing honest for an animation to add.
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
            isAnimationActive={false}
          />
          <Line
            yAxisId="releases"
            type="linear"
            dataKey="n_releases"
            stroke="color-mix(in srgb, var(--text-primary) 45%, transparent)"
            strokeWidth={1.5}
            strokeDasharray="4 3"
            dot={false}
            isAnimationActive={false}
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

/** One "Movers" grid card. Verdict/kicker tone follows the SAME up/down rule everywhere:
 * accent-300 when the 24-month trend is up, paper (ink-primary/55) when it's down — never
 * red/green, per the foundation. SHARED SELECTION: a plain click selects the niche on the
 * board (dossier in the rail) when it is in the Top-N population; otherwise — and for
 * modifier/middle clicks — the card keeps its deep-dive navigation. Movers are never
 * emerging (the API splits those out), so the trend is present — ?? 0 only satisfies the
 * shared nullable card type. */
function NicheCard({ card, onCardOpen }: { card: RadarNicheCard; onCardOpen: (dimension: string, key: string) => boolean }) {
  const trendPct = card.demand_trend_24m_pct ?? 0;
  const up = trendPct >= 0;
  const tone = up ? "text-brand" : "text-ink-primary/55";
  const strongOpp = card.opportunity_v2 != null && card.opportunity_v2 >= 70;

  return (
    <Link
      to={nicheDetailPath(card.dimension, card.key)}
      onClick={(e) => {
        // Plain click -> select on the board (same channel as a dot click). Modifier or
        // middle clicks keep their browser meaning (open the deep dive in a new tab).
        if (!e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey && onCardOpen(card.dimension, card.key)) {
          e.preventDefault();
          return;
        }
        trackEvent("niche_open");
      }}
      className="blueprint relative flex flex-col gap-2 border-ink-primary/25 px-5 py-4 transition-colors hover:bg-ink-primary/[0.04]"
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

/** One "Emerging" card. NEVER headlines a trend % — an emerging niche has no comparable
 * base, so its % is not representative. The headline number is absolute 24-month review
 * volume; the dashed border echoes the board's dashed emerging halo (Industry constraints
 * hold: radius 0, mono-steel, no red/green). The copy names WHICH tell fired (PR #98
 * review): "new label" wording only when the new-game review mass clears
 * EMERGING_NEW_MASS_SHARE — a low-new-share emerging niche is a small stable niche whose
 * base is too small for a % read, and calling it "new" would be a fabricated claim. Same
 * shared selection model as NicheCard. */
function EmergingCard({ card, onCardOpen }: { card: RadarNicheCard; onCardOpen: (dimension: string, key: string) => boolean }) {
  const newSharePct = card.reviews_24m_new_share != null ? Math.round(card.reviews_24m_new_share * 100) : null;
  const youngLabel = card.reviews_24m_new_share != null && card.reviews_24m_new_share >= EMERGING_NEW_MASS_SHARE;
  return (
    <Link
      to={nicheDetailPath(card.dimension, card.key)}
      onClick={(e) => {
        if (!e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey && onCardOpen(card.dimension, card.key)) {
          e.preventDefault();
          return;
        }
        trackEvent("niche_open");
      }}
      className="relative flex flex-col gap-2 border border-dashed border-ink-primary/35 px-5 py-4 transition-colors hover:bg-ink-primary/[0.04]"
      title={
        youngLabel
          ? "Emerging: this tag is young — Steam voters apply new labels to new games only, so its prior " +
            "24-month window is near zero by construction and a trend % would not be representative. " +
            "Judge it by absolute review volume."
          : "Emerging: this niche's prior 24-month window is under the comparability floor — the base is " +
            "too small for a % read (a small stable niche, not necessarily a new one). " +
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
        {fmtInt(card.reviews_24m)} reviews / 24m — {youngLabel ? "new label, no comparable base" : "base too small for a % read"}
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

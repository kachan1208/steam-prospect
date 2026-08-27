import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import clsx from "clsx";

import { RadarBoard, type RadarBoardBlip, type RadarSector } from "../components/RadarBoard";
import { useNiches, type NicheRow } from "../lib/api";
import { SOLO_FRIENDLY_MIN, radarVerdictTrace } from "../lib/radarVerdict";

/**
 * Radar — the index route. ONE INSTRUMENT, nothing below it (2026-08-27, user directive:
 * "remove the table below the radar — the radar answers the same questions"). The signal
 * feed that used to follow the board (hero narrative + Movers + Emerging card rows, fed by
 * /api/niches/radar) is gone: movers are the trend % on every rail row and ring position,
 * emerging is the dashed-halo band and its own EMERGING rail group, and the hero was a
 * re-statement of the top riser the list already leads with. The /api/niches/radar
 * endpoint itself is untouched (MCP and external consumers).
 *
 * THE INSTRUMENT (RadarBoardSection) — a single frame: the radial board plate on the
 * left, the RIGHT RAIL as its only reading pane (the ranked verdict list with the
 * full-population niche search on top, or the selected niche's verdict dossier —
 * RadarBoard.tsx owns that swap), and ONE toolbar row in the header carrying every
 * control (Solo-friendly toggle, Top N) plus the unobtrusive Niche Finder escape hatch.
 * Fed by the /api/niches LIST endpoint (two cuts: dimension=genre and dimension=tag
 * tiers=micro,theme). The stats cut is PINNED (24m × 50+ reviews) — see BOARD_WINDOW's
 * doc. The methodology paragraph is a collapsed-by-default <details> disclosure so the
 * board breathes (full text one click away, never gone).
 *
 * POPULATION (user directive, 2026-08-26): the page is SOLO-FIRST — the board defaults
 * to solo-friendly niches only (singleplayer share solo_viability >= 0.8, filtered
 * SERVER-side via the API's solo_only param; NULL = unknown = excluded). Solo never
 * moves a ring in either mode — see lib/radarVerdict.ts.
 *
 * FETCH SHAPE (the search directive): each cut asks for the endpoint's MAX limit
 * (POPULATION_LIMIT), not Top-N — the rail's search must cover the FULL radar population
 * at the active cut + solo setting (~213 rows solo-on), never just the plotted dots. The
 * Top-N cap became a pure client-side slice, so flipping it re-plots instantly with no
 * refetch. See the `pool` memo.
 */

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

/** The /api/niches endpoint's maximum limit — each dimension query asks for this many so
 * the rail search spans the WHOLE population of the cut (solo-on that's ~213 rows across
 * both cuts; solo-off it's the full book, still comfortably under the cap per dimension).
 * If a cut ever outgrew the cap the search would honestly cover its top 500 by
 * opportunity — the same rows every other surface can rank. */
const POPULATION_LIMIT = 500;

/** Blip cap so the board stays readable; "top N by opportunity_v2" across all sectors.
 * A display cap only: the rail search sees past it (see POPULATION_LIMIT). */
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
 * The instrument frame: header (title + the SINGLE toolbar row + the Niche Finder link —
 * the nav the removed signal feed used to carry), the board+rail, and the collapsed
 * Methodology disclosure. Purely presentational — the page owns every piece of state
 * (queries, selection, toggles).
 */
function RadarBoardSection({
  blips,
  pool,
  plotCap,
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
  blips: RadarBoardBlip[];
  pool: RadarBoardBlip[];
  plotCap: number;
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
    <section className="blueprint relative border-ink-primary/25 px-6 py-5 lg:px-[30px] lg:py-[24px]">
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
          <Link to="/niches" className="text-[12px] text-brand transition-colors hover:text-brand-hover">
            Open Niche Finder →
          </Link>
        </div>
      </div>

      {loading && <div className="py-16 text-center text-sm text-ink-muted">Plotting the board…</div>}
      {bothFailed && (
        <div className="py-16 text-center text-sm text-status-serious">
          Failed to load the niche cuts{errorMessage ? `: ${errorMessage}` : "."}
        </div>
      )}
      {!loading && !bothFailed && (
        <RadarBoard
          blips={blips}
          pool={pool}
          plotCap={plotCap}
          soloOnly={soloOnly}
          selectedId={selectedId}
          onSelect={onSelect}
        />
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
          placed it, spelled out with the bars they were judged against. The board plots the Top N by opportunity; the
          rail&rsquo;s search covers the whole population of the cut, past the plot cap.{" "}
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
  // queries and the rail all hang off this state. Top-N is a client-side display slice
  // (see POPULATION_LIMIT), so only the solo toggle changes what is fetched.
  const [soloOnly, setSoloOnly] = useState(true);
  const [topN, setTopN] = useState(80);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // The board population: the two cuts that make up the three sectors. Each query asks
  // for the endpoint's max rows by opportunity_v2 — the full population the rail search
  // spans; the plotted Top-N is sliced client-side below. solo_only is SERVER-side (the
  // shared list endpoint's opt-in param — non-radar consumers stay unfiltered): filtering
  // before the limit means a solo-only board always fills back up instead of thinning out.
  const soloParam = soloOnly ? (1 as const) : undefined;
  const genreQ = useNiches({
    dimension: "genre",
    window: BOARD_WINDOW,
    min_reviews: BOARD_MIN_REVIEWS,
    sort: "opportunity_v2",
    order: "desc",
    solo_only: soloParam,
    limit: POPULATION_LIMIT,
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
    limit: POPULATION_LIMIT,
    offset: 0,
  });

  /** The FULL population at this cut + solo setting, both dimensions merged, opportunity
   * order — the rail search's scope. `blips` (what the board plots) is its Top-N head. */
  const pool = useMemo<RadarBoardBlip[]>(() => {
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
    return rows;
  }, [genreQ.data, tagQ.data]);

  const blips = useMemo(() => pool.slice(0, topN), [pool, topN]);

  const loading = genreQ.isLoading || tagQ.isLoading;
  const bothFailed = genreQ.isError && tagQ.isError;
  const partialFail = !bothFailed && (genreQ.isError || tagQ.isError);

  return (
    <div className="mx-auto flex max-w-[1180px] flex-col gap-5">
      <RadarBoardSection
        blips={blips}
        pool={pool}
        plotCap={topN}
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
    </div>
  );
}

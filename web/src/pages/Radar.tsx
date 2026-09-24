import { useCallback, useMemo } from "react";
import { Link, useSearchParams } from "react-router-dom";
import clsx from "clsx";

import {
  RadarBoard,
  RADAR_REGIONS,
  radarBlipFromRow,
  type RadarBoardBlip,
  type RadarRegion,
  type RadarSector,
} from "../components/RadarBoard";
import { StartHere } from "../components/StartHere";
import { InfoTipBase } from "../components/ui/InfoTipBase";
import { Loading } from "../components/ui/Loading";
import { useNiches, type NicheRow } from "../lib/api";
import {
  INDIE_FRIENDLY_MIN_HITS,
  INDIE_FRIENDLY_MIN_SHARE,
  RING_ORDER,
  SMALL_DEV_MAX_GAMES,
  SOLO_FRIENDLY_PCT,
  SOLO_LENS_LABEL,
  radarLensPasses,
  radarLensUsesIndie,
  sharePct,
} from "../lib/radarVerdict";
import type { RadarRing } from "../lib/radarVerdict";
import { usePageTitle } from "../lib/usePageTitle";

/**
 * Radar — the index route. ONE INSTRUMENT, nothing below it (2026-08-27, user directive:
 * "remove the table below the radar — the radar answers the same questions"). The signal
 * feed that used to follow the board (hero narrative + Movers + Emerging card rows, fed by
 * /api/niches/radar) is gone: movers are the trend % on every rail row and ring position,
 * emerging is the dashed-halo band and its own EMERGING rail group, and the hero was a
 * re-statement of the top riser the list already leads with. The /api/niches/radar
 * endpoint is gone as well — it 404s; api/app/routers/niches.py serves the list, /combined,
 * a niche's detail, /games, /distribution and /export.csv, and this board reads the list.
 *
 * THE FIRST 30 SECONDS (2026-09-23 review). The page used to open on a kicker reading
 * "VERDICT RINGS · BEST IN THE MIDDLE · THREE CLASS SECTORS · …" and six lines of legend. It
 * now asks the question the board answers, says in one line how to read it, and puts the
 * three-step <StartHere/> path and the guide link above it; the legend is two lines and the
 * detail sits behind an ⓘ and the Methodology disclosure.
 *
 * THE INSTRUMENT (RadarBoardSection) — a single frame: the CONCENTRIC-RING DIAL on the
 * left (RadarBoard.tsx — the verdict as a ring band, best in the middle; the niche CLASS
 * as a 120° sector; opportunity_v2 as the rank inside the band), the RIGHT RAIL as its only
 * reading pane (the ranked verdict list with the full-population niche search on top, or
 * the selected niche's verdict dossier), and ONE toolbar row in the header carrying every
 * control plus the Niche Finder escape hatch (that link matters more now: "Niches" left
 * the top nav — see App.tsx). The dial replaced the XY quadrant plate on 2026-09-10 (user:
 * "I think circle is a better representation for radar … Best - niches are in the middle")
 * — RadarBoard.tsx's header records what each of the plate's honesty rules became.
 *
 * THE CLASS IS THE DIAL'S ANGULAR AXIS, AND THE PICKER IS AN EMPHASIS (2026-09-10, second
 * pass — user: "Make it better, right now it looks like a slop"). Genres, Micro-genres and
 * Themes each hold a fixed 120° wedge and ALL THREE ALWAYS DRAW; the picker chooses which
 * wedge is emphasised, and the other two recede rather than leaving. This is what fixed the
 * density: one class at a time put 80 blips into a single full-circle sector where the
 * reference puts ~14 per quadrant.
 *
 * It keeps the 2026-08-27 directive's substance ("score Genres, Micro-genres and Themes
 * separately — user has to pick what he wants to research") and pays it better: each class
 * is still ranked ONLY against its own kind — the Top-N control now takes the top N/3 of
 * EACH class rather than the top N of the board, so a genre never competes with a micro-tag
 * for a slot — and now you can also see the three rankings side by side instead of one at a
 * time. The SEARCH still spans every class, and picking a hit moves the emphasis to that
 * niche's own wedge (see handleSelect).
 *
 * Fed by the /api/niches LIST endpoint (two cuts: dimension=genre and dimension=tag
 * tiers=micro,theme). The stats cut is PINNED (24m × 50+ reviews) — see BOARD_WINDOW's
 * doc. The methodology paragraph is a collapsed-by-default <details> disclosure so the
 * board breathes (full text one click away, never gone).
 *
 * POPULATION (user directive, 2026-08-26): the page is SOLO-FIRST — the board defaults to
 * the "Singleplayer only" lens (singleplayer share solo_viability >= 0.8; NULL = unknown =
 * excluded). Named for exactly what it does since 2026-09-23 — it was "Solo-friendly only",
 * a buildability promise the share can't keep; on the 2026-09-21 cut it removes 8 of 228
 * niches. Solo never moves a ring in either mode — see lib/radarVerdict.ts.
 *
 * FETCH SHAPE (the search directive): each cut asks for the endpoint's MAX limit
 * (POPULATION_LIMIT), not Top-N — the rail's search must cover the FULL radar population
 * at the active cut, never just the plotted dots. The Top-N cap is a pure client-side
 * slice, and since 2026-09-23 so is the singleplayer lens (it used to be the API's
 * solo_only param): the whole population fits under the limit (228 rows across both cuts),
 * filtering it here costs nothing, flipping the lens no longer refetches, and the legend can
 * say what the lens really removed ("220 of 228 kept"). Same bar as the API's
 * RADAR_SOLO_FRIENDLY_MIN. See the `pool` memo.
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

/** Blip cap so the board stays readable. A display cap only: the rail search sees past it
 * (see POPULATION_LIMIT). Since the three-sector rebuild it is DISTRIBUTED, not a board
 * total — see perClassCap. */
const TOP_N_OPTIONS = [
  { v: 40, label: "40" },
  { v: 80, label: "80" },
  { v: 120, label: "120" },
];

/** The class picker — since the three-sector rebuild it selects EMPHASIS, not contents: all
 * three classes are always on the dial, and this decides which wedge reads at full strength
 * while the other two recede. Each class is still ranked only against its own kind (see
 * perClassCap), which is what the 2026-08-27 "score them separately" directive was for.
 * Deliberately no "All": the reader is always researching something. Default micro — the
 * class the opportunity work targets. */
const CLASS_OPTIONS: { v: RadarSector; label: string }[] = [
  { v: "genre", label: "Genres" },
  { v: "micro", label: "Micro-genres" },
  { v: "theme", label: "Themes" },
];
const CLASS_KICKER: Record<RadarSector, string> = {
  genre: "genres emphasised",
  micro: "micro-genre tags emphasised",
  theme: "theme tags emphasised",
};

/**
 * THE TOP-N IS PER SECTOR, NOT PER BOARD. With three wedges a single board-wide cap would
 * hand every slot to whichever class happens to score highest on opportunity_v2 — the micro
 * tags — and leave the other two wedges empty, which is exactly the density failure the
 * rebuild set out to fix. So the cap splits: Top 80 plots the top ~27 of EACH class.
 *
 * It is a ceiling, never a floor. Genres has ~9 solo-friendly niches at this cut, so the
 * genre wedge draws 9 and looks sparser than its neighbours. That is the honest picture and
 * it is NOT padded — an under-populated class is a real finding about the class.
 */
const perClassCap = (topN: number): number => Math.ceil(topN / CLASS_OPTIONS.length);

/** Slots every non-empty ring is guaranteed before the rest is shared out. */
const RING_FLOOR = 3;

/**
 * Choose which of a class's niches get a dot, spreading the budget ACROSS the rings.
 *
 * A plain `slice(0, cap)` of the opportunity-sorted pool cannot ever reach the outer bands,
 * because the thing that puts a niche in "declining" is also what puts it last: measured on
 * production, the five declining tag niches ranked 179, 185, 207, 208 and 209 of 209, so the
 * DECLINING ring was drawn, labelled, and permanently empty at every cap the control offers.
 * An empty labelled band reads as "there are none", which is a claim about the market rather
 * than about the cut — and a false one.
 *
 * So each non-empty ring is guaranteed RING_FLOOR slots (or all it has, if fewer), and what
 * is left is shared out in proportion to what each ring still holds. WATCH keeps its bulk
 * because it genuinely is the bulk; DECLINING gets its handful. Within a ring the pick is
 * still best-opportunity-first, and the incoming order is preserved on the way out so the
 * rail's numbering stays the board's rank order.
 */
function pickAcrossRings<T extends { verdict: { ring: RadarRing } }>(rows: T[], cap: number): T[] {
  if (rows.length <= cap) return rows;
  const byRing = new Map<RadarRing, T[]>();
  for (const row of rows) {
    const list = byRing.get(row.verdict.ring);
    if (list) list.push(row);
    else byRing.set(row.verdict.ring, [row]);
  }
  const present = RING_ORDER.filter((r) => (byRing.get(r)?.length ?? 0) > 0);
  const quota = new Map<RadarRing, number>();
  let left = cap;
  for (const ring of present) {
    const take = Math.min(RING_FLOOR, byRing.get(ring)!.length, Math.floor(left / present.length));
    quota.set(ring, take);
    left -= take;
  }
  // Remainder by proportion of what each ring still has unclaimed, largest share first so a
  // rounding leftover lands where it represents the most rows.
  const remaining = present
    .map((ring) => ({ ring, spare: byRing.get(ring)!.length - quota.get(ring)! }))
    .filter((e) => e.spare > 0);
  const spareTotal = remaining.reduce((n, e) => n + e.spare, 0);
  if (spareTotal > 0) {
    for (const e of remaining.sort((a, b) => b.spare - a.spare)) {
      if (left <= 0) break;
      const share = Math.min(e.spare, left, Math.max(1, Math.round((e.spare / spareTotal) * left)));
      quota.set(e.ring, quota.get(e.ring)! + share);
      left -= share;
    }
  }
  const taken = new Map<RadarRing, number>();
  return rows.filter((row) => {
    const ring = row.verdict.ring;
    const used = taken.get(ring) ?? 0;
    if (used >= (quota.get(ring) ?? 0)) return false;
    taken.set(ring, used + 1);
    return true;
  });
}

/** The page-level population toggle (default ON — the radar is solo-first). ON keeps the
 * niches whose singleplayer share is >= 0.8 (unknown excluded); OFF reveals the full
 * population, where the lens draws multiplayer-dependent dots hollow. */
const SOLO_ONLY_OPTIONS: { v: "on" | "off"; label: string }[] = [
  { v: "on", label: "On" },
  { v: "off", label: "Off" },
];

/** Minimal segmented control in the app's hairline-border language (square, no fills
 * except the active brand chip) — same shape NicheFinder draws locally. Generic over the
 * option value so numeric (Top N) and string (solo lens) rows share one control. */
function SegRow<V extends string | number>({
  label,
  info,
  options,
  value,
  onChange,
}: {
  label: string;
  /** An ⓘ explaining the control, beside its label. */
  info?: React.ReactNode;
  options: { v: V; label: string }[];
  value: V;
  onChange: (v: V) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="kicker inline-flex items-center gap-1 text-[10px] tracking-[.1em] text-ink-muted">
        {label}
        {info}
      </span>
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
  boardClass,
  onBoardClass,
  soloOnly,
  onSoloOnly,
  topN,
  onTopN,
  selectedId,
  onSelect,
  zoom,
  onZoom,
  soloCounts,
  lensUsesIndie,
}: {
  blips: RadarBoardBlip[];
  pool: RadarBoardBlip[];
  soloCounts: { shown: number; total: number };
  /** true = the real solo/indie lens (evidence served); false = the singleplayer fallback. */
  lensUsesIndie: boolean;
  plotCap: number;
  loading: boolean;
  bothFailed: boolean;
  partialFail: boolean;
  errorMessage: string | null;
  boardClass: RadarSector;
  onBoardClass: (v: RadarSector) => void;
  soloOnly: boolean;
  onSoloOnly: (v: boolean) => void;
  topN: number;
  onTopN: (v: number) => void;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  zoom: RadarRegion | null;
  onZoom: (v: RadarRegion | null) => void;
}) {
  return (
    <section className="blueprint relative border-ink-primary/25 px-6 py-5 lg:px-[30px] lg:py-[24px]">
      <i className="bp-corner" />
      {/* Header: identity left, THE toolbar right — every board control lives here; the
          class picker leads (it is the "what am I researching" control). */}
      <div className="flex flex-wrap items-end gap-x-6 gap-y-3 pb-5">
        <div className="flex min-w-0 max-w-[720px] flex-col gap-1.5">
          <div className="kicker text-[10px] tracking-[.12em] text-brand">
            Niche radar · {CLASS_KICKER[boardClass]}
          </div>
          {/* h1, not h2: this is the index route's only heading, and a page whose
              document outline starts at h2 has no top level at all. It asks the question
              the board answers (2026-09-23) instead of naming the instrument. */}
          <h1 className="text-[24px] leading-tight text-ink-primary sm:text-[30px]">
            Which niches are worth building in right now?
          </h1>
          <p className="text-[13px] leading-relaxed text-ink-secondary" data-testid="radar-how-to-read">
            Each dot is a niche. The closer to the centre, the stronger the case for starting a game there today —
            judged on the last 24 months of games with 50+ reviews. Click a dot or a row to see the checks behind
            its ring.{" "}
            <Link to="/docs#radar" className="font-medium text-brand transition-colors hover:text-brand-hover">
              How to read the Radar →
            </Link>
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 sm:ml-auto">
          {/* "Emphasis", not "Class": the control no longer decides what is on the board —
              every class is — it decides which sector reads at full strength. */}
          <SegRow label="Emphasis" options={CLASS_OPTIONS} value={boardClass} onChange={onBoardClass} />
          {/* Named for what it does (2026-09-23): a singleplayer-share cut that removes a
              handful of multiplayer-dependent niches — not a judgement of solo buildability. */}
          <SegRow
            label={SOLO_LENS_LABEL}
            info={
              <InfoTipBase
                label={SOLO_LENS_LABEL}
                ariaLabel={`About ${SOLO_LENS_LABEL}`}
                meaning={
                  lensUsesIndie
                    ? `Keeps only niches where small indie teams demonstrably make money: of the games that earned an estimated $100K+, at least ${sharePct(INDIE_FRIENDLY_MIN_SHARE)} come from an Indie-flagged game whose developer has ${SMALL_DEV_MAX_GAMES} or fewer games on Steam (and at least ${INDIE_FRIENDLY_MIN_HITS} such games), and at least ${SOLO_FRIENDLY_PCT} of the games are single-player.`
                    : `This data predates the solo/indie evidence, so the lens falls back to the singleplayer share: it keeps niches where at least ${SOLO_FRIENDLY_PCT} of the games can be played single-player — which says nothing about how big a game is to build. Rebuild the data to get the real lens.`
                }
                formula={
                  lensUsesIndie
                    ? `keep when small-indie share of $100K+ games ≥ ${sharePct(INDIE_FRIENDLY_MIN_SHARE)} AND ≥ ${INDIE_FRIENDLY_MIN_HITS} such games AND singleplayer share ≥ ${SOLO_FRIENDLY_PCT}`
                    : `keep a niche when singleplayer share ≥ ${SOLO_FRIENDLY_PCT}`
                }
                worked={`On this cut: ${soloCounts.shown} of ${soloCounts.total} niches kept, ${
                  soloCounts.total - soloCounts.shown
                } hidden.`}
                notes="It never changes a verdict: with it off, the hidden niches return (drawn hollow) in the same ring."
              />
            }
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

      {loading && <Loading label="Plotting the board…" className="py-16 text-sm" />}
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
          soloCounts={soloCounts}
          emphasis={boardClass}
          selectedId={selectedId}
          onSelect={onSelect}
          zoom={zoom}
          onZoom={onZoom}
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
          verdict (the mart precomputes each cut as its own population). THE RING IS THE VERDICT, best in the middle:
          Enter now (innermost) → Watch → Emerging → Crowded → Declining (outermost) — so a niche&rsquo;s distance
          from the centre IS the call, not a colour you have to decode. THE SECTOR IS THE CLASS: Genres,
          Micro-genres and Themes hold a fixed 120° wedge each, all three always drawn and labelled at the rim, and
          each class is ranked ONLY against its own kind — the Top N control plots the top N/3 of every class, so a
          genre never competes with a micro-tag for a slot and no wedge can crowd another out. The class control is
          an EMPHASIS: it lights one wedge and dims the other two, it never empties the board. Genres has far fewer
          solo-friendly niches than the tag classes, so that wedge is genuinely sparser — it is not padded. Blips are
          placed by a short, seeded force relaxation clamped inside their own band and wedge (the same technique the
          reference radar uses), so segments fill evenly and a niche still lands in exactly the same spot on every
          visit. Inside a band, distance encodes the Opportunity score — nearer the centre = higher — as the RANK
          within the band, not the raw score; the score itself stays in the tooltip and the dossier, where it always
          carries its parts and its supply brake. Dot area = top-10% revenue; the number in a dot is its row in the
          list beside the board; dot colour repeats the verdict the band already names (green = enter, steel = watch,
          violet = emerging, amber = crowded, terracotta = declining — reinforcement only, every meaning survives
          grayscale); a hollow dot is outside the {SOLO_LENS_LABEL} lens (shown only with the lens off) and a dotted ring
          means the verdict rests on thin evidence. Verdicts:
          Enter now = demand past +40% / 24m without a flooding release pipeline and without winner-take-most
          revenue (the top 5% of games taking more than 85%) · Watch = demand holding or softening, demand surging
          but one of those two checks failing (the dossier names which), or score-only evidence · Emerging = no comparable demand base — either a young label (≥80% of its
          reviews from games released in the last 24 months) or a prior base too small for a % read, so no trustworthy
          trend % exists and the rail shows absolute 24-month volume instead of a percentage · Crowded = releases up
          &gt;15% YoY against flat-to-down demand, or winner-take-most · Declining = demand down ≥30% per 24 months.
          Nothing clamps on this board and nothing sits in a &ldquo;no position&rdquo; strip: a ring board has no axis
          to fall off, and every niche has a verdict, so every niche has an honest place. Click a dot for its verdict
          dossier — the same checks that placed it, spelled out with the bars they were judged against, and a deep-dive
          button into the full workup. Click a ring&rsquo;s empty space to ZOOM into it: that band expands to fill the
          dial and the rail filters to its members; Esc, the rail chip&rsquo;s ✕, or a click on the board background
          restores the full view. The board plots each class&rsquo;s own Top N/3 by opportunity; the rail lists every
          plotted dot across all three sectors, and its search covers the whole population of the cut — past the plot
          cap (while zoomed, the search reads within the zoomed ring).{" "}
          {soloOnly
            ? `Population: ${SOLO_LENS_LABEL} — ${soloCounts.shown} of ${soloCounts.total} niches on this cut: ones where small indie teams demonstrably make money (≥ ${sharePct(INDIE_FRIENDLY_MIN_SHARE)} of the $100K+ games from Indie-flagged developers with ≤ ${SMALL_DEV_MAX_GAMES} games on Steam, at least ${INDIE_FRIENDLY_MIN_HITS} of them) and the games are mostly single-player. The dossier's "Small indie teams succeed here" row shows each niche's numbers. It never changes a verdict.`
            : `Population: all niches — multiplayer-dependent ones (singleplayer share under ${SOLO_FRIENDLY_PCT}) are drawn hollow, in the same ring the market evidence puts them. Singleplayer share says the games skip netcode, not that they are small builds — the dossier's singleplayer row shows the member evidence behind it.`}
        </p>
      </details>
    </section>
  );
}

export default function Radar() {
  usePageTitle("Radar");
  // ONE selection + ONE population toggle for the whole page: the board's two list
  // queries and the rail all hang off this state. Top-N and the class picker are
  // client-side display slices (see POPULATION_LIMIT), so only the solo toggle changes
  // what is fetched.
  //
  // ALL FIVE RIDE THE URL (class/solo/top/niche 2026-08-28; the region ZOOM joined
  // them 2026-09-01) — the flagship page was the only surface whose view couldn't be
  // linked or bookmarked, while six others already use useSearchParams. "Look at
  // Roguelike Deckbuilder on the themes board" is now a URL you can send. Same contract
  // as NicheDetail/NicheFinder: DEFAULTS ARE OMITTED (a pristine /radar stays a clean
  // URL — only a non-default reading writes a param), unknown/garbage values fall back
  // to the default rather than throwing, and writes `replace` so flipping chips doesn't
  // bury the previous page under a dozen history entries.
  const [searchParams, setSearchParams] = useSearchParams();

  // ?class= IS UNCHANGED AS A URL CONTRACT AND CHANGED IN MEANING: it still names one of
  // genre | micro | theme and still defaults to micro, but since the three-sector rebuild it
  // selects the EMPHASISED wedge rather than the board's contents — every class is plotted
  // either way. An old /radar?class=theme link therefore still opens the view it named (the
  // themes wedge, lit), it just also shows the other two classes around it.
  const rawClass = searchParams.get("class");
  const boardClass: RadarSector = rawClass === "genre" || rawClass === "micro" || rawClass === "theme" ? rawClass : "micro";
  const soloOnly = searchParams.get("solo") !== "off"; // default ON — the radar is solo-first
  const rawTop = Number(searchParams.get("top"));
  const topN = TOP_N_OPTIONS.some((o) => o.v === rawTop) ? rawTop : 80;
  const selectedId = searchParams.get("niche");
  // The click-to-zoom region — a RING BAND since the 2026-09-10 dial rebuild (it was one
  // of the XY plate's four quadrants or its strip before; RADAR_REGIONS now IS RING_ORDER,
  // so an old ?zoom=growing-open link falls back to the unzoomed board instead of
  // throwing). It was RadarBoard-local useState until 2026-09-01, which made it the one
  // radar control you couldn't share: clicking a region filtered the rail and titled the
  // plate "— ZOOMED" while the address bar still read /radar, so a reload silently threw
  // the zoom away.
  const rawZoom = searchParams.get("zoom");
  const zoom: RadarRegion | null = RADAR_REGIONS.includes(rawZoom as RadarRegion) ? (rawZoom as RadarRegion) : null;

  /** One writer for all five params: null/default clears the key, anything else sets it. */
  const setParams = useCallback(
    (updates: Record<string, string | number | null>) => {
      const next = new URLSearchParams(searchParams);
      for (const [k, v] of Object.entries(updates)) {
        if (v === null || v === "") next.delete(k);
        else next.set(k, String(v));
      }
      setSearchParams(next, { replace: true });
    },
    [searchParams, setSearchParams],
  );

  const setBoardClass = useCallback((v: RadarSector) => setParams({ class: v === "micro" ? null : v }), [setParams]);
  const setSoloOnly = useCallback((v: boolean) => setParams({ solo: v ? null : "off" }), [setParams]);
  const setTopN = useCallback((v: number) => setParams({ top: v === 80 ? null : v }), [setParams]);
  const setZoom = useCallback((v: RadarRegion | null) => setParams({ zoom: v }), [setParams]);

  // The board population: the two cuts that make up the three sectors. Each query asks
  // for the endpoint's max rows by opportunity_v2 — the full population the rail search
  // spans; the plotted Top-N and the singleplayer lens are both applied client-side below
  // (see FETCH SHAPE above), so neither control refetches. These are exactly the params the
  // Niche Finder uses for its pinned-cut verdicts, so the two pages share one cache entry.
  const genreQ = useNiches({
    dimension: "genre",
    window: BOARD_WINDOW,
    min_reviews: BOARD_MIN_REVIEWS,
    sort: "opportunity_v2",
    order: "desc",
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
    limit: POPULATION_LIMIT,
    offset: 0,
  });

  /** EVERY board-class niche at this cut, both dimensions merged, opportunity order — before
   * the singleplayer lens. One row -> one blip through radarBlipFromRow (the same mapping
   * the parity oracle uses), so the ring and the dossier trace come from one evaluation. */
  const allBlips = useMemo<RadarBoardBlip[]>(() => {
    const rows: RadarBoardBlip[] = [];
    const push = (row: NicheRow) => {
      const blip = radarBlipFromRow(row);
      if (blip) rows.push(blip); // tag tiers outside micro/theme have no sector on this board
    };
    for (const r of genreQ.data?.items ?? []) push(r);
    for (const r of tagQ.data?.items ?? []) push(r);
    rows.sort((a, b) => (b.opportunity_v2 ?? -1) - (a.opportunity_v2 ?? -1) || a.key.localeCompare(b.key));
    return rows;
  }, [genreQ.data, tagQ.data]);

  /** The population the board and the rail search read: under the singleplayer lens the
   * niches with share >= SOLO_FRIENDLY_MIN (unknown excluded — the API's solo_only rule,
   * applied here so the legend can count what it removed). */
  const pool = useMemo<RadarBoardBlip[]>(
    () => (soloOnly ? allBlips.filter(radarLensPasses) : allBlips),
    [allBlips, soloOnly],
  );
  const soloCounts = useMemo(
    () => ({ shown: allBlips.filter(radarLensPasses).length, total: allBlips.length }),
    [allBlips],
  );
  // The real solo/indie lens needs the evidence columns; an older mart falls back to the
  // singleplayer share, and the lens explanation says which rule is in force.
  const lensUsesIndie = useMemo(() => radarLensUsesIndie(allBlips), [allBlips]);

  /**
   * The plotted board: EVERY class, each cut to its OWN Top N/3 by opportunity (see
   * perClassCap). Three sectors, three independent rankings — which is what keeps a genre
   * from being judged against a micro-tag, and what keeps one class from eating the board.
   * `pool` is already in opportunity order, so a filter-and-slice per class is the ranking.
   *
   * Deliberately NOT dependent on boardClass: the emphasis must not change what is plotted,
   * or flipping it would re-run the force layout and move every dot on the dial.
   */
  const blips = useMemo(() => {
    const cap = perClassCap(topN);
    return CLASS_OPTIONS.flatMap((o) => pickAcrossRings(pool.filter((b) => b.sector === o.v), cap));
  }, [pool, topN]);

  /** The selection channel. A search hit can belong to another class; selecting it moves the
   * EMPHASIS to that niche's own wedge, so the dot you just opened is the lit one. (Before
   * the three-sector rebuild this was load-bearing — the other class simply was not on the
   * board — and it stays because a dossier open over a dimmed dot is a worse read.) */
  const handleSelect = (id: string | null) => {
    // Both the class switch and the selection go in ONE param write — two setParams calls
    // in a row would each read the same stale `searchParams` snapshot and the second
    // would clobber the first.
    if (id !== null) {
      const row = pool.find((b) => `${b.dimension}:${b.key}` === id);
      if (row && row.sector !== boardClass) {
        setParams({ class: row.sector === "micro" ? null : row.sector, niche: id });
        return;
      }
    }
    setParams({ niche: id });
  };

  const loading = genreQ.isLoading || tagQ.isLoading;
  const bothFailed = genreQ.isError && tagQ.isError;
  const partialFail = !bothFailed && (genreQ.isError || tagQ.isError);

  return (
    // No page-level max-width — the radar is the app's centerpiece instrument, so it
    // fills the ONE shared page container (App.tsx PAGE_CONTAINER) like every other page.
    // The old 1180px self-cap was exactly the "pages are different sizes" complaint.
    <div className="flex flex-col gap-5">
      {/* The three-step path for a first visit (dismissible, remembered) — above the board,
          so a new reader meets the order of play before the dense instrument. */}
      <StartHere />
      <RadarBoardSection
        blips={blips}
        pool={pool}
        soloCounts={soloCounts}
        lensUsesIndie={lensUsesIndie}
        plotCap={perClassCap(topN)}
        loading={loading}
        bothFailed={bothFailed}
        partialFail={partialFail}
        errorMessage={genreQ.error instanceof Error ? genreQ.error.message : null}
        boardClass={boardClass}
        onBoardClass={setBoardClass}
        soloOnly={soloOnly}
        onSoloOnly={setSoloOnly}
        topN={topN}
        onTopN={setTopN}
        selectedId={selectedId}
        onSelect={handleSelect}
        zoom={zoom}
        onZoom={setZoom}
      />
    </div>
  );
}

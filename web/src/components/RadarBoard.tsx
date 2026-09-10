import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Link } from "react-router-dom";
import clsx from "clsx";

import { trackEvent } from "../lib/analytics";
import { fmtInt, fmtSigned, fmtUsd } from "../lib/format";
import { MONO } from "../lib/palette";
import {
  BLIP_R_MAX,
  BLIP_R_MIN,
  RING_LABEL,
  RING_ORDER,
  SOLO_FRIENDLY_MIN,
  blipRadius,
  soloBucket,
  type RadarRing,
  type RadarVerdict,
  type VerdictCheck,
} from "../lib/radarVerdict";
import { TooltipPanel } from "./charts/TooltipPanel";
import { nicheDetailPath } from "../lib/nichePath";
import {
  CLASS_LABEL,
  CLASS_ORDER,
  DEFAULT_PLATE_W,
  annulusPath,
  cellArea,
  layoutRings,
  polar,
  ringGeom,
  sectorSpans,
  type RadarClass,
  type RingGeom,
  type RingPlaced,
  type SectorSpan,
} from "./radarRings";

/**
 * RadarBoard — the CONCENTRIC-RING DIAL (2026-09-10, user directive: "Let's make UX on a
 * tech radar more user friendly. Button to go deeper into the niche is super small and
 * almost not visible. Second thing is, I think circle is a better representation for radar.
 * Like we do there: https://solidgate-tech.github.io/ Best - niches are in the middle").
 *
 * It replaces the XY QUADRANT PLATE (2026-08-27 — demand trend x release saturation, dot
 * style as the verdict). That plate drew the verdict's INPUTS and left the verdict itself to
 * a colour; this one draws the VERDICT and leaves the inputs to the dossier. The trade is
 * deliberate and it is the user's: a reader who wants "what should I look at" gets it from
 * position now — nearest the middle — instead of having to learn a two-axis reading and
 * then remember that colour, not position, carries the call.
 *
 *   RING BAND = THE VERDICT, BEST IN THE MIDDLE. enter (innermost) -> watch -> emerging ->
 *       crowded -> declining (outermost). lib/radarVerdict.ts's RING_ORDER has spelled this
 *       order "inner -> outer" since the first polar board; the XY plate simply never drew
 *       it. Each band carries a one-word caption in its OWN RING'S COLOUR, stacked up the
 *       vertical axis in the top half just inside the band's outer edge — the reference's
 *       ADOPT / TRIAL / ASSESS / HOLD, measured and matched.
 *   SECTOR = THE NICHE CLASS. Genres / Micro-genres / Themes, three fixed 120° wedges,
 *       always all three, labelled at the rim. See "THE THREE-SECTOR REBUILD" below.
 *   RADIUS INSIDE A BAND = opportunity_v2's rank in the blip's own cell, best nearest the
 *       band's inner edge — the SEED of a d3-force relaxation, not a fixed spiral. Rank,
 *       not raw score — see radarRings.ts.
 *   dot AREA = P90 revenue (sqrt scale, like every bubble on this site) — unchanged.
 *   dot NUMBER = the rail's rank, drawn inside the dot and keyed to the rail list exactly
 *       the way the reference numbers its blips. This is what makes the dial and the rail
 *       one instrument instead of two.
 *   dot STYLE keeps the two orthogonal lenses: team-scale (singleplayer share <
 *       SOLO_FRIENDLY_MIN) draws hollow, a CAUTION verdict (hedged evidence) draws a dotted
 *       ring. Caution is orthogonal to the ring — a "watch · caution" blip sits in the watch
 *       band like any other — so it still needs its own channel.
 *
 * WHAT THE OLD PLATE'S HEADER ARGUED, AND WHERE EACH ARGUMENT LANDED
 *   - "VERDICT COLOUR IS REINFORCEMENT, NOT THE ONLY CHANNEL" (2026-08-27 colour amendment):
 *     KEPT, and strengthened. Position is now the verdict, so the hue is doubly redundant —
 *     the band caption spells the same word in text, the rail groups by it, and the legend
 *     names every hue. The board survives grayscale, as required.
 *   - "OUTLIERS CLAMP, VISIBLY" (edge-pinned dots + outward chevrons + ">= +300" edge ticks):
 *     GONE, because the ring form makes it impossible AND unnecessary. There is no fixed
 *     linear domain any more: the radial channel is a within-band rank (in range by
 *     construction) and the angular channel is free. Nothing can fall off this scale, so
 *     there is nothing to pin. The true numbers still ride the tooltip and the dossier.
 *   - "NO XY, NO DOT IN THE PLOT" (the dashed EMERGING / no-trend-base strip under the plot):
 *     GONE, and this is a straight gain. The strip existed because an emerging niche has no
 *     trustworthy trend % and a row missing trend or saturation has no honest X or Y at all.
 *     The dial does not ask for either: every row has a verdict (radarVerdictTrace is total),
 *     and emerging IS a ring. Those rows now sit in the emerging band with everyone else,
 *     ranked by the same score. The rail keeps its NEW · volume glyph, and the dossier still
 *     refuses to headline a young tag's trend %.
 *   - "DETERMINISTIC, NEVER Math.random" jitter: KEPT and generalised. Placement is a pure
 *     function of the blips (hash01-seeded rank positions, a fixed tick count and a seeded
 *     random source for d3-force), so a niche holds its spot across renders, visits and
 *     machines.
 *   - "COLLISION NUDGING": KEPT, re-aimed, and now done by d3-force. The band is the verdict
 *     and the sector is the class, so both are claims; the relaxation is clamped back inside
 *     both every tick. A blip can never be pushed out of its own band or sector.
 *   - "THE RAIL IS THE ACCESSIBLE PATH": KEPT verbatim. The SVG dots are mouse conveniences
 *     (aria-hidden); every niche's keyboard route is its rail row, a real <button>, and
 *     navigation lives on the dossier's deep-dive button.
 *   - "REGION HOVER / CLICK-TO-ZOOM": KEPT, with the regions re-cut to the new geometry —
 *     see RadarRegion below.
 *   - "ONE INSTRUMENT" (plate + rail share one selection model, search over the whole pool,
 *     dossier as the rail's selection pane at >=lg and a slide-over drawer below lg):
 *     UNCHANGED, every word of it.
 *
 * THE REGIONS ARE NOW THE RINGS (RadarRegion = RadarRing). The XY plate's five regions were
 * the four quadrants its two verdict bars tiled the plot into, plus the strip. Neither
 * survives the form, and the ring bands are the obvious successor: hovering a band lifts its
 * members and ticks their rail rows, clicking a band's empty space zooms the dial to that
 * band (the band expands to fill the whole dial, non-members do not render) and filters the
 * rail to it — same three exits as before (the rail chip's X, Esc, a background click), same
 * controlled `zoom` prop, same ?zoom= URL param. An old ?zoom=growing-open link now falls
 * back to the unzoomed board rather than throwing, because pages/Radar.tsx validates the
 * param against RADAR_REGIONS.
 *
 * THE DEEP DIVE IS A PRIMARY BUTTON (the other half of the directive: "Button to go deeper
 * into the niche is super small and almost not visible"). It used to be a 13px plain text
 * link at the bottom of the dossier. It is now a filled brand button, full width of the
 * dossier, in the page's primary-action language (bg-brand / text-brand-fg / font-semibold —
 * the same vocabulary as App.tsx's header CTA and NicheDetail's compare button), pinned
 * ABOVE the raw-context line so it is the last thing the eye lands on, not a footnote after
 * it. The route (nicheDetailPath) and the trackEvent("niche_open") call are untouched.
 *
 * Everything is hand-rolled SVG — the CSP forbids external chart libs. All colours are CSS
 * vars. CLICK TARGETS: only the dots and the band hit-areas are interactive inside the SVG;
 * decor, captions, rim labels and blip numbers all sit in pointer-events:none groups, so a
 * click on a caption reads as a click on the band under it, never as a dead dot.
 *
 * PLATE SIZING: unchanged in principle — the viewBox is rebuilt from the wrapper's MEASURED
 * CSS width (1 unit = 1 CSS px, so text keeps its true point size at every breakpoint), and
 * the dial is a square inscribed in it, bounded so it neither pushes the rail below the fold
 * at 1440x900 nor collapses its five bands on a phone. See radarRings.ts's ringGeom().
 *
 * ─────────────────────────────────────────────────────────────────────────────────────
 * THE THREE-SECTOR REBUILD (2026-09-10, second pass — user: "Make it better, right now it
 * looks like a slop. On a link I provided before there is a library used to render radar").
 * The first cut of the dial was rejected on sight, and measuring the reference against it
 * said exactly why. Four things changed, in the order they mattered:
 *
 *   1. DENSITY — the real defect. The reference puts 55 blips across FOUR quadrants (~14
 *      each); the first cut put 80 into ONE full-circle sector, ~4x denser, so the middle
 *      clumped and the rim sat empty. The class picker is now the ANGULAR AXIS: Genres,
 *      Micro-genres and Themes each hold a fixed 120° wedge and all three always draw. The
 *      Top-N control distributes per sector rather than capping the whole board (the page
 *      slices the top N/3 of each class), so no wedge is empty and none dominates. Genres
 *      only has ~9 solo-friendly niches at this cut — that wedge is simply sparser, and it
 *      is NOT padded to look full.
 *   2. PLACEMENT — d3-force, as the reference does it. A short, fixed-length simulation
 *      with forceCollide plus a per-tick clamp back into the blip's own (band, wedge). The
 *      old deterministic spiral put consecutive ranks on a fixed stride and left the
 *      segments visibly lumpy; relaxation fills them evenly. Determinism is preserved by
 *      construction — see radarRings.ts's layoutRings.
 *   3. RING CAPTIONS were large grey wallpaper. They are now ONE WORD in their OWN RING'S
 *      COLOUR (ADOPT-is-green, in the reference's terms), stacked up the vertical axis in
 *      the top half just inside each band's outer edge, at ~0.085R. 12 o'clock is a sector
 *      boundary on this dial, exactly as it is on the reference, so the captions sit on a
 *      divider instead of in a crowd.
 *   4. NUMBERS were too small to read. The blip scale runs 9–11.5px on a desktop dial with
 *      the number at up to 11px, semibold, knocked out of the fill.
 *
 * And the two mechanisms that hold it together, both measured on the live board (production
 * data through the dev proxy, screenshots at 1440x900 and 390x844):
 *   - THE BANDS ARE EQUAL-WIDTH AGAIN. The sqrt(count) weighting existed because a
 *     one-class board gave WATCH 53 of 80 rows; three sectors and a per-sector cap take the
 *     worst cell to 12 of 27, which the collision force clears with room to spare. See
 *     radarRings.ts's RING_STOPS.
 *   - THE BLIP SCALE FITS THE WORST CELL. One shared factor, so every P90-revenue ratio
 *     survives, floored so a dot never gets too small for its number. cellFitScale below.
 */

/** The board's CLASS — and, since the three-sector rebuild, the dial's SECTOR as well. The
 * picker's value (Genres / Micro-genres / Themes) no longer decides which rows are on the
 * board (all three classes are), it decides which wedge is EMPHASISED. Kept under its
 * historical name because pages/Radar.tsx and the ?class= URL contract both spell it. */
export type RadarSector = RadarClass;

const SECTOR_LABEL = CLASS_LABEL;
/** One-letter class marker for rail rows — the rail carries all three classes now, so every
 * row names its own ("Roguelike" the tag vs "Roguelike" the genre). */
const SECTOR_SHORT: Record<RadarSector, string> = { genre: "G", micro: "M", theme: "T" };

export interface RadarBoardBlip {
  dimension: string;
  key: string;
  /** The mart's tag tier — "micro" | "theme" | "umbrella" | "meta" for tags, "genre" (or
   * null on older marts) for genre rows. Carried for the dossier and the API contract; the
   * dial's sector comes from `sector` (the CLASS) since the three-sector rebuild. */
  tier: string | null;
  /** THE DIAL'S SECTOR: the niche class. */
  sector: RadarSector;
  n_games: number;
  p90_rev: number | null;
  /** THE RADIUS INSIDE THE BAND (as a rank — see radarRings.ts). */
  opportunity_v2: number | null;
  /** Percent units; the 24-month demand trend (last 24 complete months vs the prior 24 —
   * see mart_niche.sql's _niche_demand24m). null = this niche has no trend. A verdict INPUT;
   * since the ring rebuild it is no longer a coordinate — it rides the tooltip, the rail's
   * move glyph and the dossier's demand check. */
  demandTrendPct: number | null;
  /** Signed fraction, releases YoY (0.15 = +15%); null = unknown. Verdict input. */
  saturationYoy: number | null;
  /** The mart's young-tag flag (see lib/radarVerdict.ts): when true the trend % is not
   * representative. It also PRE-EMPTS the verdict, so demandEmerging === true is exactly
   * the "emerging" ring — which is why the dial needs no separate marker for it any more. */
  demandEmerging: boolean;
  /** Absolute review inflow over the last 24 months — the number an emerging niche is
   * actually judged by (its % has no comparable base). */
  reviews24m: number | null;
  /** Prior-window review inflow — the dossier's demand-base context. */
  reviewsPrev24m: number | null;
  /** 0..1 SINGLEPLAYER SHARE of the cut's scored games (a no-netcode proxy, not a
   * production-scope measure); null = unknown (mart predates the column). A LENS only —
   * drawn as dot style (hollow = team-scale), never fed into the verdict. */
  solo_viability: number | null;
  verdict: RadarVerdict;
  /** The verdict's decomposition (radarVerdictTrace's checks — produced by the SAME
   * evaluation as `verdict`); rendered by the rail dossier when the dot is selected. */
  trace: VerdictCheck[];
}

// ---- regions ------------------------------------------------------------------------------

/**
 * THE HOVER / ZOOM REGION IS THE RING BAND. It used to be one of the XY plate's four
 * quadrants (or its strip); with the dial, band membership IS the verdict, so the region and
 * the rail's grouping are the same partition by construction and can never drift — the old
 * board had to precompute membership from the raw fields to keep them in step.
 */
export type RadarRegion = RadarRing;

/** The region ids as VALUES — the page parses ?zoom= against this list, so a URL can never
 * name a region the board doesn't have, and the two can't drift apart. */
export const RADAR_REGIONS: readonly RadarRegion[] = RING_ORDER;

/** Region display names — the band captions' wording, reused verbatim by the zoom title and
 * the rail's zoom-filter chip so the three surfaces can never drift. */
export const REGION_NAME: Record<RadarRegion, string> = {
  enter: RING_LABEL.enter.toUpperCase(),
  watch: RING_LABEL.watch.toUpperCase(),
  emerging: RING_LABEL.emerging.toUpperCase(),
  crowded: RING_LABEL.crowded.toUpperCase(),
  declining: RING_LABEL.declining.toUpperCase(),
};

export { DEFAULT_PLATE_W };

// ---- layout -------------------------------------------------------------------------------

export interface PlacedBlip extends RadarBoardBlip {
  id: string;
  /** 1-based rail number (ring-verdict order, then opportunity desc) — the number drawn
   * INSIDE the dot and printed by the rail row. */
  n: number;
  /** Ring band == verdict == hover/zoom region. */
  region: RadarRegion;
  /** The dial sector this blip's CLASS puts it in (== `sector`; kept as its own field so
   * the geometry contract reads on the placed blip, not on the row it came from). */
  wedge: RadarClass;
  x: number;
  y: number;
  r: number;
  /** Distance from the dial's centre / angle in radians — kept so tests can assert the
   * band-and-sector invariants directly instead of re-deriving them from x/y. */
  radius: number;
  angle: number;
  /** Rank by opportunity_v2 inside this blip's own cell (band x sector), 0-based. */
  cellRank: number;
  /** True when the row carries no opportunity_v2: it ranks last in its cell, and the
   * tooltip says the radius is a fallback rather than a reading. */
  unscored: boolean;
  /** True while a zoom is active and this blip is not in the zoomed band: it does not
   * render. Membership itself never changes with zoom — it is always the verdict. */
  hidden: boolean;
}

/** A rail/dossier entry: a plotted blip (with its rail rank), or a pool niche beyond the
 * plotted board reachable only through search — n: null, no dot on the dial. */
export type RailBlip = RadarBoardBlip & { id: string; n: number | null };

export interface RingBoardLayout {
  dots: PlacedBlip[];
  /** The three class sectors, in dial order — the rim labels and the divider spokes. */
  sectors: SectorSpan[];
  /** Member count per sector, for the rim label's honest count (0 is a real answer). */
  sectorCount: Map<RadarClass, number>;
  /** The geometry this layout was computed in — the renderer draws with the SAME object so
   * bands, hit areas and dot positions can never disagree. */
  geom: RingGeom;
  vbH: number;
}

export interface LayoutOpts {
  /** The wrapper's measured CSS width; defaults to DEFAULT_PLATE_W (tests, pre-measure). */
  plateW?: number;
  /** Active zoom ring — null = the full dial. */
  zoom?: RadarRegion | null;
}

/**
 * BLIP SIZE. blipRadius() still owns the sqrt(P90 revenue) scale — the same one every bubble
 * on this site uses — but its [3, 9] px range was tuned for a plate where a dot carried no
 * text. A dot must now hold its rail number, so the range is re-mapped to the dial's size.
 * THE REFERENCE'S BLIP IS r=9 WITH A 9px NUMBER IN IT on a 400px radius; ours runs 9–11.5 on
 * a 320px radius, which is the same dot-to-dial ratio with a little more room for a
 * three-digit rank. On a phone the range COMPRESSES rather than shrinking (the size channel
 * loses some resolution) so that every blip can still carry its number — the number keys the
 * dot to the rail, and a dot with no key is worse than a dot with a coarse area.
 */
function dialBlipR(p90: number | null, maxP90: number, R: number): number {
  const t = (blipRadius(p90, maxP90) - BLIP_R_MIN) / (BLIP_R_MAX - BLIP_R_MIN);
  const rMin = Math.min(9, Math.max(5.5, R / 36));
  const rMax = Math.min(11.5, Math.max(8, R / 28));
  return rMin + t * (rMax - rMin);
}

/** Share of a cell's area the blips may fill before the dial reads as a smear. Above it the
 * collision force runs out of room and starts leaving overlaps. */
const CELL_FILL_TARGET = 0.38;
/** …and the scale never goes below this, because a dot too small to carry its rail number
 * has lost the thing that keys it to the list. Past the floor the board accepts some
 * touching instead — the honest failure, and only ever on a phone-sized dial. */
const MIN_FIT_SCALE = 0.7;

/**
 * THE CROWD FIT. The blip scale is nominal, not final: a cell too full cannot separate at
 * desktop dot sizes however good the relaxation is, and forceCollide would just leave a
 * smear. So the layout measures the WORST cell's area fill first and shrinks every blip by
 * ONE shared factor until that cell is under CELL_FILL_TARGET (bounded by MIN_FIT_SCALE).
 * The cell's area comes from radarRings.ts's cellArea(), which already subtracts the wedge
 * pads and the 12 o'clock caption gutter — the arc the placement will never use.
 *
 * One shared factor is the point: the size channel is P90 revenue, and scaling every dot by
 * the same number leaves every ratio between two dots exactly as it was. A per-cell fit
 * would have quietly made "big dot" mean something different in different rings.
 */
function cellFitScale(
  inputs: { ring: RadarRing; sector: RadarClass; r: number }[],
  geom: RingGeom,
  sectors: SectorSpan[],
): number {
  const spanBySector = new Map(sectors.map((s) => [s.sector, s]));
  const cells = new Map<string, { ring: RadarRing; sector: RadarClass; blipArea: number }>();
  for (const i of inputs) {
    const key = `${i.ring}|${i.sector}`;
    const cur = cells.get(key);
    if (cur) cur.blipArea += Math.PI * i.r * i.r;
    else cells.set(key, { ring: i.ring, sector: i.sector, blipArea: Math.PI * i.r * i.r });
  }
  let worst = 0;
  for (const cell of cells.values()) {
    const band = geom.band(cell.ring);
    const span = spanBySector.get(cell.sector) ?? sectors[0];
    if (!band || !span) continue;
    worst = Math.max(worst, cell.blipArea / cellArea(band, span));
  }
  if (worst <= CELL_FILL_TARGET) return 1;
  return Math.max(MIN_FIT_SCALE, Math.sqrt(CELL_FILL_TARGET / worst));
}

/**
 * THE LAYOUT IS MEMOISED ON THE ROW SET, not recomputed per render. The relaxation is a
 * force simulation now — cheap (~3ms for 120 blips) but not free, and React will call the
 * render path for a hover, a search keystroke or a rail scroll. RadarBoard's useMemo already
 * guards the common case; this one-slot cache also covers the callers that don't memoise
 * (tests, and any future consumer), keyed on everything the placement reads: the ids, their
 * rings and sectors, their scores and sizes, plus the plate width and the zoom.
 */
let layoutCache: { key: string; value: RingBoardLayout } | null = null;

function layoutKey(blips: RadarBoardBlip[], plateW: number | undefined, zoom: RadarRegion | null): string {
  const rows = blips
    .map((b) => `${b.dimension}:${b.key}|${b.verdict.ring}|${b.sector}|${b.opportunity_v2 ?? "x"}|${b.p90_rev ?? "x"}`)
    .join(";");
  return `${plateW ?? "d"}|${zoom ?? "-"}|${rows}`;
}

/**
 * Deterministic ring placement. Pure function of the blips + options: same input, same
 * output — a niche holds its position across renders, visits and machines. Exported for
 * tests (see radarRings.test.ts for the placement invariants themselves).
 */
export function layoutBoard(blips: RadarBoardBlip[], opts: LayoutOpts = {}): RingBoardLayout {
  const zoom = opts.zoom ?? null;
  const key = layoutKey(blips, opts.plateW, zoom);
  if (layoutCache && layoutCache.key === key) return layoutCache.value;

  // Rail numbering — UNCHANGED from the XY plate: ring order, then opportunity desc, then
  // key. The dial draws these same numbers inside the dots, so rail and board are one list.
  const ordered = [...blips].sort((a, b) => {
    const ring = RING_ORDER.indexOf(a.verdict.ring) - RING_ORDER.indexOf(b.verdict.ring);
    if (ring !== 0) return ring;
    const opp = (b.opportunity_v2 ?? -1) - (a.opportunity_v2 ?? -1);
    if (opp !== 0) return opp;
    return a.key.localeCompare(b.key);
  });

  // The sector is the CLASS, and all three wedges always exist — an empty class is an empty
  // wedge with an honest "· 0" at the rim, never a wedge that quietly disappears.
  const sectorCount = new Map<RadarClass, number>(CLASS_ORDER.map((c) => [c, 0]));
  for (const b of ordered) sectorCount.set(b.sector, (sectorCount.get(b.sector) ?? 0) + 1);
  const sectors = sectorSpans();
  const geom = ringGeom(opts.plateW, zoom);

  const maxP90 = blips.reduce<number>((m, b) => Math.max(m, b.p90_rev ?? 0), 0);
  const inputs = ordered.map((b) => ({
    id: `${b.dimension}:${b.key}`,
    ring: b.verdict.ring,
    sector: b.sector,
    opportunity: b.opportunity_v2,
    r: dialBlipR(b.p90_rev, maxP90, geom.R),
  }));
  // THE CROWD FIT (see cellFitScale): one bounded scale over every blip so the tightest
  // cell has room to separate. Applied to all of them together, so the P90-revenue AREA
  // ratios between any two dots are exactly what they were — the whole board just breathes
  // down a notch on a phone, or when Top 120 packs a band that Top 40 left airy.
  const fit = cellFitScale(inputs, geom, sectors);
  if (fit < 1) for (const i of inputs) i.r *= fit;
  const placed: Map<string, RingPlaced> = layoutRings(inputs, geom, sectors);

  const dots: PlacedBlip[] = ordered.map((b, i) => {
    const id = `${b.dimension}:${b.key}`;
    const p = placed.get(id);
    const hidden = zoom !== null && b.verdict.ring !== zoom;
    return {
      ...b,
      id,
      n: i + 1,
      region: b.verdict.ring,
      wedge: b.sector,
      // A hidden blip has no placement (its band is absent from the zoomed geometry); it
      // parks at the centre and never renders.
      x: p?.x ?? geom.cx,
      y: p?.y ?? geom.cy,
      r: p?.r ?? BLIP_R_MIN,
      radius: p?.radius ?? 0,
      angle: p?.angle ?? 0,
      cellRank: p?.cellRank ?? 0,
      unscored: p?.unscored ?? b.opportunity_v2 === null,
      hidden,
    };
  });

  const value: RingBoardLayout = { dots, sectors, sectorCount, geom, vbH: geom.vbH };
  layoutCache = { key, value };
  return value;
}

// ---- rendering ------------------------------------------------------------------------------

/** Verdict colour vocabulary — the 2026-08-27 COLOR AMENDMENT to the old mono-steel "never
 * red/green" rule (user: "add some colors so it's easy to understand where to focus"; hue
 * tokens + rationale in index.css). Enter carries the positive green, watch stays neutral
 * steel, emerging goes cool violet, and the crowded/declining warm family reads caution,
 * never alarm. REINFORCEMENT ONLY, and more so than before: the BAND is the verdict now, the
 * band caption spells it in words, and the rail groups by it — the board survives grayscale
 * three times over. */
const RING_FILL: Record<RadarRing, string> = {
  enter: "var(--verdict-enter)",
  watch: MONO.paper75,
  emerging: "var(--verdict-emerging)",
  crowded: "var(--verdict-crowded)",
  declining: "var(--verdict-declining)",
};

/**
 * BAND WASHES. The reference draws NO band fills at all — four hairline circles and the
 * coloured captions carry the whole structure, and that is most of why it reads clean. So
 * only ONE band keeps a resting wash here: `enter`, the standing focus tint the XY plate
 * painted over its focus quadrant, carried to the place the eye should land on this form —
 * the middle. The other four are transparent at rest and only light up under the pointer
 * (RING_HOVER_WASH), where the tint is feedback rather than decoration.
 */
const RING_WASH: Record<RadarRing, string> = {
  enter: "color-mix(in srgb, var(--verdict-enter) 7%, transparent)",
  watch: "transparent",
  emerging: "transparent",
  crowded: "transparent",
  declining: "transparent",
};

/** The extra wash a band takes WHILE HOVERED (painted over the resting one, so a hovered
 * band reads about twice its resting tint) and the tone its rail rows' left-edge ticks
 * take. */
const RING_HOVER_WASH: Record<RadarRing, string> = {
  enter: "color-mix(in srgb, var(--verdict-enter) 12%, transparent)",
  watch: "color-mix(in srgb, var(--text-primary) 7%, transparent)",
  emerging: "color-mix(in srgb, var(--verdict-emerging) 10%, transparent)",
  crowded: "color-mix(in srgb, var(--verdict-crowded) 10%, transparent)",
  declining: "color-mix(in srgb, var(--verdict-declining) 10%, transparent)",
};

const REGION_TONE: Record<RadarRegion, string> = RING_FILL;

/**
 * BAND CAPTION COLOURS — the reference's rule, measured: ADOPT is drawn in the same green
 * as the adopt blips, TRIAL in the trial violet, and so on. Each caption is its own ring's
 * hue, which is what turns five words into structure instead of five pieces of grey
 * wallpaper. WATCH is the exception in kind, not in rule: its ring has no hue (it is the
 * neutral steel verdict), so its caption takes the same receding paper tone the ring does.
 */
const RING_CAPTION_FILL: Record<RadarRing, string> = RING_FILL;
/** Resting caption alpha. High enough to read as a label — the complaint the second pass
 * fixed was that these were unreadable grey at 0.4 — low enough that a dot crossing one
 * still wins. A hovered or zoomed band steps to CAPTION_ALPHA_LIT. */
const CAPTION_ALPHA = 0.7;
const CAPTION_ALPHA_LIT = 0.95;

function fmtTrendPct(v: number | null): string {
  if (v === null) return "no demand data";
  return `${v >= 0 ? "▲ +" : "▼ −"}${Math.abs(v).toFixed(1)}%`;
}

function MoveGlyph({ trendPct }: { trendPct: number | null }) {
  if (trendPct === null) return null;
  const up = trendPct >= 0;
  return (
    <span
      className="ml-auto shrink-0 pl-2 text-[11px] tabular"
      style={{ color: up ? "var(--verdict-up)" : "var(--verdict-flat)" }}
      title={`24-month demand trend ${up ? "+" : "−"}${Math.abs(trendPct).toFixed(1)}% (last 24 months vs prior 24)`}
    >
      {up ? "▲" : "▼"} {Math.abs(trendPct).toFixed(0)}%
    </span>
  );
}

/** Rail glyph for an emerging niche — the trend % must NEVER headline a young tag (its base
 * is near zero by construction), so the row carries the absolute volume instead. */
function EmergingGlyph({ reviews24m }: { reviews24m: number | null }) {
  return (
    <span
      className="kicker ml-auto shrink-0 pl-2 text-[10px] tracking-[.08em] text-ink-muted"
      title={
        "Emerging — no comparable demand base, so the trend % is not representative " +
        "(the dossier says whether that's a young label or just a base too small for a " +
        "% read). Judged by absolute review volume instead" +
        (reviews24m != null ? ` (${fmtInt(reviews24m)} reviews / 24m).` : ".")
      }
    >
      NEW{reviews24m != null ? ` · ${fmtInt(reviews24m)}` : ""}
    </span>
  );
}

/** Pass/fail glyph. Shape carries the outcome (✓ filled tile / ✕ hollow tile / – muted
 * dash — plus the row's sr-only word), and since the 2026-08-27 color amendment the tiles
 * take a SUBTLE tint as reinforcement: pass leans the positive enter green, fail leans the
 * caution amber — never alarm-red, and never the only channel. */
function CheckGlyph({ pass }: { pass: boolean | null }) {
  const style =
    pass === true
      ? {
          backgroundColor: "color-mix(in srgb, var(--verdict-enter) 30%, transparent)",
          color: "var(--text-primary)",
          border: "1px solid var(--verdict-enter)",
        }
      : pass === false
        ? {
            backgroundColor: "color-mix(in srgb, var(--verdict-crowded) 12%, transparent)",
            color: "var(--verdict-crowded)",
            border: "1px solid var(--verdict-crowded)",
          }
        : { color: "var(--text-muted)", border: "1px solid var(--gridline)" };
  return (
    <span
      aria-hidden
      className="inline-flex h-4 w-4 shrink-0 items-center justify-center text-[10px] leading-none"
      style={style}
    >
      {pass === null ? "–" : pass ? "✓" : "✕"}
    </span>
  );
}

/**
 * The dossier's CONTENT — shared verbatim by both containers (the ≥lg rail pane and the <lg
 * slide-over drawer), so the two presentations can never drift. Decomposes WHY the niche got
 * its ring: one block per VerdictCheck from radarVerdictTrace (the SAME evaluation that
 * placed the dot — see lib/radarVerdict.ts), each with the niche's own numbers, the bar it
 * was judged against, pass/fail in neutral steel, and a one-clause reading. decides:false
 * rows (the entrant-economics falsification tell, the solo lens) are labeled "· context":
 * they can talk you out of a niche, they never move its ring.
 *
 * THE DEEP DIVE IS THE DOSSIER'S PRIMARY ACTION (2026-09-10: "Button to go deeper into the
 * niche is super small and almost not visible"). It was a 13px text link tucked under the
 * raw-context line; it is now a filled, full-width brand button in the page's primary-action
 * language, and it sits ABOVE that line — the dossier explains, and this is the way out of
 * the explanation into the full workup. Route and analytics are byte-identical to before.
 *
 * Accepts any RailBlip: a niche selected through search that isn't plotted (beyond the Top-N
 * of its class) gets the same full dossier — same trace, same bars — plus an honest header
 * note that it has no dot on the board at this cap.
 */
function DossierBody({ blip, plotCap }: { blip: RailBlip; plotCap: number }) {
  const v = blip.verdict;
  const context = [
    blip.reviews24m != null ? `reviews 24m ${fmtInt(blip.reviews24m)}` : null,
    blip.reviewsPrev24m != null ? `prior 24m ${fmtInt(blip.reviewsPrev24m)}` : null,
    `P90 rev ${fmtUsd(blip.p90_rev)}`,
    `${fmtInt(blip.n_games)} games`,
    blip.opportunity_v2 != null ? `opp v2 ${blip.opportunity_v2.toFixed(1)}` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <>
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span
          className="inline-block h-2 w-2 shrink-0 self-center"
          style={{ backgroundColor: RING_FILL[v.ring] }}
          aria-hidden
        />
        <span className="kicker text-[11px] tracking-[.08em] text-ink-primary">
          {blip.n != null ? `${blip.n}. ${blip.key}` : blip.key}
        </span>
        <span className="text-[11px] text-ink-muted">{SECTOR_LABEL[blip.sector]}</span>
      </div>
      {/* The honest not-plotted note (search reaches past the plot cap): the niche is real,
          the verdict is computed the same way — it just has no dot at this Top-N. */}
      {blip.n == null && (
        <p className="pt-1 text-[11px] text-ink-muted">
          Beyond the Top {plotCap} of {SECTOR_LABEL[blip.sector]} — no dot in that sector at this cap; the verdict below
          is judged by the same checks.
        </p>
      )}
      <p className="border-b border-chartborder pb-2 pt-1 text-[12px] text-ink-secondary">
        <span className="font-semibold text-ink-primary">{RING_LABEL[v.ring]}</span>
        {v.caution ? " · caution" : ""} — {v.reason}
      </p>

      {blip.trace.map((c) => (
        <div key={c.id} className="border-b border-chartborder py-2">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <CheckGlyph pass={c.pass} />
            <span className="sr-only">{c.pass === null ? "unknown" : c.pass ? "passes" : "fails"}</span>
            <span className="kicker text-[10px] tracking-[.08em] text-ink-muted">
              {c.decides ? c.label : `${c.label} · context`}
            </span>
          </div>
          {/* Value and the bar it was judged against share one line in the widened rail
              (flex-wrap, no truncation: at narrow widths the bar clause drops to its own
              line rather than eating the value). */}
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 pt-1">
            <span className="tabular text-[12px] text-ink-primary">{c.value}</span>
            <span className="tabular ml-auto text-right text-[10px] text-ink-muted">bar {c.threshold}</span>
          </div>
          <div className="pt-0.5 text-[11px] leading-snug text-ink-secondary">{c.note}</div>
        </div>
      ))}

      <div className="flex flex-col gap-2 pb-1 pt-3">
        <Link
          to={nicheDetailPath(blip.dimension, blip.key)}
          onClick={() => trackEvent("niche_open")}
          data-testid="radar-deep-dive"
          className="flex w-full items-center justify-center gap-2 bg-brand px-4 py-2.5 text-[13px] font-semibold text-brand-fg transition-colors hover:bg-brand-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
        >
          Open deep dive
          <span aria-hidden>→</span>
        </Link>
        <span className="tabular text-[11px] text-ink-muted">{context}</span>
      </div>
    </>
  );
}

/** The ≥lg presentation: the dossier as the rail's selection mode, scrolling inside the
 * instrument like the verdict list does. */
function VerdictDossier({
  blip,
  plotCap,
  total,
  onBack,
}: {
  blip: RailBlip;
  plotCap: number;
  total: number;
  onBack: () => void;
}) {
  return (
    <section
      aria-label={`Verdict dossier: ${blip.key}`}
      data-testid="verdict-dossier"
      className="flex min-w-0 flex-col lg:min-h-0 lg:flex-1"
    >
      <button
        type="button"
        onClick={onBack}
        aria-label="Back to all verdicts"
        className="flex w-full items-center gap-2 border-b border-ink-primary/25 pb-2 text-left text-ink-primary transition-colors hover:text-brand"
      >
        <span aria-hidden className="text-[12px] leading-none">←</span>
        <span className="kicker text-[11px] tracking-[.08em]">All verdicts</span>
        <span className="tabular text-[11px] text-ink-muted">{total}</span>
      </button>

      <div className="lg:relative lg:min-h-0 lg:flex-1">
        <div className="flex flex-col pt-2.5 lg:absolute lg:inset-0 lg:overflow-y-auto lg:pr-1">
          <DossierBody blip={blip} plotCap={plotCap} />
        </div>
      </div>
    </section>
  );
}

/**
 * The <lg presentation: an Industry-styled slide-over drawer from the right edge — the
 * stacked layout puts the rail BELOW the board, so an inline dossier would open out of view
 * and force a scroll (the exact complaint this fixes). Radius 0, hairline border, mono-steel
 * on the page plane, dimmed backdrop; closes on ✕, the back affordance, the backdrop, and
 * Escape; focus is trapped inside while open and restored on close; the page behind cannot
 * scroll. Only ever MOUNTED below lg (RadarBoard renders it from the same isDesktop switch
 * that picks the rail pane), so the two presentations are mutually exclusive by construction.
 */
function DossierDrawer({
  blip,
  plotCap,
  total,
  onClose,
}: {
  blip: RailBlip;
  plotCap: number;
  total: number;
  onClose: () => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const prevFocus = document.activeElement as HTMLElement | null;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden"; // the page behind must not scroll
    panelRef.current?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== "Tab" || !panelRef.current) return;
      // Minimal focus trap: cycle Tab/Shift-Tab within the drawer's focusables.
      const nodes = Array.from(
        panelRef.current.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      );
      if (nodes.length === 0) return;
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && (active === first || active === panelRef.current)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
      prevFocus?.focus?.();
    };
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-40 lg:hidden">
      {/* Backdrop — click closes; decorative for AT (the dialog handles semantics). */}
      <div
        aria-hidden
        data-testid="drawer-backdrop"
        onClick={onClose}
        className="absolute inset-0"
        style={{ background: "color-mix(in srgb, var(--text-primary) 25%, transparent)" }}
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={`Verdict dossier: ${blip.key}`}
        data-testid="verdict-dossier"
        tabIndex={-1}
        className="absolute inset-y-0 right-0 flex w-[min(360px,92vw)] flex-col overflow-y-auto border-l border-ink-primary/35 px-4 py-3 outline-none"
        style={{ backgroundColor: "var(--page-plane)" }}
      >
        <div className="flex items-center gap-2 border-b border-ink-primary/25 pb-2">
          <button
            type="button"
            onClick={onClose}
            aria-label="Back to all verdicts"
            className="flex min-w-0 items-center gap-2 text-left text-ink-primary transition-colors hover:text-brand"
          >
            <span aria-hidden className="text-[12px] leading-none">←</span>
            <span className="kicker text-[11px] tracking-[.08em]">All verdicts</span>
            <span className="tabular text-[11px] text-ink-muted">{total}</span>
          </button>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close dossier"
            className="ml-auto border border-ink-primary/35 px-1.5 py-0.5 text-[10px] leading-none text-ink-primary transition-colors hover:bg-ink-primary/[0.08]"
          >
            ✕
          </button>
        </div>
        <div className="flex flex-col pt-2.5">
          <DossierBody blip={blip} plotCap={plotCap} />
        </div>
      </div>
    </div>
  );
}

// The side-by-side threshold. lg (1024px) since the dossier-viewport fix: at any width where
// board and rail sit side-by-side the dossier opens beside the dial (in view); below it the
// drawer takes over — so a selection can never strand the dossier below the fold. MUST match
// the lg: utilities on the board/rail markup.
const DESKTOP_QUERY = "(min-width: 1024px)";

function subscribeDesktop(cb: () => void): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => {};
  const mql = window.matchMedia(DESKTOP_QUERY);
  mql.addEventListener("change", cb);
  return () => mql.removeEventListener("change", cb);
}

function isDesktopNow(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return true;
  return window.matchMedia(DESKTOP_QUERY).matches;
}

/** Reactive "board and rail are side-by-side" flag — drives the rail-pane vs drawer choice
 * for the dossier. Defaults to desktop when matchMedia is unavailable. */
function useIsDesktop(): boolean {
  return useSyncExternalStore(subscribeDesktop, isDesktopNow, () => true);
}

/** SVG text with a page-ground halo so labels stay legible over gridlines and dots. */
function HaloText({
  x,
  y,
  anchor,
  size = 9,
  halo = 3.5,
  fill = "var(--text-muted)",
  transform,
  opacity,
  testId,
  children,
}: {
  x: number;
  y: number;
  anchor: "start" | "middle" | "end";
  size?: number;
  /** Knockout stroke width. Scales with the type on the big band captions — a 3.5px halo
   * under 26px glyphs is a rim, not a knockout. */
  halo?: number;
  fill?: string;
  transform?: string;
  opacity?: number;
  testId?: string;
  children: React.ReactNode;
}) {
  return (
    <text
      x={x}
      y={y}
      data-testid={testId}
      textAnchor={anchor}
      className="kicker"
      transform={transform}
      opacity={opacity}
      style={{
        fontSize: size,
        letterSpacing: "0.1em",
        fill,
        stroke: "var(--page-plane)",
        strokeWidth: halo,
        paintOrder: "stroke",
      }}
    >
      {children}
    </text>
  );
}

export function RadarBoard({
  blips,
  pool,
  plotCap,
  soloOnly,
  emphasis,
  selectedId,
  onSelect,
  zoom,
  onZoom,
}: {
  /** What the dial plots: the top N/3 of EVERY class by opportunity (the page slices per
   * class — see pages/Radar.tsx), so all three wedges are filled from their own ranking. */
  blips: RadarBoardBlip[];
  /** The FULL population at this cut + solo setting, ALL classes merged, opportunity order —
   * the rail search's scope. A superset of `blips`: search must reach every niche of the
   * cut, never just the plotted class or its Top-N. */
  pool: RadarBoardBlip[];
  /** The PER-CLASS plot cap — names the honest "beyond the Top N of its class" dossier note
   * for a search selection that has no dot. */
  plotCap: number;
  soloOnly: boolean;
  /** THE CLASS CONTROL, as EMPHASIS. All three wedges always draw; this one is the wedge the
   * reader asked for, so the other two recede (dimmed dots, muted rail rows) instead of
   * disappearing. null emphasises nothing — every wedge at full strength. */
  emphasis: RadarSector | null;
  /** Controlled selection — "dimension:key" of ANY pool niche, or null. Owned by the page
   * (which also switches the class picker when a search hit is cross-class). */
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  /** Controlled click-to-zoom — the RING BAND the dial is zoomed to and whose members the
   * rail is filtered to, or null for the full board. Owned by the page so it can ride the
   * URL (?zoom=), like the class picker / solo lens / Top-N / selection. */
  zoom: RadarRegion | null;
  onZoom: (region: RadarRegion | null) => void;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [hoverId, setHoverId] = useState<string | null>(null);
  // The hovered BAND — set/cleared ONLY by the five annulus hit areas' enter/leave, so a
  // mousemove inside a band costs nothing. Hover-only, never sticky.
  const [hoverRegion, setHoverRegion] = useState<RadarRegion | null>(null);
  // Entered by clicking a band's empty area; exited by Esc, the rail chip's ✕, or a
  // background click. All three go through onZoom(null), so the URL always agrees.
  const setZoom = onZoom;
  // TOOLTIP POSITION LIVES IN A REF, NOT IN STATE (2026-08-28 perf fix). Every dot has an
  // onMouseMove, and setState-per-pointer-pixel re-rendered this whole board on every mouse
  // move across a dot. Only tooltip VISIBILITY is state now — it flips at most twice per dot
  // (enter/leave); the x/y ride a ref and are written straight onto the tooltip element's
  // style, so pointer movement costs one style write instead of a full React render.
  const tipRef = useRef<HTMLDivElement | null>(null);
  const tipPos = useRef<{ x: number; y: number } | null>(null);
  const [tipShown, setTipShown] = useState(false);
  // The rail's niche search. Local state deliberately: the query is a reading aid for the
  // list (like hover), not page state a card elsewhere needs to drive.
  const [query, setQuery] = useState("");
  // Keyboard cursor over the filtered rows (↑/↓ + Enter); reset whenever the query text
  // changes so the cursor can never point past a shrunken result set.
  const [activeIdx, setActiveIdx] = useState(0);
  // Side-by-side (≥lg): dossier in the rail pane. Stacked (<lg): dossier as the drawer.
  const isDesktop = useIsDesktop();

  // The plate's MEASURED width — the viewBox is rebuilt from it (1 unit = 1 CSS px, see
  // ringGeom). jsdom measures 0, so the DEFAULT_PLATE_W fallback is the test geometry.
  const [plateW, setPlateW] = useState<number | null>(null);
  const hasBlips = blips.length > 0;
  useEffect(() => {
    if (!hasBlips) return; // the empty state renders no dial to measure
    const el = wrapRef.current;
    if (!el) return;
    const measure = () => {
      const w = Math.round(el.clientWidth);
      if (w > 0) setPlateW(w);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [hasBlips]);

  const layout = useMemo(
    () => layoutBoard(blips, { plateW: plateW ?? DEFAULT_PLATE_W, zoom }),
    [blips, plateW, zoom],
  );
  const placed = layout.dots;
  const q = query.trim().toLowerCase();

  /** The rail's base rows under the zoom filter: the zoomed band's members (board rank
   * preserved — a gap in the numbers is honest, the rank IS the board's), or every plotted
   * dot in the full view. Chip count, header count and the zoomed search scope all read from
   * this one list. */
  const zoomMembers = useMemo<PlacedBlip[]>(
    () => (zoom === null ? placed : placed.filter((d) => d.region === zoom)),
    [zoom, placed],
  );

  /** The rail's row source. No query: the (possibly zoom-filtered) plotted list, rank order.
   * With a query: a live case-insensitive substring filter — over the FULL pool in the full
   * view (plotted rows keep their rank, beyond-board rows carry n: null), or WITHIN the
   * zoomed band's members while zoomed (search composes with the zoom filter — it must never
   * smuggle an outside niche into a filtered rail). */
  const railEntries = useMemo<RailBlip[]>(() => {
    if (!q) return zoomMembers;
    if (zoom !== null) return zoomMembers.filter((b) => b.key.toLowerCase().includes(q));
    const plottedById = new Map<string, PlacedBlip>(placed.map((p) => [p.id, p]));
    const rows: RailBlip[] = [];
    for (const b of pool) {
      if (!b.key.toLowerCase().includes(q)) continue;
      const id = `${b.dimension}:${b.key}`;
      rows.push(plottedById.get(id) ?? { ...b, id, n: null });
    }
    return rows;
  }, [q, zoom, zoomMembers, placed, pool]);

  // Esc exits the zoom — AFTER the more local Esc consumers: the search input clears its
  // text first (its handler stops propagation when it does), and the <lg dossier drawer owns
  // Esc outright while open (skip — closing it must not also unzoom).
  useEffect(() => {
    if (zoom === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (selectedId !== null && !isDesktop) return; // the drawer's Esc
      setZoom(null);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [zoom, selectedId, isDesktop, setZoom]);

  const byRing = useMemo(() => {
    const m = new Map<RadarRing, RailBlip[]>(RING_ORDER.map((r) => [r, []]));
    for (const b of railEntries) m.get(b.verdict.ring)!.push(b);
    // Within a ring group: plotted rows first in rank order, then beyond-board search hits in
    // pool (opportunity) order — sort is stable, so ties keep source order.
    for (const group of m.values()) group.sort((a, b) => (a.n ?? Infinity) - (b.n ?? Infinity));
    return m;
  }, [railEntries]);
  /** The visible rows flattened in render order — the ↑/↓/Enter walk order. */
  const flatRows = useMemo(() => RING_ORDER.flatMap((r) => byRing.get(r)!), [byRing]);

  const hovered = hoverId === null ? null : (placed.find((b) => b.id === hoverId) ?? null);
  /** The band the WASH / caption / rail ticks light for. A hovered dot wins with its own
   * band — the pointer is physically inside it, and entering the dot fires the hit area's
   * mouseleave, so without this the wash would flicker off while brushing across dots.
   * Dot-level DIMMING still follows hoverId alone (dot hover precedence). */
  const effectiveRegion: RadarRegion | null = hovered ? hovered.region : hoverRegion;
  /** Band membership by id for the rail's left-edge ticks (plotted rows only — a beyond-board
   * search hit has no dot, so no band and never a tick). */
  const regionById = useMemo(() => new Map<string, RadarRegion>(placed.map((d) => [d.id, d.region])), [placed]);
  /** The CLASS EMPHASIS channel: a wedge the reader did not ask for recedes, it never
   * leaves. Deliberately a MILD dim rather than a near-erasure — the whole reason all three
   * wedges draw is that the comparison between them is the reading, and a dot whose rail
   * number you can no longer read has lost the thing that keys it to the list. Measured on
   * the live board at 1440x900: at 0.5 the emphasised wedge still pops unmistakably and the
   * other two stay countable. */
  const OFF_CLASS = 0.5;
  const emphasised = (b: PlacedBlip): boolean => emphasis === null || b.sector === emphasis;
  /** Dot opacity under the hover channels, multiplied by the emphasis channel. DOT hover
   * takes precedence (existing tooltip behavior: only the hovered dot stays full); otherwise
   * a hovered band lifts its members and mutes everything outside; no hover leaves everyone
   * at their class's own strength. */
  const dotOpacity = (b: PlacedBlip): number => {
    const cls = emphasised(b) ? 1 : OFF_CLASS;
    if (hoverId !== null) return hoverId === b.id ? 1 : 0.35 * cls;
    if (hoverRegion !== null) return (b.region === hoverRegion ? 1 : 0.35) * cls;
    return cls;
  };
  // Selection resolves against the PLOTTED board first (dot highlight comes free), then the
  // full pool — a search hit beyond the board still opens its dossier. It survives population
  // toggles only while the niche is still in the pool.
  const selected = useMemo<RailBlip | null>(() => {
    if (selectedId === null) return null;
    const onBoard = placed.find((b) => b.id === selectedId);
    if (onBoard) return onBoard;
    const inPool = pool.find((b) => `${b.dimension}:${b.key}` === selectedId);
    return inPool ? { ...inPool, id: selectedId, n: null } : null;
  }, [selectedId, placed, pool]);

  const onSearchKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      // Esc clears the query (and only that — a second Esc has nothing left to clear).
      if (query !== "") {
        e.stopPropagation();
        setQuery("");
        setActiveIdx(0);
      }
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (flatRows.length === 0) return;
      const step = e.key === "ArrowDown" ? 1 : -1;
      setActiveIdx((i) => Math.min(Math.max(i + step, 0), flatRows.length - 1));
      return;
    }
    if (e.key === "Enter") {
      const hit = flatRows[Math.min(activeIdx, flatRows.length - 1)];
      if (hit) onSelect(hit.id);
    }
  };

  /** Write the recorded pointer position straight onto the tooltip element. Same clamping
   * rule as before: flip LEFT of the cursor past the horizontal midline (keeps the right edge
   * on the plate) and ABOVE it in the bottom band. No-ops when the tooltip isn't mounted yet
   * — the callback ref below re-applies as soon as it is. */
  const positionTip = () => {
    const el = tipRef.current;
    const p = tipPos.current;
    if (!el || !p) return;
    el.style.left = `${p.x}px`;
    el.style.top = `${p.y}px`;
    el.style.transform = `translate(${p.x > layout.geom.plateW / 2 ? "calc(-100% - 12px)" : "12px"}, ${
      p.y > layout.vbH - 180 ? "calc(-100% - 12px)" : "12px"
    })`;
  };
  const moveTip = (e: React.MouseEvent) => {
    const rect = wrapRef.current?.getBoundingClientRect();
    if (!rect) return;
    tipPos.current = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    positionTip();
  };
  const clearHover = () => {
    setHoverId(null);
    setTipShown(false);
    tipPos.current = null;
  };

  if (blips.length === 0) {
    return (
      <div className="py-10 text-center text-sm text-ink-muted">
        {soloOnly ? "No solo-friendly niches match this cut." : "No niches match this cut."}
      </div>
    );
  }

  // Everything below draws in the layout's OWN geometry (zoom-aware bands included) — never
  // a re-derived one.
  const geom = layout.geom;
  const { cx, cy, R, r0 } = geom;
  /** What actually renders: a zoom hides every non-member. */
  const visible = placed.filter((d) => !d.hidden);
  /** COMPACT decor for narrow dials (phones): labels keep their TRUE point size (1 viewBox
   * unit = 1 px), so a 300px dial can't fit desktop decor type — this steps it down a notch
   * (the band captions size themselves off the band; see radarRings.ts). */
  const compact = geom.compact;

  return (
    <div className="flex flex-col gap-5 lg:flex-row lg:items-stretch">
      {/* The dial — it takes every horizontal pixel the shared page container leaves beside
          the rail, and the viewBox is rebuilt from this wrapper's measured width (1 unit =
          1 CSS px — labels and dots never scale with the box). The rail keeps its fixed
          360/460px, so the dial alone absorbs the container's growth. */}
      {/* Below lg the dial claws back the section's own -mx-6 of horizontal padding: it is
          the hero of a stacked layout and the padding was costing it ~15% of its radius,
          which on a phone is the difference between five separable bands and four. From lg
          up it sits back inside the padding, beside the rail. */}
      <div ref={wrapRef} className="relative -mx-6 w-auto lg:mx-0 lg:w-full lg:min-w-0 lg:flex-1">
        <svg
          viewBox={`0 0 ${geom.plateW} ${layout.vbH}`}
          className="block h-auto w-full"
          role="img"
          aria-label={
            `Radar dial: ${visible.length} niches on concentric verdict rings, best in the middle — ` +
            `${RING_ORDER.map((r) => RING_LABEL[r]).join(" then ")} outward; the three sectors are the ` +
            `niche classes (${CLASS_ORDER.map((c) => `${CLASS_LABEL[c]} ${layout.sectorCount.get(c) ?? 0}`).join(", ")}), ` +
            `distance inside a band is the opportunity rank, dot area is P90 revenue and each dot carries ` +
            `its rail number` +
            (emphasis !== null ? `; ${CLASS_LABEL[emphasis]} emphasised` : "") +
            (zoom !== null ? `; zoomed to the ${REGION_NAME[zoom]} ring` : "")
          }
        >
          {/* DECOR — band washes, band circles, sector spokes, the centre mark and the band
              CAPTIONS. pointer-events none as a GROUP: only the dots and the band hit areas
              may ever be interactive, so a click landing on a caption reads as the band under
              it, never as a dead dot.

              THE BAND CAPTIONS DELIBERATELY PAINT *UNDER* THE DOTS — the reference's own
              order (its ring labels sit in the grid group, below the blips) and the opposite
              of the 2026-09-01 rule that moved the XY plate's bar labels above them. That
              rule existed because the flood-bar label was a 9px string being erased by the
              dense cluster sitting on the very line it named. These are one word per band,
              in the band's own hue, on a divider axis the placement keeps clear (see the
              caption gutter in radarRings.ts) — so they rarely meet a dot at all, and when
              they do the DATA must win. The RIM LABELS and the ZOOM TITLE — small,
              load-bearing, unique — still paint last, in ring-annotations. */}
          <g pointerEvents="none" data-testid="ring-decor">
            {geom.bands.map((b) => (
              <path
                key={`wash-${b.ring}`}
                data-testid={`ring-band-${b.ring}`}
                d={annulusPath(cx, cy, b.r0, b.r1)}
                fillRule="evenodd"
                fill={RING_WASH[b.ring]}
              />
            ))}
            {/* Band edges. The outermost circle is the dial's frame; the inner edges read as
                gridlines. */}
            {geom.bands.map((b) => (
              <circle
                key={`edge-${b.ring}`}
                cx={cx}
                cy={cy}
                r={b.r1}
                fill="none"
                stroke={b.r1 === R ? "var(--baseline)" : "var(--gridline)"}
                strokeWidth={1}
              />
            ))}
            <circle cx={cx} cy={cy} r={r0} fill="none" stroke="var(--gridline)" strokeWidth={1} />

            {/* SECTOR SPOKES — the three class dividers, drawn from the centre hole to the
                rim exactly like the reference's quadrant axes. Always three: the wedges are
                fixed, so a class that happens to be empty at this cut still owns its arc. */}
            {layout.sectors.map((s) => {
              const a = polar(cx, cy, s.a0, r0);
              const b = polar(cx, cy, s.a0, R);
              return (
                <line
                  key={`spoke-${s.sector}`}
                  data-testid={`radar-spoke-${s.sector}`}
                  x1={a.x}
                  y1={a.y}
                  x2={b.x}
                  y2={b.y}
                  // --baseline, not --gridline: the spokes now carry the board's primary
                  // grouping (which class a niche is in), so they must out-read the band
                  // circles rather than tie with them. At gridline weight they vanished on
                  // the first render of this layout — the sectors were there and invisible,
                  // which is worse than not having them.
                  stroke="var(--baseline)"
                  strokeWidth={1.5}
                />
              );
            })}

            {/* THE CENTRE MARK — "best in the middle", said once, in the one place the form
                puts it. */}
            <HaloText x={cx} y={cy + 3} anchor="middle" size={compact ? 8 : 9} fill="var(--text-muted)">
              BEST
            </HaloText>

            {/* BAND CAPTIONS — ONE WORD in the band's OWN HUE, stacked up the vertical axis
                in the TOP half, each just inside its band's outer edge. That is the
                reference's ADOPT / TRIAL / ASSESS / HOLD, measured off it: 42px at
                `-ringRadius + 62` on a 400px radius, coloured to the ring (ADOPT is the same
                green as the adopt blips). The vertical axis is a SECTOR DIVIDER here, as it
                is there, so the captions sit on a boundary rather than in a crowd. A hovered
                or zoomed band's caption steps up to nearly full strength. */}
            {geom.bands.map((b) => {
              const lit = effectiveRegion === b.ring || zoom === b.ring;
              return (
                <HaloText
                  key={`cap-${b.ring}`}
                  testId={`ring-caption-${b.ring}`}
                  x={cx}
                  y={cy - b.captionR + b.captionSize * 0.36}
                  anchor="middle"
                  size={b.captionSize}
                  halo={b.captionSize * 0.2}
                  fill={RING_CAPTION_FILL[b.ring]}
                  opacity={lit ? CAPTION_ALPHA_LIT : CAPTION_ALPHA}
                >
                  {b.caption}
                </HaloText>
              );
            })}
          </g>

          {/* BAND HIT AREAS — the hover/zoom hit-testing. Transparent fills (not "none":
              transparent still hit-tests) that take the band's hover wash while it is lit;
              drawn OVER the decor so the wash covers the whole band, UNDER the dots so every
              dot keeps its own hover and click (dot-click precedence: a dot click opens its
              dossier, never zooms). A click on a band's EMPTY area ZOOMS into it. While
              zoomed the five give way to ONE full-viewBox background rect whose click exits
              the zoom (band hover is moot in a single-band view). */}
          {zoom === null ? (
            <g data-testid="radar-regions">
              {geom.bands.map((b) => (
                <path
                  key={`hit-${b.ring}`}
                  data-testid={`radar-region-${b.ring}`}
                  d={annulusPath(cx, cy, b.r0, b.r1)}
                  fillRule="evenodd"
                  fill={effectiveRegion === b.ring ? RING_HOVER_WASH[b.ring] : "transparent"}
                  style={{ transition: "fill 120ms", cursor: "zoom-in" }}
                  onMouseEnter={() => setHoverRegion(b.ring)}
                  onMouseLeave={() => setHoverRegion(null)}
                  onClick={() => {
                    setHoverRegion(null);
                    setZoom(b.ring);
                  }}
                />
              ))}
            </g>
          ) : (
            <rect
              data-testid="radar-zoom-exit"
              x={0}
              y={0}
              width={geom.plateW}
              height={layout.vbH}
              fill="transparent"
              style={{ cursor: "zoom-out" }}
              onClick={() => setZoom(null)}
            />
          )}

          {/* DOTS — the rail carries the accessible buttons, these are mouse conveniences.
              Solo lens as dot STYLE: team-scale (singleplayer share < SOLO_FRIENDLY_MIN)
              draws hollow — ring-coloured stroke over a `transparent` fill (transparent, not
              "none", so the interior still hit-tests); solo-friendly and unknown draw filled.
              The VERDICT is the fill vocabulary (redundant with the band, kept as the
              grayscale-proof reinforcement it always was); a CAUTION verdict adds a dotted
              ring, because caution is orthogonal to the ring and has no other channel.
              Each dot carries its RAIL NUMBER — knocked out of a filled dot in the page
              plane, drawn in the ring hue on a hollow one. */}
          <g aria-hidden>
            {visible.map((b) => {
              const team = soloBucket(b.solo_viability) === "team";
              const label = String(b.n);
              // THE NUMBER HAS TO BE READABLE (the fourth complaint of the second pass). The
              // reference runs a 9px number inside an r=9 blip; ours goes up to 11px inside
              // an r≈9–11.5 blip, stepping down only for a three-digit rank.
              const numSize = Math.min(b.r * 1.3, 11) * (label.length >= 3 ? 0.76 : 1);
              return (
                <g key={b.id}>
                  {b.verdict.caution && (
                    <circle
                      cx={b.x}
                      cy={b.y}
                      r={b.r + 2.5}
                      fill="none"
                      stroke="var(--text-muted)"
                      strokeWidth={1}
                      strokeDasharray="1.5 2.5"
                      opacity={dotOpacity(b)}
                      pointerEvents="none"
                    />
                  )}
                  <circle
                    data-testid={`radar-blip-${b.id}`}
                    cx={b.x}
                    cy={b.y}
                    r={b.r}
                    fill={team ? "transparent" : RING_FILL[b.verdict.ring]}
                    stroke={team ? RING_FILL[b.verdict.ring] : "var(--page-plane)"}
                    strokeWidth={team ? 1.5 : 1}
                    opacity={dotOpacity(b)}
                    // cx/cy/r ride a short CSS transition so entering/leaving a zoom glides
                    // instead of snapping (SVG geometry properties are CSS-transitionable in
                    // every current engine; where not, it just snaps — correctness never
                    // depends on it).
                    style={{ cursor: "pointer", transition: "opacity 120ms, cx 240ms, cy 240ms, r 240ms" }}
                    onMouseEnter={(e) => {
                      setHoverId(b.id);
                      setTipShown(true);
                      moveTip(e);
                    }}
                    // Records into a ref + mutates the tooltip's style directly — this fires
                    // per pointer pixel and must never re-render the board (see tipPos).
                    onMouseMove={moveTip}
                    onMouseLeave={clearHover}
                    // A dot click opens the VERDICT DOSSIER in the rail (the analysis is the
                    // board's first answer); navigation to the detail page lives on the
                    // dossier's own deep-dive button.
                    onClick={() => onSelect(b.id)}
                  />
                  <text
                    data-testid={`radar-blip-num-${b.id}`}
                    x={b.x}
                    y={b.y + numSize * 0.35}
                    textAnchor="middle"
                    className="tabular"
                    pointerEvents="none"
                    opacity={dotOpacity(b)}
                    style={{
                      fontSize: numSize,
                      fontWeight: 700,
                      letterSpacing: "-0.02em",
                      fill: team ? RING_FILL[b.verdict.ring] : "var(--page-plane)",
                      transition: "opacity 120ms, x 240ms, y 240ms",
                    }}
                  >
                    {label}
                  </text>
                  {/* Band-member emphasis: while a band is hovered (and no dot is — dot hover
                      keeps its stronger single-dot ring below), every member dot takes a
                      slight ring on top of its full opacity. Deliberately fainter than the
                      hover/selection ring (thinner, secondary ink). */}
                  {hoverId === null && hoverRegion !== null && b.region === hoverRegion && (
                    <circle
                      data-testid={`radar-region-ring-${b.id}`}
                      cx={b.x}
                      cy={b.y}
                      r={b.r + 2}
                      fill="none"
                      stroke="var(--text-secondary)"
                      strokeWidth={0.75}
                      pointerEvents="none"
                    />
                  )}
                  {(hoverId === b.id || selectedId === b.id) && (
                    <circle
                      cx={b.x}
                      cy={b.y}
                      r={b.r + 3}
                      fill="none"
                      stroke="var(--text-primary)"
                      strokeWidth={1.5}
                      pointerEvents="none"
                    />
                  )}
                </g>
              );
            })}
          </g>

          {/* RIM + ZOOM ANNOTATIONS — LAST, so they paint OVER the dots. Small, unique and
              load-bearing (which band am I in? which tier is this sector?), so unlike the
              band captions they must never be lost under the data — the 2026-09-01
              annotation rule, applied to the labels it was written for. pointerEvents none:
              every dot keeps its own hover and click. */}
          <g pointerEvents="none" data-testid="ring-annotations">
            {zoom !== null ? (
              <>
                {/* Both lines live in the top rim pad, clear of the dial's own frame (the
                    zoomed view draws no rim sector label there, so the pad is free). */}
                <HaloText x={cx} y={10} anchor="middle" size={11.5} fill={REGION_TONE[zoom]}>
                  {REGION_NAME[zoom]} — ZOOMED
                </HaloText>
                <HaloText x={cx} y={21} anchor="middle" size={8.5} halo={4}>
                  ESC · BACKGROUND CLICK · OR THE RAIL CHIP ✕ EXITS
                </HaloText>
              </>
            ) : compact ? (
              /* A phone spends its side margins on RADIUS, not on rim labels (see
                 radarRings.ts's RIM_PAD_SIDE_COMPACT) — reserving room for "MICRO-GENRES ·
                 27" out at the wedge's mid angle would halve the dial. So the sector order
                 becomes one honest caption line under the dial, reading clockwise from 12,
                 with the emphasised class marked. */
              <HaloText testId="radar-sector-legend" x={cx} y={geom.vbH - 6} anchor="middle" size={8}>
                {`↻ FROM 12 · ${layout.sectors
                  .map(
                    (s) =>
                      `${emphasis === s.sector ? "▸" : ""}${SECTOR_SHORT[s.sector]} ${
                        layout.sectorCount.get(s.sector) ?? 0
                      }`,
                  )
                  .join(" · ")} · G=GENRES M=MICRO T=THEMES`}
              </HaloText>
            ) : (
              /* SECTOR RIM LABELS — the class each wedge holds and its honest count, at the
                 wedge's mid angle, the way the reference names its four quadrants around the
                 dial. The EMPHASISED class is drawn in primary ink; the other two recede to
                 muted, so the label layer says the same thing the dots do. */
              layout.sectors.map((s) => {
                const p = polar(cx, cy, s.mid, R + 13);
                const c = Math.cos(s.mid);
                const anchor = c > 0.3 ? "start" : c < -0.3 ? "end" : "middle";
                const on = emphasis === null || emphasis === s.sector;
                return (
                  <HaloText
                    key={`rim-${s.sector}`}
                    testId={`radar-sector-label-${s.sector}`}
                    x={p.x}
                    y={p.y + (Math.sin(s.mid) > 0.3 ? 7 : Math.sin(s.mid) < -0.3 ? -1 : 3)}
                    anchor={anchor}
                    size={compact ? 8.5 : 10.5}
                    fill={on ? "var(--text-primary)" : "var(--text-muted)"}
                    opacity={on ? 1 : 0.75}
                  >
                    {`${CLASS_LABEL[s.sector].toUpperCase()} · ${layout.sectorCount.get(s.sector) ?? 0}`}
                  </HaloText>
                );
              })
            )}
          </g>
        </svg>

        {/* Legend. Under the default solo-only population the hollow/filled lens encoding is
            redundant (every dot is solo-friendly by construction), so the legend states the
            POPULATION RULE instead of drawing lens samples — the UI must never imply
            team-scale niches might be hiding on the board. The metric is named honestly:
            solo_viability IS the niche's singleplayer share (a no-netcode proxy, not a
            production-scope measure — the dossier's solo row carries the member evidence).
            The sample circles are plain aria-hidden glyphs, never click targets. */}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 pt-2 text-[11px] text-ink-muted">
          {soloOnly ? (
            <span className="inline-flex items-center gap-1.5">
              <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden className="pointer-events-none shrink-0">
                <circle cx="5" cy="5" r="4" fill="currentColor" />
              </svg>
              <span>
                population: solo-friendly only · singleplayer share ≥ {SOLO_FRIENDLY_MIN} (server-filtered; unknown
                excluded)
              </span>
            </span>
          ) : (
            <>
              <span className="inline-flex items-center gap-1.5">
                <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden className="pointer-events-none shrink-0">
                  <circle cx="5" cy="5" r="4" fill="currentColor" />
                </svg>
                solo-friendly (singleplayer share ≥ {SOLO_FRIENDLY_MIN}) or unknown
              </span>
              <span className="inline-flex items-center gap-1.5">
                <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden className="pointer-events-none shrink-0">
                  <circle cx="5" cy="5" r="3.5" fill="none" stroke="currentColor" strokeWidth="1.3" />
                </svg>
                team-scale (&lt; {SOLO_FRIENDLY_MIN})
              </span>
            </>
          )}
          {/* The verdict hue key (2026-08-27 color amendment) — every hue is doubled by a word
              right here AND by the band caption it sits in, so the mapping survives grayscale
              and any CVD. Listed inner ring first, which is also the order of the dial. */}
          <span data-testid="verdict-color-key" className="inline-flex flex-wrap items-center gap-x-3 gap-y-1">
            {RING_ORDER.map((ring, i) => (
              <span key={ring} className="inline-flex items-center gap-1.5">
                <span className="inline-block h-2 w-2 shrink-0" style={{ backgroundColor: RING_FILL[ring] }} aria-hidden />
                {i === 0 ? `${RING_LABEL[ring]} (inner ring)` : i === RING_ORDER.length - 1 ? `${RING_LABEL[ring]} (outer)` : RING_LABEL[ring]}
              </span>
            ))}
          </span>
          <span>
            ring = the verdict, best in the middle · the number in a dot is its rail rank · inside a band, nearer the
            centre = higher opportunity v2 (the rank, not the score — the score is in the tooltip and the dossier) ·
            the three sectors are the niche classes, each showing its OWN top {plotCap} by opportunity · the Class
            control emphasises a sector, it never empties the board · dot area = P90 revenue · colour repeats the
            verdict the band already names (reinforcement, never the only channel) · nothing clamps here: a ring board
            has no axis to fall off · click a ring&rsquo;s empty space to zoom into it and filter the rail (Esc, the
            rail chip&rsquo;s ✕, or a background click exits)
          </span>
        </div>

        {/* Hover tooltip — HTML over the SVG, same TooltipPanel language as every chart.
            Clamped to the plate: it flips to the LEFT of the cursor past the horizontal
            midline (keeps the right edge) and flips ABOVE the cursor in the bottom band. */}
        {hovered && tipShown && (
          <div
            // left/top/transform are deliberately NOT React-managed props: positionTip writes
            // them imperatively so a mousemove costs a style write, not a render. The callback
            // ref applies the recorded position the instant the element mounts (and on every
            // re-render, since the inline ref re-runs), so there is no frame where the panel
            // sits un-positioned at the plate's origin.
            ref={(el) => {
              tipRef.current = el;
              positionTip();
            }}
            className="pointer-events-none absolute z-10"
          >
            <TooltipPanel
              title={`${hovered.n}. ${hovered.key} — ${SECTOR_LABEL[hovered.sector]}`}
              rows={[
                {
                  label: "Verdict",
                  value: `${RING_LABEL[hovered.verdict.ring]}${hovered.verdict.caution ? " · caution" : ""}`,
                  color: RING_FILL[hovered.verdict.ring],
                },
                // An emerging niche never shows its trend % — a young tag's base is near zero
                // by construction, so the honest numbers are the label's youth and its
                // absolute volume.
                ...(hovered.demandEmerging
                  ? [
                      { label: "Demand 24m", value: "emerging — no comparable % base" },
                      {
                        label: "Reviews 24m",
                        value: hovered.reviews24m != null ? fmtInt(hovered.reviews24m) : "—",
                      },
                    ]
                  : [{ label: "Demand 24m", value: fmtTrendPct(hovered.demandTrendPct) }]),
                {
                  label: "Releases YoY",
                  value: hovered.saturationYoy != null ? fmtSigned(hovered.saturationYoy, 0) : "unknown",
                },
                { label: "P90 revenue", value: fmtUsd(hovered.p90_rev) },
                { label: "Games", value: fmtInt(hovered.n_games) },
                { label: "Opp v2", value: hovered.opportunity_v2 != null ? hovered.opportunity_v2.toFixed(1) : "—" },
                {
                  label: "Singleplayer share",
                  value: hovered.solo_viability != null ? hovered.solo_viability.toFixed(2) : "unknown",
                },
              ]}
            />
          </div>
        )}
      </div>

      {/* THE RAIL — the board's single reading pane: the ranked verdict list under the
          full-pool niche search, or (at ≥lg, side-by-side) the selected niche's dossier. From
          lg up it matches the dial's height and scrolls inside itself (absolute-inset column
          — full counts in the group headers, so nothing is silently capped); below lg it
          flows with the page, uncapped, and the dossier renders as the slide-over DRAWER
          instead. Widths: 360px at lg, 460px at xl — the dial shrinks first; the dossier's
          value+bar rows fit one line at both. */}
      <div className="flex min-w-0 flex-col border-t border-chartborder pt-4 lg:w-[360px] lg:shrink-0 lg:border-l lg:border-t-0 lg:pl-4 lg:pt-0 xl:w-[460px] xl:pl-5">
        {selected && isDesktop ? (
          <VerdictDossier blip={selected} plotCap={plotCap} total={zoomMembers.length} onBack={() => onSelect(null)} />
        ) : (
          <>
            {/* THE ZOOM-FILTER CHIP — while a ring is zoomed the rail reads that ring only,
                and this chip says so at the top with the honest member count. The whole chip
                is the clear button (✕ affordance on the right) — the third exit path beside
                Esc and the plate-background click. */}
            {zoom !== null && (
              <button
                type="button"
                data-testid="radar-zoom-chip"
                onClick={() => setZoom(null)}
                aria-label={`Clear ring filter: ${REGION_NAME[zoom]}`}
                className="mb-2 flex w-full items-center gap-2 border border-ink-primary/35 px-2.5 py-1.5 text-left transition-colors hover:bg-ink-primary/[0.08]"
              >
                <span className="inline-block h-2 w-2 shrink-0" style={{ backgroundColor: REGION_TONE[zoom] }} aria-hidden />
                <span className="kicker text-[10px] tracking-[.08em] text-ink-primary">{REGION_NAME[zoom]}</span>
                <span className="tabular text-[11px] text-ink-muted">
                  {zoomMembers.length} niche{zoomMembers.length === 1 ? "" : "s"}
                </span>
                <span aria-hidden className="ml-auto text-[11px] leading-none text-ink-muted">✕</span>
              </button>
            )}
            {/* The niche search — scope is the FULL pool across all classes (stated right in
                the placeholder so nobody has to guess it only reaches the plotted class),
                EXCEPT while zoomed: search composes with the zoom filter, reading within the
                ring's members only — and says so. */}
            <input
              type="text"
              data-testid="radar-search"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setActiveIdx(0);
              }}
              onKeyDown={onSearchKey}
              placeholder={
                zoom !== null
                  ? `Search ${zoomMembers.length} in ${REGION_NAME[zoom]}…`
                  : `Search all ${pool.length} niches…`
              }
              aria-label={
                zoom !== null
                  ? `Search the ${zoomMembers.length} niches in the zoomed ${REGION_NAME[zoom]} ring`
                  : `Search all ${pool.length} niches in this cut`
              }
              autoComplete="off"
              spellCheck={false}
              className="mb-2 w-full border border-ink-primary/30 bg-transparent px-2.5 py-1.5 text-[13px] text-ink-primary placeholder:text-ink-muted"
            />
            <div className="flex items-baseline gap-2 border-b border-ink-primary/25 pb-2">
              <span className="kicker text-[11px] tracking-[.08em] text-ink-primary">Verdicts</span>
              <span className="tabular text-[11px] text-ink-muted">
                {q
                  ? `${railEntries.length} of ${zoom !== null ? zoomMembers.length : pool.length} match`
                  : zoomMembers.length}
              </span>
              <span className="ml-auto text-[10px] text-ink-muted">
                {q ? "Esc clears · ↑↓ + Enter opens" : "click a dot or row for its dossier"}
              </span>
            </div>
            <div className="lg:relative lg:min-h-0 lg:flex-1">
              <div data-testid="radar-rail-list" className="rail-scroll flex flex-col gap-4 pt-2 lg:absolute lg:inset-0 lg:overflow-y-auto lg:pb-8 lg:pr-2">
                {/* The honest empty state: the search really looked at the whole pool. */}
                {q && railEntries.length === 0 && (
                  <div data-testid="radar-search-empty" className="pt-1.5 text-[12px] text-ink-muted">
                    No niches match &ldquo;{query.trim()}&rdquo; —{" "}
                    {zoom !== null
                      ? `searched the ${zoomMembers.length} niches in ${REGION_NAME[zoom]}.`
                      : `searched all ${pool.length} niches in this cut.`}
                  </div>
                )}
                {RING_ORDER.map((ring) => {
                  const entries = byRing.get(ring)!;
                  // While searching OR zoom-filtered, a ring with no matches is noise — drop
                  // the whole group (the chip/header already carry the honest totals; the
                  // unfiltered list keeps its explicit "None in this cut.").
                  if ((q || zoom !== null) && entries.length === 0) return null;
                  return (
                    <div key={ring}>
                      <div className="flex items-baseline gap-2 border-b border-chartborder pb-1.5">
                        <span className="inline-block h-2 w-2 shrink-0 self-center" style={{ backgroundColor: RING_FILL[ring] }} aria-hidden />
                        <span className="kicker text-[11px] text-ink-primary">{RING_LABEL[ring]}</span>
                        <span className="tabular text-[11px] text-ink-muted">{entries.length}</span>
                      </div>
                      {entries.length === 0 ? (
                        <div className="pt-1.5 text-[12px] text-ink-muted">None in this cut.</div>
                      ) : (
                        <div className="grid grid-cols-1 gap-x-6 pt-1 sm:grid-cols-2 lg:grid-cols-1">
                          {entries.map((b) => {
                            // Band-hover rail tick (a reading aid, never a reorder/filter):
                            // while a band is lit, the rows whose DOTS live in it take a 2px
                            // left-edge tick in the ring tone. box-shadow, not border — zero
                            // layout shift, pure paint. Beyond-board search hits have no dot,
                            // so no band and never a tick.
                            const rowRegion = regionById.get(b.id);
                            const ticked = effectiveRegion !== null && rowRegion === effectiveRegion;
                            // THE CLASS EMPHASIS reaches the rail too, at the same strength
                            // it reaches the dots — one instrument, one channel. Nothing is
                            // removed or reordered: an off-class row keeps its rank, its
                            // glyphs and its click.
                            const offClass = emphasis !== null && b.sector !== emphasis;
                            return (
                            <button
                              type="button"
                              key={b.id}
                              data-testid={`radar-row-${b.id}`}
                              data-region-tick={ticked ? effectiveRegion : undefined}
                              data-off-class={offClass ? b.sector : undefined}
                              onClick={() => onSelect(b.id)}
                              onMouseEnter={() => setHoverId(b.id)}
                              onMouseLeave={clearHover}
                              title={`${b.key} — ${SECTOR_LABEL[b.sector]} · ${RING_LABEL[b.verdict.ring]}: ${
                                b.verdict.reason
                              }${b.n == null ? ` (beyond the Top ${plotCap} of its class — no dot on the board)` : ""}`}
                              style={{
                                ...(ticked ? { boxShadow: `inset 2px 0 0 ${REGION_TONE[effectiveRegion!]}` } : null),
                                ...(offClass ? { opacity: OFF_CLASS + 0.25 } : null),
                              }}
                              className={clsx(
                                "group/rl flex min-w-0 items-baseline gap-2 py-[3px] text-left text-[13px] transition-colors",
                                (hoverId === b.id || (q && flatRows[activeIdx]?.id === b.id)) &&
                                  "bg-ink-primary/[0.06]",
                              )}
                            >
                              {/* Beyond-board search hits have no rail rank — an em dash,
                                  never a fake number (the dossier carries the full note). */}
                              <span className="tabular w-6 shrink-0 text-right text-[11px] text-ink-muted">
                                {b.n ?? "—"}
                              </span>
                              <span className="truncate text-ink-secondary transition-colors group-hover/rl:text-brand">{b.key}</span>
                              <span className="shrink-0 text-[10px] text-ink-muted" title={SECTOR_LABEL[b.sector]}>
                                {SECTOR_SHORT[b.sector]}
                              </span>
                              {b.demandEmerging ? (
                                <EmergingGlyph reviews24m={b.reviews24m} />
                              ) : (
                                <MoveGlyph trendPct={b.demandTrendPct} />
                              )}
                            </button>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
              {/* Scroll affordance (A1): macOS overlay scrollbars hide until touched, so
                  without this fade a clipped rail reads as the list just ENDING — the exact
                  silent cap this layout exists to remove. Paired with .rail-scroll's
                  always-visible thin scrollbar (index.css). */}
              <div
                aria-hidden
                className="pointer-events-none absolute inset-x-0 bottom-0 hidden h-8 lg:block"
                style={{ background: "linear-gradient(to top, var(--page-plane), transparent)" }}
              />
            </div>
          </>
        )}
      </div>

      {/* Below lg the dossier is a slide-over drawer — a selection must never strand it below
          the board (see DossierDrawer). Same close channel as the rail's back button:
          onSelect(null). */}
      {selected && !isDesktop && (
        <DossierDrawer blip={selected} plotCap={plotCap} total={zoomMembers.length} onClose={() => onSelect(null)} />
      )}
    </div>
  );
}

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Link } from "react-router-dom";
import clsx from "clsx";

import { trackEvent } from "../lib/analytics";
import { fmtInt, fmtSigned, fmtUsd } from "../lib/format";
import { MONO } from "../lib/palette";
import {
  DEMAND_ENTER_PCT,
  RING_LABEL,
  RING_ORDER,
  SAT_FLOOD_YOY,
  SOLO_FRIENDLY_MIN,
  blipRadius,
  hash01,
  soloBucket,
  type RadarRing,
  type RadarVerdict,
  type VerdictCheck,
} from "../lib/radarVerdict";
import { TooltipPanel } from "./charts/TooltipPanel";
import { nicheDetailPath } from "../lib/nichePath";

/**
 * RadarBoard — the XY QUADRANT plate (2026-08-27, user directive: "score them accordingly
 * to our current criterias and make more like XY axis graph with 4 different parameters").
 * The polar ring board this replaces encoded the verdict as an annulus; this board draws
 * the verdict's own INPUTS as the axes, so a dot's position IS its evidence:
 *
 *   X — demand_trend_24m_pct (% per 24 months: review inflow, last 24 complete months vs
 *       the prior 24). The decisive demand check.
 *   Y — saturation_yoy (% releases YoY). The decisive supply/overcrowding check. The
 *       axis runs CALMER-UP (2026-08-27 directive: "top right corner should tell about
 *       the niches you have to choose"): fewer releases YoY toward the top, flooding
 *       toward the bottom — the tick values simply descend upward, and the axis title
 *       says so. The top-right quadrant is therefore the FOCUS ZONE (growing demand,
 *       calm pipeline), reinforced by a low-alpha wash in the enter hue.
 *   dot AREA — P90 revenue (sqrt scale, like every bubble on this site).
 *   dot STYLE — the final VERDICT. Fill hue + brightness carry it: enter green, watch
 *       neutral steel, emerging violet, crowded amber, declining terracotta (the
 *       2026-08-27 COLOR AMENDMENT to the old mono-steel rule — see index.css; hues are
 *       REINFORCEMENT only, every meaning survives grayscale). Style is the 4th channel
 *       deliberately: a dot can sit in the focus quadrant and still be Watch (the
 *       concentration / winner-take-most veto fires on evidence the axes don't draw),
 *       so position alone must never be read as the recommendation — the fill carries
 *       the final word and the dossier the full trace. opportunity_v2 stays in tooltip
 *       + dossier: a sixth visual channel would fight the verdict styling.
 *
 * THE QUADRANT GEOMETRY IS THE VERDICT'S OWN THRESHOLDS: the vertical hairline sits at
 * X = +40%/24m (DEMAND_ENTER_PCT — the enter bar) and the horizontal at Y = +15% YoY
 * (SAT_FLOOD_YOY — the flood bar, in the lower half now that calm points up); zero
 * lines draw fainter. So the "GROWING · OPEN" quadrant is literally the region where
 * the demand check passes and the supply veto does not fire — the same booleans the
 * dossier spells out.
 *
 * HONESTY RULES OF THE PLATE:
 *   - OUTLIERS CLAMP, VISIBLY: axes are linear over fixed labeled domains (X −100…+300,
 *     Y −60…+120). A value beyond the domain pins its dot at the plot edge with an
 *     outward chevron marker (and "≥ +300"-style edge tick labels); the tooltip and
 *     dossier carry the true number. Never silently dropped, never fake-positioned.
 *   - NO XY, NO DOT IN THE PLOT: an EMERGING niche has no trustworthy trend % (young
 *     label — its prior window is near zero by construction), and a niche without a
 *     trend or saturation reading has no honest coordinate at all. Those rows render in
 *     a dashed STRIP under the plot (the dashed-halo language), sized by absolute
 *     24-month review volume — the number an emerging niche is actually judged by.
 *   - Overlap jitter is DETERMINISTIC (hash01 of the niche id, never Math.random), only
 *     applied to coincident dots, and never moves a pinned dot off its clamp edge.
 *
 * ONE INSTRUMENT (unchanged from the 2026-08-27 layout overhaul): plate and rail live in
 * one frame and share one selection model. The rail has two modes:
 *   - default: the ranked VERDICT LIST — every plotted niche, grouped by ring verdict,
 *     FULL counts — under the NICHE SEARCH input. The search's scope is the `pool` prop
 *     (the WHOLE population of the cut + solo setting across ALL classes, not just the
 *     plotted Top-N): typing filters live (case-insensitive substring on the niche key);
 *     matches beyond the plotted board appear with an em-dash rank and still open a full
 *     dossier. Esc clears; ↑/↓ + Enter walk and open matches. No silent caps: below lg
 *     the list flows with the page; from lg up it scrolls inside the rail with true
 *     totals in the group headers.
 *   - selection: the VERDICT DOSSIER — in view at every width. From lg (1024px) up the
 *     board and rail sit side-by-side (rail 360px at lg, 460px at xl) and the dossier is
 *     the rail's selection pane; below lg it renders as the slide-over DRAWER
 *     (DossierDrawer: backdrop, ✕/back/ESC close, focus-trapped). Both presentations
 *     render the same DossierBody. A selection that is NOT plotted still opens its
 *     dossier, with an honest "beyond the Top N plot" note.
 * Selection is CONTROLLED (selectedId/onSelect): the page owns it — and uses it to
 * switch the class picker when a search hit belongs to another class.
 *
 * Everything is hand-rolled SVG — the CSP forbids external chart libs. All colors are
 * CSS vars; the solo LENS stays orthogonal (team-scale dots draw hollow, singleplayer
 * share < SOLO_FRIENDLY_MIN); a caution verdict (weak/partial evidence) draws a dotted
 * ring. CLICK TARGETS: only the dots are interactive inside the SVG — axes, gridlines,
 * threshold hairlines and labels sit in a pointer-events:none group, and the region
 * hover rects below carry NO click handler, so a click on empty quadrant space still
 * reads as background, never as a dead dot. Keyboard access: the SVG dots are mouse
 * conveniences (aria-hidden); every niche's keyboard route is its rail row (a real
 * button), and navigation lives on the dossier's deep-dive link.
 *
 * REGION HOVER (2026-08-27, user directive: "can we add a side highlight when you hover
 * on it? and highlight all the circles in it?"): the plate carries five invisible
 * hover-only hit rects — the four quadrants the verdict bars tile the plot into, plus
 * the EMERGING strip as a fifth region with the same contract. Hovering one lifts the
 * region (a whisper-alpha wash in its semantic tone + a brightened corner label), pops
 * every member dot to full opacity with a slight ring, and mutes every dot outside to
 * the usual 0.35; rail rows of member niches take a left-edge tick in the region tone
 * (the rail is never reordered or filtered — spec'd as a reading aid only). PERFORMANCE
 * CONTRACT: membership is precomputed per layout (layoutXY assigns each dot its region),
 * so a mousemove does no per-dot math — only region enter/leave flips state, and dots
 * restyle through their existing CSS opacity transition. DOT hover takes precedence
 * (tooltip + single-dot emphasis exactly as before) but keeps the hovered dot's OWN
 * region washed — the pointer is physically inside that region, and dropping the wash
 * would flicker while brushing across dots. Hover-only: mouse leave restores
 * everything; click→dossier selection is untouched.
 *
 * CLICK-TO-ZOOM (2026-08-28, user directive: "when you click on a radar one of the
 * sides - it zooms in to this side and filters niches on the right side"): clicking a
 * region's EMPTY area (dots keep their dossier click — precedence unchanged) zooms the
 * plate into that region and filters the rail to its members. A QUADRANT zoom
 * re-domains both axes to the quadrant's own bounds (ZOOM_DOMAIN — the verdict bars
 * become the inner edges), renders only member dots (edge-pinned members keep their
 * chevrons, judged against the zoomed domain), re-ticks the axes for the smaller
 * domain, and swaps the four corner labels for one region title. The STRIP's zoom is a
 * rail filter + an ENLARGED strip presentation only — an emerging row never gets a
 * fake XY position, so there is no quadrant view to zoom to. While zoomed: region
 * hover is disabled (moot in a single-region view; dot hover/tooltip stays), the rail
 * carries a clear-filter CHIP with the honest member count, search composes WITH the
 * filter (scope = the region's members), and verdict-group counts recompute from the
 * filtered rows. Three exits, all page-local: the chip's ✕, Esc (after more local Esc
 * consumers — search text, the <lg drawer), and clicking the plate's background.
 *
 * PLATE SIZING (2026-08-28, "radar is too small" + "not all pages have same size"):
 * see the geometry section — the plate is rectangular and responsive (viewBox rebuilt
 * from the measured wrapper width, 1 unit = 1 CSS px), filling the shared page
 * container beside the fixed-width rail.
 */

export type RadarSector = "genre" | "micro" | "theme";

const SECTOR_LABEL: Record<RadarSector, string> = {
  genre: "Genres",
  micro: "Micro-genres",
  theme: "Themes",
};
/** One-letter class marker for rail rows — the search spans all classes, so a cross-class
 * match needs its class named ("Roguelike" the tag vs "Roguelike" the genre). */
const SECTOR_SHORT: Record<RadarSector, string> = { genre: "G", micro: "M", theme: "T" };

export interface RadarBoardBlip {
  dimension: string;
  key: string;
  tier: string | null;
  sector: RadarSector;
  n_games: number;
  p90_rev: number | null;
  opportunity_v2: number | null;
  /** Percent units; the 24-month demand trend (last 24 complete months vs the prior 24 —
   * see mart_niche.sql's _niche_demand24m). null = this niche has no trend (the mart
   * predates the column, or the niche had no prior-window baseline). THE X AXIS. */
  demandTrendPct: number | null;
  /** Signed fraction, releases YoY (0.15 = +15%); null = unknown. THE Y AXIS. */
  saturationYoy: number | null;
  /** The mart's young-tag flag (see lib/radarVerdict.ts): when true the trend % is not
   * representative — the row renders in the no-%-base strip, never at a fake X. */
  demandEmerging: boolean;
  /** Absolute review inflow over the last 24 months — the number an emerging niche is
   * judged by (its % has no comparable base), and the strip's size scale. */
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

// ---- XY geometry ------------------------------------------------------------------------

/** X domain, % per 24 months. −100 is the true floor (inflow cannot drop further); +300
 * clips the young-tag long tail — beyond it a dot pins at the edge with a chevron. */
export const X_DOMAIN: readonly [number, number] = [-100, 300];
/** Y domain, % releases YoY. Chosen from the live distribution (p5 ≈ −23%, p95 ≈ +160%):
 * the −30…+60 band where most niches live keeps most of the pixels; the ~5% beyond +120
 * pin at the top edge rather than crushing the readable region. */
export const Y_DOMAIN: readonly [number, number] = [-60, 120];
/** The vertical quadrant line: the verdict's own demand bar (+40% / 24m to enter). */
export const X_BAR = DEMAND_ENTER_PCT;
/** The horizontal quadrant line: the verdict's own flood bar (+15% releases YoY). */
export const Y_BAR = SAT_FLOOD_YOY * 100;

/**
 * THE PLATE IS RECTANGULAR AND RESPONSIVE (2026-08-28, user directive: "radar is too
 * small"). The old board was a fixed 640-unit SQUARE viewBox (a leftover of the polar
 * ring plate) capped at ~640 CSS px — every label and dot scaled with the box, so
 * phones rendered 9px labels at ~5px and a wide container could only blow them up.
 * Now the SVG viewBox is rebuilt from the wrapper's MEASURED CSS width: one viewBox
 * unit = one CSS pixel at every breakpoint, the plot fills all horizontal space the
 * shared page container gives it beside the rail (~880px plate at 1440, ~1040px at
 * 1920), text keeps its true point size everywhere, and the height follows the width
 * gently (~16:10 at desktop widths) between honest bounds so board + rail + toolbar
 * still fit above the fold at 1440×900. plateGeom() is the single source of the plot
 * rectangle; layoutXY() takes the measured width (and the zoom state, below) and
 * returns positions in that space.
 */
const MARGIN_L = 48; // y tick labels + the rotated axis title
const MARGIN_T = 22; // the top corner labels breathe
const MARGIN_R = 16;
const AXIS_H = 40; // bottom margin: tick labels + axis title
const PLOT_H_RATIO = 0.6;
const PLOT_H_MIN = 300;
const PLOT_H_MAX = 560;
/** Width before the wrapper is measured — and the effective width under jsdom (tests),
 * where clientWidth is 0 and the fallback sticks. Exported so tests can name it. */
export const DEFAULT_PLATE_W = 928;

/** The plate's five HOVER/ZOOM REGIONS: the four quadrants the verdict bars tile the
 * plot into, plus the EMERGING strip as a full peer (same hover + zoom-filter
 * contract). Ids echo the corner labels; "shrinking-open" covers the FLAT/SHRINKING ·
 * OPEN corner. */
export type RadarRegion =
  | "growing-open"
  | "growing-flooding"
  | "shrinking-open"
  | "shrinking-flooding"
  | "strip";

/** CLICK-TO-ZOOM DOMAINS (2026-08-28 directive: "when you click on a radar one of the
 * sides - it zooms in to this side and filters niches on the right side"). Clicking a
 * quadrant's EMPTY area re-domains the axes to that quadrant's own bounds — the
 * verdict bars become the inner edges, the full-view domain edges stay the outer ones.
 * The strip has no XY by construction, so it gets NO quadrant zoom — zoom === "strip"
 * keeps the full domains and enlarges the strip instead (a rail filter + emphasis,
 * never a fake position). */
const ZOOM_DOMAIN: Record<
  Exclude<RadarRegion, "strip">,
  { x: readonly [number, number]; y: readonly [number, number] }
> = {
  "growing-open": { x: [X_BAR, X_DOMAIN[1]], y: [Y_DOMAIN[0], Y_BAR] },
  "growing-flooding": { x: [X_BAR, X_DOMAIN[1]], y: [Y_BAR, Y_DOMAIN[1]] },
  "shrinking-open": { x: [X_DOMAIN[0], X_BAR], y: [Y_DOMAIN[0], Y_BAR] },
  "shrinking-flooding": { x: [X_DOMAIN[0], X_BAR], y: [Y_BAR, Y_DOMAIN[1]] },
};

export interface PlateGeom {
  /** viewBox width == the wrapper's measured CSS width (1 unit = 1 px). */
  plateW: number;
  /** Plot rectangle inside the viewBox; margins host tick labels and axis titles. */
  plot: { l: number; t: number; w: number; h: number };
  /** Plot right / bottom edge. */
  x1: number;
  y1: number;
  /** Plot + x-axis margin — the strip attaches below this. */
  baseH: number;
  /** The ACTIVE axis domains — the zoomed quadrant's bounds, or the full view's. */
  xd: readonly [number, number];
  yd: readonly [number, number];
  /** Domain % -> px, unclamped (clamping is layoutXY's job, so it can flag it). */
  xToPx: (v: number) => number;
  /** Domain % YoY -> px; CALMER UP — low saturation at the top, flooding at the bottom
   * (the 2026-08-27 orientation flip). Tick VALUES are untouched; they simply descend
   * upward, and the axis title says so. */
  yToPx: (v: number) => number;
}

export function plateGeom(plateW: number = DEFAULT_PLATE_W, zoom: RadarRegion | null = null): PlateGeom {
  const w = Math.max(280, Math.round(plateW));
  const plotW = w - MARGIN_L - MARGIN_R;
  const plotH = Math.min(PLOT_H_MAX, Math.max(PLOT_H_MIN, Math.round(plotW * PLOT_H_RATIO)));
  const plot = { l: MARGIN_L, t: MARGIN_T, w: plotW, h: plotH };
  const zoomed = zoom !== null && zoom !== "strip" ? ZOOM_DOMAIN[zoom] : null;
  const xd = zoomed ? zoomed.x : X_DOMAIN;
  const yd = zoomed ? zoomed.y : Y_DOMAIN;
  return {
    plateW: w,
    plot,
    x1: plot.l + plot.w,
    y1: plot.t + plot.h,
    baseH: plot.t + plot.h + AXIS_H,
    xd,
    yd,
    xToPx: (v: number) => plot.l + ((v - xd[0]) / (xd[1] - xd[0])) * plot.w,
    yToPx: (v: number) => plot.t + ((v - yd[0]) / (yd[1] - yd[0])) * plot.h,
  };
}

/** Default full-view geometry — the module-scope conveniences the tests (and the
 * pre-measure first render) see. Under jsdom the wrapper measures 0 wide, so the
 * component renders EXACTLY this geometry there. */
const G0 = plateGeom();
export const PLOT = G0.plot;
export const xToPx = G0.xToPx;
export const yToPx = G0.yToPx;

/** Axis ticks for the ACTIVE domain: nice 1/2/2.5/5 steps at a density tuned to the
 * rendered plot size. Domain endpoints are always included (the clamp "≥ / ≤" edge
 * labels live there); interior ticks that would crowd an endpoint are dropped. */
export function axisTicks(lo: number, hi: number, target: number): number[] {
  const span = hi - lo;
  const raw = span / Math.max(1, target);
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step = ([1, 2, 2.5, 5, 10].find((m) => raw <= m * pow) ?? 10) * pow;
  const ticks: number[] = [lo];
  for (let v = Math.ceil(lo / step) * step; v < hi; v += step) {
    if (v - lo > span * 0.06 && hi - v > span * 0.06) ticks.push(Number(v.toFixed(6)));
  }
  ticks.push(hi);
  return ticks;
}

// The no-XY strip (emerging / no-trend rows) under the axis. Two presentations: the
// resting strip, and the ENLARGED strip while zoom === "strip" (the fifth region's
// zoom is a rail filter + visual emphasis — emerging rows never get a fake XY).
const STRIP_GAP = 8;
const STRIP_SIZES = {
  rest: { labelH: 18, rowH: 20, pad: 10, rMin: 2.5, rMax: 7 },
  zoom: { labelH: 22, rowH: 30, pad: 12, rMin: 3.5, rMax: 11 },
} as const;

export interface PlacedBlip extends RadarBoardBlip {
  id: string;
  /** 1-based rail number (ring-verdict order, then opportunity desc). */
  n: number;
  /** Hover-region membership, precomputed at LAYOUT time from the DATA's side of the
   * verdict bars (growing = demand ≥ the enter bar; flooding = saturation strictly
   * above the flood bar — the verdict's own booleans), never the jittered/clamped
   * pixel: a dot nudged across a hairline by coincident-dot jitter still lights with
   * the quadrant its evidence puts it in. Strip residents belong to "strip". */
  region: RadarRegion;
  x: number;
  y: number;
  r: number;
  /** 0 = honest position; 1/−1 = the true value lies beyond the axis max/min — the dot
   * is pinned at that plot edge and draws an outward chevron (tooltip has the truth). */
  clampX: -1 | 0 | 1;
  clampY: -1 | 0 | 1;
  /** True = no honest XY coordinate (emerging, or trend/saturation missing): drawn in
   * the dashed strip under the plot, sized by 24m review volume — never fake-positioned
   * inside the quadrants. */
  strip: boolean;
  /** True while a QUADRANT zoom is active and this dot is not a member of the zoomed
   * region (strip residents included — the strip is not part of any quadrant): the dot
   * is out of the zoomed domain, so it does not render. Region membership itself is
   * untouched — it is always the raw values' side of the verdict bars. */
  hidden: boolean;
}

/** A rail/dossier entry: a plotted blip (with its rail rank), or a pool niche beyond the
 * plotted board reachable only through search — n: null, no dot on the plate. */
export type RailBlip = RadarBoardBlip & { id: string; n: number | null };

export interface XYLayout {
  dots: PlacedBlip[];
  stripCount: number;
  /** True when the strip holds rows that are NOT the mart's emerging flag (a niche with
   * no trend or no saturation reading) — the strip label must then not overclaim. */
  stripHasNonEmerging: boolean;
  stripTop: number;
  stripH: number;
  /** Total viewBox height — grows with the strip so nothing overlays the axis. */
  vbH: number;
  /** The geometry this layout was computed in — the renderer draws with the SAME object
   * so plot frame, hit rects and dot positions can never disagree. */
  geom: PlateGeom;
}

const clampNum = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

export interface LayoutOpts {
  /** The wrapper's measured CSS width; defaults to DEFAULT_PLATE_W (tests, pre-measure). */
  plateW?: number;
  /** Active zoom region — null = the full view. */
  zoom?: RadarRegion | null;
}

/**
 * Deterministic XY placement. Pure function of the blips + options (hash01 jitter only),
 * exported for tests: same input, same output — a niche holds its position across
 * renders, visits and machines.
 */
export function layoutXY(blips: RadarBoardBlip[], opts: LayoutOpts = {}): XYLayout {
  const zoom = opts.zoom ?? null;
  const zoomQuadrant = zoom !== null && zoom !== "strip";
  const geom = plateGeom(opts.plateW, zoom);
  const { plot, x1: plotX1, y1: plotY1, xd, yd } = geom;
  /** Dot radius scale: BLIP_R_MIN/MAX were tuned for the old 578px-wide plot; a larger
   * plot grows dots gently so the bigger canvas doesn't read emptier, a phone plot
   * shrinks them slightly. Bounded — never a stretch. */
  const rScale = Math.min(1.35, Math.max(0.9, plot.w / 578));
  const maxP90 = blips.reduce<number>((m, b) => Math.max(m, b.p90_rev ?? 0), 0);
  const ordered = [...blips].sort((a, b) => {
    const ring = RING_ORDER.indexOf(a.verdict.ring) - RING_ORDER.indexOf(b.verdict.ring);
    if (ring !== 0) return ring;
    const opp = (b.opportunity_v2 ?? -1) - (a.opportunity_v2 ?? -1);
    if (opp !== 0) return opp;
    return a.key.localeCompare(b.key);
  });

  const dots: PlacedBlip[] = ordered.map((blip, i) => {
    const id = `${blip.dimension}:${blip.key}`;
    // No honest coordinate -> the strip. Emerging first (its % EXISTS but is not
    // representative — plotting it would be worse than missing data), then any row a
    // linear axis simply has no number for.
    const strip = blip.demandEmerging || blip.demandTrendPct === null || blip.saturationYoy === null;
    if (strip) {
      // Strip coords are assigned in the packing pass below. A quadrant zoom hides the
      // strip (it belongs to no quadrant); the strip's own zoom enlarges it instead.
      return {
        ...blip,
        id,
        n: i + 1,
        x: 0,
        y: 0,
        r: STRIP_SIZES.rest.rMin,
        clampX: 0 as const,
        clampY: 0 as const,
        strip: true,
        region: "strip" as const,
        hidden: zoomQuadrant,
      };
    }
    const xv = blip.demandTrendPct as number;
    const yv = (blip.saturationYoy as number) * 100;
    // Region membership on the RAW fields against the verdict's own bars (>= to grow,
    // strictly > to flood — the exact comparisons radarVerdictTrace runs), so the hover
    // and zoom sets can never disagree with the quadrant geometry's meaning. Membership
    // never changes with zoom — only what the zoomed domain renders does.
    const growing = xv >= DEMAND_ENTER_PCT;
    const flooding = (blip.saturationYoy as number) > SAT_FLOOD_YOY;
    const region: RadarRegion = growing
      ? flooding
        ? "growing-flooding"
        : "growing-open"
      : flooding
        ? "shrinking-flooding"
        : "shrinking-open";
    const hidden = zoomQuadrant && region !== zoom;
    // Clamps are judged against the ACTIVE domain: in the full view these are the fixed
    // axis edges; inside a zoom the outer edges still clamp (a +900% dot pins at the
    // zoomed right edge with its chevron) while the bar-side edges cannot clamp by
    // construction (membership already puts every value on this side of the bar).
    const clampX = xv > xd[1] ? 1 : xv < xd[0] ? -1 : 0;
    const clampY = yv > yd[1] ? 1 : yv < yd[0] ? -1 : 0;
    const r = blipRadius(blip.p90_rev, maxP90) * rScale;
    // Pinned dots sit ON their edge (touching it from inside); honest dots inset by r so
    // the circle never spills out of the frame.
    const x =
      clampX === 1
        ? plotX1 - r - 1
        : clampX === -1
          ? plot.l + r + 1
          : clampNum(geom.xToPx(xv), plot.l + r, plotX1 - r);
    // Calmer-up: beyond-max saturation (clampY = 1, flooding off the scale) pins at the
    // BOTTOM edge; beyond-min pins at the top.
    const y =
      clampY === 1
        ? plotY1 - r - 1
        : clampY === -1
          ? plot.t + r + 1
          : clampNum(geom.yToPx(yv), plot.t + r, plotY1 - r);
    return { ...blip, id, n: i + 1, x, y, r, clampX, clampY, strip: false, region, hidden };
  });

  // Coincident-dot jitter: only when centers land in the same ~2px cell, offset by a
  // hash-derived angle (deterministic), growing with the pile index — and NEVER along a
  // pinned axis (a clamp edge is a claim; jitter must not soften it). Hidden dots are
  // skipped: an invisible dot must not push a visible one around.
  const seen = new Map<string, number>();
  for (const d of dots) {
    if (d.strip || d.hidden) continue;
    const cell = `${Math.round(d.x / 2)}|${Math.round(d.y / 2)}`;
    const k = seen.get(cell) ?? 0;
    seen.set(cell, k + 1);
    if (k === 0) continue;
    const ang = hash01(`${d.id}|jitter`) * 2 * Math.PI;
    const dist = 3 + 2.5 * k;
    if (d.clampX === 0) d.x = clampNum(d.x + Math.cos(ang) * dist, plot.l + d.r, plotX1 - d.r);
    if (d.clampY === 0) d.y = clampNum(d.y + Math.sin(ang) * dist, plot.t + d.r, plotY1 - d.r);
  }

  // Strip packing: volume desc (the strip's own honest ranking), left-to-right rows.
  // The strip spans the plot's full width whatever that width is, and its sizes swap to
  // the enlarged presentation while the strip itself is the zoomed region.
  const S = zoom === "strip" ? STRIP_SIZES.zoom : STRIP_SIZES.rest;
  const stripDots = dots.filter((d) => d.strip && !d.hidden);
  stripDots.sort((a, b) => (b.reviews24m ?? -1) - (a.reviews24m ?? -1) || a.key.localeCompare(b.key));
  const maxVol = stripDots.reduce<number>((m, d) => Math.max(m, d.reviews24m ?? 0), 0);
  const stripTop = geom.baseH + STRIP_GAP;
  let cursor = plot.l + S.pad;
  let row = 0;
  for (const d of stripDots) {
    d.r =
      maxVol > 0 && d.reviews24m != null
        ? S.rMin + Math.sqrt(d.reviews24m / maxVol) * (S.rMax - S.rMin)
        : S.rMin;
    if (cursor + 2 * d.r > plotX1 - S.pad) {
      row += 1;
      cursor = plot.l + S.pad;
    }
    d.x = cursor + d.r;
    d.y = stripTop + S.labelH + S.rowH / 2 + row * S.rowH;
    cursor += 2 * d.r + 10;
  }
  const stripH = stripDots.length > 0 ? S.labelH + (row + 1) * S.rowH + S.pad : 0;

  return {
    dots,
    stripCount: stripDots.length,
    stripHasNonEmerging: stripDots.some((d) => !d.demandEmerging),
    stripTop,
    stripH,
    vbH: stripDots.length > 0 ? stripTop + stripH + 2 : geom.baseH,
    geom,
  };
}

// ---- rendering --------------------------------------------------------------------------

/** Verdict color vocabulary (4th visual channel) — the 2026-08-27 COLOR AMENDMENT to
 * the old mono-steel "never red/green" rule (user: "add some colors so it's easy to
 * understand where to focus"; hue tokens + rationale in index.css). Enter carries the
 * positive green, watch stays neutral steel, emerging goes cool violet, and the
 * crowded/declining warm family reads caution, never alarm. REINFORCEMENT ONLY: the
 * quadrant position, fill style (hollow/halo/ring) and the rail wording carry every
 * meaning without color — the board must survive grayscale. */
const RING_FILL: Record<RadarRing, string> = {
  enter: "var(--verdict-enter)",
  watch: MONO.paper75,
  emerging: "var(--verdict-emerging)",
  crowded: "var(--verdict-crowded)",
  declining: "var(--verdict-declining)",
};

/** REGION HOVER washes — whisper alphas, semantic tones (see the module doc's REGION
 * HOVER section). The focus quadrant deepens its own enter green (it paints OVER the
 * standing focus wash, so hover reads roughly twice the resting tint); the two MIXED
 * quadrants (one good axis, one bad) take a neutral steel lift — neither hue would be
 * honest there; the double-negative quadrant leans the caution amber (the crowded
 * family: caution, never alarm-red); the strip lifts in its own emerging violet.
 * color-mix over the theme tokens keeps light/dark in lockstep with index.css. */
const REGION_WASH: Record<RadarRegion, string> = {
  "growing-open": "color-mix(in srgb, var(--verdict-enter) 8%, transparent)",
  "growing-flooding": "color-mix(in srgb, var(--text-primary) 5%, transparent)",
  "shrinking-open": "color-mix(in srgb, var(--text-primary) 5%, transparent)",
  "shrinking-flooding": "color-mix(in srgb, var(--verdict-crowded) 8%, transparent)",
  strip: "color-mix(in srgb, var(--verdict-emerging) 9%, transparent)",
};

/** The rail rows' left-edge tick tone while their region is hovered — the same semantic
 * families as the wash, at full token strength (the tick is 2px, it can afford it). */
const REGION_TONE: Record<RadarRegion, string> = {
  "growing-open": "var(--verdict-enter)",
  "growing-flooding": "var(--text-secondary)",
  "shrinking-open": "var(--text-secondary)",
  "shrinking-flooding": "var(--verdict-crowded)",
  strip: "var(--verdict-emerging)",
};

/** Region display names — the corner labels' wording, reused verbatim by the zoom
 * title and the rail's zoom-filter chip so the three surfaces can never drift. */
export const REGION_NAME: Record<RadarRegion, string> = {
  "growing-open": "GROWING · OPEN",
  "growing-flooding": "GROWING · FLOODING",
  "shrinking-open": "FLAT/SHRINKING · OPEN",
  "shrinking-flooding": "SHRINKING · FLOODING",
  strip: "EMERGING",
};

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

/** Rail glyph for an emerging niche — the trend % must NEVER headline a young tag (its
 * base is near zero by construction), so the row carries the absolute volume instead. */
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
 * dash — plus the row's sr-only word), and since the 2026-08-27 color amendment the
 * tiles take a SUBTLE tint as reinforcement: pass leans the positive enter green, fail
 * leans the caution amber — never alarm-red, and never the only channel. */
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
 * The dossier's CONTENT — shared verbatim by both containers (the ≥lg rail pane and the
 * <lg slide-over drawer), so the two presentations can never drift. Decomposes WHY the
 * niche got its ring: one block per VerdictCheck from radarVerdictTrace (the SAME
 * evaluation that placed the dot — see lib/radarVerdict.ts), each with the niche's own
 * numbers, the bar it was judged against, pass/fail in neutral steel, and a one-clause
 * reading. decides:false rows (the entrant-economics falsification tell, the solo lens)
 * are labeled "· context": they can talk you out of a niche, they never move its ring.
 * Below the trace: the raw context numbers and the deep-dive link (the dossier explains;
 * the detail page is where the full workup lives).
 *
 * Accepts any RailBlip: a niche selected through search that isn't plotted (beyond the
 * Top-N of its class) gets the same full dossier — same trace, same bars — plus an
 * honest header note that it has no dot on the board at this cap.
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
      {/* The honest not-plotted note (search reaches past the plot cap): the niche is
          real, the verdict is computed the same way — it just has no dot at this Top-N. */}
      {blip.n == null && (
        <p className="pt-1 text-[11px] text-ink-muted">
          Beyond the Top {plotCap} plot — no dot on the board at this cap; the verdict below is judged by the same
          checks.
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

      <div className="flex flex-col gap-2 pb-1 pt-2.5">
        <span className="tabular text-[11px] text-ink-muted">{context}</span>
        <Link
          to={nicheDetailPath(blip.dimension, blip.key)}
          onClick={() => trackEvent("niche_open")}
          className="text-[13px] text-brand transition-colors hover:text-brand-hover"
        >
          Open deep dive →
        </Link>
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
 * stacked layout puts the rail BELOW the board, so an inline dossier would open out of
 * view and force a scroll (the exact complaint this fixes). Radius 0, hairline border,
 * mono-steel on the page plane, dimmed backdrop; closes on ✕, the back affordance, the
 * backdrop, and Escape; focus is trapped inside while open and restored on close; the
 * page behind cannot scroll. Only ever MOUNTED below lg (RadarBoard renders it from the
 * same isDesktop switch that picks the rail pane), so the two presentations are
 * mutually exclusive by construction.
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

// The side-by-side threshold. lg (1024px) since the dossier-viewport fix: at any width
// where board and rail sit side-by-side the dossier opens beside the plate (in view);
// below it the drawer takes over — so a selection can never strand the dossier below
// the fold. MUST match the lg: utilities on the board/rail markup.
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

/** Reactive "board and rail are side-by-side" flag — drives the rail-pane vs drawer
 * choice for the dossier. Defaults to desktop when matchMedia is unavailable. */
function useIsDesktop(): boolean {
  return useSyncExternalStore(subscribeDesktop, isDesktopNow, () => true);
}

/** Outward chevron on a pinned dot — the explicit "true value beyond this edge" marker.
 * Calmer-up orientation: beyond-max saturation (clampY = 1) is pinned at the BOTTOM
 * edge, so its chevron points down. pointer-events none (the dot under it is the click
 * target). */
function ClampChevron({ d }: { d: PlacedBlip }) {
  const marks: string[] = [];
  if (d.clampX === 1) marks.push(`M ${d.x + d.r + 2} ${d.y - 3.5} L ${d.x + d.r + 5.5} ${d.y} L ${d.x + d.r + 2} ${d.y + 3.5}`);
  if (d.clampX === -1) marks.push(`M ${d.x - d.r - 2} ${d.y - 3.5} L ${d.x - d.r - 5.5} ${d.y} L ${d.x - d.r - 2} ${d.y + 3.5}`);
  if (d.clampY === 1) marks.push(`M ${d.x - 3.5} ${d.y + d.r + 2} L ${d.x} ${d.y + d.r + 5.5} L ${d.x + 3.5} ${d.y + d.r + 2}`);
  if (d.clampY === -1) marks.push(`M ${d.x - 3.5} ${d.y - d.r - 2} L ${d.x} ${d.y - d.r - 5.5} L ${d.x + 3.5} ${d.y - d.r - 2}`);
  if (marks.length === 0) return null;
  return (
    <path
      data-testid={`radar-clamp-${d.id}`}
      d={marks.join(" ")}
      fill="none"
      stroke="var(--text-muted)"
      strokeWidth={1.2}
      pointerEvents="none"
    />
  );
}

/** SVG text with a page-ground halo so labels stay legible over gridlines and dots. */
function HaloText({
  x,
  y,
  anchor,
  size = 9,
  fill = "var(--text-muted)",
  transform,
  children,
}: {
  x: number;
  y: number;
  anchor: "start" | "middle" | "end";
  size?: number;
  fill?: string;
  transform?: string;
  children: React.ReactNode;
}) {
  return (
    <text
      x={x}
      y={y}
      textAnchor={anchor}
      className="kicker"
      transform={transform}
      style={{
        fontSize: size,
        letterSpacing: "0.1em",
        fill,
        stroke: "var(--page-plane)",
        strokeWidth: 3.5,
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
  selectedId,
  onSelect,
}: {
  /** What the plate plots: the active class's Top-N by opportunity (the page slices). */
  blips: RadarBoardBlip[];
  /** The FULL population at this cut + solo setting, ALL classes merged, opportunity
   * order — the rail search's scope. A superset of `blips`: search must reach every
   * niche of the cut, never just the plotted class or its Top-N. */
  pool: RadarBoardBlip[];
  /** The Top-N plot cap — names the honest "beyond the Top N plot" dossier note for a
   * search selection that has no dot. */
  plotCap: number;
  soloOnly: boolean;
  /** Controlled selection — "dimension:key" of ANY pool niche, or null. Owned by the
   * page (which also switches the class picker when a search hit is cross-class). */
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [hoverId, setHoverId] = useState<string | null>(null);
  // The hovered REGION (quadrant or strip) — set/cleared ONLY by the five hit rects'
  // enter/leave, so a mousemove inside a region costs nothing. Hover-only, never sticky.
  const [hoverRegion, setHoverRegion] = useState<RadarRegion | null>(null);
  // CLICK-TO-ZOOM state (page-local, never routed): the region whose domain the plate
  // is zoomed to and whose members the rail is filtered to. Entered by clicking a
  // region's empty area; exited by Esc, the rail chip's ✕, or a background click.
  const [zoom, setZoom] = useState<RadarRegion | null>(null);
  // TOOLTIP POSITION LIVES IN A REF, NOT IN STATE (2026-08-28 perf fix). Every dot has an
  // onMouseMove, and setState-per-pointer-pixel re-rendered this whole ~1900-line board
  // (all dots, the plate decor, the rail list) on every mouse move across a dot. Only
  // tooltip VISIBILITY is state now — it flips at most twice per dot (enter/leave); the
  // x/y ride a ref and are written straight onto the tooltip element's style, so pointer
  // movement costs one style write instead of a full React render.
  const tipRef = useRef<HTMLDivElement | null>(null);
  const tipPos = useRef<{ x: number; y: number } | null>(null);
  const [tipShown, setTipShown] = useState(false);
  // The rail's niche search. Local state deliberately: the query is a reading aid for
  // the list (like hover), not page state a card elsewhere needs to drive.
  const [query, setQuery] = useState("");
  // Keyboard cursor over the filtered rows (↑/↓ + Enter); reset whenever the query text
  // changes so the cursor can never point past a shrunken result set.
  const [activeIdx, setActiveIdx] = useState(0);
  // Side-by-side (≥lg): dossier in the rail pane. Stacked (<lg): dossier as the drawer.
  const isDesktop = useIsDesktop();

  // The plate's MEASURED width — the viewBox is rebuilt from it (1 unit = 1 CSS px, see
  // plateGeom). jsdom measures 0, so the DEFAULT_PLATE_W fallback is the test geometry.
  const [plateW, setPlateW] = useState<number | null>(null);
  const hasBlips = blips.length > 0;
  useEffect(() => {
    if (!hasBlips) return; // the empty state renders no plate to measure
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
    () => layoutXY(blips, { plateW: plateW ?? DEFAULT_PLATE_W, zoom }),
    [blips, plateW, zoom],
  );
  const placed = layout.dots;
  const q = query.trim().toLowerCase();

  /** The rail's base rows under the zoom filter: the zoomed region's member dots (board
   * rank preserved — a gap in the numbers is honest, the rank IS the board's), or every
   * plotted dot in the full view. Chip count, header count and the zoomed search scope
   * all read from this one list. */
  const zoomMembers = useMemo<PlacedBlip[]>(
    () => (zoom === null ? placed : placed.filter((d) => d.region === zoom)),
    [zoom, placed],
  );

  /** The rail's row source. No query: the (possibly zoom-filtered) plotted list, rank
   * order. With a query: a live case-insensitive substring filter — over the FULL pool
   * in the full view (plotted rows keep their rank, beyond-board rows carry n: null),
   * or WITHIN the zoomed region's members while zoomed (search composes with the zoom
   * filter — it must never smuggle an outside niche into a filtered rail). */
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

  // Esc exits the zoom — AFTER the more local Esc consumers: the search input clears
  // its text first (its handler stops propagation when it does), and the <lg dossier
  // drawer owns Esc outright while open (skip — closing it must not also unzoom).
  useEffect(() => {
    if (zoom === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (selectedId !== null && !isDesktop) return; // the drawer's Esc
      setZoom(null);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [zoom, selectedId, isDesktop]);

  const byRing = useMemo(() => {
    const m = new Map<RadarRing, RailBlip[]>(RING_ORDER.map((r) => [r, []]));
    for (const b of railEntries) m.get(b.verdict.ring)!.push(b);
    // Within a ring group: plotted rows first in rank order, then beyond-board search
    // hits in pool (opportunity) order — sort is stable, so ties keep source order.
    for (const group of m.values()) group.sort((a, b) => (a.n ?? Infinity) - (b.n ?? Infinity));
    return m;
  }, [railEntries]);
  /** The visible rows flattened in render order — the ↑/↓/Enter walk order. */
  const flatRows = useMemo(() => RING_ORDER.flatMap((r) => byRing.get(r)!), [byRing]);

  const hovered = hoverId === null ? null : (placed.find((b) => b.id === hoverId) ?? null);
  /** The region the WASH / corner label / rail ticks light for. A hovered dot wins with
   * its own region — the pointer is physically inside it, and entering the dot fires the
   * hit rect's mouseleave, so without this the wash would flicker off while brushing
   * across dots. Dot-level DIMMING still follows hoverId alone (dot hover precedence). */
  const effectiveRegion: RadarRegion | null = hovered ? hovered.region : hoverRegion;
  /** Region membership by id for the rail's left-edge ticks (plotted rows only — a
   * beyond-board search hit has no dot, so no region and never a tick). */
  const regionById = useMemo(() => new Map<string, RadarRegion>(placed.map((d) => [d.id, d.region])), [placed]);
  /** Dot opacity under the hover channels + the strip zoom. DOT hover takes precedence
   * (existing tooltip behavior: only the hovered dot stays full); otherwise a hovered
   * region lifts its members and mutes everything outside; while the STRIP is the
   * zoomed region the quadrant dots recede (the strip has the emphasis — a quadrant
   * zoom simply hides non-members instead); no hover leaves everyone full. */
  const dotOpacity = (b: PlacedBlip): number => {
    if (hoverId !== null) return hoverId === b.id ? 1 : 0.35;
    if (hoverRegion !== null) return b.region === hoverRegion ? 1 : 0.35;
    if (zoom === "strip" && !b.strip) return 0.25;
    return 1;
  };
  // Selection resolves against the PLOTTED board first (dot highlight comes free), then
  // the full pool — a search hit beyond the board still opens its dossier. It survives
  // population toggles only while the niche is still in the pool.
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
   * rule as before: flip LEFT of the cursor past the horizontal midline (keeps the right
   * edge on the plate) and ABOVE it in the bottom band. No-ops when the tooltip isn't
   * mounted yet — the callback ref below re-applies as soon as it is. */
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

  // Everything below draws in the layout's OWN geometry (zoom-aware domains included) —
  // never the module-scope full-view defaults.
  const geom = layout.geom;
  const { plot, xd, yd } = geom;
  const plotX1 = geom.x1;
  const plotY1 = geom.y1;
  /** What actually renders: a quadrant zoom hides non-members (and the strip). */
  const visible = placed.filter((d) => !d.hidden);
  const anyClampMaxX = visible.some((d) => d.clampX === 1);
  const anyClampMinX = visible.some((d) => d.clampX === -1);
  const anyClampMaxY = visible.some((d) => d.clampY === 1);
  const anyClampMinY = visible.some((d) => d.clampY === -1);
  // The verdict bars' pixels — only meaningful where the bar is inside the active
  // domain (in a zoom the bar IS a domain edge, so it merges with the plot frame).
  const xBarPx = geom.xToPx(X_BAR);
  const yBarPx = geom.yToPx(Y_BAR);
  const xBarInside = X_BAR > xd[0] && X_BAR < xd[1];
  const yBarInside = Y_BAR > yd[0] && Y_BAR < yd[1];
  /** Ticks for the ACTIVE domains, density tuned to the rendered plot size. */
  const xTicks = axisTicks(xd[0], xd[1], Math.max(4, Math.round(plot.w / 110)));
  const yTicks = axisTicks(yd[0], yd[1], Math.max(3, Math.round(plot.h / 85)));
  /** The five region hit rects (spec: 4 transparent quadrant rects + the strip rect —
   * never per-dot math on mousemove). Bounds are the bar hairlines' own pixels, computed
   * once per render; the rects sit UNDER the dots, so every dot keeps its own hover/click
   * and moving onto a dot naturally hands precedence to it. Full view only — inside a
   * zoom the single-region view makes region hover moot (spec), and ONE background rect
   * takes their place as the click-to-exit surface. */
  const regionRects: { id: RadarRegion; x: number; y: number; w: number; h: number }[] =
    zoom !== null
      ? []
      : [
          { id: "shrinking-open", x: plot.l, y: plot.t, w: xBarPx - plot.l, h: yBarPx - plot.t },
          { id: "growing-open", x: xBarPx, y: plot.t, w: plotX1 - xBarPx, h: yBarPx - plot.t },
          { id: "shrinking-flooding", x: plot.l, y: yBarPx, w: xBarPx - plot.l, h: plotY1 - yBarPx },
          { id: "growing-flooding", x: xBarPx, y: yBarPx, w: plotX1 - xBarPx, h: plotY1 - yBarPx },
          ...(layout.stripCount > 0
            ? [{ id: "strip" as const, x: plot.l, y: layout.stripTop, w: plot.w, h: layout.stripH }]
            : []),
        ];
  const stripLabel = layout.stripHasNonEmerging
    ? "EMERGING / NO TREND BASE — not plottable · sized by 24m volume"
    : "EMERGING — no % base · sized by 24m volume";
  /** COMPACT decor for narrow plates (phones): labels keep their TRUE point size now
   * (1 viewBox unit = 1 px), so a 230px-wide plot can't fit the full wording — shorten
   * the labels and step the decor type down a notch instead of letting it collide. */
  const compact = plot.w < 420;

  return (
    <div className="flex flex-col gap-5 lg:flex-row lg:items-stretch">
      {/* The plate — UNCAPPED (2026-08-28 sizing directive): it takes every horizontal
          pixel the shared page container leaves beside the rail, and the viewBox is
          rebuilt from this wrapper's measured width (1 unit = 1 CSS px — labels and
          dots never scale with the box). The rail keeps its fixed 360/460px, so the
          plate alone absorbs the container's growth. */}
      <div ref={wrapRef} className="relative w-full lg:min-w-0 lg:flex-1">
        <svg
          viewBox={`0 0 ${geom.plateW} ${layout.vbH}`}
          className="block h-auto w-full"
          role="img"
          aria-label={`Radar board: niches plotted by 24-month demand trend (x) against release saturation YoY (y, calmer at the top); dot area is P90 revenue and dot color/style is the verdict${
            zoom !== null ? `; zoomed to the ${REGION_NAME[zoom]} region` : ""
          }`}
        >
          {/* Decor — frame, zero lines, THE THRESHOLD HAIRLINES, ticks, axis titles and
              quadrant labels. pointer-events none as a GROUP: only the dots may ever be
              CLICK targets (the region hit rects further down are hover-only), so a
              click landing on a hairline can never read as a dead dot. */}
          <g pointerEvents="none" data-testid="xy-decor">
            {/* Plot frame. */}
            <rect x={plot.l} y={plot.t} width={plot.w} height={plot.h} fill="none" stroke="var(--baseline)" strokeWidth={1} />

            {/* Washes. Zoomed quadrant: the whole plot IS the region, so it takes the
                region's own hover-wash tone (continuity with the hover language that
                led here). Otherwise THE FOCUS WASH — a very low-alpha tint over the
                GROWING · OPEN quadrant (demand past the enter bar, pipeline below the
                flood bar) with its own hairline, drawing the eye to the "choose from
                here" region without shouting. Reinforcement only: the quadrant is
                already defined by the two bars. */}
            {zoom !== null && zoom !== "strip" ? (
              <rect
                data-testid="xy-zoom-wash"
                x={plot.l}
                y={plot.t}
                width={plot.w}
                height={plot.h}
                fill={REGION_WASH[zoom]}
              />
            ) : (
              <rect
                data-testid="xy-focus-wash"
                x={xBarPx}
                y={plot.t}
                width={plotX1 - xBarPx}
                height={yBarPx - plot.t}
                fill="var(--verdict-enter-wash)"
                stroke="var(--verdict-enter-wash-line)"
                strokeWidth={1}
              />
            )}

            {/* Zero lines — fainter than the verdict bars (gridline vs baseline); only
                where zero is inside the active domain (a zoomed quadrant may not span it). */}
            {0 > xd[0] && 0 < xd[1] && (
              <line x1={geom.xToPx(0)} y1={plot.t} x2={geom.xToPx(0)} y2={plotY1} stroke="var(--gridline)" strokeWidth={1} />
            )}
            {0 > yd[0] && 0 < yd[1] && (
              <line x1={plot.l} y1={geom.yToPx(0)} x2={plotX1} y2={geom.yToPx(0)} stroke="var(--gridline)" strokeWidth={1} />
            )}

            {/* THE QUADRANT LINES = THE VERDICT'S OWN THRESHOLDS (lib/radarVerdict.ts):
                a dot right of the vertical bar passes the enter demand check; a dot
                BELOW the horizontal bar is in flood territory (supply veto) — calmer-up
                orientation. Inside a zoom a bar becomes the domain edge itself (the
                plot frame carries it; the edge tick names the value), so the hairline +
                label draw only while the bar cuts through the interior. */}
            {xBarInside && (
              <>
                <line
                  data-testid="xy-bar-demand"
                  x1={xBarPx}
                  y1={plot.t}
                  x2={xBarPx}
                  y2={plotY1}
                  stroke="var(--baseline)"
                  strokeWidth={1}
                  strokeDasharray="6 3"
                />
                <HaloText x={xBarPx + 4} y={plot.t + 11} anchor="start" size={compact ? 8 : 9.5} fill="var(--text-secondary)">
                  {compact ? `ENTER +${X_BAR}%` : `ENTER BAR +${X_BAR}% / 24M`}
                </HaloText>
              </>
            )}
            {yBarInside && (
              <>
                <line
                  data-testid="xy-bar-flood"
                  x1={plot.l}
                  y1={yBarPx}
                  x2={plotX1}
                  y2={yBarPx}
                  stroke="var(--baseline)"
                  strokeWidth={1}
                  strokeDasharray="6 3"
                />
                {/* Flooding lives BELOW the bar (calmer-up), so the bar's label sits on
                    the flooding side of its own line. */}
                <HaloText x={plot.l + 5} y={yBarPx + 12} anchor="start" size={compact ? 8 : 9.5} fill="var(--text-secondary)">
                  {compact ? `FLOOD +${Y_BAR}% — BELOW` : `FLOOD BAR +${Y_BAR}% YOY — FLOODING BELOW`}
                </HaloText>
              </>
            )}

            {/* Quadrant readings — region names only; the DOT STYLE carries the final
                verdict (a growing·open dot can still be Watch on a concentration veto).
                Calmer-up orientation: the TOP-RIGHT corner is the focus zone, and its
                label alone takes the enter hue. While a region is hovered its label
                BRIGHTENS (region-hover contract): the neutral corners step muted →
                primary, and the focus corner mixes its green toward primary — more
                contrast on both themes without abandoning the hue. While a QUADRANT is
                zoomed the four corner labels give way to ONE plot title naming the
                zoomed region (+ the exit affordances) — four corners would lie about a
                single-region view. */}
            {zoom !== null && zoom !== "strip" ? (
              <>
                <HaloText
                  x={plot.l + 8}
                  y={plot.t + 18}
                  anchor="start"
                  size={11}
                  fill={REGION_TONE[zoom]}
                >
                  {REGION_NAME[zoom]} — ZOOMED
                </HaloText>
                <HaloText x={plot.l + 8} y={plot.t + 33} anchor="start" size={8.5}>
                  ESC · BACKGROUND CLICK · OR THE RAIL CHIP ✕ EXITS
                </HaloText>
              </>
            ) : (
              <>
                <HaloText
                  x={plotX1 - 8}
                  y={plot.t + 26}
                  anchor="end"
                  size={compact ? 7.5 : 9}
                  fill={
                    effectiveRegion === "growing-open"
                      ? "color-mix(in srgb, var(--verdict-enter) 60%, var(--text-primary))"
                      : "var(--verdict-enter)"
                  }
                >
                  {compact ? "GROW · OPEN" : "GROWING · OPEN"}
                </HaloText>
                <HaloText
                  x={plotX1 - 8}
                  y={plotY1 - 10}
                  anchor="end"
                  size={compact ? 7.5 : 9}
                  fill={effectiveRegion === "growing-flooding" ? "var(--text-primary)" : "var(--text-muted)"}
                >
                  {compact ? "GROW · FLOOD" : "GROWING · FLOODING"}
                </HaloText>
                <HaloText
                  x={plot.l + 8}
                  y={plotY1 - 10}
                  anchor="start"
                  size={compact ? 7.5 : 9}
                  fill={effectiveRegion === "shrinking-flooding" ? "var(--text-primary)" : "var(--text-muted)"}
                >
                  {compact ? "SHRINK · FLOOD" : "SHRINKING · FLOODING"}
                </HaloText>
                <HaloText
                  x={plot.l + 8}
                  y={plot.t + 26}
                  anchor="start"
                  size={compact ? 7.5 : 9}
                  fill={effectiveRegion === "shrinking-open" ? "var(--text-primary)" : "var(--text-muted)"}
                >
                  {compact ? "FLAT · OPEN" : "FLAT/SHRINKING · OPEN"}
                </HaloText>
              </>
            )}

            {/* X ticks + labels — computed for the ACTIVE domain (density follows the
                plot width; a zoom re-domains and re-ticks). Edge labels grow a ≥ / ≤
                prefix when something clamps there — the scale is telling you it ends
                before the data does. */}
            {xTicks.map((t) => (
              <g key={`xt${t}`}>
                <line x1={geom.xToPx(t)} y1={plotY1} x2={geom.xToPx(t)} y2={plotY1 + 4} stroke="var(--baseline)" strokeWidth={1} />
                <text
                  x={geom.xToPx(t)}
                  y={plotY1 + 16}
                  textAnchor="middle"
                  className="tabular"
                  style={{ fontSize: compact ? 10 : 11, fill: "var(--text-muted)" }}
                >
                  {t === xd[1] && anyClampMaxX
                    ? `≥ +${t}`
                    : t === xd[0] && anyClampMinX
                      ? `≤ ${t}`
                      : t > 0
                        ? `+${t}`
                        : `${t}`}
                </text>
              </g>
            ))}
            {/* Y ticks + labels. */}
            {yTicks.map((t) => (
              <g key={`yt${t}`}>
                <line x1={plot.l - 4} y1={geom.yToPx(t)} x2={plot.l} y2={geom.yToPx(t)} stroke="var(--baseline)" strokeWidth={1} />
                <text
                  x={plot.l - 7}
                  y={geom.yToPx(t) + 3.5}
                  textAnchor="end"
                  className="tabular"
                  style={{ fontSize: compact ? 10 : 11, fill: "var(--text-muted)" }}
                >
                  {t === yd[1] && anyClampMaxY
                    ? `≥ +${t}`
                    : t === yd[0] && anyClampMinY
                      ? `≤ ${t}`
                      : t > 0
                        ? `+${t}`
                        : `${t}`}
                </text>
              </g>
            ))}

            {/* Axis titles, units spelled out — the Y title makes the flipped direction
                unmistakable (values descend upward; calm is up). */}
            <HaloText x={plot.l + plot.w / 2} y={plotY1 + 32} anchor="middle" size={compact ? 8.5 : 10}>
              {compact ? "DEMAND TREND · % / 24M" : "DEMAND TREND · % / 24M (LAST 24 VS PRIOR 24)"}
            </HaloText>
            <HaloText
              x={0}
              y={0}
              anchor="middle"
              size={compact ? 8.5 : 10}
              transform={`translate(12 ${plot.t + plot.h / 2}) rotate(-90)`}
            >
              {compact ? "RELEASES YOY · % — CALM ↑" : "RELEASES YOY · % — CALMER ↑ · FLOODING ↓"}
            </HaloText>

            {/* The no-XY strip frame + label (only when it has residents — a quadrant
                zoom hides it entirely). The strip is the fifth hover/zoom region: while
                hovered OR while it is the zoomed region, its dashed frame and label lean
                the emerging violet — the same lift contract as a quadrant's corner
                label, held steady for the zoom's enlarged presentation. */}
            {layout.stripCount > 0 && (
              <>
                <rect
                  data-testid="xy-strip"
                  x={plot.l}
                  y={layout.stripTop}
                  width={plot.w}
                  height={layout.stripH}
                  fill="none"
                  stroke={
                    effectiveRegion === "strip" || zoom === "strip"
                      ? "color-mix(in srgb, var(--verdict-emerging) 45%, transparent)"
                      : "var(--gridline)"
                  }
                  strokeWidth={1}
                  strokeDasharray="4 3"
                />
                <HaloText
                  x={plot.l + (zoom === "strip" ? STRIP_SIZES.zoom.pad : STRIP_SIZES.rest.pad)}
                  y={layout.stripTop + (zoom === "strip" ? 15 : 12)}
                  anchor="start"
                  size={zoom === "strip" ? 10 : 8.5}
                  fill={
                    effectiveRegion === "strip" || zoom === "strip" ? "var(--text-primary)" : "var(--text-muted)"
                  }
                >
                  {zoom === "strip" ? `${stripLabel} — RAIL FILTERED` : stripLabel}
                </HaloText>
              </>
            )}
          </g>

          {/* REGION HIT RECTS — the quadrant/strip hit-testing (module doc, REGION
              HOVER). Transparent fills (not "none": transparent still hit-tests) that
              take the region's wash while it is lit; drawn OVER the decor so the wash
              covers the whole region, UNDER the dots so every dot keeps its own hover
              and click (dot-click precedence: a dot click opens its dossier, never
              zooms). A click on a region's EMPTY area ZOOMS into it (2026-08-28
              directive) — still never a dossier, so empty-plate clicks keep reading as
              background where it matters. While zoomed the five rects give way to ONE
              full-viewBox background rect whose click exits the zoom (region hover is
              moot in a single-region view). */}
          {zoom === null ? (
            <g data-testid="xy-regions">
              {regionRects.map((r) => (
                <rect
                  key={r.id}
                  data-testid={`radar-region-${r.id}`}
                  x={r.x}
                  y={r.y}
                  width={r.w}
                  height={r.h}
                  fill={effectiveRegion === r.id ? REGION_WASH[r.id] : "transparent"}
                  style={{ transition: "fill 120ms", cursor: "zoom-in" }}
                  onMouseEnter={() => setHoverRegion(r.id)}
                  onMouseLeave={() => setHoverRegion(null)}
                  onClick={() => {
                    setHoverRegion(null);
                    setZoom(r.id);
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

          {/* Dots — plot + strip; the rail carries the accessible buttons. Solo lens as
              dot STYLE: team-scale (singleplayer share < SOLO_FRIENDLY_MIN) draws hollow —
              ring-colored stroke over a `transparent` fill (transparent, not "none", so
              the interior still hit-tests); solo-friendly and unknown draw filled. The
              VERDICT is the fill vocabulary; a caution verdict adds a dotted ring;
              emerging keeps its dashed halo (in the strip). */}
          <g aria-hidden>
            {visible.map((b) => (
              <g key={b.id}>
                {b.demandEmerging ? (
                  <circle
                    cx={b.x}
                    cy={b.y}
                    r={b.r + 3}
                    fill="none"
                    stroke={RING_FILL[b.verdict.ring]}
                    strokeWidth={1}
                    strokeDasharray="2.5 2.5"
                    opacity={dotOpacity(b)}
                    pointerEvents="none"
                  />
                ) : (
                  b.verdict.caution && (
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
                  )
                )}
                <circle
                  data-testid={`radar-blip-${b.id}`}
                  cx={b.x}
                  cy={b.y}
                  r={b.r}
                  fill={soloBucket(b.solo_viability) === "team" ? "transparent" : RING_FILL[b.verdict.ring]}
                  stroke={soloBucket(b.solo_viability) === "team" ? RING_FILL[b.verdict.ring] : "var(--page-plane)"}
                  strokeWidth={soloBucket(b.solo_viability) === "team" ? 1.5 : 1}
                  opacity={dotOpacity(b)}
                  // cx/cy/r ride a short CSS transition so entering/leaving a zoom
                  // glides instead of snapping (SVG geometry properties are CSS-
                  // transitionable in every current engine; where not, it just snaps —
                  // correctness never depends on it).
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
                  // A dot click opens the VERDICT DOSSIER in the rail (the analysis is
                  // the board's first answer); navigation to the detail page lives on
                  // the dossier's own deep-dive link.
                  onClick={() => onSelect(b.id)}
                />
                <ClampChevron d={b} />
                {/* Region-member emphasis: while a region is hovered (and no dot is —
                    dot hover keeps its stronger single-dot ring below), every member
                    dot takes a slight ring on top of its full opacity. Deliberately
                    fainter than the hover/selection ring (thinner, secondary ink). */}
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
                    r={b.r + (b.demandEmerging ? 5 : 2.5)}
                    fill="none"
                    stroke="var(--text-primary)"
                    strokeWidth={1}
                    pointerEvents="none"
                  />
                )}
              </g>
            ))}
          </g>
        </svg>

        {/* Dot-style legend. Under the default solo-only population the hollow/filled lens
            encoding is redundant (every dot is solo-friendly by construction), so the
            legend states the POPULATION RULE instead of drawing lens samples — the UI must
            never imply team-scale niches might be hiding on the board. The metric is named
            honestly: solo_viability IS the niche's singleplayer share (a no-netcode proxy,
            not a production-scope measure — the dossier's solo row carries the member
            evidence). The sample circles are plain aria-hidden glyphs, never click targets. */}
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
          <span className="inline-flex items-center gap-1.5">
            <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden className="pointer-events-none shrink-0">
              <circle cx="6" cy="6" r="2.5" fill="currentColor" />
              <circle cx="6" cy="6" r="5" fill="none" stroke="currentColor" strokeWidth="1" strokeDasharray="2 2" />
            </svg>
            emerging (no comparable % base)
          </span>
          {/* The verdict hue key (2026-08-27 color amendment) — every hue is doubled by
              a word right here, so the mapping survives grayscale and any CVD. */}
          <span data-testid="verdict-color-key" className="inline-flex flex-wrap items-center gap-x-3 gap-y-1">
            {RING_ORDER.map((ring) => (
              <span key={ring} className="inline-flex items-center gap-1.5">
                <span className="inline-block h-2 w-2 shrink-0" style={{ backgroundColor: RING_FILL[ring] }} aria-hidden />
                {RING_LABEL[ring]}
              </span>
            ))}
          </span>
          <span>
            dot area = P90 revenue · color = verdict (position is evidence, color is the call — reinforcement, never
            the only channel) · calm is UP: the washed top-right quadrant is the focus zone · chevron at an edge =
            beyond the axis scale, true % in the tooltip · click a quadrant&rsquo;s empty space to zoom into it and
            filter the rail (Esc, the rail chip&rsquo;s ✕, or a background click exits)
          </span>
        </div>

        {/* Hover tooltip — HTML over the SVG, same TooltipPanel language as every chart.
            Clamped to the plate: it flips to the LEFT of the cursor past the horizontal
            midline (keeps the right edge) and flips ABOVE the cursor in the bottom band
            (the plate's rendered height scales with its width via the viewBox). */}
        {hovered && tipShown && (
          <div
            // left/top/transform are deliberately NOT React-managed props: positionTip
            // writes them imperatively so a mousemove costs a style write, not a render.
            // The callback ref applies the recorded position the instant the element
            // mounts (and on every re-render, since the inline ref re-runs), so there is
            // no frame where the panel sits un-positioned at the plate's origin.
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
                // An emerging niche never shows its trend % — a young tag's base is near
                // zero by construction, so the honest numbers are the label's youth and
                // its absolute volume.
                ...(hovered.demandEmerging
                  ? [
                      { label: "Demand 24m", value: "emerging — no comparable % base" },
                      {
                        label: "Reviews 24m",
                        value: hovered.reviews24m != null ? fmtInt(hovered.reviews24m) : "—",
                      },
                    ]
                  : [
                      {
                        label: "Demand 24m",
                        value: `${fmtTrendPct(hovered.demandTrendPct)}${hovered.clampX !== 0 ? " · beyond scale" : ""}`,
                      },
                    ]),
                {
                  label: "Releases YoY",
                  value:
                    hovered.saturationYoy != null
                      ? `${fmtSigned(hovered.saturationYoy, 0)}${hovered.clampY !== 0 ? " · beyond scale" : ""}`
                      : "unknown",
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
          full-pool niche search, or (at ≥lg, side-by-side) the selected niche's dossier.
          From lg up it matches the plate's height and scrolls inside itself
          (absolute-inset column — full counts in the group headers, so nothing is
          silently capped); below lg it flows with the page, uncapped, and the dossier
          renders as the slide-over DRAWER instead. Widths: 360px at lg, 460px at xl —
          the plate shrinks first; the dossier's value+bar rows fit one line at both. */}
      <div className="flex min-w-0 flex-col border-t border-chartborder pt-4 lg:w-[360px] lg:shrink-0 lg:border-l lg:border-t-0 lg:pl-4 lg:pt-0 xl:w-[460px] xl:pl-5">
        {selected && isDesktop ? (
          <VerdictDossier blip={selected} plotCap={plotCap} total={zoomMembers.length} onBack={() => onSelect(null)} />
        ) : (
          <>
            {/* THE ZOOM-FILTER CHIP — while a region is zoomed the rail reads that
                region only, and this chip says so at the top with the honest member
                count. The whole chip is the clear button (✕ affordance on the right) —
                the third exit path beside Esc and the plot-background click. */}
            {zoom !== null && (
              <button
                type="button"
                data-testid="radar-zoom-chip"
                onClick={() => setZoom(null)}
                aria-label={`Clear region filter: ${REGION_NAME[zoom]}`}
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
            {/* The niche search — scope is the FULL pool across all classes (stated
                right in the placeholder so nobody has to guess it only reaches the
                plotted class), EXCEPT while zoomed: search composes with the zoom
                filter, reading within the region's members only — and says so. */}
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
                  ? `Search the ${zoomMembers.length} niches in the zoomed ${REGION_NAME[zoom]} region`
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
                  // While searching OR zoom-filtered, a ring with no matches is noise —
                  // drop the whole group (the chip/header already carry the honest
                  // totals; the unfiltered list keeps its explicit "None in this cut.").
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
                            // Region-hover rail tick (a reading aid, never a reorder/
                            // filter): while a region is lit, the rows whose DOTS live in
                            // it take a 2px left-edge tick in the region tone. box-shadow,
                            // not border — zero layout shift, pure paint. Beyond-board
                            // search hits have no dot, so no region and never a tick.
                            const rowRegion = regionById.get(b.id);
                            const ticked = effectiveRegion !== null && rowRegion === effectiveRegion;
                            return (
                            <button
                              type="button"
                              key={b.id}
                              data-testid={`radar-row-${b.id}`}
                              data-region-tick={ticked ? effectiveRegion : undefined}
                              onClick={() => onSelect(b.id)}
                              onMouseEnter={() => setHoverId(b.id)}
                              onMouseLeave={clearHover}
                              title={`${b.key} — ${RING_LABEL[b.verdict.ring]}: ${b.verdict.reason}${
                                b.n == null ? ` (beyond the Top ${plotCap} plot — no dot on the board)` : ""
                              }`}
                              style={ticked ? { boxShadow: `inset 2px 0 0 ${REGION_TONE[effectiveRegion!]}` } : undefined}
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
                  without this fade a clipped rail reads as the list just ENDING — the
                  exact silent cap this layout exists to remove. Paired with .rail-scroll's
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

      {/* Below lg the dossier is a slide-over drawer — a selection must never strand it
          below the board (see DossierDrawer). Same close channel as the rail's back
          button: onSelect(null). */}
      {selected && !isDesktop && (
        <DossierDrawer blip={selected} plotCap={plotCap} total={zoomMembers.length} onClose={() => onSelect(null)} />
      )}
    </div>
  );
}

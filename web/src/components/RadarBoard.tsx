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
import { nicheDetailPath } from "../pages/NicheDetail";

/**
 * RadarBoard — the XY QUADRANT plate (2026-08-27, user directive: "score them accordingly
 * to our current criterias and make more like XY axis graph with 4 different parameters").
 * The polar ring board this replaces encoded the verdict as an annulus; this board draws
 * the verdict's own INPUTS as the axes, so a dot's position IS its evidence:
 *
 *   X — demand_trend_24m_pct (% per 24 months: review inflow, last 24 complete months vs
 *       the prior 24). The decisive demand check.
 *   Y — saturation_yoy (% releases YoY). The decisive supply/overcrowding check.
 *   dot AREA — P90 revenue (sqrt scale, like every bubble on this site).
 *   dot STYLE — the final VERDICT (radarVerdict — mono-steel fills, brightest = enter,
 *       receding paper alphas; NEVER red/green). Style is the 4th channel deliberately:
 *       a dot can sit in the enter quadrant and still be Watch (the concentration /
 *       winner-take-most veto fires on evidence the axes don't draw), so position alone
 *       must never be read as the recommendation — the fill carries the final word and
 *       the dossier the full trace. opportunity_v2 stays in tooltip + dossier: a fifth
 *       visual channel on a mono-steel board would fight the verdict styling.
 *
 * THE QUADRANT GEOMETRY IS THE VERDICT'S OWN THRESHOLDS: the vertical hairline sits at
 * X = +40%/24m (DEMAND_ENTER_PCT — the enter bar) and the horizontal at Y = +15% YoY
 * (SAT_FLOOD_YOY — the flood bar); zero lines draw fainter. So the "GROWING · OPEN"
 * quadrant is literally the region where the demand check passes and the supply veto
 * does not fire — the same booleans the dossier spells out.
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
 * threshold hairlines and labels sit in a pointer-events:none group. Keyboard access:
 * the SVG dots are mouse conveniences (aria-hidden); every niche's keyboard route is its
 * rail row (a real button), and navigation lives on the dossier's deep-dive link.
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

const VB_W = 640;
/** Plot rectangle inside the viewBox; margins host the tick labels and axis titles. */
export const PLOT = { l: 46, t: 20, w: 578, h: 380 } as const;
const PLOT_X1 = PLOT.l + PLOT.w;
const PLOT_Y1 = PLOT.t + PLOT.h;
const AXIS_H = 36; // bottom margin: tick labels + axis title
const BASE_H = PLOT_Y1 + AXIS_H;

const X_TICKS = [-100, 0, 100, 200, 300];
const Y_TICKS = [-60, 0, 60, 120];

// The no-XY strip (emerging / no-trend rows) under the axis.
const STRIP_GAP = 8;
const STRIP_LABEL_H = 18;
const STRIP_ROW_H = 20;
const STRIP_PAD = 10;
const STRIP_DOT_R_MIN = 2.5;
const STRIP_DOT_R_MAX = 7;

/** Domain % -> px, unclamped (clamping is layoutXY's job, so it can flag it). */
export function xToPx(v: number): number {
  return PLOT.l + ((v - X_DOMAIN[0]) / (X_DOMAIN[1] - X_DOMAIN[0])) * PLOT.w;
}
/** Domain % YoY -> px; +Y up (flooding at the top). */
export function yToPx(v: number): number {
  return PLOT.t + ((Y_DOMAIN[1] - v) / (Y_DOMAIN[1] - Y_DOMAIN[0])) * PLOT.h;
}

export interface PlacedBlip extends RadarBoardBlip {
  id: string;
  /** 1-based rail number (ring-verdict order, then opportunity desc). */
  n: number;
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
}

const clampNum = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

/**
 * Deterministic XY placement. Pure function of the blips (hash01 jitter only), exported
 * for tests: same input, same output — a niche holds its position across renders, visits
 * and machines.
 */
export function layoutXY(blips: RadarBoardBlip[]): XYLayout {
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
      // Strip coords are assigned in the packing pass below.
      return { ...blip, id, n: i + 1, x: 0, y: 0, r: STRIP_DOT_R_MIN, clampX: 0, clampY: 0, strip: true };
    }
    const xv = blip.demandTrendPct as number;
    const yv = (blip.saturationYoy as number) * 100;
    const clampX = xv > X_DOMAIN[1] ? 1 : xv < X_DOMAIN[0] ? -1 : 0;
    const clampY = yv > Y_DOMAIN[1] ? 1 : yv < Y_DOMAIN[0] ? -1 : 0;
    const r = blipRadius(blip.p90_rev, maxP90);
    // Pinned dots sit ON their edge (touching it from inside); honest dots inset by r so
    // the circle never spills out of the frame.
    const x =
      clampX === 1 ? PLOT_X1 - r - 1 : clampX === -1 ? PLOT.l + r + 1 : clampNum(xToPx(xv), PLOT.l + r, PLOT_X1 - r);
    const y =
      clampY === 1 ? PLOT.t + r + 1 : clampY === -1 ? PLOT_Y1 - r - 1 : clampNum(yToPx(yv), PLOT.t + r, PLOT_Y1 - r);
    return { ...blip, id, n: i + 1, x, y, r, clampX, clampY, strip: false };
  });

  // Coincident-dot jitter: only when centers land in the same ~2px cell, offset by a
  // hash-derived angle (deterministic), growing with the pile index — and NEVER along a
  // pinned axis (a clamp edge is a claim; jitter must not soften it).
  const seen = new Map<string, number>();
  for (const d of dots) {
    if (d.strip) continue;
    const cell = `${Math.round(d.x / 2)}|${Math.round(d.y / 2)}`;
    const k = seen.get(cell) ?? 0;
    seen.set(cell, k + 1);
    if (k === 0) continue;
    const ang = hash01(`${d.id}|jitter`) * 2 * Math.PI;
    const dist = 3 + 2.5 * k;
    if (d.clampX === 0) d.x = clampNum(d.x + Math.cos(ang) * dist, PLOT.l + d.r, PLOT_X1 - d.r);
    if (d.clampY === 0) d.y = clampNum(d.y + Math.sin(ang) * dist, PLOT.t + d.r, PLOT_Y1 - d.r);
  }

  // Strip packing: volume desc (the strip's own honest ranking), left-to-right rows.
  const stripDots = dots.filter((d) => d.strip);
  stripDots.sort((a, b) => (b.reviews24m ?? -1) - (a.reviews24m ?? -1) || a.key.localeCompare(b.key));
  const maxVol = stripDots.reduce<number>((m, d) => Math.max(m, d.reviews24m ?? 0), 0);
  const stripTop = BASE_H + STRIP_GAP;
  let cursor = PLOT.l + STRIP_PAD;
  let row = 0;
  for (const d of stripDots) {
    d.r =
      maxVol > 0 && d.reviews24m != null
        ? STRIP_DOT_R_MIN + Math.sqrt(d.reviews24m / maxVol) * (STRIP_DOT_R_MAX - STRIP_DOT_R_MIN)
        : STRIP_DOT_R_MIN;
    if (cursor + 2 * d.r > PLOT_X1 - STRIP_PAD) {
      row += 1;
      cursor = PLOT.l + STRIP_PAD;
    }
    d.x = cursor + d.r;
    d.y = stripTop + STRIP_LABEL_H + STRIP_ROW_H / 2 + row * STRIP_ROW_H;
    cursor += 2 * d.r + 10;
  }
  const stripH = stripDots.length > 0 ? STRIP_LABEL_H + (row + 1) * STRIP_ROW_H + STRIP_PAD : 0;

  return {
    dots,
    stripCount: stripDots.length,
    stripHasNonEmerging: stripDots.some((d) => !d.demandEmerging),
    stripTop,
    stripH,
    vbH: stripDots.length > 0 ? stripTop + stripH + 2 : BASE_H,
  };
}

// ---- rendering --------------------------------------------------------------------------

/** Mono-steel verdict vocabulary (4th visual channel): the strongest verdict carries the
 * accent, the rest recede in paper alphas. Never red/green; the fill + the rail carry the
 * meaning — POSITION only ever claims what the axes measured. */
const RING_FILL: Record<RadarRing, string> = {
  enter: "var(--verdict-up)",
  watch: MONO.paper75,
  emerging: MONO.paper65,
  crowded: MONO.paper50,
  declining: MONO.paper35,
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

/** Pass/fail glyph in the app's neutral steel vocabulary — NEVER red/green (Industry
 * constraint): pass = filled steel tile, fail = hollow outlined tile, unknown = muted
 * dash. The row also carries an sr-only outcome word, so the glyph is never the only
 * channel. */
function CheckGlyph({ pass }: { pass: boolean | null }) {
  const style =
    pass === true
      ? { backgroundColor: "var(--text-primary)", color: "var(--page-plane)", border: "1px solid var(--text-primary)" }
      : pass === false
        ? { color: "var(--text-primary)", border: "1px solid var(--baseline)" }
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
 * pointer-events none (the dot under it is the click target). */
function ClampChevron({ d }: { d: PlacedBlip }) {
  const marks: string[] = [];
  if (d.clampX === 1) marks.push(`M ${d.x + d.r + 2} ${d.y - 3.5} L ${d.x + d.r + 5.5} ${d.y} L ${d.x + d.r + 2} ${d.y + 3.5}`);
  if (d.clampX === -1) marks.push(`M ${d.x - d.r - 2} ${d.y - 3.5} L ${d.x - d.r - 5.5} ${d.y} L ${d.x - d.r - 2} ${d.y + 3.5}`);
  if (d.clampY === 1) marks.push(`M ${d.x - 3.5} ${d.y - d.r - 2} L ${d.x} ${d.y - d.r - 5.5} L ${d.x + 3.5} ${d.y - d.r - 2}`);
  if (d.clampY === -1) marks.push(`M ${d.x - 3.5} ${d.y + d.r + 2} L ${d.x} ${d.y + d.r + 5.5} L ${d.x + 3.5} ${d.y + d.r + 2}`);
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
  const [tip, setTip] = useState<{ x: number; y: number } | null>(null);
  // The rail's niche search. Local state deliberately: the query is a reading aid for
  // the list (like hover), not page state a card elsewhere needs to drive.
  const [query, setQuery] = useState("");
  // Keyboard cursor over the filtered rows (↑/↓ + Enter); reset whenever the query text
  // changes so the cursor can never point past a shrunken result set.
  const [activeIdx, setActiveIdx] = useState(0);
  // Side-by-side (≥lg): dossier in the rail pane. Stacked (<lg): dossier as the drawer.
  const isDesktop = useIsDesktop();

  const layout = useMemo(() => layoutXY(blips), [blips]);
  const placed = layout.dots;
  const q = query.trim().toLowerCase();

  /** The rail's row source. No query: the plotted list, rank order (the board's own
   * reading). With a query: a live case-insensitive substring filter over the FULL pool —
   * plotted rows keep their rank, beyond-board rows carry n: null. */
  const railEntries = useMemo<RailBlip[]>(() => {
    if (!q) return placed;
    const plottedById = new Map<string, PlacedBlip>(placed.map((p) => [p.id, p]));
    const rows: RailBlip[] = [];
    for (const b of pool) {
      if (!b.key.toLowerCase().includes(q)) continue;
      const id = `${b.dimension}:${b.key}`;
      rows.push(plottedById.get(id) ?? { ...b, id, n: null });
    }
    return rows;
  }, [q, placed, pool]);

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

  const moveTip = (e: React.MouseEvent) => {
    const rect = wrapRef.current?.getBoundingClientRect();
    if (rect) setTip({ x: e.clientX - rect.left, y: e.clientY - rect.top });
  };
  const clearHover = () => {
    setHoverId(null);
    setTip(null);
  };

  if (blips.length === 0) {
    return (
      <div className="py-10 text-center text-sm text-ink-muted">
        {soloOnly ? "No solo-friendly niches match this cut." : "No niches match this cut."}
      </div>
    );
  }

  const anyClampMaxX = placed.some((d) => d.clampX === 1);
  const anyClampMinX = placed.some((d) => d.clampX === -1);
  const anyClampMaxY = placed.some((d) => d.clampY === 1);
  const anyClampMinY = placed.some((d) => d.clampY === -1);
  const xBarPx = xToPx(X_BAR);
  const yBarPx = yToPx(Y_BAR);
  const stripLabel = layout.stripHasNonEmerging
    ? "EMERGING / NO TREND BASE — not plottable · sized by 24m volume"
    : "EMERGING — no % base · sized by 24m volume";
  /** The plate's rendered height in CSS px (viewBox scales with width) — the tooltip's
   * bottom-flip band needs it, and the plate is no longer square. */
  const plateHPx = ((wrapRef.current?.clientWidth ?? VB_W) * layout.vbH) / VB_W;

  return (
    <div className="flex flex-col gap-5 lg:flex-row lg:items-stretch">
      {/* The plate. max-w: 640 from lg (the widened rail eats the difference first — at
          1024 the plate settles near 500px; 640 = the viewBox width, so it never
          upscales). */}
      <div ref={wrapRef} className="relative mx-auto w-full max-w-[600px] lg:mx-0 lg:min-w-0 lg:max-w-[640px] lg:flex-1">
        <svg
          viewBox={`0 0 ${VB_W} ${layout.vbH}`}
          className="block h-auto w-full"
          role="img"
          aria-label="Radar board: niches plotted by 24-month demand trend (x) against release saturation YoY (y); dot area is P90 revenue and dot style is the verdict"
        >
          {/* Decor — frame, zero lines, THE THRESHOLD HAIRLINES, ticks, axis titles and
              quadrant labels. pointer-events none as a GROUP: only the dots may ever be
              click targets, so a click landing on a hairline can never read as a dead
              dot. */}
          <g pointerEvents="none" data-testid="xy-decor">
            {/* Plot frame. */}
            <rect x={PLOT.l} y={PLOT.t} width={PLOT.w} height={PLOT.h} fill="none" stroke="var(--baseline)" strokeWidth={1} />

            {/* Zero lines — fainter than the verdict bars (gridline vs baseline). */}
            <line x1={xToPx(0)} y1={PLOT.t} x2={xToPx(0)} y2={PLOT_Y1} stroke="var(--gridline)" strokeWidth={1} />
            <line x1={PLOT.l} y1={yToPx(0)} x2={PLOT_X1} y2={yToPx(0)} stroke="var(--gridline)" strokeWidth={1} />

            {/* THE QUADRANT LINES = THE VERDICT'S OWN THRESHOLDS (lib/radarVerdict.ts):
                a dot right of the vertical bar passes the enter demand check; a dot
                above the horizontal bar is in flood territory (supply veto). */}
            <line
              data-testid="xy-bar-demand"
              x1={xBarPx}
              y1={PLOT.t}
              x2={xBarPx}
              y2={PLOT_Y1}
              stroke="var(--baseline)"
              strokeWidth={1}
              strokeDasharray="6 3"
            />
            <line
              data-testid="xy-bar-flood"
              x1={PLOT.l}
              y1={yBarPx}
              x2={PLOT_X1}
              y2={yBarPx}
              stroke="var(--baseline)"
              strokeWidth={1}
              strokeDasharray="6 3"
            />
            <HaloText x={xBarPx + 4} y={PLOT.t + 11} anchor="start" size={8.5} fill="var(--text-secondary)">
              ENTER BAR +{X_BAR}% / 24M
            </HaloText>
            <HaloText x={PLOT.l + 5} y={yBarPx - 5} anchor="start" size={8.5} fill="var(--text-secondary)">
              FLOOD BAR +{Y_BAR}% YOY
            </HaloText>

            {/* Quadrant readings — region names only; the DOT STYLE carries the final
                verdict (a growing·open dot can still be Watch on a concentration veto). */}
            <HaloText x={PLOT_X1 - 8} y={PLOT_Y1 - 10} anchor="end">
              GROWING · OPEN
            </HaloText>
            <HaloText x={PLOT_X1 - 8} y={PLOT.t + 26} anchor="end">
              GROWING · FLOODING
            </HaloText>
            <HaloText x={PLOT.l + 8} y={PLOT.t + 26} anchor="start">
              SHRINKING · FLOODING
            </HaloText>
            <HaloText x={PLOT.l + 8} y={PLOT_Y1 - 10} anchor="start">
              FLAT/SHRINKING · OPEN
            </HaloText>

            {/* X ticks + labels. Edge labels grow a ≥ / ≤ prefix when something clamps
                there — the scale is telling you it ends before the data does. */}
            {X_TICKS.map((t) => (
              <g key={`xt${t}`}>
                <line x1={xToPx(t)} y1={PLOT_Y1} x2={xToPx(t)} y2={PLOT_Y1 + 4} stroke="var(--baseline)" strokeWidth={1} />
                <text
                  x={xToPx(t)}
                  y={PLOT_Y1 + 15}
                  textAnchor="middle"
                  className="tabular"
                  style={{ fontSize: 10, fill: "var(--text-muted)" }}
                >
                  {t === X_DOMAIN[1] && anyClampMaxX
                    ? `≥ +${t}`
                    : t === X_DOMAIN[0] && anyClampMinX
                      ? `≤ ${t}`
                      : t > 0
                        ? `+${t}`
                        : `${t}`}
                </text>
              </g>
            ))}
            {/* Y ticks + labels. */}
            {Y_TICKS.map((t) => (
              <g key={`yt${t}`}>
                <line x1={PLOT.l - 4} y1={yToPx(t)} x2={PLOT.l} y2={yToPx(t)} stroke="var(--baseline)" strokeWidth={1} />
                <text
                  x={PLOT.l - 7}
                  y={yToPx(t) + 3}
                  textAnchor="end"
                  className="tabular"
                  style={{ fontSize: 10, fill: "var(--text-muted)" }}
                >
                  {t === Y_DOMAIN[1] && anyClampMaxY
                    ? `≥ +${t}`
                    : t === Y_DOMAIN[0] && anyClampMinY
                      ? `≤ ${t}`
                      : t > 0
                        ? `+${t}`
                        : `${t}`}
                </text>
              </g>
            ))}

            {/* Axis titles, units spelled out. */}
            <HaloText x={PLOT.l + PLOT.w / 2} y={PLOT_Y1 + 30} anchor="middle">
              DEMAND TREND · % / 24M (LAST 24 VS PRIOR 24)
            </HaloText>
            <HaloText x={0} y={0} anchor="middle" transform={`translate(12 ${PLOT.t + PLOT.h / 2}) rotate(-90)`}>
              RELEASES YOY · % (SATURATION)
            </HaloText>

            {/* The no-XY strip frame + label (only when it has residents). */}
            {layout.stripCount > 0 && (
              <>
                <rect
                  data-testid="xy-strip"
                  x={PLOT.l}
                  y={layout.stripTop}
                  width={PLOT.w}
                  height={layout.stripH}
                  fill="none"
                  stroke="var(--gridline)"
                  strokeWidth={1}
                  strokeDasharray="4 3"
                />
                <HaloText x={PLOT.l + STRIP_PAD} y={layout.stripTop + 12} anchor="start" size={8.5}>
                  {stripLabel}
                </HaloText>
              </>
            )}
          </g>

          {/* Dots — plot + strip; the rail carries the accessible buttons. Solo lens as
              dot STYLE: team-scale (singleplayer share < SOLO_FRIENDLY_MIN) draws hollow —
              ring-colored stroke over a `transparent` fill (transparent, not "none", so
              the interior still hit-tests); solo-friendly and unknown draw filled. The
              VERDICT is the fill vocabulary; a caution verdict adds a dotted ring;
              emerging keeps its dashed halo (in the strip). */}
          <g aria-hidden>
            {placed.map((b) => (
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
                    opacity={hoverId !== null && hoverId !== b.id ? 0.35 : 1}
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
                      opacity={hoverId !== null && hoverId !== b.id ? 0.35 : 1}
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
                  opacity={hoverId !== null && hoverId !== b.id ? 0.35 : 1}
                  style={{ cursor: "pointer", transition: "opacity 120ms" }}
                  onMouseEnter={(e) => {
                    setHoverId(b.id);
                    moveTip(e);
                  }}
                  onMouseMove={moveTip}
                  onMouseLeave={clearHover}
                  // A dot click opens the VERDICT DOSSIER in the rail (the analysis is
                  // the board's first answer); navigation to the detail page lives on
                  // the dossier's own deep-dive link.
                  onClick={() => onSelect(b.id)}
                />
                <ClampChevron d={b} />
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
          <span>
            dot area = P90 revenue · fill = verdict (position is evidence, fill is the call) · chevron at an edge =
            beyond the axis scale, true % in the tooltip
          </span>
        </div>

        {/* Hover tooltip — HTML over the SVG, same TooltipPanel language as every chart.
            Clamped to the plate: it flips to the LEFT of the cursor past the horizontal
            midline (keeps the right edge) and flips ABOVE the cursor in the bottom band
            (the plate's rendered height scales with its width via the viewBox). */}
        {hovered && tip && (
          <div
            className="pointer-events-none absolute z-10"
            style={{
              left: tip.x,
              top: tip.y,
              transform: `translate(${tip.x > (wrapRef.current?.clientWidth ?? VB_W) / 2 ? "calc(-100% - 12px)" : "12px"}, ${
                tip.y > plateHPx - 180 ? "calc(-100% - 12px)" : "12px"
              })`,
            }}
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
          <VerdictDossier blip={selected} plotCap={plotCap} total={placed.length} onBack={() => onSelect(null)} />
        ) : (
          <>
            {/* The niche search — scope is the FULL pool across all classes, stated
                right in the placeholder so nobody has to guess it only reaches the
                plotted class. */}
            <input
              type="text"
              data-testid="radar-search"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setActiveIdx(0);
              }}
              onKeyDown={onSearchKey}
              placeholder={`Search all ${pool.length} niches…`}
              aria-label={`Search all ${pool.length} niches in this cut`}
              autoComplete="off"
              spellCheck={false}
              className="mb-2 w-full border border-ink-primary/30 bg-transparent px-2.5 py-1.5 text-[13px] text-ink-primary placeholder:text-ink-muted"
            />
            <div className="flex items-baseline gap-2 border-b border-ink-primary/25 pb-2">
              <span className="kicker text-[11px] tracking-[.08em] text-ink-primary">Verdicts</span>
              <span className="tabular text-[11px] text-ink-muted">
                {q ? `${railEntries.length} of ${pool.length} match` : placed.length}
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
                    No niches match &ldquo;{query.trim()}&rdquo; — searched all {pool.length} niches in this cut.
                  </div>
                )}
                {RING_ORDER.map((ring) => {
                  const entries = byRing.get(ring)!;
                  // While searching, a ring with no matches is noise — drop the whole
                  // group (the unfiltered list keeps its explicit "None in this cut.").
                  if (q && entries.length === 0) return null;
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
                          {entries.map((b) => (
                            <button
                              type="button"
                              key={b.id}
                              data-testid={`radar-row-${b.id}`}
                              onClick={() => onSelect(b.id)}
                              onMouseEnter={() => setHoverId(b.id)}
                              onMouseLeave={clearHover}
                              title={`${b.key} — ${RING_LABEL[b.verdict.ring]}: ${b.verdict.reason}${
                                b.n == null ? ` (beyond the Top ${plotCap} plot — no dot on the board)` : ""
                              }`}
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
                          ))}
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
        <DossierDrawer blip={selected} plotCap={plotCap} total={placed.length} onClose={() => onSelect(null)} />
      )}
    </div>
  );
}

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Link } from "react-router-dom";
import clsx from "clsx";

import { trackEvent } from "../lib/analytics";
import { fmtInt, fmtUsd } from "../lib/format";
import { MONO } from "../lib/palette";
import {
  RING_LABEL,
  RING_ORDER,
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
 * RadarBoard — the radial "tech-radar" plate (Zalando/solidgate visual language, Industry
 * blueprint dialect): concentric hairline verdict rings, three angular sectors (Genres /
 * Micro-genres / Themes), one dot per niche, and a RIGHT RAIL that is the board's single
 * reading pane.
 *
 * ONE INSTRUMENT (2026-08-27 layout overhaul): plate and rail live in one frame and share
 * one selection model. The rail has two modes:
 *   - default: the ranked VERDICT LIST — every niche, grouped by ring, FULL counts. No
 *     silent caps (project rule): below lg the list flows with the page; from lg up it
 *     fills the plate's height and scrolls inside the rail (absolute-inset column), with
 *     the group headers carrying the true totals so nothing can quietly end at item #22.
 *   - selection: the VERDICT DOSSIER — IN VIEW at every width (the dossier-viewport fix:
 *     a selection must never strand its answer below the fold). From lg (1024px) up the
 *     board and rail sit side-by-side (rail 300px at lg, 340px at xl; the plate shrinks
 *     first) and the dossier is the rail's selection pane, beside the plate. Below lg
 *     the layout stacks — an inline pane would open BELOW the board, forcing a scroll —
 *     so the dossier renders as an Industry-styled slide-over DRAWER from the right edge
 *     instead (DossierDrawer: backdrop, ✕/back/ESC close, focus-trapped). Both
 *     presentations render the same DossierBody, so they cannot drift.
 * Selection is CONTROLLED (selectedId/onSelect props): the page owns it so the signal
 * feed's cards can select a niche on the board through the same channel a dot click uses.
 *
 * Everything is hand-rolled SVG — the CSP forbids external chart libs, and recharts has no
 * polar scatter anyway. All colors are CSS vars; the ring verdict is encoded by POSITION
 * (which annulus) and spelled in the rail/tooltip, never by hue alone — dots follow the
 * app's mono-steel vocabulary (enter = --verdict-up accent, then receding paper alphas).
 * A second, orthogonal encoding carries the solo LENS: team-scale niches (singleplayer
 * share `solo_viability` < SOLO_FRIENDLY_MIN) draw hollow (ring-colored stroke,
 * transparent fill), solo-friendly and unknown draw filled; the dot legend and tooltip
 * spell it out. Deliberately a lens, not a ring — see lib/radarVerdict.ts. A third mark
 * flags EMERGING niches (demand_emerging): a dashed halo, a NEW + absolute-volume glyph
 * instead of a trend %, and a tooltip that never prints the non-representative %.
 *
 * POPULATION (`soloOnly` prop): the board's default population is solo-friendly niches
 * only — filtered SERVER-side (the API's solo_only param, same 0.8 bar as
 * SOLO_FRIENDLY_MIN; NULL solo_viability = unknown = excluded). With soloOnly the
 * hollow/filled encoding is redundant, so the dot legend states the population rule
 * instead of drawing lens samples.
 *
 * LAYOUT IS DETERMINISTIC: every jitter comes from hash01(dimension:key), never
 * Math.random, so a niche holds its position across renders, visits and machines.
 * Density handling (2026-08-27, after dots merged into blobs in the micro sector's
 * outer bands): when a (sector, ring) cell's dots would claim more than CELL_FILL_MAX of
 * its area, every radius in that cell scales down together (sqrt of the overflow, floored
 * at BLIP_R_DENSE_MIN) — pure arithmetic over the cell's own population, so still
 * deterministic — and the pairwise collision relax runs RELAX_PASSES fixed passes.
 *
 * CLICK TARGETS: only the blip dots are interactive inside the SVG — the hairline rings,
 * separators and labels sit in a pointer-events:none group so a scripted or misaimed
 * click on the decor can never look like a dead dot (and the legend's sample circles are
 * plain aria-hidden glyphs, not targets). Keyboard access: the SVG dots are mouse
 * conveniences (aria-hidden); every niche's keyboard route is its rail row (a real
 * button), and navigation lives on the dossier's deep-dive link.
 */

export type RadarSector = "genre" | "micro" | "theme";
export const SECTOR_ORDER: RadarSector[] = ["genre", "micro", "theme"];

const SECTOR_LABEL: Record<RadarSector, string> = {
  genre: "Genres",
  micro: "Micro-genres",
  theme: "Themes",
};
/** One-letter sector marker for rail rows (a "Roguelike" tag and a "Roguelike" genre
 * can both be on the board — the letter disambiguates without a second grouping level). */
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
   * predates the column, or the niche had no prior-window baseline). */
  demandTrendPct: number | null;
  /** The mart's young-tag flag (see lib/radarVerdict.ts): when true the trend % is not
   * representative — the blip plates in the Emerging ring, draws a dashed halo, and the
   * tooltip/rail show absolute volume instead of the %. */
  demandEmerging: boolean;
  /** Absolute review inflow over the last 24 months — the number an emerging niche is
   * judged by (its % has no comparable base). null on marts without the demand columns. */
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

// ---- geometry ---------------------------------------------------------------------------

const SIZE = 640;
const C = SIZE / 2;
const R = 284; // outer ring radius; the margin hosts the sector labels
/** Ring outer edges as fractions of R, inner -> outer (index-aligned with RING_ORDER,
 * which grew an Emerging band between Watch and Crowded). The inner (strongest) ring is
 * deliberately the widest band per unit of its label's importance, like the reference. */
const RING_OUTER = [0.3, 0.52, 0.68, 0.85, 1] as const;
const SECTOR_SPAN = (2 * Math.PI) / SECTOR_ORDER.length;
/** Sector i spans [sectorStart(i), sectorStart(i) + SECTOR_SPAN); 0 starts straight up. */
function sectorStart(i: number): number {
  return -Math.PI / 2 + i * SECTOR_SPAN;
}

/** Max share of a (sector, ring) cell's area its dots may claim before every dot in the
 * cell shrinks together — the deterministic anti-blob rule (see module doc). */
export const CELL_FILL_MAX = 0.22;
/** The floor density scaling can never cross — dots stay visible and hittable. */
export const BLIP_R_DENSE_MIN = 2.5;
/** Fixed pairwise-relax passes (was 3 — not enough for the dense micro-genre bands). */
const RELAX_PASSES = 8;

export interface PlacedBlip extends RadarBoardBlip {
  id: string;
  /** 1-based rail number (ring order, then sector order, then opportunity desc). */
  n: number;
  x: number;
  y: number;
  r: number;
}

/** Angular padding (radians) keeping a dot of radius r clear of the sector separators. */
function angularPad(r: number, radius: number): number {
  return 0.06 + (r + 6) / Math.max(radius, 24);
}

function cellBounds(ringIdx: number, r: number): { rIn: number; rOut: number } {
  const rIn = (ringIdx === 0 ? 0 : RING_OUTER[ringIdx - 1] * R) + (ringIdx === 0 ? 18 : r + 4);
  const rOut = RING_OUTER[ringIdx] * R - (r + 4);
  return { rIn, rOut };
}

/** Clamp a point back into its (sector, ring) cell, in polar space. */
function clampToCell(b: PlacedBlip): void {
  const ringIdx = RING_ORDER.indexOf(b.verdict.ring);
  const sectorIdx = SECTOR_ORDER.indexOf(b.sector);
  const { rIn, rOut } = cellBounds(ringIdx, b.r);
  const dx = b.x - C;
  const dy = b.y - C;
  const radius = Math.min(Math.max(Math.hypot(dx, dy), rIn), Math.max(rIn, rOut));
  const a0 = sectorStart(sectorIdx);
  const pad = angularPad(b.r, radius);
  // Angle relative to the sector start, normalized to [0, 2π).
  let d = (Math.atan2(dy, dx) - a0) % (2 * Math.PI);
  if (d < 0) d += 2 * Math.PI;
  // A nudge can push a dot across a separator; snap to the nearer sector edge first.
  if (d > SECTOR_SPAN) d = d - SECTOR_SPAN < (2 * Math.PI - SECTOR_SPAN) / 2 ? SECTOR_SPAN : 0;
  const lo = Math.min(pad, SECTOR_SPAN / 2);
  const hi = Math.max(SECTOR_SPAN - pad, SECTOR_SPAN / 2);
  d = Math.min(Math.max(d, lo), hi);
  const a = a0 + d;
  b.x = C + radius * Math.cos(a);
  b.y = C + radius * Math.sin(a);
}

/**
 * Deterministic placement: hash-jittered polar position inside the (sector, ring) cell,
 * density-scaled radii (see module doc), then a fixed-pass pairwise relax to reduce
 * overlap. Exported for tests.
 */
export function layoutBlips(blips: RadarBoardBlip[]): PlacedBlip[] {
  const maxP90 = blips.reduce<number>((m, b) => Math.max(m, b.p90_rev ?? 0), 0);
  const ordered = [...blips].sort((a, b) => {
    const ring = RING_ORDER.indexOf(a.verdict.ring) - RING_ORDER.indexOf(b.verdict.ring);
    if (ring !== 0) return ring;
    const sector = SECTOR_ORDER.indexOf(a.sector) - SECTOR_ORDER.indexOf(b.sector);
    if (sector !== 0) return sector;
    const opp = (b.opportunity_v2 ?? -1) - (a.opportunity_v2 ?? -1);
    if (opp !== 0) return opp;
    return a.key.localeCompare(b.key);
  });

  // Density pass: sum each (sector, ring) cell's dot area against the cell's own annulus
  // area; an over-full cell scales EVERY resident radius by the same sqrt factor (area
  // tracks the overflow), floored at BLIP_R_DENSE_MIN. Deterministic — pure arithmetic
  // over the stable cell population, no randomness, no iteration-order dependence.
  const baseR = ordered.map((blip) => blipRadius(blip.p90_rev, maxP90));
  const dotArea = new Map<string, number>();
  for (let i = 0; i < ordered.length; i++) {
    const cell = `${RING_ORDER.indexOf(ordered[i].verdict.ring)}|${SECTOR_ORDER.indexOf(ordered[i].sector)}`;
    dotArea.set(cell, (dotArea.get(cell) ?? 0) + Math.PI * baseR[i] * baseR[i]);
  }
  const cellScale = new Map<string, number>();
  for (const [cell, area] of dotArea) {
    const ringIdx = Number(cell.split("|")[0]);
    const rOut = RING_OUTER[ringIdx] * R;
    const rIn = ringIdx === 0 ? 0 : RING_OUTER[ringIdx - 1] * R;
    const cellArea = (SECTOR_SPAN / 2) * (rOut * rOut - rIn * rIn);
    cellScale.set(cell, area > 0 ? Math.min(1, Math.sqrt((CELL_FILL_MAX * cellArea) / area)) : 1);
  }

  const placed: PlacedBlip[] = ordered.map((blip, i) => {
    const id = `${blip.dimension}:${blip.key}`;
    const cell = `${RING_ORDER.indexOf(blip.verdict.ring)}|${SECTOR_ORDER.indexOf(blip.sector)}`;
    const r = Math.max(BLIP_R_DENSE_MIN, baseR[i] * (cellScale.get(cell) ?? 1));
    const ringIdx = RING_ORDER.indexOf(blip.verdict.ring);
    const sectorIdx = SECTOR_ORDER.indexOf(blip.sector);
    const { rIn, rOut } = cellBounds(ringIdx, r);
    const radius = rOut > rIn ? rIn + hash01(`${id}|r`) * (rOut - rIn) : (rIn + rOut) / 2;
    const a0 = sectorStart(sectorIdx);
    const pad = angularPad(r, radius);
    const span = Math.max(SECTOR_SPAN - 2 * pad, 0);
    const a = span > 0 ? a0 + pad + hash01(`${id}|a`) * span : a0 + SECTOR_SPAN / 2;
    return { ...blip, id, n: i + 1, r, x: C + radius * Math.cos(a), y: C + radius * Math.sin(a) };
  });

  // Collision relax: RELAX_PASSES passes, push overlapping pairs apart along their delta,
  // then re-clamp into the cell. Deterministic (stable order, no randomness); coincident
  // centers split along a hash-derived direction.
  for (let pass = 0; pass < RELAX_PASSES; pass++) {
    for (let i = 0; i < placed.length; i++) {
      for (let j = i + 1; j < placed.length; j++) {
        const a = placed[i];
        const b = placed[j];
        const minDist = a.r + b.r + 2;
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        let dist = Math.hypot(dx, dy);
        if (dist >= minDist) continue;
        if (dist < 1e-6) {
          const ang = hash01(`${a.id}|${b.id}`) * 2 * Math.PI;
          dx = Math.cos(ang);
          dy = Math.sin(ang);
          dist = 1;
        }
        const push = (minDist - dist) / 2 / dist;
        a.x -= dx * push;
        a.y -= dy * push;
        b.x += dx * push;
        b.y += dy * push;
        clampToCell(a);
        clampToCell(b);
      }
    }
  }
  return placed;
}

// ---- rendering --------------------------------------------------------------------------

/** Mono-steel ring vocabulary: the strongest verdict carries the accent, the rest recede
 * in paper alphas. Never red/green; the ring POSITION and the rail carry the meaning. */
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
 */
function DossierBody({ blip }: { blip: PlacedBlip }) {
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
          {blip.n}. {blip.key}
        </span>
        <span className="text-[11px] text-ink-muted">{SECTOR_LABEL[blip.sector]}</span>
      </div>
      <p className="border-b border-chartborder pb-2 pt-1 text-[12px] text-ink-secondary">
        <span className="font-semibold text-ink-primary">{RING_LABEL[v.ring]}</span>
        {v.caution ? " · caution" : ""} — {v.reason}
      </p>

      {blip.trace.map((c) => (
        <div key={c.id} className="border-b border-chartborder py-2">
          {/* flex-wrap, no truncation: the bar clause drops to its own line in the
              narrow rail rather than eating the check's name. */}
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <CheckGlyph pass={c.pass} />
            <span className="sr-only">{c.pass === null ? "unknown" : c.pass ? "passes" : "fails"}</span>
            <span className="kicker text-[10px] tracking-[.08em] text-ink-muted">
              {c.decides ? c.label : `${c.label} · context`}
            </span>
            <span className="tabular ml-auto text-right text-[10px] text-ink-muted">bar {c.threshold}</span>
          </div>
          <div className="tabular pt-1 text-[12px] text-ink-primary">{c.value}</div>
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
function VerdictDossier({ blip, total, onBack }: { blip: PlacedBlip; total: number; onBack: () => void }) {
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
          <DossierBody blip={blip} />
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
function DossierDrawer({ blip, total, onClose }: { blip: PlacedBlip; total: number; onClose: () => void }) {
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
          <DossierBody blip={blip} />
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

export function RadarBoard({
  blips,
  soloOnly,
  selectedId,
  onSelect,
}: {
  blips: RadarBoardBlip[];
  soloOnly: boolean;
  /** Controlled selection — "dimension:key", or null. Owned by the page so the signal
   * feed's cards select through the same channel a dot click uses. */
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [tip, setTip] = useState<{ x: number; y: number } | null>(null);
  // Side-by-side (≥lg): dossier in the rail pane. Stacked (<lg): dossier as the drawer.
  const isDesktop = useIsDesktop();

  const placed = useMemo(() => layoutBlips(blips), [blips]);
  const byRing = useMemo(() => {
    const m = new Map<RadarRing, PlacedBlip[]>(RING_ORDER.map((r) => [r, []]));
    for (const b of placed) m.get(b.verdict.ring)!.push(b);
    return m;
  }, [placed]);
  const hovered = hoverId === null ? null : (placed.find((b) => b.id === hoverId) ?? null);
  // Selection survives population toggles only if the niche is still on the board.
  const selected = selectedId === null ? null : (placed.find((b) => b.id === selectedId) ?? null);

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

  return (
    <div className="flex flex-col gap-5 lg:flex-row lg:items-stretch">
      {/* The plate */}
      <div ref={wrapRef} className="relative mx-auto w-full max-w-[600px] lg:mx-0 lg:min-w-0 lg:flex-1">
        <svg viewBox={`0 0 ${SIZE} ${SIZE}`} className="block h-auto w-full" role="img" aria-label="Radar board: niches plotted by verdict ring and sector">
          {/* Decor — hairline rings, separators, origin cross and labels. pointer-events
              none as a GROUP: only the blip dots may ever be click targets, so a click
              landing on a hairline can never read as a dead dot (A4 hardening). */}
          <g pointerEvents="none">
            {/* Verdict rings — hairline circles, outermost on the baseline weight. */}
            {RING_OUTER.map((f, i) => (
              <circle
                key={f}
                cx={C}
                cy={C}
                r={f * R}
                fill="none"
                stroke={i === RING_OUTER.length - 1 ? "var(--baseline)" : "var(--gridline)"}
                strokeWidth={1}
              />
            ))}
            {/* Sector separators — hairline radii. */}
            {SECTOR_ORDER.map((_, i) => {
              const a = sectorStart(i);
              return (
                <line
                  key={i}
                  x1={C}
                  y1={C}
                  x2={C + R * Math.cos(a)}
                  y2={C + R * Math.sin(a)}
                  stroke="var(--gridline)"
                  strokeWidth={1}
                />
              );
            })}
            {/* Center registration cross — the blueprint sheet's origin mark. */}
            <line x1={C - 7} y1={C} x2={C + 7} y2={C} stroke="var(--baseline)" strokeWidth={1} />
            <line x1={C} y1={C - 7} x2={C} y2={C + 7} stroke="var(--baseline)" strokeWidth={1} />

            {/* Ring names, stacked along the upward separator (a cell boundary, so they
                never sit over a blip field); page-ground halo keeps them legible. */}
            {RING_ORDER.map((ring, i) => {
              const mid = ((i === 0 ? 0 : RING_OUTER[i - 1]) + RING_OUTER[i]) / 2;
              return (
                <text
                  key={ring}
                  x={C}
                  y={C - mid * R}
                  textAnchor="middle"
                  dominantBaseline="middle"
                  className="kicker"
                  style={{
                    fontSize: 10,
                    letterSpacing: "0.1em",
                    fill: "var(--text-muted)",
                    stroke: "var(--page-plane)",
                    strokeWidth: 4,
                    paintOrder: "stroke",
                  }}
                >
                  {RING_LABEL[ring]}
                </text>
              );
            })}

            {/* Sector names, outside the outer ring at each sector's mid angle. */}
            {SECTOR_ORDER.map((sector, i) => {
              const a = sectorStart(i) + SECTOR_SPAN / 2;
              return (
                <text
                  key={sector}
                  x={C + (R + 20) * Math.cos(a)}
                  y={C + (R + 20) * Math.sin(a)}
                  textAnchor="middle"
                  dominantBaseline="middle"
                  className="kicker"
                  style={{ fontSize: 11, letterSpacing: "0.12em", fill: "var(--text-secondary)" }}
                >
                  {SECTOR_LABEL[sector]}
                </text>
              );
            })}
          </g>

          {/* Blips — dots only; the rail carries the accessible buttons. Solo lens as dot
              STYLE: team-scale (singleplayer share < SOLO_FRIENDLY_MIN) draws hollow —
              ring-colored stroke over a `transparent` fill (transparent, not "none", so
              the interior still hit-tests for hover/click); solo-friendly and unknown
              draw filled. Ring POSITION is untouched — solo never moves a verdict. */}
          <g aria-hidden>
            {placed.map((b) => (
              <g key={b.id}>
                {/* Emerging halo — a dashed ring-colored circle around the dot (Industry
                    constraints: mono-steel, no hue). Orthogonal to the solo lens' hollow/
                    filled encoding, so an emerging team-scale dot keeps both marks. */}
                {b.demandEmerging && (
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
                {(hoverId === b.id || selectedId === b.id) && (
                  <circle cx={b.x} cy={b.y} r={b.r + (b.demandEmerging ? 5 : 2.5)} fill="none" stroke="var(--text-primary)" strokeWidth={1} pointerEvents="none" />
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
          <span>dot area = P90 revenue · ring = verdict (solo never moves a dot between rings)</span>
        </div>

        {/* Hover tooltip — HTML over the SVG, same TooltipPanel language as every chart.
            Clamped to the plate: it flips to the LEFT of the cursor past the horizontal
            midline (keeps the right edge) and flips ABOVE the cursor in the bottom band
            (the plate is square, so its rendered height is clientWidth; low dots used to
            push the panel past the plate's bottom edge and clip). */}
        {hovered && tip && (
          <div
            className="pointer-events-none absolute z-10"
            style={{
              left: tip.x,
              top: tip.y,
              transform: `translate(${tip.x > (wrapRef.current?.clientWidth ?? SIZE) / 2 ? "calc(-100% - 12px)" : "12px"}, ${
                tip.y > (wrapRef.current?.clientWidth || SIZE) - 180 ? "calc(-100% - 12px)" : "12px"
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
                      // Neutral on purpose — WHICH emerging tell fired (young label vs a
                      // base too small for a % read) is the dossier's distinction; the
                      // tooltip only carries the claim both tells share.
                      { label: "Demand 24m", value: "emerging — no comparable % base" },
                      {
                        label: "Reviews 24m",
                        value: hovered.reviews24m != null ? fmtInt(hovered.reviews24m) : "—",
                      },
                    ]
                  : [{ label: "Demand 24m", value: fmtTrendPct(hovered.demandTrendPct) }]),
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

      {/* THE RAIL — the board's single reading pane: the full ranked verdict list, or (at
          ≥lg, where board and rail are side-by-side) the selected niche's dossier. From
          lg up it matches the plate's height and scrolls inside itself (absolute-inset
          column — full counts in the group headers, so nothing is silently capped);
          below lg it flows with the page, uncapped, and the dossier renders as the
          slide-over DRAWER instead (an inline pane down there would open BELOW the board,
          out of view — the exact complaint this layout fixes). */}
      <div className="flex min-w-0 flex-col border-t border-chartborder pt-4 lg:w-[300px] lg:shrink-0 lg:border-l lg:border-t-0 lg:pl-4 lg:pt-0 xl:w-[340px] xl:pl-5">
        {selected && isDesktop ? (
          <VerdictDossier blip={selected} total={placed.length} onBack={() => onSelect(null)} />
        ) : (
          <>
            <div className="flex items-baseline gap-2 border-b border-ink-primary/25 pb-2">
              <span className="kicker text-[11px] tracking-[.08em] text-ink-primary">Verdicts</span>
              <span className="tabular text-[11px] text-ink-muted">{placed.length}</span>
              <span className="ml-auto text-[10px] text-ink-muted">click a dot or row for its dossier</span>
            </div>
            <div className="lg:relative lg:min-h-0 lg:flex-1">
              <div data-testid="radar-rail-list" className="rail-scroll flex flex-col gap-4 pt-2 lg:absolute lg:inset-0 lg:overflow-y-auto lg:pb-8 lg:pr-2">
                {RING_ORDER.map((ring) => {
                  const entries = byRing.get(ring)!;
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
                              title={`${b.key} — ${RING_LABEL[b.verdict.ring]}: ${b.verdict.reason}`}
                              className={clsx(
                                "group/rl flex min-w-0 items-baseline gap-2 py-[3px] text-left text-[13px] transition-colors",
                                hoverId === b.id && "bg-ink-primary/[0.06]",
                              )}
                            >
                              <span className="tabular w-6 shrink-0 text-right text-[11px] text-ink-muted">{b.n}</span>
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
        <DossierDrawer blip={selected} total={placed.length} onClose={() => onSelect(null)} />
      )}
    </div>
  );
}

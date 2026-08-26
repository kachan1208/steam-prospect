import { useMemo, useRef, useState } from "react";
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
 * Micro-genres / Themes), one dot per niche, and a numbered legend grouped by ring.
 *
 * Everything is hand-rolled SVG — the CSP forbids external chart libs, and recharts has no
 * polar scatter anyway. All colors are CSS vars; the ring verdict is encoded by POSITION
 * (which annulus) and spelled in the legend/tooltip, never by hue alone — dots follow the
 * app's mono-steel vocabulary (enter = --verdict-up accent, then receding paper alphas).
 * A second, orthogonal encoding carries the solo-viability LENS: team-scale niches
 * (solo_viability < SOLO_FRIENDLY_MIN) draw hollow (ring-colored stroke, transparent
 * fill), solo-friendly and unknown draw filled; the dot legend and tooltip spell it out.
 * Deliberately a lens, not a ring — see lib/radarVerdict.ts. A third mark flags EMERGING
 * niches (demand_emerging — young tags with no comparable demand base): a dashed halo
 * around the dot, a NEW + absolute-volume legend glyph instead of a trend %, and a
 * tooltip that never prints the non-representative % — still mono-steel, radius 0,
 * no red/green.
 *
 * POPULATION (`soloOnly` prop): the board's default population is solo-friendly niches
 * only — filtered SERVER-side (the API's solo_only param, same 0.8 bar as
 * SOLO_FRIENDLY_MIN; NULL solo_viability = unknown = excluded, because the population is
 * an explicit positive claim). With soloOnly the hollow/filled encoding is redundant (all
 * dots are solo-friendly by construction), so the dot legend states the population rule
 * instead of drawing lens samples; with the toggle off the full population returns and
 * the lens samples come back with it.
 *
 * THE DOSSIER: clicking a dot no longer navigates — it opens the VerdictDossier panel
 * under the plate, which decomposes WHY the niche got its ring: the verdict-trace rows
 * from lib/radarVerdict.ts's radarVerdictTrace (the same evaluation that placed the dot,
 * so the explanation can never disagree with the position), pass/fail in neutral steel
 * glyphs (never red/green), plus the raw context numbers and the deep-dive link. The
 * legend entries stay plain <Link>s — the keyboard-reachable route to the detail page.
 *
 * LAYOUT IS DETERMINISTIC: every jitter comes from hash01(dimension:key), never
 * Math.random, so a niche holds its position across renders, visits and machines. A small
 * fixed-pass collision relax nudges overlapping same-cell dots apart — also deterministic
 * (stable input order, pure arithmetic).
 *
 * Keyboard access: the SVG dots are mouse conveniences (aria-hidden); every niche's REAL
 * link is its legend entry, a plain <Link> — so the board never traps 80 tab stops.
 */

export type RadarSector = "genre" | "micro" | "theme";
export const SECTOR_ORDER: RadarSector[] = ["genre", "micro", "theme"];

const SECTOR_LABEL: Record<RadarSector, string> = {
  genre: "Genres",
  micro: "Micro-genres",
  theme: "Themes",
};
/** One-letter sector marker for legend rows (a "Roguelike" tag and a "Roguelike" genre
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
   * tooltip/legend show absolute volume instead of the %. */
  demandEmerging: boolean;
  /** Absolute review inflow over the last 24 months — the number an emerging niche is
   * judged by (its % has no comparable base). null on marts without the demand columns. */
  reviews24m: number | null;
  /** Prior-window review inflow — the dossier's demand-base context. */
  reviewsPrev24m: number | null;
  /** 0..1 share of the cut's scored games playable single-player; null = unknown (mart
   * predates the column). A LENS only — drawn as dot style (hollow = team-scale), never
   * fed into the verdict; see lib/radarVerdict.ts. */
  solo_viability: number | null;
  verdict: RadarVerdict;
  /** The verdict's decomposition (radarVerdictTrace's checks — produced by the SAME
   * evaluation as `verdict`); rendered by the dossier when the dot is clicked. */
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

export interface PlacedBlip extends RadarBoardBlip {
  id: string;
  /** 1-based legend number (ring order, then sector order, then opportunity desc). */
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
 * then a cheap fixed-pass pairwise relax to reduce overlap. Exported for tests.
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

  const placed: PlacedBlip[] = ordered.map((blip, i) => {
    const id = `${blip.dimension}:${blip.key}`;
    const r = blipRadius(blip.p90_rev, maxP90);
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

  // Collision relax: 3 passes, push overlapping pairs apart along their delta, then
  // re-clamp into the cell. Deterministic (stable order, no randomness); coincident
  // centers split along a hash-derived direction.
  for (let pass = 0; pass < 3; pass++) {
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
 * in paper alphas. Never red/green; the ring POSITION and the legend carry the meaning. */
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

/** Legend glyph for an emerging niche — the trend % must NEVER headline a young tag (its
 * base is near zero by construction), so the row carries the absolute volume instead. */
function EmergingGlyph({ reviews24m }: { reviews24m: number | null }) {
  return (
    <span
      className="kicker ml-auto shrink-0 pl-2 text-[10px] tracking-[.08em] text-ink-muted"
      title={
        "Emerging — a young tag: its prior 24-month window is near zero by construction, " +
        "so the trend % is not representative. Judged by absolute review volume instead" +
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
 * The verdict dossier — the per-niche analysis panel a blip click opens. Decomposes WHY
 * the niche got its ring: one row per VerdictCheck from radarVerdictTrace (the SAME
 * evaluation that placed the dot — see lib/radarVerdict.ts), each with the niche's own
 * number, the bar it was judged against, pass/fail in neutral steel, and a one-clause
 * reading. decides:false rows (the entrant-economics falsification tell, the solo lens)
 * are labeled "· context": they can talk you out of a niche, they never move its ring.
 * Below the trace: the raw context numbers and the deep-dive link (the dossier explains;
 * the detail page is where the full workup lives).
 */
function VerdictDossier({ blip, onClose }: { blip: PlacedBlip; onClose: () => void }) {
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
    <section
      aria-label={`Verdict dossier: ${blip.key}`}
      data-testid="verdict-dossier"
      className="relative mt-4 border border-ink-primary/25"
    >
      <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1 border-b border-chartborder px-4 py-2.5">
        <span
          className="inline-block h-2 w-2 shrink-0 self-center"
          style={{ backgroundColor: RING_FILL[v.ring] }}
          aria-hidden
        />
        <span className="kicker text-[11px] tracking-[.08em] text-ink-primary">
          {blip.n}. {blip.key}
        </span>
        <span className="text-[11px] text-ink-muted">{SECTOR_LABEL[blip.sector]}</span>
        <span className="text-[12px] text-ink-secondary sm:ml-auto">
          <span className="font-semibold text-ink-primary">{RING_LABEL[v.ring]}</span>
          {v.caution ? " · caution" : ""} — {v.reason}
        </span>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close dossier"
          className="ml-auto self-center border border-ink-primary/35 px-1.5 py-0.5 text-[10px] leading-none text-ink-primary transition-colors hover:bg-ink-primary/[0.08] sm:ml-2"
        >
          ✕
        </button>
      </div>

      <div className="flex flex-col">
        {blip.trace.map((c) => (
          <div
            key={c.id}
            className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 border-b border-chartborder px-4 py-2 last:border-b-0"
          >
            <span className="self-center">
              <CheckGlyph pass={c.pass} />
            </span>
            <span className="sr-only">{c.pass === null ? "unknown" : c.pass ? "passes" : "fails"}</span>
            <span className="kicker w-[168px] shrink-0 text-[10px] tracking-[.08em] text-ink-muted">
              {c.decides ? c.label : `${c.label} · context`}
            </span>
            <span className="tabular w-[168px] shrink-0 text-[12px] text-ink-primary">{c.value}</span>
            <span className="tabular w-[210px] shrink-0 text-[11px] text-ink-muted">bar {c.threshold}</span>
            <span className="min-w-0 flex-1 basis-[220px] text-[11px] text-ink-secondary">{c.note}</span>
          </div>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-3 border-t border-chartborder px-4 py-2.5">
        <span className="tabular text-[11px] text-ink-muted">{context}</span>
        <Link
          to={nicheDetailPath(blip.dimension, blip.key)}
          onClick={() => trackEvent("niche_open")}
          className="ml-auto text-[13px] text-brand transition-colors hover:text-brand-hover"
        >
          Open deep dive →
        </Link>
      </div>
    </section>
  );
}

export function RadarBoard({ blips, soloOnly }: { blips: RadarBoardBlip[]; soloOnly: boolean }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [tip, setTip] = useState<{ x: number; y: number } | null>(null);

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
    <div className="flex flex-col gap-6 xl:flex-row xl:items-start">
      {/* The plate */}
      <div ref={wrapRef} className="relative mx-auto w-full max-w-[640px] xl:mx-0 xl:flex-1">
        <svg viewBox={`0 0 ${SIZE} ${SIZE}`} className="block h-auto w-full" role="img" aria-label="Radar board: niches plotted by verdict ring and sector">
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

          {/* Blips — dots only; the legend carries the accessible links. Solo lens as dot
              STYLE: team-scale (solo_viability < SOLO_FRIENDLY_MIN) draws hollow — ring-
              colored stroke over a `transparent` fill (transparent, not "none", so the
              interior still hit-tests for hover/click); solo-friendly and unknown draw
              filled as before. Ring POSITION is untouched — solo never moves a verdict. */}
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
                  // A dot click opens the VERDICT DOSSIER (the analysis is the board's
                  // first answer); navigation to the detail page lives on the legend
                  // links and on the dossier's own deep-dive link.
                  onClick={() => setSelectedId(b.id)}
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
            never imply team-scale niches might be hiding on the board. With the toggle off
            the full population returns and the lens samples come back with it (honest
            about the overlap: unknown draws filled like solo-friendly, and the sample says
            so). */}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 pt-2 text-[11px] text-ink-muted">
          {soloOnly ? (
            <span className="inline-flex items-center gap-1.5">
              <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden className="shrink-0">
                <circle cx="5" cy="5" r="4" fill="currentColor" />
              </svg>
              <span>
                population: solo-friendly only · solo viability ≥ {SOLO_FRIENDLY_MIN} (server-filtered; unknown
                excluded)
              </span>
            </span>
          ) : (
            <>
              <span className="inline-flex items-center gap-1.5">
                <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden className="shrink-0">
                  <circle cx="5" cy="5" r="4" fill="currentColor" />
                </svg>
                solo-friendly (solo viability ≥ {SOLO_FRIENDLY_MIN}) or unknown
              </span>
              <span className="inline-flex items-center gap-1.5">
                <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden className="shrink-0">
                  <circle cx="5" cy="5" r="3.5" fill="none" stroke="currentColor" strokeWidth="1.3" />
                </svg>
                team-scale (&lt; {SOLO_FRIENDLY_MIN})
              </span>
            </>
          )}
          <span className="inline-flex items-center gap-1.5">
            <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden className="shrink-0">
              <circle cx="6" cy="6" r="2.5" fill="currentColor" />
              <circle cx="6" cy="6" r="5" fill="none" stroke="currentColor" strokeWidth="1" strokeDasharray="2 2" />
            </svg>
            emerging (young tag — no comparable base)
          </span>
          <span>dot area = P90 revenue · ring = verdict (solo never moves a dot between rings)</span>
        </div>

        {/* The verdict dossier — the click-through analysis for the selected blip. */}
        {selected && <VerdictDossier blip={selected} onClose={() => setSelectedId(null)} />}

        {/* Hover tooltip — HTML over the SVG, same TooltipPanel language as every chart. */}
        {hovered && tip && (
          <div
            className="pointer-events-none absolute z-10"
            style={{
              left: tip.x,
              top: tip.y,
              transform: `translate(${tip.x > (wrapRef.current?.clientWidth ?? SIZE) / 2 ? "calc(-100% - 12px)" : "12px"}, 12px)`,
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
                      { label: "Demand 24m", value: "new market — no comparable base" },
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
                  label: "Solo viability",
                  value: hovered.solo_viability != null ? hovered.solo_viability.toFixed(2) : "unknown",
                },
              ]}
            />
          </div>
        )}
      </div>

      {/* Legend — numbered, grouped by ring, every entry a real link. */}
      <div className="flex flex-col gap-5 xl:w-[320px] xl:max-h-[640px] xl:shrink-0 xl:overflow-y-auto xl:pr-1">
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
                <div className="grid grid-cols-1 gap-x-6 pt-1 sm:grid-cols-2 xl:grid-cols-1">
                  {entries.map((b) => (
                    <Link
                      key={b.id}
                      to={nicheDetailPath(b.dimension, b.key)}
                      onClick={() => trackEvent("niche_open")}
                      onMouseEnter={() => setHoverId(b.id)}
                      onMouseLeave={clearHover}
                      title={`${b.key} — ${RING_LABEL[b.verdict.ring]}: ${b.verdict.reason}`}
                      className={clsx(
                        "group/rl flex min-w-0 items-baseline gap-2 py-[3px] text-[13px] transition-colors",
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
                    </Link>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

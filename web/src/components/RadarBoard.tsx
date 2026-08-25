import { useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import clsx from "clsx";

import { trackEvent } from "../lib/analytics";
import { fmtInt, fmtUsd } from "../lib/format";
import { MONO } from "../lib/palette";
import {
  RING_LABEL,
  RING_ORDER,
  blipRadius,
  hash01,
  type RadarRing,
  type RadarVerdict,
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
  /** Percent units; null = no 90-day demand trend joined for this niche (see Radar.tsx —
   * GET /api/niches does not carry it; only the radar feed's top movers do). */
  demandTrendPct: number | null;
  verdict: RadarVerdict;
}

// ---- geometry ---------------------------------------------------------------------------

const SIZE = 640;
const C = SIZE / 2;
const R = 284; // outer ring radius; the margin hosts the sector labels
/** Ring outer edges as fractions of R, inner -> outer. The inner (strongest) ring is
 * deliberately the widest band per unit of its label's importance, like the reference. */
const RING_OUTER = [0.34, 0.58, 0.8, 1] as const;
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
  crowded: MONO.paper50,
  declining: MONO.paper35,
};

function fmtTrendPct(v: number | null): string {
  if (v === null) return "n/a";
  return `${v >= 0 ? "▲ +" : "▼ −"}${Math.abs(v).toFixed(1)}%`;
}

function MoveGlyph({ trendPct }: { trendPct: number | null }) {
  if (trendPct === null) return null;
  const up = trendPct >= 0;
  return (
    <span
      className="ml-auto shrink-0 pl-2 text-[11px] tabular"
      style={{ color: up ? "var(--verdict-up)" : "var(--verdict-flat)" }}
      title={`90-day demand trend ${up ? "+" : "−"}${Math.abs(trendPct).toFixed(1)}%`}
    >
      {up ? "▲" : "▼"} {Math.abs(trendPct).toFixed(0)}%
    </span>
  );
}

export function RadarBoard({ blips }: { blips: RadarBoardBlip[] }) {
  const navigate = useNavigate();
  const wrapRef = useRef<HTMLDivElement>(null);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [tip, setTip] = useState<{ x: number; y: number } | null>(null);

  const placed = useMemo(() => layoutBlips(blips), [blips]);
  const byRing = useMemo(() => {
    const m = new Map<RadarRing, PlacedBlip[]>(RING_ORDER.map((r) => [r, []]));
    for (const b of placed) m.get(b.verdict.ring)!.push(b);
    return m;
  }, [placed]);
  const hovered = hoverId === null ? null : (placed.find((b) => b.id === hoverId) ?? null);

  const moveTip = (e: React.MouseEvent) => {
    const rect = wrapRef.current?.getBoundingClientRect();
    if (rect) setTip({ x: e.clientX - rect.left, y: e.clientY - rect.top });
  };
  const clearHover = () => {
    setHoverId(null);
    setTip(null);
  };

  if (blips.length === 0) {
    return <div className="py-10 text-center text-sm text-ink-muted">No niches match this cut.</div>;
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

          {/* Blips — dots only; the legend carries the accessible links. */}
          <g aria-hidden>
            {placed.map((b) => (
              <g key={b.id}>
                <circle
                  cx={b.x}
                  cy={b.y}
                  r={b.r}
                  fill={RING_FILL[b.verdict.ring]}
                  stroke="var(--page-plane)"
                  strokeWidth={1}
                  opacity={hoverId !== null && hoverId !== b.id ? 0.35 : 1}
                  style={{ cursor: "pointer", transition: "opacity 120ms" }}
                  onMouseEnter={(e) => {
                    setHoverId(b.id);
                    moveTip(e);
                  }}
                  onMouseMove={moveTip}
                  onMouseLeave={clearHover}
                  onClick={() => {
                    trackEvent("niche_open");
                    navigate(nicheDetailPath(b.dimension, b.key));
                  }}
                />
                {hoverId === b.id && (
                  <circle cx={b.x} cy={b.y} r={b.r + 2.5} fill="none" stroke="var(--text-primary)" strokeWidth={1} pointerEvents="none" />
                )}
              </g>
            ))}
          </g>
        </svg>

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
                { label: "Demand 90d", value: fmtTrendPct(hovered.demandTrendPct) },
                { label: "P90 revenue", value: fmtUsd(hovered.p90_rev) },
                { label: "Games", value: fmtInt(hovered.n_games) },
                { label: "Opp v2", value: hovered.opportunity_v2 != null ? hovered.opportunity_v2.toFixed(1) : "—" },
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
                      <MoveGlyph trendPct={b.demandTrendPct} />
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

/**
 * radarRings — THE CONCENTRIC-RING DIAL'S GEOMETRY (2026-09-10, user directive: "I think
 * circle is a better representation for radar. Like we do there:
 * https://solidgate-tech.github.io/ Best - niches are in the middle").
 *
 * Pure math, zero React, zero DOM: the module RadarBoard.tsx draws with, and the module
 * radarRings.test.ts pins. Same contract the old layoutXY had — a pure function of the
 * blips plus the measured plate width, so a niche sits at the same spot on every render,
 * every visit and every machine, with no Math.random anywhere.
 *
 * WHAT THE DIAL ENCODES
 *   RING BAND  = the VERDICT, best in the middle. RING_ORDER already spelled this
 *                ("inner -> outer": enter, watch, emerging, crowded, declining) — the board
 *                had simply never drawn it. A blip's band IS its verdict, so a blip may
 *                never be nudged out of its band for any reason.
 *   SECTOR     = the tag TIER (lib/radarVerdict.ts's tierSector: micro / theme / umbrella /
 *                meta, plus "ungrouped" for genre rows and untiered tags). A blip may never
 *                be nudged out of its sector either.
 *   RADIUS INSIDE THE BAND = opportunity_v2's RANK within the blip's own cell (band x
 *                sector), spread evenly across the band's usable width — highest score
 *                nearest the band's INNER edge, i.e. nearest the middle, which is the whole
 *                point of the form. Rank, not raw score, and the legend says so: a rank
 *                uses the band's full width whatever the score distribution does, and the
 *                band is already the claim — nobody should ever have to read a score off a
 *                radius. The exact opportunity_v2 stays in the tooltip and the dossier.
 *   ANGLE      = free. It is the ONLY free coordinate, so it is the only one the collision
 *                pass is allowed to move.
 *
 * WHY THE OUTLIER-CLAMP MACHINERY IS GONE (and this is not a loss of honesty). The XY plate
 * clamped values beyond its fixed axis domains and drew an outward chevron, because a
 * linear axis over −100…+300 %/24m genuinely ends before the data does. The dial has no
 * such domain: the radial channel is a within-band RANK (always in range by construction)
 * and the angular channel is unbounded-free. Nothing can fall off this scale, so there is
 * nothing to pin and no chevron to draw.
 *
 * WHY THE "NO-XY STRIP" IS GONE (same reason). The strip existed because an EMERGING niche
 * has no trustworthy trend % and a row missing trend or saturation has no honest X or Y at
 * all — so the XY form had nowhere truthful to put them. The dial asks a different question:
 * every row has a VERDICT (radarVerdictTrace is total — a row with no readings lands in
 * watch·caution "no strong signal"), and emerging IS one of the five rings. So every row now
 * has an honest position, and the strip's residents sit in the emerging band where they
 * belong, ranked by the same opportunity score as everyone else.
 */

import {
  RING_LABEL,
  RING_ORDER,
  TIER_SECTOR_ORDER,
  hash01,
  type RadarRing,
  type RadarTierSector,
} from "../lib/radarVerdict";

const TAU = Math.PI * 2;

// ---- the plate ---------------------------------------------------------------------------

/** Width before the wrapper is measured — and the effective width under jsdom (tests),
 * where clientWidth is 0 and the fallback sticks. Exported so tests can name it. */
export const DEFAULT_PLATE_W = 928;

/** The dial never grows past this diameter: past it the rings stop gaining legibility and
 * start pushing the rail's first rows below the fold at 1440x900. */
const DIAL_MAX = 620;
/** …and never shrinks below this, so the five bands stay separable on a 320px phone. */
const DIAL_MIN = 236;
/** Ring above and below the circle reserved for the rim labels and the zoom title. */
const RIM_PAD = 26;
/** HORIZONTAL reserve. One sector puts its rim label at 6 o'clock under the dial, where the
 * vertical pad already covers it — so the sides give up almost nothing, which is what buys
 * a phone its extra 15% of radius. More than one sector puts labels out at the wedges' mid
 * angles, where a side label ("Micro-genre · 42") runs ~90px and would otherwise run off
 * the viewBox. */
const RIM_PAD_SIDE = 8;
const RIM_PAD_SIDE_MULTI = 90;

/**
 * DEFAULT BAND STOPS as fractions of the outer radius: the centre hole, then the five band
 * edges inner -> outer. The hole exists so the innermost band is an annulus rather than a
 * disc — a disc would pile its best rows on top of each other at r≈0, which is the opposite
 * of what "best in the middle" should look like — and it gives the dial's centre mark a home.
 *
 * These are the shape the dial takes when nobody tells it the populations (the default
 * ringGeom() call, and the tests). With counts, the bands BREATHE — see bandShares().
 */
export const RING_STOPS = [0.13, 0.365, 0.535, 0.685, 0.845, 1] as const;

/** Rows per ring — what makes the bands breathe. Missing/absent = 0. */
export type RingCounts = Partial<Record<RadarRing, number>>;

/** Every band keeps at least this share of the usable radius, however empty it is: a ring
 * with no rows is still a real verdict and still has to be legible enough to carry its own
 * caption, or the dial would quietly stop being a five-verdict scale. */
const BAND_MIN_SHARE = 0.115;

/**
 * THE BANDS BREATHE WITH THE POPULATION (bounded). Fixed fifths look tidy and read badly:
 * on the live micro-genre cut the WATCH ring carries 53 of the board's 80 rows while
 * DECLINING carries one, so equal bands crush the crowd into a hairline annulus and hand a
 * fifth of the dial to a single dot. Each band therefore takes BAND_MIN_SHARE of the usable
 * radius plus a slice of what's left, weighted by sqrt(count) — sqrt, so the width tracks
 * the AREA a band needs rather than its row count, which is what actually decides whether
 * blips fit.
 *
 * What this does NOT do: it never reorders the rings, never moves a blip out of its verdict,
 * and never changes what a band MEANS. The caption inside the band always names it. What
 * breathes is thickness — a scale's tick spacing, not its labels.
 */
export function bandShares(counts?: RingCounts): number[] {
  if (!counts) {
    const usable = 1 - RING_STOPS[0];
    return RING_ORDER.map((_, i) => (RING_STOPS[i + 1] - RING_STOPS[i]) / usable);
  }
  const w = RING_ORDER.map((r) => Math.sqrt((counts[r] ?? 0) + 0.75));
  const sum = w.reduce((a, b) => a + b, 0);
  const free = 1 - RING_ORDER.length * BAND_MIN_SHARE;
  return w.map((x) => BAND_MIN_SHARE + (free * x) / sum);
}

/** Band captions. The full ring wording on a desktop dial; the short word on a phone, where
 * "ENTER NOW" would need a gutter a third of the circle wide to clear its own band. */
const CAPTION_SHORT: Record<RadarRing, string> = {
  enter: "ENTER",
  watch: "WATCH",
  emerging: "EMERGING",
  crowded: "CROWDED",
  declining: "DECLINING",
};

/** Below this radius the dial is a phone dial: short captions, smaller type. */
export const COMPACT_R = 200;

/** Approximate rendered width of a caption in the kicker face at 0.1em tracking. Only used
 * to size the caption's own angular gutter — an over-estimate costs a few degrees of arc, an
 * under-estimate costs a legible label, so it leans generous. */
const captionWidth = (text: string, size: number) => text.length * size * 0.66;

/** No band ever reserves more than this much arc on each side of 12 o'clock. */
const MAX_GUTTER = 0.62;

export interface RingBand {
  ring: RadarRing;
  /** Inner / outer radius in viewBox px. */
  r0: number;
  r1: number;
  /** Radius the band's caption sits at (its middle). */
  mid: number;
  /** The caption string and its font size — the geometry owns both, because the band's
   * angular GUTTER is derived from them. */
  caption: string;
  captionSize: number;
  /** Half the caption's rendered width in px (plus a little air) — the neighbours read it
   * to clear a caption that reaches sideways into their own arc. */
  captionHalf: number;
  /**
   * THE CAPTION GUTTER, in radians, on EACH side of 12 o'clock. The band captions are the
   * reference's ADOPT/TRIAL/ASSESS/HOLD: big, low-contrast, inside the band, on the vertical
   * axis — and they paint UNDER the dots on purpose (wallpaper must not eat data). Under a
   * 53-row band that would erase them, so instead the placement leaves the caption's own arc
   * empty and spreads the band's blips across the rest. It is the same idea as the
   * reference's quadrant boundary, which is what keeps its labels clear.
   */
  gutter: number;
}

export interface RingGeom {
  /** viewBox width == the wrapper's measured CSS width (1 unit = 1 px). */
  plateW: number;
  /** viewBox height — derived from the dial, so the plate is always square-ish. */
  vbH: number;
  cx: number;
  cy: number;
  /** Outer radius of the dial and the centre hole's radius. */
  R: number;
  r0: number;
  /** True on a phone-sized dial: short captions, smaller decor type. */
  compact: boolean;
  /** The five bands, inner -> outer (RING_ORDER). While zoomed, the zoomed ring's band
   * spans the WHOLE dial (r0..R) and the other four are absent — see `bands`. */
  bands: RingBand[];
  band: (ring: RadarRing) => RingBand | undefined;
  /** The active zoom ring, or null for the full dial. */
  zoom: RadarRing | null;
}

export function ringGeom(
  plateW: number = DEFAULT_PLATE_W,
  zoom: RadarRing | null = null,
  sectorCount = 1,
  counts?: RingCounts,
): RingGeom {
  const w = Math.max(240, Math.round(plateW));
  const sidePad = sectorCount > 1 ? RIM_PAD_SIDE_MULTI : RIM_PAD_SIDE;
  const dial = Math.min(DIAL_MAX, Math.max(DIAL_MIN, w - 2 * sidePad), w - 8);
  const R = dial / 2;
  const cx = w / 2;
  const cy = RIM_PAD + R;
  const r0 = R * RING_STOPS[0];
  const compact = R < COMPACT_R;

  const mkBand = (ring: RadarRing, a: number, b: number): RingBand => {
    const mid = (a + b) / 2;
    const caption = compact && zoom === null ? CAPTION_SHORT[ring] : RING_LABEL[ring].toUpperCase();
    const captionSize = Math.max(9, Math.min((b - a) * 0.46, R * 0.085, 26));
    const half = captionWidth(caption, captionSize) / 2 + 6;
    return {
      ring,
      r0: a,
      r1: b,
      mid,
      caption,
      captionSize,
      captionHalf: half,
      gutter: Math.min(MAX_GUTTER, half / Math.max(mid, 1)),
    };
  };

  let bands: RingBand[];
  if (zoom) {
    bands = [mkBand(zoom, r0, R)];
  } else {
    const shares = bandShares(counts);
    const usable = R - r0;
    bands = [];
    let edge = r0;
    for (let i = 0; i < RING_ORDER.length; i++) {
      const next = i === RING_ORDER.length - 1 ? R : edge + usable * shares[i];
      bands.push(mkBand(RING_ORDER[i], edge, next));
      edge = next;
    }
    // A caption is a horizontal string sitting at its band's MID radius, so its ends reach
    // sideways past its own band and into the neighbours' arcs — the inner band's long
    // wording is the usual offender, because a short radius turns a modest string into a
    // wide angle. Each band therefore also clears its neighbours' captions, measured at the
    // edge it shares with them. Bounded by MAX_GUTTER like everything else here.
    for (let i = 0; i < bands.length; i++) {
      const inner = bands[i - 1];
      const outer = bands[i + 1];
      const fromInner = inner ? inner.captionHalf / Math.max(bands[i].r0, 1) : 0;
      const fromOuter = outer ? outer.captionHalf / Math.max(bands[i].r1, 1) : 0;
      bands[i].gutter = Math.min(MAX_GUTTER, Math.max(bands[i].gutter, fromInner, fromOuter));
    }
  }
  const byRing = new Map(bands.map((b) => [b.ring, b]));

  return {
    plateW: w,
    vbH: Math.round(cy + R + RIM_PAD),
    cx,
    cy,
    R,
    r0,
    compact,
    bands,
    band: (ring) => byRing.get(ring),
    zoom,
  };
}

// ---- sectors -----------------------------------------------------------------------------

export interface SectorSpan {
  sector: RadarTierSector;
  /** Radians, SVG convention (0 = 3 o'clock, positive = clockwise on screen). */
  a0: number;
  a1: number;
  mid: number;
}

/** 12 o'clock, where the first sector starts and the band captions live. */
export const START_ANGLE = -Math.PI / 2;

/**
 * ANGLE IS ALLOCATED ONLY TO SECTORS THAT HAVE MEMBERS — the one geometry call the brief
 * left to the implementation, and it matters more than it sounds. The board's CLASS PICKER
 * (Genres / Micro-genres / Themes) is unchanged and still admits exactly one class at a
 * time, and the API serves genre rows as tier "genre" and the tag cut as tiers=micro,theme
 * — so on every real board today EVERY row shares one tier. Drawing four labelled quadrants
 * with three of them structurally empty would be a picture of data that cannot exist; the
 * dial would also throw away three quarters of its angular room exactly when the fourth
 * quarter is the crowded one.
 *
 * So the occupied sectors split the circle equally, in TIER_SECTOR_ORDER. One tier on the
 * board = one full-circle sector (no spokes: a divider between a sector and itself is a
 * lie). Two or more = real wedges, with divider spokes and rim labels, which is what the
 * genre class + a future umbrella/meta cut would draw.
 */
export function sectorSpans(sectors: readonly RadarTierSector[]): SectorSpan[] {
  const present = TIER_SECTOR_ORDER.filter((s) => sectors.includes(s));
  const list = present.length > 0 ? present : [TIER_SECTOR_ORDER[0]];
  const span = TAU / list.length;
  return list.map((sector, i) => {
    const a0 = START_ANGLE + i * span;
    return { sector, a0, a1: a0 + span, mid: a0 + span / 2 };
  });
}

// ---- placement ---------------------------------------------------------------------------

/** What layoutRings needs from a row. Structural so RadarBoardBlip satisfies it. */
export interface RingInput {
  id: string;
  ring: RadarRing;
  sector: RadarTierSector;
  opportunity: number | null;
  /** Blip radius in viewBox px — the caller's P90-revenue scale. */
  r: number;
}

export interface RingPlaced {
  id: string;
  ring: RadarRing;
  sector: RadarTierSector;
  /** Distance from the dial's centre; always strictly inside the blip's own band. */
  radius: number;
  /** Radians; always inside the blip's own sector span. */
  angle: number;
  x: number;
  y: number;
  r: number;
  /** 0-based rank by opportunity_v2 inside this blip's own cell (band x sector) — the
   * number the radius draws. */
  cellRank: number;
  cellSize: number;
  /** True when the row has no opportunity_v2 at all: it is ranked LAST in its cell and
   * flagged, so the legend/tooltip can say the radius is a fallback, not a reading. */
  unscored: boolean;
}

/** Clearance between two blip edges before the collision pass stops pushing. */
const BLIP_GAP = 1.8;
/** Bounded, so a pathologically crowded cell degrades into "slightly tighter" rather than
 * into a hang. Each pass is O(n^2) over ONE cell, and a cell tops out around 120 rows. */
const RELAX_PASSES = 48;
/** Angular breathing room at a sector's two edges (radians), so a wedge's blips never sit
 * on the divider spoke. Zero for a full-circle sector, which has no edge. */
const SECTOR_EDGE_PAD = 0.045;

const norm = (a: number): number => {
  let v = a;
  while (v <= -Math.PI) v += TAU;
  while (v > Math.PI) v -= TAU;
  return v;
};

export interface RingLayout {
  geom: RingGeom;
  sectors: SectorSpan[];
  placed: Map<string, RingPlaced>;
}

/**
 * Place every blip. Deterministic: identical input -> identical output, byte for byte.
 *
 * Per cell (ring band x sector):
 *   1. rank by opportunity_v2 desc, ties by id — unscored rows last (see `unscored`).
 *   2. RADIUS from the rank, evenly across the band's usable width (inset by the blip's own
 *      size so a circle can never poke through a band edge), inner edge = best.
 *   3. ANGLE from a golden-ratio (phyllotaxis) stride across the sector's span, seeded per
 *      cell from hash01 so cells don't all start at the same spoke. The stride is the point:
 *      consecutive ranks — which sit at nearly the same RADIUS — land on opposite sides of
 *      the sector, and the pairs that do land near each other in angle are many ranks apart
 *      and therefore well separated in radius. That is what lets a 40-row band pack without
 *      touching.
 *   4. COLLISION PASS, ANGLE ONLY (the old board's collision-nudge idea, re-aimed at the one
 *      free axis): overlapping pairs are pushed apart along the arc, clamped to the sector's
 *      own edges. The band and the sector are claims about the niche — the nudge may never
 *      spend either of them to buy space.
 */
export function layoutRings(
  blips: readonly RingInput[],
  geom: RingGeom,
  sectors: SectorSpan[],
): Map<string, RingPlaced> {
  const spanBySector = new Map(sectors.map((s) => [s.sector, s]));
  const fallback = sectors[0];
  const out = new Map<string, RingPlaced>();

  // Bucket into cells. A blip whose band is absent (a zoom hides the other four) is simply
  // not placed — the caller filters those out before drawing.
  const cells = new Map<string, RingInput[]>();
  for (const b of blips) {
    if (!geom.band(b.ring)) continue;
    const key = `${b.ring}|${b.sector}`;
    const list = cells.get(key);
    if (list) list.push(b);
    else cells.set(key, [b]);
  }

  for (const [key, members] of cells) {
    const band = geom.band(members[0].ring)!;
    const span = spanBySector.get(members[0].sector) ?? fallback;
    const wholeCircle = Math.abs(span.a1 - span.a0 - TAU) < 1e-9;
    // A full-circle sector starts AT 12 o'clock, which is where the band caption sits, so
    // its "edges" are the caption gutter (see RingBand.gutter). A wedge keeps the small
    // spoke pad instead — its caption sits on the divider, not inside anyone's arc.
    const edgePad = wholeCircle ? band.gutter : SECTOR_EDGE_PAD;
    const full = wholeCircle && edgePad <= 1e-9;
    const a0 = span.a0 + edgePad;
    const arc = Math.max(1e-6, span.a1 - span.a0 - 2 * edgePad);

    const ordered = [...members].sort((a, b) => {
      const ao = a.opportunity;
      const bo = b.opportunity;
      if (ao === null && bo !== null) return 1;
      if (bo === null && ao !== null) return -1;
      if (ao !== null && bo !== null && ao !== bo) return bo - ao;
      return a.id.localeCompare(b.id);
    });

    const n = ordered.length;
    const maxR = ordered.reduce((m, b) => Math.max(m, b.r), 0);
    const inset = maxR + 1.5;
    const width = band.r1 - band.r0;
    // A band too thin to inset in (a phone's inner band under a big blip scale) collapses
    // to its midline rather than letting a circle cross a band edge.
    const lo = width > 2 * inset ? band.r0 + inset : band.mid;
    const hi = width > 2 * inset ? band.r1 - inset : band.mid;

    const seed = hash01(`${key}|ring-angle`);
    const nodes = ordered.map((b, i) => {
      const t = n === 1 ? 0.5 : (i + 0.5) / n;
      const radius = lo + t * (hi - lo);
      const frac = (seed + i * 0.618_033_988_749_895) % 1;
      const angle = full ? span.a0 + frac * TAU : a0 + frac * arc;
      return { b, i, radius, angle };
    });

    // --- collision pass: angle only, clamped to the sector -------------------------------
    for (let pass = 0; pass < RELAX_PASSES; pass++) {
      let moved = false;
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const p = nodes[i];
          const q = nodes[j];
          const dx = Math.cos(q.angle) * q.radius - Math.cos(p.angle) * p.radius;
          const dy = Math.sin(q.angle) * q.radius - Math.sin(p.angle) * p.radius;
          const d = Math.hypot(dx, dy);
          const need = p.b.r + q.b.r + BLIP_GAP;
          if (d >= need) continue;
          const shift = (need - d) / 2;
          // Which way round the arc: whichever side q already sits on, it keeps.
          const dir = norm(q.angle - p.angle) >= 0 ? 1 : -1;
          p.angle -= (dir * shift) / Math.max(p.radius, 10);
          q.angle += (dir * shift) / Math.max(q.radius, 10);
          if (!full) {
            p.angle = Math.min(Math.max(p.angle, a0), a0 + arc);
            q.angle = Math.min(Math.max(q.angle, a0), a0 + arc);
          }
          moved = true;
        }
      }
      if (!moved) break;
    }

    for (const nd of nodes) {
      const angle = full ? ((nd.angle - span.a0) % TAU) + span.a0 : nd.angle;
      out.set(nd.b.id, {
        id: nd.b.id,
        ring: nd.b.ring,
        sector: nd.b.sector,
        radius: nd.radius,
        angle,
        x: geom.cx + Math.cos(angle) * nd.radius,
        y: geom.cy + Math.sin(angle) * nd.radius,
        r: nd.b.r,
        cellRank: nd.i,
        cellSize: n,
        unscored: nd.b.opportunity === null,
      });
    }
  }

  return out;
}

// ---- svg path helpers ---------------------------------------------------------------------

/** A full annulus as one evenodd path — the band's hover/zoom hit area and its wash. */
export function annulusPath(cx: number, cy: number, rIn: number, rOut: number): string {
  const ring = (r: number, sweep: 0 | 1) =>
    `M ${(cx - r).toFixed(2)} ${cy.toFixed(2)} ` +
    `A ${r.toFixed(2)} ${r.toFixed(2)} 0 1 ${sweep} ${(cx + r).toFixed(2)} ${cy.toFixed(2)} ` +
    `A ${r.toFixed(2)} ${r.toFixed(2)} 0 1 ${sweep} ${(cx - r).toFixed(2)} ${cy.toFixed(2)} Z`;
  return `${ring(rOut, 0)} ${ring(Math.max(0.01, rIn), 1)}`;
}

/** Point on the dial at (angle, radius). */
export function polar(cx: number, cy: number, angle: number, radius: number): { x: number; y: number } {
  return { x: cx + Math.cos(angle) * radius, y: cy + Math.sin(angle) * radius };
}

/**
 * radarRings — THE CONCENTRIC-RING DIAL'S GEOMETRY (2026-09-10, user directive: "I think
 * circle is a better representation for radar. Like we do there:
 * https://solidgate-tech.github.io/ Best - niches are in the middle"; rebuilt the same day
 * after the first cut was rejected — "Make it better, right now it looks like a slop. On a
 * link I provided before there is a library used to render radar").
 *
 * THE REFERENCE, MEASURED. https://solidgate-tech.github.io/ renders with Zalando's
 * tech-radar (radar-0.9.js) on d3 v4. What it actually does, off the wire:
 *   - SVG 1350x900, radar radius 400, ring radii 130 / 220 / 310 / 400 — FOUR bands of
 *     roughly EQUAL width (90px) after a slightly larger inner disc (130).
 *   - 55 blips across FOUR quadrants (~14 each). Blip circle r=9 with a 9px number in it.
 *   - Ring captions 42px, COLOURED to their own ring (ADOPT is the adopt green), stacked up
 *     the vertical axis in the UPPER half at y = -68 / -158 / -248 / -338 — i.e. exactly
 *     `-ringRadius + 62`, one caption per band, just inside each band's outer edge.
 *   - Blips placed by d3's FORCE SIMULATION with a collision force, clamped every tick back
 *     into their own (quadrant, ring) segment. That is why nothing overlaps and every
 *     segment fills evenly.
 * Every one of those five is now true here too. This module owns the geometry and the
 * placement; RadarBoard.tsx owns the drawing.
 *
 * WHAT THE DIAL ENCODES
 *   RING BAND  = the VERDICT, best in the middle. RING_ORDER spells it ("inner -> outer":
 *                enter, watch, emerging, crowded, declining). A blip's band IS its verdict,
 *                so a blip may never be nudged out of its band for any reason.
 *   SECTOR     = the niche CLASS — Genres / Micro-genres / Themes, three fixed 120° wedges,
 *                ALWAYS all three (see sectorSpans). This is the change that fixed the
 *                density: the first cut put one class at a time into a single full-circle
 *                sector, which packed 80 blips where the reference puts ~14, so the middle
 *                clumped and the rim sat empty. Three sectors is also what makes the board
 *                comparable — a genre, a micro-genre and a theme are different market
 *                claims, and side-by-side wedges say so far better than a picker that
 *                swaps the whole board out.
 *   RADIUS INSIDE THE BAND = opportunity_v2's RANK within the blip's own cell (band x
 *                sector) — the force simulation's SEED, not its output (see layoutRings).
 *                Highest score starts nearest the band's inner edge, i.e. nearest the
 *                middle, which is the whole point of the form. Rank, not raw score: a rank
 *                uses the band's full width whatever the score distribution does. The exact
 *                opportunity_v2 stays in the tooltip and the dossier.
 *   ANGLE      = free inside the wedge. The relaxation may spend it freely.
 *
 * WHY THE OUTLIER-CLAMP MACHINERY IS GONE (and this is not a loss of honesty). The XY plate
 * clamped values beyond its fixed axis domains and drew an outward chevron, because a
 * linear axis over −100…+300 %/24m genuinely ends before the data does. The dial has no
 * such domain: the radial channel is a within-band RANK (always in range by construction)
 * and the angular channel is bounded by the wedge. Nothing can fall off this scale, so
 * there is nothing to pin and no chevron to draw.
 *
 * WHY THE "NO-XY STRIP" IS GONE (same reason). The strip existed because an EMERGING niche
 * has no trustworthy trend % and a row missing trend or saturation has no honest X or Y at
 * all. The dial asks a different question: every row has a VERDICT (radarVerdictTrace is
 * total), and emerging IS one of the five rings. So every row has an honest position.
 */

import { forceCollide, forceSimulation, type SimulationNodeDatum } from "d3-force";

import { RING_ORDER, hash01, type RadarRing } from "../lib/radarVerdict";

const TAU = Math.PI * 2;

// ---- the classes, which are the dial's sectors -------------------------------------------

/**
 * THE DIAL'S SECTOR IS THE NICHE CLASS. Genres / Micro-genres / Themes, in that order,
 * clockwise from 12 o'clock — the same vocabulary the board's class control has always
 * used and the same one `?class=` carries. (It used to be the tag TIER, back when only one
 * class could be on the board at a time and the tiers were the only thing left to put on
 * the angular axis. Three classes on one board is strictly more information in the same
 * space, and it is the reference's own structure.)
 */
export type RadarClass = "genre" | "micro" | "theme";

/** Sector order clockwise from 12 o'clock. Broadest class first: a genre is the coarsest
 * claim, a theme the most specific slice of taste. */
export const CLASS_ORDER: readonly RadarClass[] = ["genre", "micro", "theme"] as const;

export const CLASS_LABEL: Record<RadarClass, string> = {
  genre: "Genres",
  micro: "Micro-genres",
  theme: "Themes",
};

// ---- the plate ---------------------------------------------------------------------------

/** Width before the wrapper is measured — and the effective width under jsdom (tests),
 * where clientWidth is 0 and the fallback sticks. Exported so tests can name it. */
export const DEFAULT_PLATE_W = 928;

/** The dial never grows past this diameter: past it the rings stop gaining legibility and
 * start pushing the rail's first rows below the fold at 1440x900. MEASURED: the plate's
 * viewBox is 2R + 52 tall and the board's top edge sits ~227px down the page, so 620 is the
 * largest diameter whose 6 o'clock rim label still lands above 900. */
const DIAL_MAX = 620;
/** …and never shrinks below this, so the five bands stay separable on a 320px phone. */
const DIAL_MIN = 236;
/** Ring above and below the circle reserved for the rim labels and the zoom title. */
const RIM_PAD = 26;
/** HORIZONTAL reserve for the sector rim labels ("MICRO-GENRES · 27" runs ~130px, half of
 * it outside the dial at the wedge's mid angle). */
const RIM_PAD_SIDE = 78;
/** …but a PHONE cannot afford it. Reserving 156px of a 390px plate would halve the dial's
 * radius, which costs far more than the labels are worth, so a narrow plate gives the sides
 * up entirely and RadarBoard draws the three sectors as one honest caption line UNDER the
 * dial instead (the `compact` branch of ring-annotations). */
const RIM_PAD_SIDE_COMPACT = 8;

/**
 * BAND STOPS as fractions of the outer radius: the centre hole, then the five band edges
 * inner -> outer. THE REFERENCE'S PROPORTIONS: four bands of equal width after a slightly
 * larger inner disc (130 / 220 / 310 / 400 on radius 400). Ours are five, so: a centre hole
 * at 0.12, an inner band ~25% wider than the rest, then four equal bands.
 *
 * The hole exists so the innermost band is an annulus rather than a disc — a disc would
 * pile its best rows on top of each other at r≈0, the opposite of what "best in the middle"
 * should look like — and it gives the dial's centre mark a home.
 *
 * WHY THE POPULATION WEIGHTING IS GONE — CHECKED AGAINST THE LIVE DATA, not assumed. The
 * first cut sized each band by sqrt(row count), because on a one-class board the WATCH ring
 * carried 53 of the 80 plotted rows and equal fifths crushed them into a hairline. Measured
 * again on production through the dev proxy after the three-sector rebuild (solo-friendly
 * cut, Top 80 = the top 27 of each class, 63 blips): the fullest cell is theme x WATCH with
 * 15 rows, then micro x WATCH with 14 — 56% of a sector rather than 66% of the whole board,
 * spread over three times the arc. At r≈9.6 that cell fills ~40% of its annulus and the
 * force pass clears it with ZERO overlapping pairs, at Top 40, Top 80 and Top 120, on a
 * 1440x900 desktop dial and on a 390x844 phone. So WATCH is no longer overloaded and the
 * weighting has nothing left to buy.
 *
 * Equal bands are also what makes the dial READ as a scale: a band whose thickness moves
 * with its population quietly encodes a second variable in the same channel, and the
 * reference does not do that.
 */
export const RING_STOPS = [0.12, 0.33, 0.4975, 0.665, 0.8325, 1] as const;

/** The default band shares (fractions of the usable radius, inner -> outer), derived from
 * RING_STOPS. Exported because the geometry and the tests should read one source. */
export function bandShares(): number[] {
  const usable = 1 - RING_STOPS[0];
  return RING_ORDER.map((_, i) => (RING_STOPS[i + 1] - RING_STOPS[i]) / usable);
}

/** Band captions — ONE WORD, like the reference's ADOPT / TRIAL / ASSESS / HOLD. The full
 * ring wording ("Enter now") lives in the rail group header, the legend and the dossier;
 * a caption that has to clear its own arc pays for every extra character in blips it
 * pushes out of the way. */
const CAPTION: Record<RadarRing, string> = {
  enter: "ENTER",
  watch: "WATCH",
  emerging: "EMERGING",
  crowded: "CROWDED",
  declining: "DECLINING",
};

/** Below this radius the dial is a phone dial: smaller decor type. */
export const COMPACT_R = 200;

/** Approximate rendered width of a caption in the kicker face at 0.1em tracking. Only used
 * to size the caption's own angular gutter — an over-estimate costs a few degrees of arc, an
 * under-estimate costs a legible label, so it leans generous. */
const captionWidth = (text: string, size: number) => text.length * size * 0.66;

/** No band ever reserves more than this much arc on each side of 12 o'clock — a fifth of a
 * 120° wedge. Past it the caption would be buying its legibility with the sector's shape. */
const MAX_GUTTER = 0.45;

/** How far INSIDE its band's outer edge a caption sits, as a share of the band's width.
 * The reference's ring labels sit at `-ringRadius + 62` with a 42px face on a 90px band —
 * i.e. ~0.31 of the band in from the outer edge, measured on the baseline. */
const CAPTION_INSET = 0.3;

export interface RingBand {
  ring: RadarRing;
  /** Inner / outer radius in viewBox px. */
  r0: number;
  r1: number;
  /** Radius the band's midline sits at. */
  mid: number;
  /** The caption string, its font size and the radius its baseline sits at — the geometry
   * owns all three, because the band's angular GUTTER is derived from them. */
  caption: string;
  captionSize: number;
  captionR: number;
  /** Half the caption's rendered width in px (plus a little air). */
  captionHalf: number;
  /**
   * THE CAPTION GUTTER, in radians, on EACH side of 12 o'clock — and ONLY there. The band
   * captions are the reference's ADOPT/TRIAL/ASSESS/HOLD: one per band, stacked up the
   * vertical axis in the top half, painted UNDER the dots (wallpaper must not eat data).
   * 12 o'clock is a sector BOUNDARY on this dial, exactly as the reference's vertical axis
   * is a quadrant boundary, so the keep-out costs the two neighbouring wedges a little arc
   * at one edge and costs the other wedge nothing at all.
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
  /** True on a phone-sized dial: smaller decor type. */
  compact: boolean;
  /** The five bands, inner -> outer (RING_ORDER). While zoomed, the zoomed ring's band
   * spans the WHOLE dial (r0..R) and the other four are absent — see `bands`. */
  bands: RingBand[];
  band: (ring: RadarRing) => RingBand | undefined;
  /** The active zoom ring, or null for the full dial. */
  zoom: RadarRing | null;
}

export function ringGeom(plateW: number = DEFAULT_PLATE_W, zoom: RadarRing | null = null): RingGeom {
  const w = Math.max(240, Math.round(plateW));
  const fit = (side: number) => Math.min(DIAL_MAX, Math.max(DIAL_MIN, w - 2 * side), w - 8);
  // Try the roomy layout first; if the plate is narrow enough that the rim reserve would
  // push the dial into phone territory anyway, spend the sides on radius instead and move
  // the sector labels under the dial.
  let dial = fit(RIM_PAD_SIDE);
  if (dial / 2 < COMPACT_R) dial = fit(RIM_PAD_SIDE_COMPACT);
  const R = dial / 2;
  const cx = w / 2;
  const cy = RIM_PAD + R;
  const r0 = R * RING_STOPS[0];
  const compact = R < COMPACT_R;

  const mkBand = (ring: RadarRing, a: number, b: number): RingBand => {
    const caption = CAPTION[ring];
    // The caption's baseline sits just inside the band's OUTER edge (the reference's
    // -ringRadius + 62), and its size is bounded three ways: by the band it has to fit
    // inside, by the dial (so a huge plate doesn't grow wallpaper), and by its OWN GUTTER —
    // a caption wider than the arc it is allowed to reserve is a caption that will be
    // drawn through by blips, so it steps down instead of drowning.
    const capR = Math.max(8, b - (b - a) * CAPTION_INSET);
    const widthBudget = (2 * capR * MAX_GUTTER) / (caption.length * 0.66);
    const captionSize = Math.max(10, Math.min((b - a) * 0.5, R * 0.095, 28, widthBudget));
    const half = captionWidth(caption, captionSize) / 2 + 5;
    return {
      ring,
      r0: a,
      r1: b,
      mid: (a + b) / 2,
      caption,
      captionSize,
      captionR: capR,
      captionHalf: half,
      gutter: Math.min(MAX_GUTTER, half / capR),
    };
  };

  let bands: RingBand[];
  if (zoom) {
    bands = [mkBand(zoom, r0, R)];
  } else {
    const shares = bandShares();
    const usable = R - r0;
    bands = [];
    let edge = r0;
    for (let i = 0; i < RING_ORDER.length; i++) {
      const next = i === RING_ORDER.length - 1 ? R : edge + usable * shares[i];
      bands.push(mkBand(RING_ORDER[i], edge, next));
      edge = next;
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
  sector: RadarClass;
  /** Radians, SVG convention (0 = 3 o'clock, positive = clockwise on screen). */
  a0: number;
  a1: number;
  mid: number;
  /** True when this edge IS the 12 o'clock caption axis — the two wedges that touch it pay
   * the band's caption gutter there, and nobody else pays anything. */
  capStart: boolean;
  capEnd: boolean;
}

/** 12 o'clock, where the first sector starts and the band captions live. */
export const START_ANGLE = -Math.PI / 2;

/**
 * THE THREE SECTORS ALWAYS DRAW. Genres, Micro-genres and Themes each hold a fixed 120°
 * wedge whether or not they have rows at this cut — the opposite of the first cut, which
 * gave angle only to occupied sectors and therefore drew a single full-circle "sector" on
 * every real board. That was the density bug: one wedge doing the work of three.
 *
 * Fixed wedges also make the board STABLE. A niche does not migrate around the dial when
 * some other class empties out under a filter, and "the top left is themes" stays true from
 * one visit to the next. An empty class is drawn as an empty wedge with an honest `· 0` at
 * the rim, which is a fact about the cut, not a hole in the picture.
 */
export function sectorSpans(): SectorSpan[] {
  const span = TAU / CLASS_ORDER.length;
  return CLASS_ORDER.map((sector, i) => {
    const a0 = START_ANGLE + i * span;
    return {
      sector,
      a0,
      a1: a0 + span,
      mid: a0 + span / 2,
      capStart: i === 0,
      capEnd: i === CLASS_ORDER.length - 1,
    };
  });
}

/** Angular padding at a cell's two ends: a small pad off the divider spoke everywhere, plus
 * the band's caption gutter where the spoke IS the 12 o'clock caption axis. */
export function cellPads(band: RingBand, span: SectorSpan): { start: number; end: number } {
  return {
    start: SECTOR_EDGE_PAD + (span.capStart ? band.gutter : 0),
    end: SECTOR_EDGE_PAD + (span.capEnd ? band.gutter : 0),
  };
}

/** The area a (band x sector) cell actually offers the blips, after both pads. The crowd
 * fit in RadarBoard.tsx measures the worst cell against this. */
export function cellArea(band: RingBand, span: SectorSpan): number {
  const pads = cellPads(band, span);
  const arc = Math.max(0.05, span.a1 - span.a0 - pads.start - pads.end);
  return Math.max(1, (arc / 2) * (band.r1 * band.r1 - band.r0 * band.r0));
}

// ---- placement ---------------------------------------------------------------------------

/** What layoutRings needs from a row. Structural so RadarBoardBlip satisfies it. */
export interface RingInput {
  id: string;
  ring: RadarRing;
  sector: RadarClass;
  opportunity: number | null;
  /** Blip radius in viewBox px — the caller's P90-revenue scale. */
  r: number;
}

export interface RingPlaced {
  id: string;
  ring: RadarRing;
  sector: RadarClass;
  /** Distance from the dial's centre; always strictly inside the blip's own band. */
  radius: number;
  /** Radians; always inside the blip's own sector span. */
  angle: number;
  x: number;
  y: number;
  r: number;
  /** 0-based rank by opportunity_v2 inside this blip's own cell (band x sector) — the
   * rank that SEEDS the radius. */
  cellRank: number;
  cellSize: number;
  /** True when the row has no opportunity_v2 at all: it is ranked LAST in its cell and
   * flagged, so the legend/tooltip can say the radius is a fallback, not a reading. */
  unscored: boolean;
}

/** Clearance between two blip edges the collision force asks for — capped, but never more
 * than a quarter of the blip's own radius, so a phone dial that has already shrunk its dots
 * to fit does not then spend the room it bought on air between them. */
const blipGap = (r: number) => Math.min(2.2, r * 0.25);
/** Angular breathing room at a wedge's two edges (radians), so a blip never sits on a
 * divider spoke. */
const SECTOR_EDGE_PAD = 0.05;
/**
 * TICKS OF THE FORCE SIMULATION. Fixed, never "until convergence": a fixed count is what
 * makes the output reproducible byte-for-byte, and d3's alpha schedule is deterministic, so
 * the same seed plus the same tick count is the same board on every render and machine.
 * 180 is comfortably past the point where the collision force stops moving anything on a
 * 120-blip board (measured), and the whole run costs ~3ms.
 */
const TICKS = 180;

/**
 * The simulation's random source. forceCollide only reaches for it to break a PERFECT tie
 * (two blips at the identical point), which our rank seeding already makes near-impossible
 * — but "near-impossible" is not "deterministic", and this board's whole placement contract
 * is that a niche holds its spot across renders, visits and machines. A seeded LCG closes
 * the last hole; Math.random never runs.
 */
function lcg(seed: number): () => number {
  let s = (Math.floor(seed * 0x7fff_ffff) % 0x7fff_ffff) || 1;
  return () => {
    s = (s * 48_271) % 0x7fff_ffff;
    return s / 0x7fff_ffff;
  };
}

interface ForceNode extends SimulationNodeDatum {
  id: string;
  r: number;
  rank: number;
  cellSize: number;
  ring: RadarRing;
  sector: RadarClass;
  unscored: boolean;
  /** The cell's bounds — the clamp reads them every tick. */
  lo: number;
  hi: number;
  a0: number;
  arc: number;
  x: number;
  y: number;
}

export interface RingLayout {
  geom: RingGeom;
  sectors: SectorSpan[];
  placed: Map<string, RingPlaced>;
}

/**
 * Place every blip — D3-FORCE RELAXATION, exactly the way Zalando's radar does it, which is
 * what the reference's even segments come from.
 *
 *   1. SEED, deterministically, from the RANK. Per cell (ring band x sector): rank by
 *      opportunity_v2 desc, ties by id (unscored rows last); the radius spreads the ranks
 *      evenly across the band's usable width, inner edge = best; the angle walks a
 *      golden-ratio (phyllotaxis) stride across the wedge, offset per cell by hash01. The
 *      stride matters: consecutive ranks sit at nearly the same RADIUS, so sending them to
 *      opposite sides of the wedge means the pairs that DO end up near each other in angle
 *      are many ranks apart and therefore far apart in radius. That is a good starting
 *      configuration, and a good start is what lets a short run finish.
 *   2. RELAX with forceCollide(r + gap) over EVERY blip at once — across cells too, so a
 *      blip on one side of a band edge cannot sit on top of one just across it.
 *   3. CLAMP after every tick: each blip is pushed back inside its own (band, wedge), by
 *      radius and by angle. The band is the verdict and the wedge is the class; both are
 *      claims, and the relaxation may never spend either of them to buy space. This is
 *      Zalando's segment.clipx / clipy, in polar form.
 *
 * Deterministic: identical input -> identical output, byte for byte. Fixed tick count, no
 * convergence test, seeded random source, no Math.random anywhere.
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

  const nodes: ForceNode[] = [];
  let seedAcc = 0;

  for (const [key, members] of cells) {
    const band = geom.band(members[0].ring)!;
    const span = spanBySector.get(members[0].sector) ?? fallback;
    const pads = cellPads(band, span);
    const a0 = span.a0 + pads.start;
    const arc = Math.max(1e-6, span.a1 - span.a0 - pads.start - pads.end);

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
    const roomy = width > 2 * inset;
    const lo = roomy ? band.r0 + inset : band.mid;
    const hi = roomy ? band.r1 - inset : band.mid;

    const seed = hash01(`${key}|ring-angle`);
    seedAcc += seed;
    for (let i = 0; i < n; i++) {
      const b = ordered[i];
      const t = n === 1 ? 0.5 : (i + 0.5) / n;
      const radius = lo + t * (hi - lo);
      const frac = (seed + i * 0.618_033_988_749_895) % 1;
      const angle = a0 + frac * arc;
      nodes.push({
        id: b.id,
        r: b.r,
        rank: i,
        cellSize: n,
        ring: b.ring,
        sector: b.sector,
        unscored: b.opportunity === null,
        // Each node carries its own cell bounds, inset by ITS OWN radius so the whole
        // circle stays inside the band, not just its centre.
        lo: roomy ? band.r0 + b.r + 1 : band.mid,
        hi: roomy ? band.r1 - b.r - 1 : band.mid,
        a0,
        arc,
        x: geom.cx + Math.cos(angle) * radius,
        y: geom.cy + Math.sin(angle) * radius,
      });
    }
  }

  if (nodes.length > 0) {
    /** One clamp pass: every blip back inside its own band and its own wedge. */
    const clamp = () => {
      for (const nd of nodes) {
        const dx = nd.x - geom.cx;
        const dy = nd.y - geom.cy;
        let radius = Math.hypot(dx, dy);
        let angle = Math.atan2(dy, dx);
        // ANGLE: measure the offset into the wedge, then clamp — or, if the blip has left
        // the wedge entirely, snap it back to whichever edge it left by.
        let off = (angle - nd.a0) % TAU;
        if (off < 0) off += TAU;
        if (off > nd.arc) off = off - nd.arc < TAU - off ? nd.arc : 0;
        angle = nd.a0 + Math.min(Math.max(off, 0), nd.arc);
        // RADIUS: inside the band, whole circle included.
        radius = Math.min(Math.max(radius, nd.lo), Math.max(nd.lo, nd.hi));
        nd.x = geom.cx + Math.cos(angle) * radius;
        nd.y = geom.cy + Math.sin(angle) * radius;
      }
    };

    const sim = forceSimulation<ForceNode>(nodes)
      .randomSource(lcg((seedAcc + nodes.length * 0.017) % 1))
      .velocityDecay(0.32)
      .force(
        "collide",
        forceCollide<ForceNode>()
          .radius((d) => d.r + blipGap(d.r))
          .strength(0.9)
          .iterations(2),
      )
      .stop();
    for (let i = 0; i < TICKS; i++) {
      sim.tick();
      clamp();
    }
  }

  for (const nd of nodes) {
    const dx = nd.x - geom.cx;
    const dy = nd.y - geom.cy;
    out.set(nd.id, {
      id: nd.id,
      ring: nd.ring,
      sector: nd.sector,
      radius: Math.hypot(dx, dy),
      angle: Math.atan2(dy, dx),
      x: nd.x,
      y: nd.y,
      r: nd.r,
      cellRank: nd.rank,
      cellSize: nd.cellSize,
      unscored: nd.unscored,
    });
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

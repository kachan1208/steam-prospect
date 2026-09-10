import { describe, expect, it } from "vitest";

import {
  CLASS_ORDER,
  DEFAULT_PLATE_W,
  RING_STOPS,
  START_ANGLE,
  bandShares,
  cellPads,
  layoutRings,
  ringGeom,
  sectorSpans,
  type RadarClass,
  type RingInput,
} from "./radarRings";
import { RING_ORDER, type RadarRing } from "../lib/radarVerdict";

/**
 * THE PLACEMENT CONTRACT of the concentric-ring dial (2026-09-10, rebuilt the same day for
 * three class sectors and d3-force relaxation). Four of these are invariants the board's
 * whole meaning rests on, so they are asserted on the PURE function rather than through the
 * DOM:
 *
 *   1. A BLIP LANDS IN THE BAND ITS VERDICT NAMES — and its whole circle does, edges
 *      included. Position IS the verdict now; a dot half a radius into the neighbouring
 *      band is a dot claiming the wrong call.
 *   2. A BLIP LANDS IN THE SECTOR ITS CLASS NAMES — same reason, on the angular axis. The
 *      relaxation may move a blip freely INSIDE its (band, wedge) cell and never out of it.
 *   3. opportunity_v2 SEEDS THE BAND: higher score, smaller starting radius (nearer the
 *      middle), and the cell rank records it.
 *   4. TWO BLIPS DO NOT OVERLAP — the force pass is the only reason a crowded segment stays
 *      readable, and it must leave zero overlapping pairs on a realistic board.
 *
 * Plus the allocation rules the geometry makes: the rings run best-in-the-middle in
 * RING_ORDER at roughly equal width, all three class wedges always hold angle, and the
 * layout is byte-for-byte reproducible.
 */

const TAU = Math.PI * 2;

function blip(over: Partial<RingInput> & { id: string }): RingInput {
  return { ring: "watch", sector: "micro", opportunity: 50, r: 9, ...over };
}

/** Angular distance from `a` to the sector [a0, a1), walking clockwise from a0. */
function withinSector(angle: number, a0: number, a1: number): boolean {
  const span = a1 - a0;
  if (Math.abs(span - TAU) < 1e-9) return true; // a full circle contains every angle
  let d = (angle - a0) % TAU;
  if (d < 0) d += TAU;
  return d <= span + 1e-9;
}

/** Overlapping pairs among a set of placed circles — the number the rebuild is judged on. */
function overlaps(pts: { x: number; y: number; r: number }[]): number {
  let n = 0;
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) {
      if (Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y) < pts[i].r + pts[j].r - 1e-6) n += 1;
    }
  }
  return n;
}

describe("ringGeom — the verdict rings, best in the middle", () => {
  it("stacks the five bands in RING_ORDER from the centre out", () => {
    const g = ringGeom();
    expect(g.bands.map((b) => b.ring)).toEqual(RING_ORDER);
    // Strictly ascending, contiguous, and the outermost edge IS the dial's radius.
    let prev = g.r0;
    for (const b of g.bands) {
      expect(b.r0).toBeCloseTo(prev, 6);
      expect(b.r1).toBeGreaterThan(b.r0);
      prev = b.r1;
    }
    expect(prev).toBeCloseTo(g.R, 6);
    // "enter" is the innermost band — the whole point of the form.
    expect(g.bands[0].ring).toBe("enter");
    expect(g.bands[0].r0).toBeCloseTo(g.R * RING_STOPS[0], 6);
    // …and the outermost is "declining".
    expect(g.bands[g.bands.length - 1].ring).toBe("declining");
  });

  it("gives the bands the REFERENCE'S proportions: equal width after a larger inner disc", () => {
    // Measured off https://solidgate-tech.github.io/ : ring radii 130 / 220 / 310 / 400 on
    // radius 400 — four equal 90px bands after a wider inner disc. Ours is five bands, same
    // shape: the four outer ones are equal to each other, the inner one is wider.
    const g = ringGeom();
    const widths = g.bands.map((b) => b.r1 - b.r0);
    for (let i = 2; i < widths.length; i++) expect(widths[i]).toBeCloseTo(widths[1], 6);
    expect(widths[0]).toBeGreaterThan(widths[1]);
    expect(widths[0]).toBeLessThan(widths[1] * 1.5);
  });

  it("keeps a centre hole so the best rows spread instead of piling on r = 0", () => {
    const g = ringGeom();
    expect(g.r0).toBeGreaterThan(0);
    expect(g.r0).toBeLessThan(g.bands[0].r1);
  });

  it("is square-ish and fits its own viewBox at every width", () => {
    for (const w of [320, 390, 700, DEFAULT_PLATE_W, 1400]) {
      const g = ringGeom(w);
      expect(g.plateW).toBe(Math.max(240, w));
      expect(g.cx).toBeCloseTo(g.plateW / 2, 6);
      expect(g.cy - g.R).toBeGreaterThanOrEqual(0);
      expect(g.cy + g.R).toBeLessThanOrEqual(g.vbH);
      // The dial never grows past its cap, so a very wide container doesn't push the rail
      // below the fold.
      expect(2 * g.R).toBeLessThanOrEqual(640);
    }
  });

  it("a zoom gives the zoomed ring the WHOLE dial and drops the other four", () => {
    const g = ringGeom(DEFAULT_PLATE_W, "enter");
    expect(g.bands.map((b) => b.ring)).toEqual(["enter"]);
    expect(g.bands[0].r0).toBeCloseTo(g.r0, 6);
    expect(g.bands[0].r1).toBeCloseTo(g.R, 6);
    for (const ring of RING_ORDER.filter((r) => r !== "enter")) expect(g.band(ring)).toBeUndefined();
  });
});

describe("bandShares — one fixed scale, no population weighting", () => {
  it("reproduces RING_STOPS exactly and sums to the whole usable radius", () => {
    const shares = bandShares();
    const usable = 1 - RING_STOPS[0];
    for (let i = 0; i < shares.length; i++) {
      expect(shares[i]).toBeCloseTo((RING_STOPS[i + 1] - RING_STOPS[i]) / usable, 10);
    }
    expect(shares.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10);
  });

  it("does not move with the population — a band's thickness is not a second variable", () => {
    // The first cut weighted band width by sqrt(row count); three sectors plus a per-class
    // Top-N took the worst cell from 66% of the board to 44%, so the weighting is gone and
    // the geometry no longer depends on who is on the board at all.
    const a = ringGeom(DEFAULT_PLATE_W).bands.map((b) => [b.r0, b.r1]);
    const b = ringGeom(DEFAULT_PLATE_W).bands.map((x) => [x.r0, x.r1]);
    expect(a).toEqual(b);
  });
});

describe("the band captions — the reference's ADOPT / TRIAL / ASSESS / HOLD", () => {
  const geom = ringGeom();

  it("is ONE WORD per band, sitting just inside that band's OUTER edge", () => {
    // Zalando's radar puts its ring label at `-ringRadius + 62` with a 42px face: near the
    // outer edge of the band, in the top half, on the vertical axis.
    for (const band of geom.bands) {
      expect(band.caption).not.toContain(" ");
      expect(band.captionR).toBeGreaterThan(band.r0);
      expect(band.captionR).toBeLessThan(band.r1);
      expect(band.captionR).toBeGreaterThan(band.mid); // outer half of the band
      expect(band.captionSize).toBeGreaterThanOrEqual(10);
    }
    expect(geom.band("enter")!.caption).toBe("ENTER");
    expect(geom.band("declining")!.caption).toBe("DECLINING");
  });

  it("reserves arc at 12 o'clock sized to the caption, bounded so it can't reshape a wedge", () => {
    for (const band of geom.bands) {
      expect(band.gutter).toBeGreaterThan(0);
      expect(band.gutter).toBeLessThanOrEqual(0.45);
      // Either wide enough for the caption it protects, or clamped at the ceiling.
      expect(band.gutter >= band.captionHalf / band.captionR - 1e-9 || band.gutter === 0.45).toBe(true);
    }
  });

  it("charges that gutter ONLY to the two wedges that touch 12 o'clock", () => {
    const [first, middle, last] = sectorSpans();
    const band = geom.band("watch")!;
    expect(cellPads(band, first).start).toBeCloseTo(cellPads(band, first).end + band.gutter, 6);
    expect(cellPads(band, last).end).toBeCloseTo(cellPads(band, last).start + band.gutter, 6);
    // The wedge across the dial from the caption axis pays nothing at either end.
    expect(cellPads(band, middle).start).toBeCloseTo(cellPads(band, middle).end, 10);
    expect(cellPads(band, middle).start).toBeLessThan(band.gutter);
  });

  it("keeps blips out of the caption's arc, so the label is never buried", () => {
    const spans = sectorSpans();
    const rows: RingInput[] = CLASS_ORDER.flatMap((sector) =>
      Array.from({ length: 12 }, (_, i) => blip({ id: `${sector}-${i}`, sector, opportunity: 90 - i })),
    );
    const placed = layoutRings(rows, geom, spans);
    const band = geom.band("watch")!;
    for (const row of rows) {
      const p = placed.get(row.id)!;
      // Angular distance from straight up (START_ANGLE).
      let d = Math.abs(((p.angle - START_ANGLE + Math.PI) % TAU) - Math.PI);
      d = Math.min(d, TAU - d);
      expect(d).toBeGreaterThanOrEqual(band.gutter - 1e-6);
    }
  });
});

describe("sectorSpans — three class wedges, always", () => {
  it("splits the circle into three equal 120° wedges in CLASS_ORDER from 12 o'clock", () => {
    const spans = sectorSpans();
    expect(spans.map((s) => s.sector)).toEqual([...CLASS_ORDER]);
    for (const s of spans) expect(s.a1 - s.a0).toBeCloseTo(TAU / 3, 6);
    expect(spans[0].a0).toBeCloseTo(START_ANGLE, 6);
    // Contiguous, no gap and no overlap, all the way round.
    expect(spans[1].a0).toBeCloseTo(spans[0].a1, 6);
    expect(spans[2].a0).toBeCloseTo(spans[1].a1, 6);
    expect(spans[2].a1).toBeCloseTo(START_ANGLE + TAU, 6);
  });

  it("marks the 12 o'clock caption axis on exactly the two wedges that touch it", () => {
    const spans = sectorSpans();
    expect(spans.map((s) => s.capStart)).toEqual([true, false, false]);
    expect(spans.map((s) => s.capEnd)).toEqual([false, false, true]);
  });

  it("is stable — a class holds its wedge whether or not it has rows at this cut", () => {
    // The whole point of fixed wedges: a niche never migrates round the dial because some
    // other class emptied out under a filter.
    expect(sectorSpans()).toEqual(sectorSpans());
  });
});

describe("layoutRings — band, sector, order, separation", () => {
  const geom = ringGeom();
  const spans = sectorSpans();

  it("puts every blip's WHOLE circle inside the band its verdict names", () => {
    const rows: RingInput[] = RING_ORDER.flatMap((ring: RadarRing, i) =>
      Array.from({ length: 6 }, (_, k) => blip({ id: `${ring}-${k}`, ring, opportunity: 90 - k * 7 - i })),
    );
    const placed = layoutRings(rows, geom, spans);
    expect(placed.size).toBe(rows.length);
    for (const row of rows) {
      const p = placed.get(row.id)!;
      const band = geom.band(row.ring)!;
      expect(p.ring).toBe(row.ring);
      // The circle's own edges, not just its centre — a dot spilling across a band edge is
      // a dot claiming the wrong verdict.
      expect(p.radius - p.r).toBeGreaterThanOrEqual(band.r0 - 1e-6);
      expect(p.radius + p.r).toBeLessThanOrEqual(band.r1 + 1e-6);
      // x/y agree with the polar coordinates the invariants are stated in.
      expect(Math.hypot(p.x - geom.cx, p.y - geom.cy)).toBeCloseTo(p.radius, 6);
    }
  });

  it("puts every blip inside the wedge its CLASS names", () => {
    const rows = CLASS_ORDER.flatMap((sector: RadarClass) =>
      Array.from({ length: 9 }, (_, k) => blip({ id: `${sector}-${k}`, sector, opportunity: 80 - k })),
    );
    const placed = layoutRings(rows, geom, spans);
    for (const row of rows) {
      const p = placed.get(row.id)!;
      const span = spans.find((s) => s.sector === row.sector)!;
      expect(p.sector).toBe(row.sector);
      expect(withinSector(p.angle, span.a0, span.a1)).toBe(true);
    }
  });

  it("seeds a band by opportunity_v2 — the higher score ranks nearer the middle", () => {
    const rows = [
      blip({ id: "low", opportunity: 12 }),
      blip({ id: "high", opportunity: 88 }),
      blip({ id: "mid", opportunity: 50 }),
    ];
    const placed = layoutRings(rows, geom, spans);
    const r = (id: string) => placed.get(id)!.radius;
    expect(r("high")).toBeLessThan(r("mid"));
    expect(r("mid")).toBeLessThan(r("low"));
    expect(placed.get("high")!.cellRank).toBe(0);
    expect(placed.get("low")!.cellRank).toBe(2);
  });

  it("ranks an UNSCORED row last in its cell and says so, instead of inventing a score", () => {
    const rows = [
      blip({ id: "scored-low", opportunity: 3 }),
      blip({ id: "unscored", opportunity: null }),
      blip({ id: "scored-high", opportunity: 70 }),
    ];
    const placed = layoutRings(rows, geom, spans);
    expect(placed.get("unscored")!.unscored).toBe(true);
    expect(placed.get("unscored")!.cellRank).toBe(2);
    expect(placed.get("scored-low")!.unscored).toBe(false);
    expect(placed.get("unscored")!.radius).toBeGreaterThan(placed.get("scored-low")!.radius);
  });

  it("never lets two blips of the same cell coincide — even at identical scores", () => {
    // 14 identical rows: same ring, same sector, same score, same size. Nothing but the
    // relaxation can separate them.
    const rows = Array.from({ length: 14 }, (_, i) => blip({ id: `same-${i}`, opportunity: 50 }));
    const placed = layoutRings(rows, geom, spans);
    const pts = rows.map((row) => placed.get(row.id)!);
    for (let i = 0; i < pts.length; i++) {
      for (let j = i + 1; j < pts.length; j++) {
        expect(Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y)).toBeGreaterThan(1);
      }
    }
  });

  it("leaves ZERO overlapping pairs on a live-shaped board", () => {
    // The live production shape at Top 80 (solo-friendly cut, top 27 of each class): the
    // genre wedge is genuinely sparse, the two tag wedges carry the load, and WATCH is the
    // fullest band in each.
    const shape: Record<RadarClass, Partial<Record<RadarRing, number>>> = {
      genre: { watch: 5, crowded: 4 },
      micro: { enter: 6, watch: 12, emerging: 3, crowded: 5, declining: 1 },
      theme: { enter: 6, watch: 13, crowded: 7, declining: 1 },
    };
    const rows: RingInput[] = [];
    for (const sector of CLASS_ORDER) {
      for (const ring of RING_ORDER) {
        const n = shape[sector][ring] ?? 0;
        for (let i = 0; i < n; i++) {
          rows.push(blip({ id: `${sector}-${ring}-${i}`, sector, ring, opportunity: 90 - i, r: 10 }));
        }
      }
    }
    const placed = layoutRings(rows, geom, spans);
    expect(overlaps(rows.map((row) => placed.get(row.id)!))).toBe(0);
    // …and every one of them is still in its own band AND its own wedge: the relaxation may
    // never buy space with a claim.
    for (const row of rows) {
      const p = placed.get(row.id)!;
      const band = geom.band(row.ring)!;
      const span = spans.find((s) => s.sector === row.sector)!;
      expect(p.radius - p.r).toBeGreaterThanOrEqual(band.r0 - 1e-6);
      expect(p.radius + p.r).toBeLessThanOrEqual(band.r1 + 1e-6);
      expect(withinSector(p.angle, span.a0, span.a1)).toBe(true);
    }
  });

  it("separates a CROWDED cell without touching, inside one band and one wedge", () => {
    const band = geom.band("watch")!;
    const span = spans.find((s) => s.sector === "micro")!;
    const rows = Array.from({ length: 20 }, (_, i) => blip({ id: `w-${i}`, opportunity: 90 - i, r: 8 }));
    const placed = layoutRings(rows, geom, spans);
    const pts = rows.map((row) => placed.get(row.id)!);
    expect(overlaps(pts)).toBe(0);
    for (const p of pts) {
      expect(p.radius - p.r).toBeGreaterThanOrEqual(band.r0 - 1e-6);
      expect(p.radius + p.r).toBeLessThanOrEqual(band.r1 + 1e-6);
      expect(withinSector(p.angle, span.a0, span.a1)).toBe(true);
    }
  });

  it("fills a segment EVENLY — no half the wedge packed and the other half empty", () => {
    // The lumpiness the force pass exists to remove: split the cell's usable arc in half and
    // both halves must carry a fair share of the blips.
    const rows = Array.from({ length: 16 }, (_, i) => blip({ id: `e-${i}`, ring: "crowded", opportunity: 90 - i }));
    const placed = layoutRings(rows, geom, spans);
    const span = spans.find((s) => s.sector === "micro")!;
    const half = (span.a0 + span.a1) / 2;
    let low = 0;
    for (const row of rows) {
      let off = (placed.get(row.id)!.angle - span.a0) % TAU;
      if (off < 0) off += TAU;
      if (off < half - span.a0) low += 1;
    }
    expect(low).toBeGreaterThanOrEqual(5);
    expect(low).toBeLessThanOrEqual(11);
  });

  it("is exactly reproducible call-to-call — a fixed tick count and a seeded random source", () => {
    const rows = Array.from({ length: 30 }, (_, i) =>
      blip({ id: `r-${i}`, sector: CLASS_ORDER[i % 3], opportunity: 70 - i }),
    );
    const a = layoutRings(rows, geom, spans);
    const b = layoutRings(rows, geom, spans);
    for (const row of rows) {
      expect(a.get(row.id)).toEqual(b.get(row.id));
    }
    // Order of the INPUT rows must not change the output either: the cell sort is total.
    const shuffled = [...rows].reverse();
    const c = layoutRings(shuffled, geom, spans);
    for (const row of rows) expect(c.get(row.id)).toEqual(a.get(row.id));
  });

  it("places nothing for a band the geometry does not hold (a zoom hides the other four)", () => {
    const zoomed = ringGeom(DEFAULT_PLATE_W, "enter");
    const placed = layoutRings(
      [blip({ id: "in", ring: "enter" }), blip({ id: "out", ring: "crowded" })],
      zoomed,
      spans,
    );
    expect(placed.get("in")).toBeTruthy();
    expect(placed.get("out")).toBeUndefined();
    // The zoomed band is the whole dial, so its member spreads across the full radius.
    expect(placed.get("in")!.radius).toBeGreaterThan(zoomed.r0);
    expect(placed.get("in")!.radius).toBeLessThan(zoomed.R);
  });
});

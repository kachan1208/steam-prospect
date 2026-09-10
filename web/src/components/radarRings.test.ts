import { describe, expect, it } from "vitest";

import {
  DEFAULT_PLATE_W,
  RING_STOPS,
  START_ANGLE,
  bandShares,
  layoutRings,
  ringGeom,
  sectorSpans,
  type RingInput,
} from "./radarRings";
import { RING_ORDER, TIER_SECTOR_ORDER, type RadarRing, type RadarTierSector } from "../lib/radarVerdict";

/**
 * THE PLACEMENT CONTRACT of the concentric-ring dial (2026-09-10). Three of these are
 * invariants the board's whole meaning rests on, so they are asserted on the PURE function
 * rather than through the DOM:
 *
 *   1. A BLIP LANDS IN THE BAND ITS VERDICT NAMES — and its whole circle does, edges
 *      included. Position IS the verdict now; a dot half a radius into the neighbouring
 *      band is a dot claiming the wrong call.
 *   2. A BLIP LANDS IN THE SECTOR ITS TIER NAMES — same reason, on the angular axis.
 *   3. opportunity_v2 ORDERS THE BAND: higher score, smaller radius (nearer the middle).
 *   4. TWO BLIPS IN THE SAME CELL DO NOT COINCIDE — the collision pass is the only reason
 *      a crowded band stays readable, and it may only spend the ANGLE to do it.
 *
 * Plus the two allocation rules the geometry makes: rings run best-in-the-middle in
 * RING_ORDER, and angle goes only to the tiers that actually have rows.
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
      expect(2 * g.R).toBeLessThanOrEqual(620);
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

describe("bandShares — the bands breathe with the population, bounded", () => {
  it("with no counts it reproduces the default stops exactly", () => {
    const shares = bandShares();
    const usable = 1 - RING_STOPS[0];
    for (let i = 0; i < shares.length; i++) {
      expect(shares[i]).toBeCloseTo((RING_STOPS[i + 1] - RING_STOPS[i]) / usable, 10);
    }
  });

  it("gives the crowded ring more radius than the empty one, and always sums to the dial", () => {
    // The live micro-genre cut's shape: watch carries most of the board, declining one row.
    const shares = bandShares({ enter: 8, watch: 53, emerging: 8, crowded: 10, declining: 1 });
    const byRing = new Map(RING_ORDER.map((r, i) => [r, shares[i]]));
    expect(byRing.get("watch")!).toBeGreaterThan(byRing.get("declining")! * 1.5);
    expect(byRing.get("crowded")!).toBeGreaterThan(byRing.get("declining")!);
    expect(shares.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10);
  });

  it("never starves a ring below its floor — an empty verdict is still a legible band", () => {
    const shares = bandShares({ watch: 400 });
    for (const s of shares) expect(s).toBeGreaterThanOrEqual(0.11);
    // …and the geometry it produces is still contiguous, inner -> outer.
    const g = ringGeom(DEFAULT_PLATE_W, null, 1, { watch: 400 });
    expect(g.bands.map((b) => b.ring)).toEqual(RING_ORDER);
    let prev = g.r0;
    for (const b of g.bands) {
      expect(b.r0).toBeCloseTo(prev, 6);
      prev = b.r1;
    }
    expect(prev).toBeCloseTo(g.R, 6);
  });
});

describe("the caption gutter — a band's blips leave room for the words inside it", () => {
  const geom = ringGeom();
  const oneSector = sectorSpans(["micro"]);

  it("reserves arc at 12 o'clock, sized to the caption, on every band", () => {
    for (const band of geom.bands) {
      expect(band.gutter).toBeGreaterThan(0);
      expect(band.gutter).toBeLessThanOrEqual(0.62);
      // Wide enough for the caption it is protecting, or clamped at the ceiling.
      expect(band.gutter >= band.captionHalf / band.mid - 1e-9 || band.gutter === 0.62).toBe(true);
    }
  });

  it("keeps blips out of that arc, so the wallpaper caption is never buried", () => {
    const rows: RingInput[] = Array.from({ length: 40 }, (_, i) => ({
      id: `w-${i}`,
      ring: "watch" as const,
      sector: "micro" as const,
      opportunity: 90 - i,
      r: 9,
    }));
    const placed = layoutRings(rows, geom, oneSector);
    const band = geom.band("watch")!;
    for (const row of rows) {
      const p = placed.get(row.id)!;
      // Angular distance from straight up (START_ANGLE).
      let d = Math.abs(((p.angle - START_ANGLE + Math.PI) % (Math.PI * 2)) - Math.PI);
      d = Math.min(d, Math.PI * 2 - d);
      expect(d).toBeGreaterThanOrEqual(band.gutter - 1e-6);
    }
  });
});

describe("sectorSpans — angle goes only to the tiers that have rows", () => {
  it("gives a single occupied tier the whole circle (no wedge, so no divider spoke)", () => {
    const [only] = sectorSpans(["micro"]);
    expect(only.sector).toBe("micro");
    expect(only.a0).toBeCloseTo(START_ANGLE, 6);
    expect(only.a1 - only.a0).toBeCloseTo(TAU, 6);
  });

  it("splits the circle equally between the occupied tiers, in TIER_SECTOR_ORDER", () => {
    // Deliberately out of order on the way in — the dial's order is the vocabulary's.
    const spans = sectorSpans(["ungrouped", "theme", "micro"]);
    expect(spans.map((s) => s.sector)).toEqual(["micro", "theme", "ungrouped"]);
    for (const s of spans) expect(s.a1 - s.a0).toBeCloseTo(TAU / 3, 6);
    expect(spans[0].a0).toBeCloseTo(START_ANGLE, 6); // first sector starts at 12 o'clock
    // Contiguous, no gap and no overlap.
    expect(spans[1].a0).toBeCloseTo(spans[0].a1, 6);
    expect(spans[2].a1).toBeCloseTo(START_ANGLE + TAU, 6);
  });

  it("never leaves an empty tier holding angle", () => {
    const spans = sectorSpans(["meta"]);
    expect(spans).toHaveLength(1);
    expect(spans[0].sector).toBe("meta");
    for (const s of TIER_SECTOR_ORDER.filter((t) => t !== "meta")) {
      expect(spans.some((x) => x.sector === s)).toBe(false);
    }
  });
});

describe("layoutRings — band, sector, order, separation", () => {
  const geom = ringGeom();
  const oneSector = sectorSpans(["micro"]);

  it("puts every blip's WHOLE circle inside the band its verdict names", () => {
    const rows: RingInput[] = RING_ORDER.flatMap((ring: RadarRing, i) =>
      Array.from({ length: 6 }, (_, k) => blip({ id: `${ring}-${k}`, ring, opportunity: 90 - k * 7 - i })),
    );
    const placed = layoutRings(rows, geom, oneSector);
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

  it("puts every blip inside the sector its tier names", () => {
    const tiers: RadarTierSector[] = ["micro", "theme", "umbrella", "meta"];
    const spans = sectorSpans(tiers);
    const rows = tiers.flatMap((sector) =>
      Array.from({ length: 5 }, (_, k) => blip({ id: `${sector}-${k}`, sector, opportunity: 80 - k })),
    );
    const placed = layoutRings(rows, geom, spans);
    for (const row of rows) {
      const p = placed.get(row.id)!;
      const span = spans.find((s) => s.sector === row.sector)!;
      expect(p.sector).toBe(row.sector);
      expect(withinSector(p.angle, span.a0, span.a1)).toBe(true);
    }
  });

  it("orders a band by opportunity_v2 — higher score, nearer the middle", () => {
    const rows = [
      blip({ id: "low", opportunity: 12 }),
      blip({ id: "high", opportunity: 88 }),
      blip({ id: "mid", opportunity: 50 }),
    ];
    const placed = layoutRings(rows, geom, oneSector);
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
    const placed = layoutRings(rows, geom, oneSector);
    expect(placed.get("unscored")!.unscored).toBe(true);
    expect(placed.get("unscored")!.cellRank).toBe(2);
    expect(placed.get("scored-low")!.unscored).toBe(false);
    expect(placed.get("unscored")!.radius).toBeGreaterThan(placed.get("scored-low")!.radius);
  });

  it("never lets two blips of the same cell coincide — even at identical scores", () => {
    // 24 identical rows: same ring, same sector, same score, same size. Nothing but the
    // placement can separate them.
    const rows = Array.from({ length: 24 }, (_, i) => blip({ id: `same-${i}`, opportunity: 50 }));
    const placed = layoutRings(rows, geom, oneSector);
    const pts = rows.map((row) => placed.get(row.id)!);
    for (let i = 0; i < pts.length; i++) {
      for (let j = i + 1; j < pts.length; j++) {
        expect(Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y)).toBeGreaterThan(1);
      }
    }
  });

  it("separates a CROWDED cell without touching — the collision pass spends angle only", () => {
    const band = geom.band("watch")!;
    const rows = Array.from({ length: 40 }, (_, i) => blip({ id: `w-${i}`, opportunity: 90 - i, r: 8 }));
    const placed = layoutRings(rows, geom, oneSector);
    const pts = rows.map((row) => placed.get(row.id)!);
    let overlaps = 0;
    for (let i = 0; i < pts.length; i++) {
      for (let j = i + 1; j < pts.length; j++) {
        if (Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y) < pts[i].r + pts[j].r) overlaps += 1;
      }
    }
    expect(overlaps).toBe(0);
    // …and every one of them is still inside its own band: the nudge may never buy space
    // with the radius, because the radius is a claim.
    for (const p of pts) {
      expect(p.radius - p.r).toBeGreaterThanOrEqual(band.r0 - 1e-6);
      expect(p.radius + p.r).toBeLessThanOrEqual(band.r1 + 1e-6);
    }
  });

  it("keeps a wedge's crowded cell inside its own wedge (the nudge is clamped, not wrapped)", () => {
    const spans = sectorSpans(["micro", "theme", "umbrella", "meta"]);
    const span = spans.find((s) => s.sector === "theme")!;
    const rows = Array.from({ length: 18 }, (_, i) =>
      blip({ id: `t-${i}`, sector: "theme", ring: "enter", opportunity: 80 - i, r: 9 }),
    );
    const placed = layoutRings(rows, geom, spans);
    for (const row of rows) {
      expect(withinSector(placed.get(row.id)!.angle, span.a0, span.a1)).toBe(true);
    }
  });

  it("is exactly reproducible call-to-call — no Math.random anywhere in the placement", () => {
    const rows = Array.from({ length: 30 }, (_, i) => blip({ id: `r-${i}`, opportunity: 70 - i }));
    const a = layoutRings(rows, geom, oneSector);
    const b = layoutRings(rows, geom, oneSector);
    for (const row of rows) {
      expect(a.get(row.id)).toEqual(b.get(row.id));
    }
  });

  it("places nothing for a band the geometry does not hold (a zoom hides the other four)", () => {
    const zoomed = ringGeom(DEFAULT_PLATE_W, "enter");
    const placed = layoutRings(
      [blip({ id: "in", ring: "enter" }), blip({ id: "out", ring: "crowded" })],
      zoomed,
      oneSector,
    );
    expect(placed.get("in")).toBeTruthy();
    expect(placed.get("out")).toBeUndefined();
    // The zoomed band is the whole dial, so its member spreads across the full radius.
    expect(placed.get("in")!.radius).toBeGreaterThan(zoomed.r0);
    expect(placed.get("in")!.radius).toBeLessThan(zoomed.R);
  });
});

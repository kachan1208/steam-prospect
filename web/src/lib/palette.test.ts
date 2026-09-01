import { describe, expect, it } from "vitest";

import { COMPARE_SERIES, compareSeries } from "./palette";

/**
 * A2 — the Compare overlay's series encoding.
 *
 * The defect these pin, measured on production /compare?ids=730,1962700,2393160 at 1440,
 * 1024 and 390 (2026-09-01), against the chart ground #1d2d3d:
 *
 *   slot 1  #b5d9fd                        9.57:1 on the ground
 *   slot 2  rgba(242,242,243,.75) = #bdc1c6  7.74:1   slot 1 vs 2 = 1.24:1
 *   slot 3  rgba(242,242,243,.65) = #a7adb3  6.21:1   slot 2 vs 3 = 1.25:1
 *   slot 6  rgba(242,242,243,.35) = #68727d  2.86:1   — below the 3:1 floor entirely
 *
 * WCAG 1.4.11 asks 3:1 of adjacent graphical objects, and no line carried any non-colour
 * mark, so three games were three shades of one grey.
 */

// The one ground every chart in the app is drawn on — the theme is pinned to dark
// (lib/theme.tsx), and this is --page-plane / the panel fill in .dark.
const GROUND = "#1d2d3d";

function rgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
}

/** WCAG 2.1 relative luminance + contrast ratio. */
function relLum([r, g, b]: [number, number, number]): number {
  const f = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
function contrast(a: string, b: string): number {
  const [hi, lo] = [relLum(rgb(a)), relLum(rgb(b))].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

describe("contrast helper", () => {
  it("reproduces two known WCAG ratios, so the assertions below mean something", () => {
    expect(contrast("#ffffff", "#000000")).toBeCloseTo(21, 1);
    // The measured before-value this whole fix exists for.
    expect(contrast("#bdc1c6", "#a7adb3")).toBeCloseTo(1.25, 2);
  });
});

describe("COMPARE_SERIES — every slot is legible against the ground", () => {
  it.each(COMPARE_SERIES.map((s, i) => [i + 1, s.hex] as const))(
    "slot %i (%s) clears 3:1 on #1d2d3d",
    (_slot, hex) => {
      expect(contrast(hex, GROUND)).toBeGreaterThanOrEqual(3);
    },
  );
});

describe("COMPARE_SERIES — adjacent series are 3:1 apart", () => {
  it.each(COMPARE_SERIES.slice(0, -1).map((s, i) => [i + 1, s.hex, COMPARE_SERIES[i + 1].hex] as const))(
    "slot %i (%s) vs its neighbour (%s)",
    (_slot, a, b) => {
      expect(contrast(a, b)).toBeGreaterThanOrEqual(3);
    },
  );

  it("is an alternating light/dark ladder, which is the only shape that can reach 3:1", () => {
    // A chain of N marks each 3:1 from the next AND 3:1 from the ground needs 3^(N-1) of
    // luminance headroom; white on #1d2d3d is 14.05:1, so N=3 caps out at 2.16:1 if the
    // separation has to hold for EVERY pair. Alternating tiers is what buys 3:1 on the
    // consecutive pairs, and it only works if consecutive slots really do alternate.
    const light = COMPARE_SERIES.map((s) => relLum(rgb(s.hex)) > 0.5);
    for (let i = 0; i + 1 < light.length; i++) expect(light[i]).not.toBe(light[i + 1]);
  });
});

describe("COMPARE_SERIES — identity never depends on colour alone", () => {
  it("gives every slot its own dash pattern", () => {
    const dashes = COMPARE_SERIES.map((s) => s.dash ?? "solid");
    expect(new Set(dashes).size).toBe(COMPARE_SERIES.length);
  });

  it("gives every slot its own marker shape, so the chart survives greyscale", () => {
    expect(new Set(COMPARE_SERIES.map((s) => s.shape)).size).toBe(COMPARE_SERIES.length);
  });

  it("has one distinct slot per compare cap slot — nothing wraps onto the primary", () => {
    expect(new Set(COMPARE_SERIES.map((s) => s.color)).size).toBe(COMPARE_SERIES.length);
    expect(COMPARE_SERIES).toHaveLength(6);
  });

  it("keeps compareSeries() total for out-of-range and negative indices", () => {
    expect(compareSeries(0)).toBe(COMPARE_SERIES[0]);
    expect(compareSeries(6)).toBe(COMPARE_SERIES[0]);
    expect(compareSeries(-1)).toBe(COMPARE_SERIES[5]);
  });

  it("references only CSS custom properties, so nothing hard-codes a hex into the DOM", () => {
    for (const s of COMPARE_SERIES) expect(s.color).toMatch(/^var\(--[a-z0-9-]+\)$/);
  });
});

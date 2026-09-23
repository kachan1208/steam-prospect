import { describe, expect, it } from "vitest";

import {
  alignByLaunch,
  compareTakeaway,
  completeMonths,
  launchWindowReviews,
  launchWindowWorked,
  partialPeriodOf,
  periodLabel,
  periodOf,
} from "./compareTrends";

const pt = (period: string, n_reviews: number) => ({ period, n_reviews, ccu_avg: null });

describe("partialPeriodOf / completeMonths", () => {
  it("treats the data's as-of month as still running — unless the as-of day ends it", () => {
    expect(partialPeriodOf(new Date(Date.UTC(2026, 8, 21)))).toBe("2026-09");
    expect(partialPeriodOf(new Date(Date.UTC(2026, 8, 30)))).toBe("2026-10"); // Sep 30: Sep is over
    expect(partialPeriodOf(null, new Date(Date.UTC(2026, 0, 5)))).toBe("2026-01");
  });

  it("drops the running month (the dive at every line's right edge)", () => {
    const pts = [pt("2026-07", 1920), pt("2026-08", 1774), pt("2026-09", 903)];
    expect(completeMonths(pts, "2026-09").map((p) => p.period)).toEqual(["2026-07", "2026-08"]);
    expect(completeMonths(pts, null)).toHaveLength(3);
  });

  it("round-trips periods and labels them in the app's format", () => {
    expect(periodOf(2024 * 12 + 1)).toBe("2024-02");
    expect(periodLabel("2024-02")).toBe("Feb 2024");
  });
});

describe("launchWindowReviews — the first N months from Steam's full histogram", () => {
  const BALATRO = [pt("2024-02", 10_384), pt("2024-03", 13_110), pt("2024-04", 6_631), pt("2024-05", 4_385)];

  it("sums the launch month and the ones after it", () => {
    const w = launchWindowReviews(BALATRO, { release_date: "2024-02-20" }, 3, "2026-09");
    expect(w.total).toBe(30_125);
    expect(w.monthsCovered).toBe(3);
    expect(w.before).toBe(0);
    expect(launchWindowWorked("Balatro", w)).toBe("Balatro: Feb 2024 – Apr 2024: 10,384 + 13,110 + 6,631 = 30,125");
  });

  it("counts a month with no histogram row as zero, not as missing", () => {
    const w = launchWindowReviews([pt("2024-02", 10), pt("2024-04", 5)], { release_date: "2024-02-01" }, 3, null);
    expect(w.total).toBe(15);
    expect(w.parts.map((p) => p.n)).toEqual([10, 0, 5]);
  });

  it("stops at the running month, so a recent launch reports how much of its window is over", () => {
    const w = launchWindowReviews([pt("2026-08", 500), pt("2026-09", 200)], { release_date: "2026-08-10" }, 3, "2026-09");
    expect(w.total).toBe(500);
    expect(w.monthsCovered).toBe(1);
    expect(w.months).toBe(3);
  });

  it("notices reviews BEFORE the anchor — an EA game anchored on its 1.0 date", () => {
    const spire = [pt("2017-11", 89), pt("2017-12", 1_021), pt("2019-01", 5_000)];
    const w = launchWindowReviews(spire, { release_date: "2019-01-23" }, 3, null);
    expect(w.before).toBe(1_110);
    expect(w.anchor?.source).toBe("release");
    // With the first public date the window starts where the game went on sale.
    const fp = launchWindowReviews(spire, { release_date: "2019-01-23", first_public_date: "2017-11-14" }, 3, null);
    expect(fp.total).toBe(89 + 1_021);
    expect(fp.before).toBe(0);
  });

  it("has no window without a launch date", () => {
    expect(launchWindowReviews(BALATRO, { release_date: null }, 3, null).total).toBeNull();
  });
});

describe("alignByLaunch", () => {
  it("merges games on months since launch and keeps each point's own calendar month", () => {
    const rows = alignByLaunch(
      new Map([
        [1, [pt("2024-02", 10), pt("2024-03", 20)]],
        [2, [pt("2019-01", 7), pt("2019-02", 8), pt("2019-03", 9)]],
      ]),
      new Map([
        [1, { iso: "2024-02-20", source: "release" as const }],
        [2, { iso: "2019-01-23", source: "release" as const }],
      ]),
    );
    expect(rows.map((r) => r.offset)).toEqual([0, 1, 2]);
    expect(rows[0]).toMatchObject({ g1: 10, g2: 7, p1: "2024-02", p2: "2019-01" });
    // Game 1 has no month 2: a gap (null), not a zero.
    expect(rows[2].g1).toBeNull();
  });

  it("leaves out a game with no anchor", () => {
    const rows = alignByLaunch(new Map([[1, [pt("2024-02", 10)]]]), new Map([[1, null]]));
    expect(rows).toEqual([]);
  });
});

describe("compareTakeaway — bearish reading first", () => {
  const G = (name: string, revenue: number | null, trend7d: number | null, first3: number | null = null) => ({
    name,
    revenue,
    trend7d,
    first3,
    first3Complete: first3 !== null,
  });

  it("leads with everyone losing players, then the money, then the fastest start", () => {
    const line = compareTakeaway([
      G("Balatro", 89_409_354, -0.55, 30_125),
      G("Slay the Spire", 163_931_451, -2.29, 10_000),
      G("Hades", 231_389_000, -5.35, 17_000),
    ]);
    expect(line).toBe(
      "All 3 are losing players this week (−0.6% to −5.3%). Hades has earned the most (est. $231.4M, 2.6× Balatro). Balatro started fastest (30.1K reviews in its first 3 months).",
    );
  });

  it("names who is falling and who is growing when they split", () => {
    const line = compareTakeaway([G("A", 1_000_000, -3, null), G("B", 950_000, 4, null)])!;
    expect(line.startsWith("A is losing players this week; B is growing.")).toBe(true);
    expect(line).toContain("about level with the rest");
  });

  it("says nothing it can't back: free games have no revenue to rank, and one game is no comparison", () => {
    expect(compareTakeaway([G("Solo", 1, 1)])).toBeNull();
    expect(compareTakeaway([G("Free A", null, null), G("Free B", null, null)])).toBeNull();
  });
});

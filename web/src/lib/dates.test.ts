import { describe, expect, it } from "vitest";

import { addMonths, daysIntoMonth, fillMonthlyGaps, fmtDay, fmtMonth, monthRange, partialMonth } from "./dates";

describe("fmtDay / fmtMonth — one date vocabulary", () => {
  it("prints a day as 'Feb 20, 2024' from a date, a DuckDB timestamp or an ISO timestamp", () => {
    expect(fmtDay("2024-02-20")).toBe("Feb 20, 2024");
    expect(fmtDay("2017-03-06 23:59:53")).toBe("Mar 6, 2017");
    expect(fmtDay("2026-07-05T20:32:49.073129+00:00")).toBe("Jul 5, 2026");
  });

  it("reads the calendar date off the string, never shifting it through the viewer's timezone", () => {
    // new Date("2024-02-20") is UTC midnight — Feb 19 anywhere west of UTC.
    expect(fmtDay("2024-02-20")).toBe("Feb 20, 2024");
  });

  it("prints a month as 'Nov 2024'", () => {
    expect(fmtMonth("2024-11")).toBe("Nov 2024");
    expect(fmtMonth("2024-11-01")).toBe("Nov 2024");
  });

  it("returns null for nothing or garbage rather than printing it", () => {
    expect(fmtDay(null)).toBeNull();
    expect(fmtDay("soon")).toBeNull();
    expect(fmtMonth("2024-13")).toBeNull();
  });
});

describe("month arithmetic", () => {
  it("crosses year boundaries both ways", () => {
    expect(addMonths("2024-11", 3)).toBe("2025-02");
    expect(addMonths("2024-01", -1)).toBe("2023-12");
    expect(monthRange("2024-11", "2025-02")).toEqual(["2024-11", "2024-12", "2025-01", "2025-02"]);
  });
});

describe("fillMonthlyGaps", () => {
  it("puts the silent months back between the first and the last", () => {
    // Hollow Knight's press timeline shape: 41 bars for 108 months before this.
    const filled = fillMonthlyGaps(
      [
        { period: "2017-03", n: 9 },
        { period: "2017-06", n: 2 },
        { period: "2017-07", n: 1 },
      ],
      (period) => ({ period, n: 0 }),
    );
    expect(filled).toEqual([
      { period: "2017-03", n: 9 },
      { period: "2017-04", n: 0 },
      { period: "2017-05", n: 0 },
      { period: "2017-06", n: 2 },
      { period: "2017-07", n: 1 },
    ]);
  });

  it("leaves a dense or single-point series alone", () => {
    const dense = [
      { period: "2024-01", n: 1 },
      { period: "2024-02", n: 2 },
    ];
    expect(fillMonthlyGaps(dense, (period) => ({ period, n: 0 }))).toEqual(dense);
    expect(fillMonthlyGaps([{ period: "2024-01", n: 1 }], (period) => ({ period, n: 0 }))).toHaveLength(1);
  });
});

describe("partialMonth — the month still being counted", () => {
  const asOf = new Date(Date.UTC(2026, 8, 21)); // data as of Sep 21, 2026

  it("is the last charted month when that is the data's as-of month", () => {
    expect(partialMonth("2026-09", asOf)).toBe("2026-09");
    expect(partialMonth("2026-08", asOf)).toBeNull();
  });

  it("follows the DATA's as-of month, not the viewer's clock", () => {
    // A reader on Oct 2 looking at a mart built Sep 21: September is still the partial one.
    expect(partialMonth("2026-09", asOf, new Date(2026, 9, 2))).toBe("2026-09");
  });

  it("falls back to the viewer's month when the data's age is unknown", () => {
    expect(partialMonth("2026-09", null, new Date(2026, 8, 15))).toBe("2026-09");
    expect(partialMonth("2026-08", null, new Date(2026, 8, 15))).toBeNull();
  });

  it("says how far into the month the data runs", () => {
    expect(daysIntoMonth(asOf)).toEqual({ day: 21, of: 30 });
    expect(daysIntoMonth(null)).toBeNull();
  });
});

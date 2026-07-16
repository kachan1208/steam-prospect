import { describe, expect, it } from "vitest";

import {
  fmtCompact,
  fmtInt,
  fmtMinutes,
  fmtPct,
  fmtPrice,
  fmtSigned,
  fmtUsd,
  monthName,
  titleCase,
  weekdayName,
} from "./format";

describe("fmtUsd", () => {
  it("returns an em dash for null/undefined/NaN", () => {
    expect(fmtUsd(null)).toBe("—");
    expect(fmtUsd(undefined)).toBe("—");
    expect(fmtUsd(NaN)).toBe("—");
  });

  it("formats sub-$10 values with 2 decimals, else 0", () => {
    expect(fmtUsd(9.5)).toBe("$9.50");
    expect(fmtUsd(249)).toBe("$249");
  });

  it("compacts thousands/millions/billions with one decimal", () => {
    expect(fmtUsd(1234)).toBe("$1.2K");
    expect(fmtUsd(1_234_567)).toBe("$1.2M");
    expect(fmtUsd(1_234_567_890)).toBe("$1.2B");
  });

  it("prefixes a minus sign for negative values (sign outside the $)", () => {
    expect(fmtUsd(-500)).toBe("-$500");
    expect(fmtUsd(-1_500)).toBe("-$1.5K");
  });
});

describe("fmtCompact", () => {
  it("returns an em dash for null/undefined/NaN", () => {
    expect(fmtCompact(null)).toBe("—");
    expect(fmtCompact(undefined)).toBe("—");
    expect(fmtCompact(NaN)).toBe("—");
  });

  it("uses locale grouping under 10K", () => {
    expect(fmtCompact(1284)).toBe("1,284");
    expect(fmtCompact(9999)).toBe("9,999");
  });

  it("compacts to K at 10K+ and M at 1M+", () => {
    expect(fmtCompact(12_900)).toBe("12.9K");
    expect(fmtCompact(4_200_000)).toBe("4.2M");
  });
});

describe("fmtInt", () => {
  it("returns an em dash for null/undefined/NaN", () => {
    expect(fmtInt(null)).toBe("—");
    expect(fmtInt(undefined)).toBe("—");
  });

  it("rounds and applies locale grouping", () => {
    expect(fmtInt(1234.6)).toBe("1,235");
    expect(fmtInt(-42.4)).toBe("-42");
  });
});

describe("fmtPct", () => {
  it("returns an em dash for null/undefined/NaN", () => {
    expect(fmtPct(null)).toBe("—");
  });

  it("formats a 0-1 fraction as a percentage with the given precision", () => {
    expect(fmtPct(0.5)).toBe("50.0%");
    expect(fmtPct(0.1234, 2)).toBe("12.34%");
    expect(fmtPct(1)).toBe("100.0%");
  });
});

describe("fmtSigned", () => {
  it("prefixes a plus sign for positive values but not zero/negative", () => {
    expect(fmtSigned(0.05)).toBe("+5.0%");
    expect(fmtSigned(-0.05)).toBe("-5.0%");
    expect(fmtSigned(0)).toBe("0.0%");
  });
});

describe("fmtPrice", () => {
  it("renders zero as Free, not $0.00", () => {
    expect(fmtPrice(0)).toBe("Free");
  });

  it("formats non-zero prices to 2 decimals", () => {
    expect(fmtPrice(19.99)).toBe("$19.99");
    expect(fmtPrice(5)).toBe("$5.00");
  });

  it("returns an em dash for null/undefined", () => {
    expect(fmtPrice(null)).toBe("—");
    expect(fmtPrice(undefined)).toBe("—");
  });
});

describe("monthName", () => {
  it("maps 1-12 to Jan-Dec", () => {
    expect(monthName(1)).toBe("Jan");
    expect(monthName(12)).toBe("Dec");
  });

  it("wraps out-of-range months modulo 12", () => {
    expect(monthName(13)).toBe("Jan");
    expect(monthName(0)).toBe("Dec");
  });
});

describe("weekdayName", () => {
  it("maps DuckDB-style 0=Monday .. 6=Sunday", () => {
    expect(weekdayName(0)).toBe("Mon");
    expect(weekdayName(6)).toBe("Sun");
  });

  it("wraps modulo 7", () => {
    expect(weekdayName(7)).toBe("Mon");
  });
});

describe("titleCase", () => {
  it("capitalizes the first letter of each whitespace-separated word", () => {
    expect(titleCase("hello world")).toBe("Hello World");
  });

  it("does not capitalize after an internal hyphen (only the token's first char)", () => {
    expect(titleCase("open-world survival")).toBe("Open-world Survival");
  });
});

describe("fmtMinutes", () => {
  it("returns an em dash for null/undefined/NaN", () => {
    expect(fmtMinutes(null)).toBe("—");
  });

  it("renders sub-hour playtime as whole minutes", () => {
    expect(fmtMinutes(35)).toBe("35m");
  });

  it("renders sub-100h playtime as hours with one decimal", () => {
    expect(fmtMinutes(90)).toBe("1.5h");
    expect(fmtMinutes(3000)).toBe("50.0h");
  });

  it("rounds to a whole number of hours at 100h+", () => {
    expect(fmtMinutes(6000)).toBe("100h");
  });

  it("clamps negative values to 0 rather than going negative", () => {
    expect(fmtMinutes(-10)).toBe("0m");
  });
});

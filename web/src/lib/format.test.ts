import { describe, expect, it } from "vitest";

import {
  axisFormatter,
  axisScale,
  fmtAxisCompact,
  fmtAxisUsd,
  fmtCompact,
  fmtInt,
  fmtMinutes,
  fmtMonths,
  fmtPct,
  fmtPrice,
  fmtSigned,
  fmtUsd,
  monthName,
  niceAxisTicks,
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

describe("fmtAxisCompact", () => {
  it("matches fmtCompact below 100K", () => {
    expect(fmtAxisCompact(null)).toBe("—");
    expect(fmtAxisCompact(1284)).toBe("1,284");
    expect(fmtAxisCompact(12_900)).toBe("12.9K");
    expect(fmtAxisCompact(4_200_000)).toBe("4.2M");
  });

  it("drops the decimal at three integer digits so ticks never outgrow a 40px YAxis", () => {
    // fmtCompact(240_000) === "240.0K" — six glyphs, which recharts clipped to "40.0K".
    expect(fmtAxisCompact(240_000)).toBe("240K");
    expect(fmtAxisCompact(120_000)).toBe("120K");
    expect(fmtAxisCompact(240_000_000)).toBe("240M");
  });
});

describe("fmtAxisUsd", () => {
  it("matches fmtUsd's units with round-dollar/zero anchors", () => {
    expect(fmtAxisUsd(null)).toBe("—");
    expect(fmtAxisUsd(0)).toBe("$0"); // fmtUsd(0) === "$0.00"
    expect(fmtAxisUsd(1_500)).toBe("$1.5K");
    expect(fmtAxisUsd(1_234_567_890)).toBe("$1.2B");
    expect(fmtAxisUsd(-1_500)).toBe("-$1.5K");
  });

  it("drops the decimal at three integer digits", () => {
    expect(fmtAxisUsd(463_000_000)).toBe("$463M"); // fmtUsd → "$463.0M", clipped on a 44px axis
    expect(fmtAxisUsd(550_000)).toBe("$550K");
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

describe("fmtMonths", () => {
  it("returns an em dash for null/undefined/NaN", () => {
    expect(fmtMonths(null)).toBe("—");
    expect(fmtMonths(undefined)).toBe("—");
    expect(fmtMonths(NaN)).toBe("—");
  });

  it("renders lifetimes under 2 years as whole months", () => {
    expect(fmtMonths(14)).toBe("14 mo");
    expect(fmtMonths(23)).toBe("23 mo");
  });

  it("renders 24+ months as years with one decimal", () => {
    expect(fmtMonths(24)).toBe("2.0 yr");
    expect(fmtMonths(38)).toBe("3.2 yr");
  });
});

/* ─────────────────────────────────────────────────────────────────────────────────────
 * A5 — ONE AXIS, ONE UNIT.
 *
 * Every case below is a tick string measured on production (2026-09-01) before the fix,
 * so these fail against the old per-value formatters, not against a hypothetical.
 * ───────────────────────────────────────────────────────────────────────────────────── */

/** The property the whole feature exists to guarantee: strip the sign, the "$" and the
 *  digits off each non-zero tick and exactly one unit suffix, and one decimal count, must
 *  remain. "0" is the sanctioned bare origin and is excluded. */
function unitVocabulary(labels: string[]): { suffixes: Set<string>; decimals: Set<number> } {
  const suffixes = new Set<string>();
  const decimals = new Set<number>();
  for (const label of labels) {
    if (/^-?\$?0%?$/.test(label)) continue;
    const m = label.match(/^-?\$?([\d,]+)(?:\.(\d+))?([KMB%]?)$/);
    if (!m) throw new Error(`unparseable axis tick: ${JSON.stringify(label)}`);
    suffixes.add(m[3]);
    decimals.add(m[2]?.length ?? 0);
  }
  return { suffixes, decimals };
}

describe("axisFormatter — one unit and one decimal count per axis", () => {
  it("stops the /timing price histogram's count axis mixing K with comma grouping", () => {
    // Measured before: "28.0K / 21.0K / 14.0K / 7,000 / 0" — fmtAxisCompact crosses its
    // own 10,000 threshold partway up the axis.
    const ticks = [0, 7_000, 14_000, 21_000, 28_000];
    const labels = ticks.map((t) => axisFormatter(ticks)(t));
    expect(labels).toEqual(["0", "7K", "14K", "21K", "28K"]);
    expect(unitVocabulary(labels).suffixes).toEqual(new Set(["K"]));
  });

  it("stops /games/:appid's review-velocity axis losing its decimal at 120K", () => {
    // Measured before: "0 / 30.0K / 60.0K / 90.0K / 120K".
    const ticks = [0, 30_000, 60_000, 90_000, 120_000];
    const labels = ticks.map((t) => axisFormatter(ticks)(t));
    expect(labels).toEqual(["0", "30K", "60K", "90K", "120K"]);
    expect(unitVocabulary(labels).decimals).toEqual(new Set([0]));
  });

  it("stops /entity's revenue axis switching from millions to billions mid-scale", () => {
    // Measured before: "$0 / $250M / $500M / $750M / $1.0B".
    const ticks = [0, 250e6, 500e6, 750e6, 1e9];
    const labels = ticks.map((t) => axisFormatter(ticks, "usd")(t));
    expect(labels).toEqual(["$0", "$250M", "$500M", "$750M", "$1,000M"]);
    expect(unitVocabulary(labels).suffixes).toEqual(new Set(["M"]));
  });

  it("keeps the reported $550M -> $1.1B axis in one unit, so its even steps read as even", () => {
    const ticks = [0, 550e6, 1.1e9, 1.65e9, 2.2e9];
    const labels = ticks.map((t) => axisFormatter(ticks, "usd")(t));
    expect(labels).toEqual(["$0", "$550M", "$1,100M", "$1,650M", "$2,200M"]);
  });

  it("never abbreviates a value it would have to print as a fraction of its unit", () => {
    // 2,000 in K would be "2.0K" and 500 would be "0.5K" — an axis of fractions.
    const ticks = [0, 500, 1_000, 1_500, 2_000];
    expect(ticks.map((t) => axisFormatter(ticks)(t))).toEqual(["0", "500", "1,000", "1,500", "2,000"]);
  });

  it("never rounds a tick to make it fit the unit", () => {
    // $250M in billions is either "$0.3B" (a lie) or "$0.25B" (a decimal nothing else on
    // the axis uses); the formatter must step DOWN a unit instead.
    expect(axisFormatter([0, 250e6, 1e9], "usd")(250e6)).toBe("$250M");
  });

  it("gives the /timing price axis one dollar vocabulary instead of three", () => {
    // Measured before: "$0.00 / $5.00" (2dp) beside "$10 / $13 / $58" (0dp) beside "$1.9K"
    // — and "$13" was itself a rounded $12.50 bin edge.
    // The real bin edges ($2.50 bins, 0 -> 1902.5) plus the two benchmark marks the chart
    // also prints on this axis ($9.99, $19.99), which is what forces cents.
    const edges = [0, 2.5, 5, 10, 12.5, 17.5, 500, 1_900, 9.99, 19.99];
    const fmt = axisFormatter(edges, "usd", 2);
    const labels = edges.map(fmt);
    expect(unitVocabulary(labels).suffixes).toEqual(new Set([""]));
    expect(unitVocabulary(labels).decimals).toEqual(new Set([2]));
    expect(fmt(12.5)).toBe("$12.50"); // never "$13"
    expect(fmt(1_900)).toBe("$1,900.00"); // never "$1.9K"
  });

  it("keeps a price axis able to say $19.99 (maxDecimals 2)", () => {
    expect(axisFormatter([0.01, 4.99, 9.99, 19.99, 39.99], "usd", 2)(19.99)).toBe("$19.99");
  });

  it("changes unit per decade on a LOG axis, where that IS the one vocabulary", () => {
    // Five decades of revenue edges cannot be pinned to one unit without printing
    // "$100,000K"; each label instead takes the largest unit with a mantissa >= 1.
    const edges = [0, 1_000, 10_000, 100_000, 1e6, 1e7, 1e8];
    expect(edges.map((e) => axisFormatter(edges, "usd", 2)(e))).toEqual([
      "$0",
      "$1K",
      "$10K",
      "$100K",
      "$1M",
      "$10M",
      "$100M",
    ]);
  });

  it("gives /timing's big percent charts and its launch-shape minis the same vocabulary", () => {
    // Measured before: "20.0%" on the big charts, "32%" on the minis, same page.
    const big = [0, 5, 10, 15, 20];
    const mini = [0, 8, 16, 24, 32];
    expect(big.map((t) => axisFormatter(big, "pct")(t))).toEqual(["0%", "5%", "10%", "15%", "20%"]);
    expect(mini.map((t) => axisFormatter(mini, "pct")(t))).toEqual(["0%", "8%", "16%", "24%", "32%"]);
  });

  it("returns an em dash for null/undefined/NaN, like every other formatter here", () => {
    const fmt = axisFormatter([0, 10, 20]);
    expect(fmt(null)).toBe("—");
    expect(fmt(undefined)).toBe("—");
    expect(fmt(NaN)).toBe("—");
  });
});

describe("niceAxisTicks / axisScale", () => {
  it("produces evenly spaced ticks — the /games/:appid price axis was 0, 9, 18, 33", () => {
    const ticks = niceAxisTicks(29.99, 5);
    const steps = ticks.slice(1).map((t, i) => t - ticks[i]);
    expect(new Set(steps.map((s) => s.toFixed(6))).size).toBe(1);
    expect(ticks[0]).toBe(0);
    expect(ticks[ticks.length - 1]).toBeGreaterThanOrEqual(29.99);
  });

  it("covers the data without leaving a whole magnitude of dead headroom", () => {
    const ticks = niceAxisTicks(120_000, 5);
    const top = ticks[ticks.length - 1];
    expect(top).toBeGreaterThanOrEqual(120_000);
    expect(top).toBeLessThanOrEqual(120_000 * 1.5);
  });

  it("only uses steps from the 1/2/2.5/5 x 10^n family", () => {
    for (const max of [7, 33, 480, 29_990, 1.7e6, 9.4e9]) {
      const ticks = niceAxisTicks(max, 5);
      const step = ticks[1] - ticks[0];
      const mantissa = step / Math.pow(10, Math.floor(Math.log10(step)));
      expect([1, 2, 2.5, 5].some((m) => Math.abs(m - mantissa) < 1e-9)).toBe(true);
    }
  });

  it("hands back a domain that ends exactly on the last tick", () => {
    const s = axisScale(28_431, "count");
    expect(s.domain).toEqual([0, s.ticks[s.ticks.length - 1]]);
    expect(unitVocabulary(s.ticks.map(s.format)).suffixes.size).toBe(1);
  });

  it("degrades to a single zero tick rather than throwing on an empty/flat series", () => {
    expect(niceAxisTicks(0)).toEqual([0]);
    expect(axisScale(0).format(0)).toBe("0");
  });
});

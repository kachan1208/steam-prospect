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
  fmtPercentile,
  fmtPrice,
  fmtSigned,
  fmtUsd,
  formatWith,
  isFiniteNumber,
  MISSING,
  MISSING_REASON_TEXT,
  missingReason,
  monthName,
  niceAxisTicks,
  titleCase,
  weekdayName,
  isFreeTitle,
  fmtRevenue,
  priceKind,
  fmtPriceFor,
  fmtRevenueFor,
  PRICE_UNKNOWN,
  fmtIsoDate,
  fmtIsoMonth,
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
  // DuckDB's dayofweek() — what mart_seasonality computes: 0 = SUNDAY .. 6 = Saturday. The
  // old table read 0 = Monday and shifted every heatmap column a day; the mart's own release
  // counts put the two quiet days (the weekend) at 0 and 6.
  it("maps DuckDB's dayofweek: 0 = Sunday .. 6 = Saturday", () => {
    expect(weekdayName(0)).toBe("Sun");
    expect(weekdayName(1)).toBe("Mon");
    expect(weekdayName(4)).toBe("Thu");
    expect(weekdayName(6)).toBe("Sat");
  });

  it("wraps modulo 7, negatives included", () => {
    expect(weekdayName(7)).toBe("Sun");
    expect(weekdayName(-1)).toBe("Sat");
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

describe("isFreeTitle", () => {
  // DOGWALK (3775050, Blender Studio) shipped free: Steam returns NO price_overview, so
  // price_initial is NULL — not 0 — and every revenue cell read "—" as if the number were
  // merely unknown. 12,898 games in the 2026-09-11 mart are in that state.
  it("reads a null price with the free flag as free", () => {
    expect(isFreeTitle({ price_initial: null, is_free: 1 })).toBe(true);
    expect(fmtRevenue(null, isFreeTitle({ price_initial: null, is_free: 1 }))).toBe("Free");
  });

  it("still reads an explicit $0 price as free, flag or not", () => {
    expect(isFreeTitle({ price_initial: 0 })).toBe(true);
    expect(isFreeTitle({ price_initial: 0, is_free: 0 })).toBe(true);
  });

  // Rainbow Six Siege: is_free set AND a real $19.99 price with ~$920M estimated box revenue.
  it("keeps a priced title's number even when Steam flags it free", () => {
    expect(isFreeTitle({ price_initial: 19.99, is_free: 1 })).toBe(false);
    expect(fmtRevenue(920_000_000, isFreeTitle({ price_initial: 19.99, is_free: 1 }))).toBe("$920.0M");
  });

  // A paid game whose price we simply never captured must stay "unknown", not become "Free".
  it("leaves an unpriced, unflagged title alone", () => {
    expect(isFreeTitle({ price_initial: null })).toBe(false);
    expect(isFreeTitle({ price_initial: null, is_free: 0 })).toBe(false);
    expect(fmtRevenue(null, isFreeTitle({ price_initial: null }))).toBe("—");
  });
});

/* ─────────────────────────────────────────────────────────────────────────────────────
 * THE UNIT IS CHOSEN AFTER ROUNDING (2026-09-22 code review).
 *
 * The first case of every block is the exact string the old formatter printed; each test
 * fails against the pick-the-unit-then-round implementation.
 * ───────────────────────────────────────────────────────────────────────────────────── */

const NON_FINITE = [null, undefined, NaN, Infinity, -Infinity];

describe("unit after rounding — fmtUsd", () => {
  it("never prints $1000.0K / $1000 — a value that rounds up takes the bigger unit", () => {
    expect(fmtUsd(999_950)).toBe("$1.0M"); // was "$1000.0K"
    expect(fmtUsd(999.6)).toBe("$1.0K"); // was "$1000"
    expect(fmtUsd(999.5)).toBe("$1.0K");
    expect(fmtUsd(999_999_999)).toBe("$1.0B"); // was "$1000.0M"
    expect(fmtUsd(999_950_000_000)).toBe("$1.0T");
  });

  it("stays in the smaller unit when rounding does not reach the boundary", () => {
    expect(fmtUsd(999.4)).toBe("$999");
    expect(fmtUsd(999_949)).toBe("$999.9K");
    expect(fmtUsd(999_949_999)).toBe("$999.9M");
    expect(fmtUsd(1_000)).toBe("$1.0K");
    expect(fmtUsd(1_000_000)).toBe("$1.0M");
  });

  it("drops the cents once a price rounds to $10 — $9.999 is $10, not $10.00", () => {
    expect(fmtUsd(9.999)).toBe("$10"); // was "$10.00"
    expect(fmtUsd(9.994)).toBe("$9.99");
    expect(fmtUsd(10)).toBe("$10");
  });

  it("decides the sign after rounding and mirrors the ladder for negatives", () => {
    expect(fmtUsd(-999_950)).toBe("-$1.0M");
    expect(fmtUsd(-0.001)).toBe("$0.00"); // not "-$0.00"
  });

  it("prints the missing dash for every non-finite input — never $InfinityB", () => {
    for (const v of NON_FINITE) expect(fmtUsd(v)).toBe(MISSING);
    expect(fmtRevenue(Infinity, false)).toBe(MISSING);
  });
});

describe("unit after rounding — fmtCompact", () => {
  it("never prints 1000.0K or 10,000", () => {
    expect(fmtCompact(999_960)).toBe("1.0M"); // was "1000.0K"
    expect(fmtCompact(9_999.5)).toBe("10.0K"); // was "10,000"
    expect(fmtCompact(999_950_000)).toBe("1.0B"); // was "1000.0M"
  });

  it("stays put below the boundary", () => {
    expect(fmtCompact(9_999.4)).toBe("9,999");
    expect(fmtCompact(999_949)).toBe("999.9K");
    expect(fmtCompact(1_500_000_000)).toBe("1.5B"); // was "1500.0M"
  });

  it("handles negatives and non-finite input", () => {
    expect(fmtCompact(-999_960)).toBe("-1.0M");
    expect(fmtCompact(-0.3)).toBe("0");
    for (const v of NON_FINITE) expect(fmtCompact(v)).toBe(MISSING);
  });
});

describe("unit after rounding — axis formatters keep to three integer digits", () => {
  it("fmtAxisCompact never prints 100.0K / 1000K / 1000M", () => {
    expect(fmtAxisCompact(99_960)).toBe("100K"); // was "100.0K" — six glyphs on a 40px axis
    expect(fmtAxisCompact(999_600)).toBe("1.0M"); // was "1000K"
    expect(fmtAxisCompact(99_960_000)).toBe("100M"); // was "100.0M"
    expect(fmtAxisCompact(999_600_000)).toBe("1.0B"); // was "1000M"
  });

  it("fmtAxisCompact stays put below each boundary", () => {
    expect(fmtAxisCompact(99_949)).toBe("99.9K");
    expect(fmtAxisCompact(999_499)).toBe("999K");
    expect(fmtAxisCompact(250e9)).toBe("250B");
  });

  it("fmtAxisUsd follows the same ladder with a $ prefix", () => {
    expect(fmtAxisUsd(999.6)).toBe("$1.0K"); // was "$1000"
    expect(fmtAxisUsd(99_960)).toBe("$100K"); // was "$100.0K"
    expect(fmtAxisUsd(999_600)).toBe("$1.0M"); // was "$1000K"
    expect(fmtAxisUsd(999_600_000)).toBe("$1.0B"); // was "$1000M"
    for (const v of NON_FINITE) expect(fmtAxisUsd(v)).toBe(MISSING);
    for (const v of NON_FINITE) expect(fmtAxisCompact(v)).toBe(MISSING);
  });

  it("axisFormatter's formatters treat ±Infinity like NaN", () => {
    expect(axisFormatter([0, 10, 20])(Infinity)).toBe(MISSING);
    expect(axisFormatter([0, 10, 20], "pct")(-Infinity)).toBe(MISSING);
    expect(axisFormatter([0, 1_000, 1e6, 1e8], "usd")(Infinity)).toBe(MISSING); // log branch
  });
});

describe("unit after rounding — a sweep across every boundary", () => {
  // Values approaching each threshold from below at shrinking distances. Whatever unit the
  // formatter lands on, the mantissa must be BELOW the next unit's size: a "1000" in front
  // of a K/M/B/T suffix is the bug this block exists for.
  const thresholds = [10, 1e3, 1e4, 1e5, 1e6, 1e8, 1e9, 1e11, 1e12];
  const values = thresholds.flatMap((t) => [0.5, 0.05, 0.005, 0.0005, 0].map((d) => t * (1 - d / 100)));
  const mantissa = (s: string) => Number(s.replace(/^-?\$?/, "").replace(/[KMBT]$/, "").replace(/,/g, ""));

  it("fmtUsd / fmtCompact never print a 1000+ mantissa beside a unit suffix", () => {
    for (const v of values) {
      for (const out of [fmtUsd(v), fmtCompact(v)]) {
        if (/[KMBT]$/.test(out)) expect(mantissa(out), `${v} -> ${out}`).toBeLessThan(1000);
      }
    }
  });

  it("axis formatters never print more than three integer digits beside a suffix", () => {
    for (const v of values) {
      for (const out of [fmtAxisCompact(v), fmtAxisUsd(v)]) {
        if (/[KMBT]$/.test(out)) {
          expect(mantissa(out), `${v} -> ${out}`).toBeLessThan(1000);
          const integerDigits = out.replace(/^-?\$?/, "").replace(/[KMBT]$/, "").split(".")[0];
          expect(integerDigits.length, `${v} -> ${out}`).toBeLessThanOrEqual(3);
        }
      }
    }
  });
});

describe("unit after rounding — durations", () => {
  it("fmtMinutes: 59.6 minutes is an hour, not 60m", () => {
    expect(fmtMinutes(59.6)).toBe("1.0h"); // was "60m"
    expect(fmtMinutes(59.4)).toBe("59m");
    expect(fmtMinutes(60)).toBe("1.0h");
  });

  it("fmtMinutes: 99.95+ hours drops to whole hours, never 100.0h", () => {
    expect(fmtMinutes(5_997)).toBe("100h"); // was "100.0h"
    expect(fmtMinutes(5_996.9)).toBe("99.9h");
    for (const v of NON_FINITE) expect(fmtMinutes(v)).toBe(MISSING);
  });

  it("fmtMonths: 23.6 months is 2.0 yr, never 24 mo", () => {
    expect(fmtMonths(23.6)).toBe("2.0 yr"); // was "24 mo"
    expect(fmtMonths(23.4)).toBe("23 mo");
    for (const v of NON_FINITE) expect(fmtMonths(v)).toBe(MISSING);
  });
});

describe("percent and integer formatters — sign after rounding, non-finite guard", () => {
  it("a change that rounds to zero carries no sign", () => {
    expect(fmtSigned(0.0004)).toBe("0.0%"); // was "+0.0%"
    expect(fmtSigned(-0.0004)).toBe("0.0%"); // was "-0.0%"
    expect(fmtPct(-0.0004)).toBe("0.0%"); // was "-0.0%"
    expect(fmtSigned(0.0006)).toBe("+0.1%");
    expect(fmtPct(-0.05)).toBe("-5.0%");
  });

  it("fmtInt never prints -0", () => {
    expect(fmtInt(-0.4)).toBe("0"); // was "-0"
    expect(fmtInt(-0.6)).toBe("-1");
  });

  it("every one of them prints the missing dash for ±Infinity", () => {
    for (const v of NON_FINITE) {
      expect(fmtPct(v)).toBe(MISSING);
      expect(fmtSigned(v)).toBe(MISSING);
      expect(fmtInt(v)).toBe(MISSING);
      expect(fmtPrice(v)).toBe(MISSING);
    }
  });
});

describe("fmtPercentile — floors, and never claims P100", () => {
  it("prints the top end as 'top 1%' — 99.6 is not P100", () => {
    expect(fmtPercentile(99.6)).toBe("top 1%"); // Math.round printed "P100"
    expect(fmtPercentile(99)).toBe("top 1%");
    expect(fmtPercentile(100)).toBe("top 1%");
  });

  it("floors everything in between", () => {
    expect(fmtPercentile(98.99)).toBe("P98");
    expect(fmtPercentile(73.9)).toBe("P73");
    expect(fmtPercentile(50)).toBe("P50");
    expect(fmtPercentile(1)).toBe("P1");
  });

  it("prints the bottom end as words — a bare P0 reads as missing data", () => {
    expect(fmtPercentile(0.4)).toBe("bottom 1%");
    expect(fmtPercentile(0)).toBe("bottom 1%");
  });

  it("clamps out-of-range input and dashes non-finite input", () => {
    expect(fmtPercentile(120)).toBe("top 1%");
    expect(fmtPercentile(-5)).toBe("bottom 1%");
    for (const v of NON_FINITE) expect(fmtPercentile(v)).toBe(MISSING);
  });
});

describe("the sentinel-friendly API", () => {
  it("missingReason says WHY a value is not printable", () => {
    expect(missingReason(null)).toBe("missing");
    expect(missingReason(undefined)).toBe("missing");
    expect(missingReason(NaN)).toBe("not-a-number");
    expect(missingReason(Infinity)).toBe("infinite");
    expect(missingReason(-Infinity)).toBe("infinite");
    expect(missingReason(0)).toBeNull(); // zero IS data — it must never be read as missing
  });

  it("formatWith keeps the reason next to the text", () => {
    expect(formatWith(1_234, fmtUsd)).toEqual({ text: "$1.2K", missing: null });
    expect(formatWith(0, fmtUsd)).toEqual({ text: "$0.00", missing: null });
    expect(formatWith(null, fmtUsd)).toEqual({ text: MISSING, missing: "missing" });
    expect(formatWith(1 / 0, fmtUsd)).toEqual({ text: MISSING, missing: "infinite" });
    expect(MISSING_REASON_TEXT[formatWith(NaN, fmtPct).missing!]).toBe("not computable");
  });

  it("isFiniteNumber is a proper guard", () => {
    expect(isFiniteNumber(0)).toBe(true);
    expect(isFiniteNumber(-2.5)).toBe(true);
    expect(isFiniteNumber(NaN)).toBe(false);
    expect(isFiniteNumber(Infinity)).toBe(false);
    expect(isFiniteNumber("12")).toBe(false);
    expect(isFiniteNumber(null)).toBe(false);
  });
});

describe("priceKind / fmtPriceFor / fmtRevenueFor — $0 is only free when Steam says so", () => {
  // GET /api/games/search?q=grand%20theft%20auto (2026-09-21 mart), verbatim fields.
  const GTA_V_LEGACY = { price_initial: 0, is_free: 0 };
  const CS_GO = { price_initial: 0, is_free: 1 };
  const DOGWALK = { price_initial: null, is_free: 1 };
  const SIEGE = { price_initial: 19.99, is_free: 1 };

  it("reads a $0 row with is_free = 0 as an UNKNOWN price, not a free game", () => {
    expect(priceKind(GTA_V_LEGACY)).toBe("unknown");
    expect(fmtPriceFor(GTA_V_LEGACY)).toBe(PRICE_UNKNOWN);
    // The mart priced its revenue at $0.00; the cell must say why there is no number.
    expect(fmtRevenueFor(GTA_V_LEGACY, 0)).toBe("Price unknown");
  });

  it("keeps the flagged free games free, with or without a $0 price", () => {
    expect(priceKind(CS_GO)).toBe("free");
    expect(priceKind(DOGWALK)).toBe("free");
    expect(fmtRevenueFor(CS_GO, 0)).toBe("Free");
    expect(fmtPriceFor(DOGWALK)).toBe("Free");
  });

  it("lets a known price win over the free flag", () => {
    expect(priceKind(SIEGE)).toBe("paid");
    expect(fmtPriceFor(SIEGE)).toBe("$19.99");
    expect(fmtRevenueFor(SIEGE, 920_000_000)).toBe("$920.0M");
  });

  it("lets the rebuilt mart's own price_status decide whenever the row carries it", () => {
    expect(priceKind({ price_initial: 0, is_free: 1, price_status: "unknown" })).toBe("unknown");
    expect(priceKind({ price_initial: 0, is_free: 0, price_status: "free" })).toBe("free");
    expect(priceKind({ price_initial: 19.99, is_free: 1, price_status: "paid" })).toBe("paid");
    // An unrecognised status is ignored, not trusted.
    expect(priceKind({ price_initial: 0, is_free: 1, price_status: "mystery" })).toBe("free");
  });

  it("falls back to the old reading when the row carries no flag at all", () => {
    expect(priceKind({ price_initial: 0 })).toBe("free");
    expect(priceKind({ price_initial: 0, is_free: null })).toBe("free");
    expect(priceKind({ price_initial: null })).toBe("unknown");
    expect(fmtPriceFor({ price_initial: null })).toBe("Price unknown");
  });
});

describe("fmtIsoDate / fmtIsoMonth — one date format, no timezone drift", () => {
  it("prints the footer's style from the ISO digits", () => {
    expect(fmtIsoDate("2024-02-20")).toBe("Feb 20, 2024");
    expect(fmtIsoDate("2026-09-21T22:28:20+00:00")).toBe("Sep 21, 2026");
    expect(fmtIsoDate("2024-02")).toBe("Feb 2024");
    expect(fmtIsoMonth("2024-02-20")).toBe("Feb 2024");
  });

  it("never shifts a 1st-of-the-month date into the previous month", () => {
    // new Date("2024-03-01T00:00:00") west of UTC is still Mar 1 locally, but a UTC parse
    // read back in local time is Feb 29 — the digits never move.
    expect(fmtIsoMonth("2024-03-01")).toBe("Mar 2024");
    expect(fmtIsoDate("2024-01-01")).toBe("Jan 1, 2024");
  });

  it("prints MISSING for anything that isn't an ISO date", () => {
    expect(fmtIsoDate(null)).toBe(MISSING);
    expect(fmtIsoDate("")).toBe(MISSING);
    expect(fmtIsoDate("Coming soon")).toBe(MISSING);
    expect(fmtIsoMonth("2024-13-01")).toBe(MISSING);
  });
});

import { describe, expect, it } from "vitest";

import { pressToneSummary } from "./NotableCoverageCard";
import type { GamePress } from "../lib/api";

/**
 * A percentage and the base printed next to it must be able to produce each other.
 *
 * press_pos_share is positive / (positive + negative) — neutrals excluded. The chip printed it
 * beside n_scored_articles, which INCLUDES neutrals, so /games/367520 read
 * "Mostly positive · 83% positive · 101 scored" over 58 positive / 12 negative / 31 neutral:
 * 58/101 = 57.4%, and the only way to 83% is 58/70, a base the card never showed.
 *
 * Numbers below are GET /api/games/367520/teardown verbatim.
 */
function press(overrides: Partial<GamePress>): GamePress {
  return {
    total_mentions: 101,
    n_sources: 6,
    first_seen: "2017-03-06 23:59:53",
    last_seen: "2026-02-05 12:26:12.474",
    by_source: [],
    timeline: [],
    notable: [],
    n_pos_articles: 58,
    n_neg_articles: 12,
    n_neutral_articles: 31,
    n_scored_articles: 101,
    press_pos_share: 0.8285714285714286,
    mean_compound: 0.28829405940594055,
    ...overrides,
  };
}

describe("pressToneSummary", () => {
  it("prints the base the percentage actually uses", () => {
    const tone = pressToneSummary(press({}));
    expect(tone?.label).toBe("Mostly positive");
    expect(tone?.detail).toBe("83% positive of 70 rated · 31 neutral excluded");
  });

  it("never pairs the share with a base that cannot produce it", () => {
    const p = press({});
    const tone = pressToneSummary(p);
    const rated = p.n_pos_articles + p.n_neg_articles;
    // The number in the chip has to be the denominator of the printed percentage.
    expect(Math.round((p.n_pos_articles / rated) * 100)).toBe(83);
    expect(tone?.detail).toContain(`${rated} rated`);
    // 58/101 = 57%, so the all-scored base must not be offered as the share's base.
    expect(tone?.detail).not.toMatch(/83% positive · 101 scored/);
  });

  it("drops the exclusion clause when there is nothing excluded", () => {
    const tone = pressToneSummary(press({ n_neutral_articles: 0, n_scored_articles: 70 }));
    expect(tone?.detail).toBe("83% positive of 70 scored");
  });

  it("still refuses to invent a lean when nothing was scored or nothing took a side", () => {
    expect(pressToneSummary(press({ n_scored_articles: 0 }))).toBeNull();
    expect(pressToneSummary(press({ press_pos_share: null }))?.detail).toBe("101 scored, no clear lean");
  });
});

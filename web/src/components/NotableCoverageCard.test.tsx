import { describe, expect, it } from "vitest";
import { render, within } from "@testing-library/react";

import { NotableCoverageCard, pressToneSummary } from "./NotableCoverageCard";
import type { GamePress, PressNotableArticle } from "../lib/api";

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

function article(overrides: Partial<PressNotableArticle> = {}): PressNotableArticle {
  return {
    source: "pcgamer",
    title: "How to get gold in Subnautica 2",
    author: "Sean Martin",
    published_at: "2026-05-14 09:00:00",
    match_confidence: 0.9,
    is_earliest: false,
    url: "https://example.test/a",
    sentiment_compound: 0.4,
    sentiment: "positive",
    ...overrides,
  };
}

/**
 * Two phone-width layout failures measured on production 2026-09-01, on /games/1962700 at
 * 390px. jsdom has no layout engine, so what is asserted here is the STRUCTURE that
 * produces the measured result — the pixels themselves were verified with Playwright:
 * body scrollWidth 417 -> 390, and the press headline box 146px -> 286px.
 */
describe("NotableCoverageCard at phone widths", () => {
  it("lets the tone chip give way instead of running off the page (A3)", () => {
    const { container } = render(<NotableCoverageCard press={press({ notable: [article()] })} />);
    const chip = within(container).getByText("Mostly positive").parentElement!;
    // 372px of chip on a 318px line: as `shrink-0` it overflowed the viewport by 27px and
    // clipped its own last word ("exclud…"), giving the route the app's only body-level
    // horizontal scroll. It has to be able to shrink AND to wrap internally.
    expect(chip.className).not.toMatch(/\bshrink-0\b/);
    expect(chip.className).toMatch(/\bflex-wrap\b/);
    expect(chip.className).toMatch(/\bmax-w-full\b/);
    // …and the disclosure that wrapping exists to preserve is still whole.
    expect(chip.textContent).toContain("83% positive of 70 rated · 31 neutral excluded");
  });

  it("gives the headline the full row below sm instead of a 146px sliver (A11)", () => {
    const { container } = render(<NotableCoverageCard press={press({ notable: [article()] })} />);
    const headline = within(container).getByText("How to get gold in Subnautica 2", { selector: "span" });
    const row = headline.closest("div.flex-1")!.parentElement!;
    // The outlet column's fixed width is what cost the headline 140px of a 318px card, so
    // it must be breakpoint-scoped: stacked below sm, two columns from sm up.
    expect(row.className).toMatch(/\bflex-col\b/);
    expect(row.className).toMatch(/\bsm:flex-row\b/);
    const meta = row.firstElementChild as HTMLElement;
    expect(meta.className).toMatch(/\bsm:w-32\b/);
    expect(meta.className).not.toMatch(/(^|\s)w-32(\s|$)/);
  });
});

import { describe, expect, it } from "vitest";
import { render, within } from "@testing-library/react";

import { NotableCoverageCard } from "./NotableCoverageCard";
import type { GamePress, PressNotableArticle } from "../lib/api";

/** GET /api/games/367520/teardown's press block (Hollow Knight), verbatim. */
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
 * The per-article "Positive tone / Negative tone" badges and the header's "Mostly positive"
 * chip are gone (2026-09-23): headline VADER tagged PC Gamer's glowing "Balatro review"
 * NEGATIVE, and across the catalog it tracks the game's NAME (grim-titled games read 45%
 * positive vs 69%) far more than its coverage. See the note at the top of the component.
 */
describe("NotableCoverageCard — no automated tone guesses", () => {
  it("prints no tone badge on any row, whatever the article's stored sentiment", () => {
    const { container } = render(
      <NotableCoverageCard
        press={press({
          notable: [
            article({ title: "Balatro review", sentiment: "negative", sentiment_compound: -0.49, is_earliest: true }),
            article({ title: "Balatro Review - IGN", source: "ign", sentiment: "positive" }),
          ],
        })}
      />,
    );
    expect(container.textContent).not.toMatch(/tone/i);
    expect(container.textContent).not.toMatch(/Mostly (positive|negative)|Mixed tone|Neutral coverage/);
    expect(container.textContent).not.toMatch(/% positive of/);
    // What the scrape does know is still there.
    expect(within(container).getByText("Earliest coverage found")).toBeTruthy();
    expect(within(container).getByText("Balatro review", { selector: "span" })).toBeTruthy();
  });

  it("dates each article in the page's one date format", () => {
    const { container } = render(<NotableCoverageCard press={press({ notable: [article()] })} />);
    expect(within(container).getByText("May 14, 2026")).toBeTruthy();
    expect(container.textContent).not.toContain("2026-05-14");
  });

  it("renders nothing without notable articles", () => {
    const { container } = render(<NotableCoverageCard press={press({ notable: [] })} />);
    expect(container.textContent).toBe("");
  });
});

/**
 * A phone-width layout failure measured on production 2026-09-01, on /games/1962700 at
 * 390px. jsdom has no layout engine, so what is asserted here is the STRUCTURE that
 * produces the measured result — the pixels themselves were verified with Playwright:
 * the press headline box 146px -> 286px.
 */
describe("NotableCoverageCard at phone widths", () => {
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

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

// The row's drill-down panel is the only thing in this tree that touches the API; stubbing the
// hook lets the real component render without a QueryClient. Same idiom as
// AspectReviewExamples.test.tsx.
vi.mock("../../lib/api", () => ({ useAspectReviews: vi.fn(() => ({ data: undefined })) }));

import {
  AspectDivergingBars,
  BADGE_MIN_RATED,
  aspectTextSummary,
  ratedMentions,
  standoutAspects,
  weakAspects,
} from "./AspectDivergingBars";
import type { ReviewAspect } from "../../lib/api";

afterEach(cleanup);

/**
 * A percentage and the count printed next to it must be able to produce each other — the rule
 * pressToneSummary already enforces for press tone (components/NotableCoverageCard.test.tsx).
 *
 * An aspect row broke it twice over. "N mentions" is total_mentions, the KEYWORD arm; the
 * "% positive" beside it is text_pos_share = n_text_pos / (n_text_pos + n_text_neg) over the
 * mentions the CLASSIFIER kept and re-keyed. So /games/252490 shipped "Map & Navigation /
 * Backtracking · 155 mentions · 100% positive · +95pp vs Action genre · Standout strength" off
 * n_text_pos=1, n_text_neg=0 — a badge, a differential and a share, all from one mention, with
 * 155 printed beside them. And the old badge floor (5 total_mentions) could not catch it,
 * because it was measured on the wrong population: 155 >= 5.
 *
 * Every number below is GET /api/games/{appid}/teardown verbatim (prod, 2026-09-01).
 */
function aspect(overrides: Partial<ReviewAspect> = {}): ReviewAspect {
  // Rust (252490), "Map & Navigation / Backtracking" — the audit's exhibit.
  return {
    aspect: "Map & Navigation / Backtracking",
    n_pos_mentions: 75,
    n_neg_mentions: 80,
    total_mentions: 155,
    pos_share: 75 / 155,
    n_reviews_sampled: 10679,
    genre_pos_share: 0.5,
    baseline_genre: "Action",
    n_games_in_baseline: 19460,
    delta_vs_genre: 0,
    n_text_pos: 1,
    n_text_neg: 0,
    n_text_neutral: 0,
    text_pos_share: 1.0,
    mean_compound: 0.1,
    genre_text_pos_share: 0.0531518090264826,
    text_delta_vs_genre: 0.9468481909735174,
    ...overrides,
  };
}

// Rust's "Controls & Performance" — a genuinely deep row, and one where the keyword count
// (380) still is not the rated base (21 + 327 = 348).
const controls = aspect({
  aspect: "Controls & Performance",
  n_pos_mentions: 120,
  n_neg_mentions: 260,
  total_mentions: 380,
  pos_share: 120 / 380,
  n_text_pos: 21,
  n_text_neg: 327,
  n_text_neutral: 17,
  text_pos_share: 0.0603448275862069,
  genre_text_pos_share: 0.1891197296871747,
  text_delta_vs_genre: -0.1287749021009678,
});

describe("ratedMentions", () => {
  it("is the denominator of text_pos_share, not the keyword count", () => {
    const a = aspect();
    expect(ratedMentions(a)).toBe(1);
    expect(a.total_mentions).toBe(155);
    // The share the API sends is 1/1. It is NOT 1/155, and it is not anything/155.
    expect(a.n_text_pos / ratedMentions(a)).toBe(a.text_pos_share);
  });
});

describe("aspectTextSummary", () => {
  it("suppresses the share, the differential and the bar when the base is a handful", () => {
    const s = aspectTextSummary(aspect());
    expect(s.kind).toBe("thin");
    // The three things that were printed off a single mention are all gone.
    expect(s.detail).not.toMatch(/100%/);
    expect(s.detail).not.toMatch(/95/);
    expect(s.detail).not.toMatch(/positive/);
    expect(s.detail).toBe("Only 1 rated mention — too thin to score (needs 10).");
  });

  it("prints the base the percentage actually uses once the base is deep enough", () => {
    const s = aspectTextSummary(controls);
    expect(s.kind).toBe("scored");
    expect(s.detail).toBe("6% positive of 348 rated · -13 pts vs Action genre · 17 neutral excluded");
    // The keyword count must never be offered as the share's base: 21/380 = 6% rounds the
    // same, so assert the printed base is the one that PRODUCES the share exactly.
    expect(s.detail).toContain(`${controls.n_text_pos + controls.n_text_neg} rated`);
    expect(s.detail).not.toContain("380");
  });

  it("names the base for every aspect row prod serves, never a bare percentage", () => {
    // Both directions of the keyword/rated divergence, both real rows.
    //   Rust "Content & Length": 60 keyword mentions, 93 rated (25 + 68) — keyword UNDER.
    //   Rust "Difficulty":      317 keyword mentions, 178 rated (77 + 101) — keyword OVER.
    const rows = [
      aspect({
        aspect: "Content & Length",
        total_mentions: 60,
        n_text_pos: 25,
        n_text_neg: 68,
        n_text_neutral: 14,
        text_pos_share: 0.26881720430107525,
        text_delta_vs_genre: -0.12948452867387855,
      }),
      aspect({
        aspect: "Difficulty",
        total_mentions: 317,
        n_text_pos: 77,
        n_text_neg: 101,
        n_text_neutral: 43,
        text_pos_share: 0.43258426966292135,
        text_delta_vs_genre: 0.00976965276624564,
      }),
    ];
    for (const r of rows) {
      const s = aspectTextSummary(r);
      expect(s.kind).toBe("scored");
      expect(s.detail).toMatch(/^\d+% positive of \d+ rated/);
      expect(s.detail).toContain(`of ${ratedMentions(r)} rated`);
      // The count in the header is a different population and must not appear as the base.
      expect(s.detail).not.toContain(`of ${r.total_mentions} rated`);
    }
  });

  it("keeps the pre-existing copy when nothing opinionated was scored at all", () => {
    const s = aspectTextSummary(
      aspect({ n_text_pos: 0, n_text_neg: 0, n_text_neutral: 12, text_pos_share: null }),
    );
    expect(s.kind).toBe("none");
    expect(s.detail).toBe("Not enough opinionated text to score sentiment (12 neutral/unclear mentions).");
  });

  it("keeps `detail` derived from the rendered segments so the two cannot drift", () => {
    const s = aspectTextSummary(controls);
    expect(s.parts.map((p) => (p.strong ? `${p.strong} ${p.text}` : p.text)).join(" · ")).toBe(
      s.detail,
    );
  });
});

describe("standoutAspects — a badge needs a real lead on a real base", () => {
  it("refuses to badge a row whose evidence is one mention", () => {
    // +95pp is the largest differential on the page, and the row still must not win: the
    // differential is 1.0 - 0.053 computed from 1/1.
    expect(standoutAspects([aspect()]).has("Map & Navigation / Backtracking")).toBe(false);
  });

  it("no longer badges a mostly-NEGATIVE aspect for being slightly less hated than the genre", () => {
    // GET /api/games/730/teardown (CS2), verbatim: 13 positive / 43 negative = 23% of 56 rated,
    // +3 pts over the Action baseline. The old "top 3 by any positive gap" rule called this a
    // "Standout strength".
    const cs2Controls = aspect({
      aspect: "Controls & Performance",
      total_mentions: 94,
      n_text_pos: 13,
      n_text_neg: 43,
      n_text_neutral: 0,
      text_pos_share: 0.23214285714285715,
      genre_text_pos_share: 0.20211114341715578,
      text_delta_vs_genre: 0.030031713725701376,
    });
    expect(standoutAspects([cs2Controls]).size).toBe(0);
    // ...and it is not a weakness either: it leads the genre, just not by enough to mean much.
    expect(weakAspects([cs2Controls]).size).toBe(0);
  });

  it("wants all three: >= 50% positive, >= +10 pts, >= 30 rated mentions", () => {
    const deep = (name: string, pos: number, neg: number, delta: number) =>
      aspect({ aspect: name, n_text_pos: pos, n_text_neg: neg, text_pos_share: pos / (pos + neg), text_delta_vs_genre: delta });
    const badged = standoutAspects([
      deep("clears all three", 80, 26, 0.27), // Balatro Content & Length: 75% of 106, +27
      deep("thin base", 7, 4, 0.18), // Balatro Combat & Bosses: 64% of 11, +18
      deep("mostly negative", 9, 12, 0.26), // Balatro Controls & Performance: 43% of 21, +26
      deep("small gap", 60, 20, 0.08), // 75% of 80, +8
    ]);
    expect([...badged]).toEqual(["clears all three"]);
  });

  it("gates on the rated base, not the keyword count, in both directions", () => {
    // Deep keyword count, thin evidence -> no badge. Thin keyword count, deep evidence -> badge.
    const loudButEmpty = aspect({
      aspect: "Loud",
      total_mentions: 412,
      n_text_pos: 1,
      n_text_neg: 0,
      text_delta_vs_genre: 0.95,
    });
    const quietButReal = aspect({
      aspect: "Quiet",
      total_mentions: 3,
      n_text_pos: 30,
      n_text_neg: 10,
      text_pos_share: 0.75,
      text_delta_vs_genre: 0.2,
    });
    expect(ratedMentions(quietButReal)).toBeGreaterThanOrEqual(BADGE_MIN_RATED);
    const badged = standoutAspects([loudButEmpty, quietButReal]);
    expect(badged.has("Loud")).toBe(false);
    expect(badged.has("Quiet")).toBe(true);
  });

  it("still caps at three and still ignores negative differentials", () => {
    const deep = (name: string, delta: number) =>
      aspect({
        aspect: name,
        n_text_pos: 30,
        n_text_neg: 10,
        text_pos_share: 0.75,
        text_delta_vs_genre: delta,
      });
    const badged = standoutAspects([
      deep("a", 0.5),
      deep("b", 0.4),
      deep("c", 0.3),
      deep("d", 0.2),
      deep("e", -0.9),
    ]);
    expect([...badged].sort()).toEqual(["a", "b", "c"]);
  });
});

describe("weakAspects — the mirror rule", () => {
  it("flags an aspect panned clearly more than the genre pans it", () => {
    const priced = aspect({
      aspect: "Price & Value",
      n_text_pos: 15,
      n_text_neg: 45,
      text_pos_share: 0.25,
      genre_text_pos_share: 0.6,
      text_delta_vs_genre: -0.35,
    });
    expect([...weakAspects([priced])]).toEqual(["Price & Value"]);
    expect(standoutAspects([priced]).size).toBe(0);
  });

  it("wants <= 50% positive, <= -10 pts and >= 30 rated mentions", () => {
    const row = (name: string, pos: number, neg: number, delta: number) =>
      aspect({ aspect: name, n_text_pos: pos, n_text_neg: neg, text_pos_share: pos / (pos + neg), text_delta_vs_genre: delta });
    const flagged = weakAspects([
      row("thin", 5, 13, -0.33), // CS2 Price & Value: 28% of 18 rated — too thin to call
      row("still liked", 60, 30, -0.12), // 67% positive: behind the genre, but not panned
      row("small gap", 30, 50, -0.05),
      row("clear", 20, 60, -0.3),
    ]);
    expect([...flagged]).toEqual(["clear"]);
  });
});

describe("AspectDivergingBars (rendered)", () => {
  it("no longer puts a keyword count next to a share computed over one mention", () => {
    render(<AspectDivergingBars appid={252490} aspects={[aspect(), controls]} />);

    // The keyword count is still there — it is a real number about a real population — but it
    // now says which population, so nobody divides it into the split below.
    expect(screen.getByText("155 keyword mentions")).toBeTruthy();
    expect(screen.queryByText("155 mentions")).toBeNull();

    // And the three claims that were made from n_text_pos=1 / n_text_neg=0 are gone.
    expect(screen.getByText(/Only 1 rated mention — too thin to score \(needs 10\)/)).toBeTruthy();
    expect(document.body.textContent).not.toContain("100% positive");
    expect(document.body.textContent).not.toContain("+95 pts");
    expect(screen.queryByText("Standout strength")).toBeNull();
  });

  it("prints the rated base beside every share it does show", () => {
    render(<AspectDivergingBars appid={252490} aspects={[aspect(), controls]} />);
    expect(screen.getByText(/6% positive of 348 rated/)).toBeTruthy();
    // The overall-vote line is the ONE percentage whose base is total_mentions, so it names it.
    expect(screen.getByText(/of the 380 reviews mentioning this were thumbs-up/)).toBeTruthy();
  });

  it("renders the badge and the differential for an aspect that clears the bar", () => {
    const content = aspect({
      aspect: "Content & Length",
      total_mentions: 106,
      n_pos_mentions: 101,
      n_neg_mentions: 5,
      pos_share: 101 / 106,
      n_text_pos: 80,
      n_text_neg: 26,
      n_text_neutral: 10,
      text_pos_share: 80 / 106,
      genre_text_pos_share: 0.48,
      text_delta_vs_genre: 80 / 106 - 0.48,
    });
    render(<AspectDivergingBars appid={2379780} aspects={[content]} />);
    expect(screen.getByText("Standout strength")).toBeTruthy();
    expect(screen.getByText(/75% positive of 106 rated/)).toBeTruthy();
    expect(screen.getByText("+27 pts")).toBeTruthy();
  });

  it("does not badge an 11-mention aspect any more, however large its lead", () => {
    const music = aspect({
      aspect: "Music & Audio",
      total_mentions: 18,
      n_pos_mentions: 12,
      n_neg_mentions: 6,
      pos_share: 12 / 18,
      n_text_pos: 10,
      n_text_neg: 1,
      n_text_neutral: 6,
      text_pos_share: 0.9090909090909091,
      text_delta_vs_genre: 0.09940635627467376,
    });
    render(<AspectDivergingBars appid={252490} aspects={[music]} />);
    // The share and gap still print (11 >= the 10 needed for a share)...
    expect(screen.getByText(/91% positive of 11 rated/)).toBeTruthy();
    // ...but a badge needs 30 rated mentions and a 10-point lead.
    expect(screen.queryByText("Standout strength")).toBeNull();
    expect(screen.getByTestId("aspect-standouts").textContent).toContain("No aspect stands out from the genre either way.");
  });

  it("leads with the weaknesses, then the strengths", () => {
    const weak = aspect({
      aspect: "Price & Value",
      n_text_pos: 15,
      n_text_neg: 45,
      text_pos_share: 0.25,
      genre_text_pos_share: 0.6,
      text_delta_vs_genre: -0.35,
    });
    const strong = aspect({
      aspect: "Story & Writing",
      n_text_pos: 474,
      n_text_neg: 102,
      text_pos_share: 474 / 576,
      genre_text_pos_share: 0.59,
      text_delta_vs_genre: 474 / 576 - 0.59,
    });
    render(<AspectDivergingBars appid={1} aspects={[strong, weak]} />);
    const line = screen.getByTestId("aspect-standouts").textContent ?? "";
    expect(line.indexOf("Panned more than the genre")).toBeGreaterThanOrEqual(0);
    expect(line.indexOf("Panned more than the genre")).toBeLessThan(line.indexOf("Praised more than the genre"));
    expect(line).toContain("Price & Value (25% positive, -35 pts)");
    expect(line).toContain("Story & Writing (82% positive, +23 pts)");
    expect(screen.getByText("Standout weakness")).toBeTruthy();
    expect(screen.getByText("Standout strength")).toBeTruthy();
  });

  it("explains the badge rule in place, with this game's own numbers", () => {
    const content = aspect({
      aspect: "Content & Length",
      n_text_pos: 80,
      n_text_neg: 26,
      text_pos_share: 80 / 106,
      text_delta_vs_genre: 0.27,
      baseline_genre: "Strategy",
    });
    render(<AspectDivergingBars appid={1} aspects={[content]} />);
    fireEvent.click(screen.getByRole("button", { name: "About Standout strength / weakness" }));
    const tip = screen.getByRole("tooltip");
    expect(tip.textContent).toContain("≥ 50% of rated mentions positive AND ≥ +10 pts");
    expect(tip.textContent).toContain("≥ 30 rated mentions");
    expect(tip.textContent).toContain("Strength — Content & Length: 75% positive of 106 rated, +27 pts vs Strategy");
  });

  it("keeps the aspect name a real toggle button, with its ⓘ beside it, not inside it", () => {
    render(<AspectDivergingBars appid={252490} aspects={[controls]} />);
    const toggle = screen.getByRole("button", { name: "Controls & Performance" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    const tipBtn = screen.getByRole("button", { name: "About Controls & Performance" });
    expect(toggle.contains(tipBtn)).toBe(false);
    fireEvent.click(tipBtn);
    expect(screen.getByRole("tooltip").textContent).toContain("21 positive ÷ 348 rated = 6%; Action genre 19% → -13 pts");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
  });
});

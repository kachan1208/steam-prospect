import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";

import type { AspectReviewExcerpt, AspectSentiment } from "../../lib/api";

// The panel's only dependency is the lazy react-query hook; stubbing it lets every test drive
// a concrete payload (including the "new fields absent" one production serves for hours after
// this ships) through the real component tree. `vi.hoisted` because vi.mock's factory runs
// while the module under test is imported — before any plain `const` in this file exists.
const { useAspectReviewsMock } = vi.hoisted(() => ({ useAspectReviewsMock: vi.fn() }));
vi.mock("../../lib/api", () => ({ useAspectReviews: useAspectReviewsMock }));

import { AspectReviewExamples, fullReviewText, locateExcerpt } from "./AspectReviewExamples";

afterEach(cleanup);
beforeEach(() => useAspectReviewsMock.mockReset());

const EXCERPT = "The combat feels weightless and the enemies barely react.";
// Note the SECOND, unsampled mention of "combat" in the last paragraph: expanding must not
// start marking keywords in context the reader did not ask about.
const FULL = [
  "I really wanted to love this one.",
  "",
  `${EXCERPT} Ten hours in it finally clicks, but getting there is a slog and the tutorial never explains why.`,
  "",
  "Would still recommend it on sale if combat is not your main reason for buying.",
].join("\n");

function excerpt(over: Partial<AspectReviewExcerpt> = {}): AspectReviewExcerpt {
  return {
    excerpt: EXCERPT,
    matched_keywords: ["combat"],
    votes_up: 12,
    playtime_minutes: 2520,
    date: "2025-03-11",
    language: "english",
    ...over,
  };
}

/** Wire the stub so each column resolves its own list, mirroring the two real queries. */
function mockLists(lists: { praise?: AspectReviewExcerpt[]; complaint?: AspectReviewExcerpt[] }) {
  useAspectReviewsMock.mockImplementation((_appid: number, _aspect: string, sentiment: AspectSentiment) => ({
    isLoading: false,
    isError: false,
    error: null,
    data: { appid: 1, aspect: "combat", sentiment, items: lists[sentiment] ?? [] },
  }));
}

function renderPanel(lists: Parameters<typeof mockLists>[0]) {
  mockLists(lists);
  return render(<AspectReviewExamples appid={1} aspect="combat" />);
}

const readMore = () => screen.getByRole("button", { name: /read the full review/i });
const hide = () => screen.getByRole("button", { name: /hide the full review/i });

describe("AspectReviewExamples — degraded payload (review_text/steam_url absent)", () => {
  it("renders the excerpt with no expand affordance at all", () => {
    renderPanel({ praise: [excerpt()] });

    expect(screen.getByText(/enemies barely react/)).toBeTruthy();
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    expect(screen.queryByText(/read full review/i)).toBeNull();
    expect(screen.queryAllByRole("link")).toHaveLength(0);
  });

  it("keeps both group headings and the caveat line", () => {
    renderPanel({ praise: [excerpt()] });

    expect(screen.getByText("Positive about this aspect")).toBeTruthy();
    expect(screen.getByText("Negative about this aspect")).toBeTruthy();
    expect(screen.getByText(/not the reviewer’s overall thumbs-up\/down/i)).toBeTruthy();
  });

  it("still marks the matched keyword so the excerpt explains why it is here", () => {
    const { container } = renderPanel({ praise: [excerpt()] });

    const marks = [...container.querySelectorAll("mark")];
    expect(marks).toHaveLength(1);
    expect(marks[0].textContent).toBe("combat");
  });
});

describe("AspectReviewExamples — expanding a review", () => {
  it("swaps the sampled sentence for the whole review and back", () => {
    renderPanel({ praise: [excerpt({ review_text: FULL })] });

    expect(screen.queryByText(/wanted to love this one/)).toBeNull();

    fireEvent.click(readMore());
    expect(screen.getByText(/wanted to love this one/)).toBeTruthy();
    expect(hide().getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("Show less")).toBeTruthy();

    fireEvent.click(hide());
    expect(screen.queryByText(/wanted to love this one/)).toBeNull();
    expect(readMore().getAttribute("aria-expanded")).toBe("false");
  });

  it("marks keywords only inside the sampled sentence, not across the whole body", () => {
    const { container } = renderPanel({ praise: [excerpt({ review_text: FULL })] });

    fireEvent.click(readMore());

    // "combat" occurs twice in FULL; only the sampled sentence's occurrence is marked.
    const marks = [...container.querySelectorAll("mark")];
    expect(marks).toHaveLength(1);
    expect(marks[0].textContent).toBe("combat");
    expect(container.textContent).toContain("if combat is not your main reason");
  });

  it("expands only the clicked card", () => {
    renderPanel({
      praise: [
        excerpt({ review_text: FULL }),
        excerpt({ excerpt: "Second one.", review_text: "Second one. And a lot more text after it." }),
      ],
    });

    fireEvent.click(screen.getAllByRole("button", { name: /read the full review/i })[0]);

    expect(screen.getByText(/wanted to love this one/)).toBeTruthy();
    expect(screen.queryByText(/a lot more text after it/)).toBeNull();
  });

  it("keeps each column's cards independent", () => {
    renderPanel({
      praise: [excerpt({ review_text: FULL })],
      complaint: [excerpt({ excerpt: "Hitboxes are a lie.", review_text: "Hitboxes are a lie. Every single time." })],
    });

    fireEvent.click(screen.getAllByRole("button", { name: /read the full review/i })[1]);

    expect(screen.getByText(/Every single time/)).toBeTruthy();
    expect(screen.queryByText(/wanted to love this one/)).toBeNull();
  });
});

describe("AspectReviewExamples — keyboard and screen readers", () => {
  it("exposes a real button with aria-expanded, not a click-handled div", () => {
    renderPanel({ praise: [excerpt({ review_text: FULL })] });

    const btn = readMore();
    expect(btn.tagName).toBe("BUTTON");
    expect(btn.getAttribute("type")).toBe("button");
    expect(btn.getAttribute("aria-expanded")).toBe("false");
    // Never removed from the tab order, and short enough to be announced as a name.
    expect(btn.getAttribute("tabindex")).toBeNull();
    expect(btn.getAttribute("aria-label")).toBe("Read the full review");
  });

  it("holds focus on the toggle across expand and collapse", () => {
    renderPanel({ praise: [excerpt({ review_text: FULL })] });

    const btn = readMore();
    btn.focus();
    fireEvent.click(btn);
    // Same element, relabelled — focus is not dropped to <body> the way a swapped-out
    // control would drop it.
    expect(document.activeElement).toBe(hide());

    fireEvent.click(hide());
    expect(document.activeElement).toBe(readMore());
  });

  it("ignores the toggle while text inside that card is selected", () => {
    renderPanel({ praise: [excerpt({ review_text: FULL })] });
    const btn = readMore();

    const sel = { isCollapsed: false, anchorNode: btn.querySelector("p") } as unknown as Selection;
    const spy = vi.spyOn(window, "getSelection").mockReturnValue(sel);
    fireEvent.click(btn);
    expect(screen.queryByText(/wanted to love this one/)).toBeNull();

    // A selection somewhere else on the page must NOT swallow the activation.
    spy.mockReturnValue({ isCollapsed: false, anchorNode: document.body } as unknown as Selection);
    fireEvent.click(btn);
    expect(screen.getByText(/wanted to love this one/)).toBeTruthy();
    spy.mockRestore();
  });
});

describe("AspectReviewExamples — the Steam permalink", () => {
  it("appears once expanded, outside the toggle button", () => {
    renderPanel({ praise: [excerpt({ review_text: FULL, steam_url: "https://steamcommunity.com/r/1" })] });

    expect(screen.queryByRole("link")).toBeNull();

    fireEvent.click(readMore());
    const link = screen.getByRole("link", { name: /view on steam/i });
    expect(link.getAttribute("href")).toBe("https://steamcommunity.com/r/1");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    // A link nested in a button is invalid and unreachable by keyboard in some browsers.
    expect(hide().contains(link)).toBe(false);
  });

  it("sits inline when there is nothing to expand", () => {
    renderPanel({ praise: [excerpt({ steam_url: "https://steamcommunity.com/r/2" })] });

    expect(screen.queryAllByRole("button")).toHaveLength(0);
    expect(screen.getByRole("link", { name: /view on steam/i }).getAttribute("href")).toBe(
      "https://steamcommunity.com/r/2",
    );
  });

  it("is simply absent when the mart has not shipped the field yet", () => {
    renderPanel({ praise: [excerpt({ review_text: FULL })] });

    fireEvent.click(readMore());
    expect(screen.queryByRole("link")).toBeNull();
  });
});

describe("AspectReviewExamples — the meta line", () => {
  it("drops zero/absent stats instead of printing them", () => {
    const { container } = renderPanel({
      praise: [excerpt({ votes_up: 0, playtime_minutes: null, date: null })],
    });

    expect(container.textContent).not.toContain("found helpful");
    expect(container.textContent).not.toContain("played");
    // No stats, nothing to expand, no permalink -> no meta line at all, rather than a row of
    // fmtMinutes' "—" placeholder and a "0 found helpful".
    expect(container.querySelector(".tabular")).toBeNull();
  });

  it("prints the stats that carry a value, dot-separated", () => {
    const { container } = renderPanel({ praise: [excerpt()] });

    expect(container.textContent).toContain("42.0h played · 2025-03-11 · 12 found helpful");
  });

  it("trims a timestamp date down to the day", () => {
    const { container } = renderPanel({ praise: [excerpt({ date: "2025-03-11 23:59:53.255" })] });

    expect(container.textContent).toContain("2025-03-11 ·");
    expect(container.textContent).not.toContain("23:59:53");
  });
});

describe("AspectReviewExamples — query states", () => {
  it("reports loading, errors and empty columns", () => {
    useAspectReviewsMock.mockImplementation((_a: number, _b: string, sentiment: AspectSentiment) =>
      sentiment === "praise"
        ? { isLoading: true, isError: false, error: null, data: undefined }
        : { isLoading: false, isError: true, error: new Error("boom"), data: undefined },
    );
    const { container } = render(<AspectReviewExamples appid={1} aspect="combat" />);
    expect(container.textContent).toContain("Loading…");
    expect(container.textContent).toContain("Failed to load: boom");

    cleanup();
    renderPanel({});
    expect(screen.getByText(/No sampled reviews read positive about this aspect/)).toBeTruthy();
    expect(screen.getByText(/No sampled reviews read negative about this aspect/)).toBeTruthy();
  });

  it("asks for both sentiments with the aspect it was given", () => {
    renderPanel({ praise: [excerpt()] });

    expect(useAspectReviewsMock).toHaveBeenCalledWith(1, "combat", "praise");
    expect(useAspectReviewsMock).toHaveBeenCalledWith(1, "combat", "complaint");
  });
});

describe("fullReviewText — when there is genuinely more to read", () => {
  const base = excerpt();

  it("is null when the field is missing, null or blank", () => {
    expect(fullReviewText(base)).toBeNull();
    expect(fullReviewText({ ...base, review_text: null })).toBeNull();
    expect(fullReviewText({ ...base, review_text: "   " })).toBeNull();
  });

  it("is null when the review IS the excerpt, whitespace differences included", () => {
    expect(fullReviewText({ ...base, review_text: EXCERPT })).toBeNull();
    expect(fullReviewText({ ...base, review_text: `  ${EXCERPT}\n ` })).toBeNull();
    expect(fullReviewText({ ...base, review_text: "Too short." })).toBeNull();
  });

  it("is the untouched body when it adds context", () => {
    expect(fullReviewText({ ...base, review_text: FULL })).toBe(FULL);
  });
});

describe("locateExcerpt — anchoring the sampled sentence", () => {
  it("splits the body into before / match / after", () => {
    const parts = locateExcerpt(FULL, EXCERPT);
    expect(parts).not.toBeNull();
    const [before, match, after] = parts as [string, string, string];
    expect(match).toBe(EXCERPT);
    expect(before).toContain("wanted to love this one");
    expect(after).toContain("Ten hours in");
    expect(before + match + after).toBe(FULL);
  });

  it("matches across the line breaks the excerpt collapsed away", () => {
    const body = "Intro line.\nThe combat feels weightless\nand the enemies barely react. Outro.";
    const parts = locateExcerpt(body, EXCERPT);
    expect(parts).not.toBeNull();
    expect((parts as [string, string, string])[1]).toBe(
      "The combat feels weightless\nand the enemies barely react.",
    );
  });

  it("ignores the ellipsis the mart wraps an excerpt in", () => {
    const parts = locateExcerpt(FULL, `…${EXCERPT}…`);
    expect((parts as [string, string, string])[1]).toBe(EXCERPT);
  });

  it("is null when the sentence is not in the body, so the caller can fall back", () => {
    expect(locateExcerpt(FULL, "Nothing like this appears anywhere.")).toBeNull();
    expect(locateExcerpt(FULL, "   ")).toBeNull();
  });

  it("treats regex metacharacters in the excerpt as literal text", () => {
    const body = "Prelude. Price (a+b) is $5.00 — worth it? Definitely. Postlude.";
    const parts = locateExcerpt(body, "Price (a+b) is $5.00 — worth it?");
    expect((parts as [string, string, string])[1]).toBe("Price (a+b) is $5.00 — worth it?");
  });

  it("falls back to highlighting the whole body when the sentence cannot be found", () => {
    const { container } = renderPanel({
      praise: [
        excerpt({
          excerpt: "A sentence that is not in the body at all.",
          review_text: "Completely different combat text, long enough to be worth expanding further.",
        }),
      ],
    });

    fireEvent.click(readMore());
    const marks = [...container.querySelectorAll("mark")];
    expect(marks.map((m) => m.textContent)).toEqual(["combat"]);
  });
});

describe("AspectReviewExamples — layout", () => {
  it("stacks the two groups until xl so quotes keep a readable measure", () => {
    const { container } = renderPanel({ praise: [excerpt()] });

    const grid = container.querySelector(".grid") as HTMLElement;
    expect(grid.className).toContain("grid-cols-1");
    expect(grid.className).toContain("xl:grid-cols-2");
    // Both earlier split points produced unreadable columns: `sm` split ~40ch on a small
    // laptop, and `lg` split at exactly the width where GameProfile's sidebar grid shrinks
    // the main column (~32ch each). See the layout note on AspectReviewExamples.
    expect(grid.className).not.toContain("sm:grid-cols-2");
    expect(grid.className).not.toContain("lg:grid-cols-2");
    expect(within(grid).getAllByRole("heading", { level: 4 })).toHaveLength(2);
  });

  it("caps the review prose measure so a full-width stacked card cannot run 120ch lines", () => {
    const { container } = renderPanel({ praise: [excerpt({ review_text: FULL })] });

    // Collapsed excerpt and expanded full body both carry the cap and the readable size.
    let prose = container.querySelector("p") as HTMLElement;
    expect(prose.className).toContain("max-w-prose");
    expect(prose.className).toContain("text-sm");
    expect(prose.className).toContain("leading-relaxed");

    fireEvent.click(readMore());
    prose = container.querySelector("p") as HTMLElement;
    expect(prose.className).toContain("max-w-prose");
    expect(prose.className).toContain("text-sm");
    expect(prose.className).toContain("leading-relaxed");
  });
});

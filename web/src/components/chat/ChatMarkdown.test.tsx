import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";

import { ChatMarkdown } from "./ChatMarkdown";

afterEach(cleanup);

describe("ChatMarkdown", () => {
  // Regression test for the streaming-table infinite loop: the chat streams assistant text
  // token-by-token, so ChatMarkdown re-renders on EVERY partial prefix of the eventual full
  // message — including mid-table states where a "|...|" row has arrived but its "|---|"
  // separator (or its body rows) haven't yet. The old paragraph-consuming loop used a plain
  // `while` that could fail to advance its line index on exactly this kind of line, spinning
  // forever and growing the blocks[] array until the renderer OOM'd ("Aw, Snap!"). The fix
  // (see ChatMarkdown.tsx) switched it to a `do/while` that always advances at least one line.
  // These two inputs are the exact repro shapes from that bug; the only real assertion here is
  // that render() RETURNS AT ALL — a regressed infinite loop hangs/OOMs the process rather than
  // failing an expect(), so simply reaching the assertions below is most of the point.
  it("renders a '|'-prefixed line with no separator row without hanging (two-row, no header rule)", () => {
    const { container } = render(<ChatMarkdown text={"| a | b |\n| c | d |"} />);

    // No valid GFM table (no separator row between the two "|" lines) — falls back to a
    // plain paragraph rendering the raw text, pipes and all, not a <table>.
    expect(container.querySelector("table")).toBeNull();
    expect(container.textContent).toContain("| a | b |");
    expect(container.textContent).toContain("| c | d |");
  });

  it("renders a heading followed by a lone streamed-in table header row without hanging", () => {
    const { container } = render(<ChatMarkdown text={"## H\n\n| Cut | Opp |"} />);

    // The heading renders normally; the trailing "|"-row has no separator yet (end of the
    // streamed-so-far text), so it is NOT (yet) a table — same fallback as above.
    expect(container.querySelector("table")).toBeNull();
    expect(container.textContent).toContain("H");
    expect(container.textContent).toContain("| Cut | Opp |");
  });

  it("still renders a real GFM table once a full header+separator+row has streamed in", () => {
    const { container } = render(
      <ChatMarkdown text={"| Cut | Opp |\n| --- | --- |\n| Combat | 72 |"} />,
    );
    const table = container.querySelector("table");
    expect(table).not.toBeNull();
    expect(container.querySelectorAll("thead th")).toHaveLength(2);
    expect(table?.textContent).toContain("Cut");
    expect(table?.textContent).toContain("Combat");
    expect(table?.textContent).toContain("72");
  });

  it("renders a header+separator with no body rows yet (mid-stream) as an empty-bodied table", () => {
    const { container } = render(<ChatMarkdown text={"| Cut | Opp |\n| --- | --- |"} />);
    const table = container.querySelector("table");
    expect(table).not.toBeNull();
    expect(container.querySelectorAll("tbody tr")).toHaveLength(0);
  });

  it("renders plain paragraphs and inline formatting unaffected by the table-detection fix", () => {
    const { container } = render(<ChatMarkdown text={"Hello **world**, this is `code`."} />);
    expect(container.querySelector("strong")?.textContent).toBe("world");
    expect(container.querySelector("code")?.textContent).toBe("code");
  });
});

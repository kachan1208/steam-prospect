import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import { FilterBar } from "./FilterChip";
import { ResultChipRow, topValues } from "./ResultChipRow";
import { ResultHeader, ResultList, ResultRow, ResultTitle, RevenueCell } from "./ResultList";
import { MAX_OFFSET, PAGE_LIMIT, ResultsFooter, pagingState } from "./ResultsFooter";
import { SearchBar } from "./SearchBar";
import { Segmented } from "./Segmented";
import { SortControl, sortPatch } from "./SortControl";

/**
 * The search primitives /games and /studios share. Each one was lifted out of GameSearch
 * verbatim so the two pages cannot drift; these pin the contract each page relies on —
 * the count wording, the chip states, the sort toggle, the paging cliff — at the component,
 * so a page test that fails points at the page, not at a primitive.
 */

afterEach(cleanup);

describe("SearchBar", () => {
  it("labels the field and counts matches — singular, plural, and an ellipsis while loading", () => {
    const onChange = vi.fn();
    const bar = (total: number, loading: boolean) => (
      <SearchBar
        value=""
        onChange={onChange}
        placeholder="Search by name…"
        ariaLabel="Search games by name"
        total={total}
        loading={loading}
      />
    );
    const { rerender } = render(bar(1, false));
    expect(screen.getByLabelText("Search games by name")).toBe(screen.getByPlaceholderText("Search by name…"));
    expect(screen.getByText("1 match")).toBeTruthy();
    rerender(bar(174_265, false));
    expect(screen.getByText("174,265 matches")).toBeTruthy();
    rerender(bar(0, true));
    expect(screen.getByText("…")).toBeTruthy();
    expect(screen.queryByText(/match/)).toBeNull();
  });

  it("hands typed text up as a plain string", () => {
    const onChange = vi.fn();
    render(
      <SearchBar value="" onChange={onChange} placeholder="Search…" ariaLabel="Search" total={0} loading={false} />,
    );
    fireEvent.change(screen.getByLabelText("Search"), { target: { value: "witch" } });
    expect(onChange).toHaveBeenCalledWith("witch");
  });
});

describe("FilterBar", () => {
  it("is just its two ends with nothing applied — no orphaned 'Filter:' or 'Clear all'", () => {
    render(<FilterBar chips={[]} onClearAll={() => {}} leading={<span>LEAD</span>} trailing={<span>TRAIL</span>} />);
    expect(screen.queryByText("Filter:")).toBeNull();
    expect(screen.queryByText("Clear all")).toBeNull();
    expect(screen.getByText("LEAD")).toBeTruthy();
    expect(screen.getByText("TRAIL")).toBeTruthy();
  });

  it("renders each applied filter as a removable accent chip, plus Clear all", () => {
    const clearQ = vi.fn();
    const clearAll = vi.fn();
    render(<FilterBar chips={[{ key: "q", label: "“witch”", onClear: clearQ }]} onClearAll={clearAll} />);
    expect(screen.getByText("Filter:")).toBeTruthy();
    const chip = screen.getByRole("button", { name: /“witch”/ });
    expect(chip.getAttribute("title")).toBe("Remove filter");
    expect(chip.className).toContain("border-brand");
    fireEvent.click(chip);
    expect(clearQ).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByText("Clear all"));
    expect(clearAll).toHaveBeenCalledTimes(1);
  });
});

describe("Segmented", () => {
  const OPTIONS = [
    { value: "publisher", label: "Publishers" },
    { value: "developer", label: "Developers", title: "Who built the games" },
  ] as const;

  it("is a labelled group whose selected segment is aria-pressed", () => {
    render(<Segmented options={OPTIONS} value="publisher" onChange={() => {}} ariaLabel="Role" />);
    expect(screen.getByRole("group", { name: "Role" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Publishers" }).getAttribute("aria-pressed")).toBe("true");
    const dev = screen.getByRole("button", { name: "Developers" });
    expect(dev.getAttribute("aria-pressed")).toBe("false");
    expect(dev.getAttribute("title")).toBe("Who built the games");
    // The unselected segment is a live control: it wears ink-secondary, never ink-muted.
    expect(dev.className).toContain("text-ink-secondary");
    expect(dev.className).not.toContain("text-ink-muted");
  });

  it("fires onChange only for an actual change", () => {
    const onChange = vi.fn();
    render(<Segmented options={OPTIONS} value="publisher" onChange={onChange} ariaLabel="Role" />);
    fireEvent.click(screen.getByRole("button", { name: "Publishers" }));
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Developers" }));
    expect(onChange).toHaveBeenCalledWith("developer");
  });
});

describe("sortPatch / SortControl", () => {
  it("re-picking the current key flips the direction; a new key starts highest-first unless it is ascFirst", () => {
    expect(sortPatch("total_reviews", "desc", "total_reviews", ["name"])).toEqual({ order: "asc" });
    expect(sortPatch("total_reviews", "asc", "total_reviews", ["name"])).toEqual({ order: "desc" });
    expect(sortPatch("total_reviews", "desc", "est_rev_reviews", ["name"])).toEqual({ sort: "est_rev_reviews", order: "desc" });
    expect(sortPatch("total_reviews", "desc", "name", ["name"])).toEqual({ sort: "name", order: "asc" });
  });

  it("routes the select and the arrow through onSort — the arrow re-picks the current key", () => {
    const onSort = vi.fn();
    render(
      <SortControl keys={["a", "b"] as const} labels={{ a: "alpha", b: "beta" }} sort="a" order="desc" onSort={onSort} />,
    );
    expect(screen.getByText("sorted by")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Sort by"), { target: { value: "b" } });
    expect(onSort).toHaveBeenLastCalledWith("b");
    const arrow = screen.getByRole("button", { name: "Toggle sort direction" });
    expect(arrow.textContent).toBe("▼");
    expect(arrow.getAttribute("title")).toMatch(/highest first/);
    fireEvent.click(arrow);
    expect(onSort).toHaveBeenLastCalledWith("a");
  });

  it("draws the arrow the other way up when ascending", () => {
    render(<SortControl keys={["a"] as const} labels={{ a: "alpha" }} sort="a" order="asc" onSort={() => {}} />);
    const arrow = screen.getByRole("button", { name: "Toggle sort direction" });
    expect(arrow.textContent).toBe("▲");
    expect(arrow.getAttribute("title")).toMatch(/lowest first/);
  });
});

describe("topValues / ResultChipRow", () => {
  it("counts each row's first perRow values once and returns the most common first, capped at max", () => {
    const rows = [["a", "b", "c"], ["a", "c"], ["c", "d"]];
    expect(topValues(rows, (r) => r, 2, 10)).toEqual(["a", "c", "b", "d"]);
    expect(topValues(rows, (r) => r, 2, 2)).toEqual(["a", "c"]);
    expect(topValues(rows, (r) => r, 3, 10)).toEqual(["c", "a", "b", "d"]);
    expect(topValues([], (r: string[]) => r)).toEqual([]);
  });

  it("renders nothing without items, so an empty page has no orphaned label", () => {
    const { container } = render(<ResultChipRow label="Tags in these results:" items={[]} />);
    expect(container.innerHTML).toBe("");
  });

  it("is buttons when the pivot stays on the page, and the active item wears the accent", () => {
    const onPick = vi.fn();
    render(<ResultChipRow label="Tags in these results:" items={["FPS", "Shooter"]} active="FPS" onPick={onPick} />);
    expect(screen.getByText("Tags in these results:")).toBeTruthy();
    expect(screen.getByRole("button", { name: "FPS" }).className).toContain("border-brand");
    expect(screen.getByRole("button", { name: "Shooter" }).className).not.toContain("border-brand");
    fireEvent.click(screen.getByRole("button", { name: "Shooter" }));
    expect(onPick).toHaveBeenCalledWith("Shooter");
  });

  it("is real links when the pivot leaves the page, so middle-click works", () => {
    render(
      <MemoryRouter>
        <ResultChipRow label="Genres in these results:" items={["RPG"]} href={(g) => `/games?genre=${g}`} />
      </MemoryRouter>,
    );
    expect(screen.getByRole("link", { name: "RPG" }).getAttribute("href")).toBe("/games?genre=RPG");
    expect(screen.queryByRole("button")).toBeNull();
  });
});

describe("pagingState / ResultsFooter", () => {
  it("stops at the last offset the API will serve, not at total", () => {
    expect(MAX_OFFSET).toBe(10_000);
    expect(PAGE_LIMIT).toBe(25);
    expect(pagingState(174_265, 0, 25)).toMatchObject({
      rangeStart: 1, rangeEnd: 25, canPrev: false, canNext: true, atPagingCap: false,
    });
    // At the cap 174,240 matches remain — reachable by narrowing, not through Next.
    expect(pagingState(174_265, 10_000, 25)).toMatchObject({
      rangeStart: 10_001, rangeEnd: 10_025, canPrev: true, canNext: false, atPagingCap: true,
    });
    // 9,975 + 25 = 10,000, which the API DOES serve — over-clamping would strand the reader.
    expect(pagingState(174_265, 9_975, 25)).toMatchObject({ canNext: true, atPagingCap: false });
    // A genuine last page is not "the cap".
    expect(pagingState(30, 25, 25)).toMatchObject({ rangeStart: 26, rangeEnd: 30, canNext: false, atPagingCap: false });
    expect(pagingState(0, 0, 25)).toMatchObject({ rangeStart: 0, rangeEnd: 0, canPrev: false, canNext: false });
  });

  it("prints the range, disables the dead ends and hands the next offset up", () => {
    const onPage = vi.fn();
    const { rerender } = render(<ResultsFooter total={60} offset={0} limit={25} onPage={onPage} />);
    expect(screen.getByText("1–25 of 60")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Prev" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(onPage).toHaveBeenLastCalledWith(25);

    rerender(<ResultsFooter total={60} offset={50} limit={25} onPage={onPage} />);
    expect(screen.getByText("51–60 of 60")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Next" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Prev" }));
    expect(onPage).toHaveBeenLastCalledWith(25);

    // Prev from a short first hop lands on 0 — the caller turns that into "no ?offset=".
    rerender(<ResultsFooter total={60} offset={10} limit={25} onPage={onPage} />);
    fireEvent.click(screen.getByRole("button", { name: "Prev" }));
    expect(onPage).toHaveBeenLastCalledWith(0);

    rerender(<ResultsFooter total={0} offset={0} limit={25} onPage={onPage} />);
    expect(screen.getByText("0 results")).toBeTruthy();
  });

  it("says WHY paging stopped at the cap, rather than looking like the end of the results", () => {
    render(<ResultsFooter total={174_265} offset={10_000} limit={25} onPage={() => {}} />);
    expect(screen.getByText(/paging stops at 10,000/)).toBeTruthy();
    expect(screen.getByText(/10,001–10,025 of 174,265/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Next" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("ResultList", () => {
  it("stacks the metric group below the chosen breakpoint — sm by default (/games), lg for /studios' seven cells", () => {
    render(
      <MemoryRouter>
        <ResultList>
          <ResultHeader lead="Studio" stackBelow="lg">
            <span>Games</span>
          </ResultHeader>
          <ResultRow stackBelow="lg" onOpen={() => {}} lead={<span>lead</span>} metrics={<span>metric</span>} />
        </ResultList>
      </MemoryRouter>,
    );
    const header = screen.getByText("Studio").parentElement!;
    expect(header.className).toContain("lg:flex");
    expect(header.className).not.toContain("sm:flex");
    const row = screen.getByText("lead").parentElement!.parentElement!;
    expect(row.className).toContain("lg:flex-row");
    expect(screen.getByText("metric").parentElement!.className).toContain("flex-wrap");

    cleanup();
    render(
      <MemoryRouter>
        <ResultList>
          <ResultHeader lead="Game">
            <span>Est. gross</span>
          </ResultHeader>
          <ResultRow onOpen={() => {}} lead={<span>lead</span>} metrics={<span>metric</span>} />
        </ResultList>
      </MemoryRouter>,
    );
    expect(screen.getByText("Game").parentElement!.className).toContain("sm:flex");
    expect(screen.getByText("lead").parentElement!.parentElement!.className).toContain("sm:flex-row");
  });

  it("opens the row on a click anywhere, but the title link handles its own click", () => {
    const onOpen = vi.fn();
    render(
      <MemoryRouter>
        <ResultRow
          onOpen={onOpen}
          lead={<ResultTitle to="/games/730" name="Counter-Strike" meta="FPS · Shooter · Aug 2012" />}
          metrics={<span>metric</span>}
        />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByText("metric"));
    expect(onOpen).toHaveBeenCalledTimes(1);
    const link = screen.getByRole("link", { name: /Counter-Strike/ });
    expect(link.getAttribute("href")).toBe("/games/730");
    expect(link.textContent).toContain("FPS · Shooter · Aug 2012");
    fireEvent.click(link);
    expect(onOpen).toHaveBeenCalledTimes(1); // stopPropagation — one navigation, not two
  });

  it("accents the top row's revenue only, and takes the width the header repeats", () => {
    render(
      <>
        <RevenueCell top>$1.0M</RevenueCell>
        <RevenueCell top={false} width="w-28">
          $2.0M
        </RevenueCell>
      </>,
    );
    const top = screen.getByText("$1.0M");
    expect(top.className).toContain("text-brand");
    expect(top.className).toContain("w-20");
    const rest = screen.getByText("$2.0M");
    expect(rest.className).toContain("text-ink-primary");
    expect(rest.className).toContain("w-28");
    expect(rest.className).not.toContain("w-20");
  });
});

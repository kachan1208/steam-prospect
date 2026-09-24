import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { PREFIX_MERGE_MS, loadRecent, pushRecent } from "../../lib/recentSearches";
import { RecentSearchChips } from "./RecentSearches";
import { SearchBar } from "./SearchBar";

beforeEach(() => {
  window.localStorage.clear();
  let t = 1_000_000;
  // Oldest first, far enough apart that the prefix merge never folds them.
  for (const q of ["Balatro", "Hades", "Hollow Knight"]) pushRecent("games", q, (t += PREFIX_MERGE_MS * 2));
});
afterEach(cleanup);

function Harness({ onSearch = () => {} }: { onSearch?: (q: string) => void }) {
  const [q, setQ] = useState("");
  return (
    <SearchBar
      recentScope="games"
      value={q}
      onChange={(v) => {
        setQ(v);
        onSearch(v);
      }}
      placeholder="Search by name…"
      ariaLabel="Search games by name"
      total={0}
      loading={false}
    />
  );
}

const input = () => screen.getByRole("combobox", { name: "Search games by name" }) as HTMLInputElement;
const options = () => screen.queryAllByRole("option").map((o) => o.textContent?.replace("×", "").trim());

describe("recent searches on the SearchBar", () => {
  it("opens on focus when the box is empty, newest first, and closes once you type", () => {
    render(<Harness />);
    expect(screen.queryByRole("listbox")).toBeNull();
    fireEvent.focus(input());
    expect(input().getAttribute("aria-expanded")).toBe("true");
    expect(options()).toEqual(["Hollow Knight", "Hades", "Balatro"]);
    fireEvent.change(input(), { target: { value: "cel" } });
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("runs a recent search from the keyboard and moves it to the top", () => {
    const onSearch = vi.fn();
    render(<Harness onSearch={onSearch} />);
    fireEvent.focus(input());
    fireEvent.keyDown(input(), { key: "ArrowDown" });
    fireEvent.keyDown(input(), { key: "ArrowDown" });
    expect(input().getAttribute("aria-activedescendant")).toMatch(/-opt-1$/);
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(onSearch).toHaveBeenCalledWith("Hades");
    expect(input().value).toBe("Hades");
    expect(loadRecent("games")[0].q).toBe("Hades");
  });

  it("picks with the mouse, removes one with ×, clears all, and Esc closes", () => {
    const onSearch = vi.fn();
    render(<Harness onSearch={onSearch} />);
    fireEvent.focus(input());
    fireEvent.mouseDown(screen.getAllByTestId("recent-remove")[0]);
    expect(options()).toEqual(["Hades", "Balatro"]);
    expect(onSearch).not.toHaveBeenCalled();

    fireEvent.keyDown(input(), { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
    fireEvent.blur(input());
    fireEvent.focus(input());
    fireEvent.mouseDown(screen.getByRole("option", { name: /Balatro/ }));
    expect(onSearch).toHaveBeenCalledWith("Balatro");

    fireEvent.change(input(), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(loadRecent("games")).toEqual([]);
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("removes the highlighted entry with Delete", () => {
    render(<Harness />);
    fireEvent.focus(input());
    fireEvent.keyDown(input(), { key: "ArrowDown" });
    fireEvent.keyDown(input(), { key: "Delete" });
    expect(options()).toEqual(["Hades", "Balatro"]);
  });

  it("without recentScope the bar is a plain search box", () => {
    render(
      <SearchBar value="" onChange={() => {}} placeholder="Search…" ariaLabel="Plain search" total={0} loading={false} />,
    );
    const box = screen.getByLabelText("Plain search");
    fireEvent.focus(box);
    expect(box.getAttribute("role")).toBeNull();
    expect(screen.queryByRole("listbox")).toBeNull();
  });
});

describe("RecentSearchChips", () => {
  it("renders nothing without history, and picks / removes / clears with it", () => {
    const onPick = vi.fn();
    const { rerender } = render(<RecentSearchChips scope="niches" onPick={onPick} />);
    expect(screen.queryByTestId("recent-search-chips")).toBeNull();

    pushRecent("niches", "Roguelike", 1_000);
    pushRecent("niches", "Souls-like", 1_000 + PREFIX_MERGE_MS * 2);
    rerender(<RecentSearchChips scope="niches" onPick={onPick} />);
    fireEvent.click(screen.getByRole("button", { name: "Roguelike" }));
    expect(onPick).toHaveBeenCalledWith("Roguelike");
    fireEvent.click(screen.getByRole("button", { name: "Remove “Souls-like” from recent searches" }));
    expect(loadRecent("niches").map((e) => e.q)).toEqual(["Roguelike"]);
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(screen.queryByTestId("recent-search-chips")).toBeNull();
  });
});

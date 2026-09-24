import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";

import {
  PREFIX_MERGE_MS,
  RECENT_MAX,
  RECORD_DELAY_MS,
  clearRecent,
  loadRecent,
  normalizeQuery,
  pushRecent,
  removeRecent,
  useRecordRecentSearch,
} from "./recentSearches";

beforeEach(() => window.localStorage.clear());
afterEach(() => vi.useRealTimers());

describe("recent searches store", () => {
  it("normalizes whitespace and ignores queries shorter than two characters", () => {
    expect(normalizeQuery("  hollow   knight ")).toBe("hollow knight");
    pushRecent("games", " a ");
    expect(loadRecent("games")).toEqual([]);
  });

  it("keeps the newest first, dedupes case-insensitively (latest casing wins) and caps the list", () => {
    let t = 1_000_000;
    pushRecent("games", "Hades", (t += PREFIX_MERGE_MS * 2));
    pushRecent("games", "Balatro", (t += PREFIX_MERGE_MS * 2));
    pushRecent("games", "hades", (t += PREFIX_MERGE_MS * 2));
    expect(loadRecent("games").map((e) => e.q)).toEqual(["hades", "Balatro"]);
    for (let i = 0; i < RECENT_MAX + 3; i++) pushRecent("games", `query ${i}`, (t += PREFIX_MERGE_MS * 2));
    const list = loadRecent("games");
    expect(list).toHaveLength(RECENT_MAX);
    expect(list[0].q).toBe(`query ${RECENT_MAX + 2}`);
  });

  it("replaces a half-typed query with its completion when both land within the merge window", () => {
    pushRecent("niches", "rogue", 5_000);
    pushRecent("niches", "roguelike", 5_000 + 3_000);
    expect(loadRecent("niches").map((e) => e.q)).toEqual(["roguelike"]);
    // Outside the window both stay — the user really searched both.
    pushRecent("niches", "roguelike deckbuilder", 5_000 + 3_000 + PREFIX_MERGE_MS + 1);
    expect(loadRecent("niches").map((e) => e.q)).toEqual(["roguelike deckbuilder", "roguelike"]);
  });

  it("keeps each surface's list separate, and removes / clears one list only", () => {
    pushRecent("games", "Hades");
    pushRecent("studios", "Supergiant");
    removeRecent("games", "HADES");
    expect(loadRecent("games")).toEqual([]);
    expect(loadRecent("studios").map((e) => e.q)).toEqual(["Supergiant"]);
    clearRecent("studios");
    expect(loadRecent("studios")).toEqual([]);
  });

  it("degrades to no history when storage is unavailable or corrupt", () => {
    window.localStorage.setItem("prospect.recentSearches.v1.games", "{not json");
    expect(loadRecent("games")).toEqual([]);
    const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    expect(() => pushRecent("games", "Hades")).not.toThrow();
    spy.mockRestore();
  });
});

describe("useRecordRecentSearch", () => {
  it("records a query only after it has settled AND returned results, and only once", () => {
    vi.useFakeTimers();
    const { rerender } = renderHook(({ q, ready }) => useRecordRecentSearch("games", q, ready), {
      initialProps: { q: "hol", ready: false },
    });
    vi.advanceTimersByTime(RECORD_DELAY_MS * 2);
    expect(loadRecent("games")).toEqual([]); // no results yet → not a search

    rerender({ q: "hollow", ready: true });
    vi.advanceTimersByTime(RECORD_DELAY_MS - 1);
    expect(loadRecent("games")).toEqual([]); // still typing, as far as we know
    vi.advanceTimersByTime(1);
    expect(loadRecent("games").map((e) => e.q)).toEqual(["hollow"]);

    // A refetch / re-render of the same query never re-stamps it.
    const at = loadRecent("games")[0].at;
    rerender({ q: "hollow", ready: false });
    rerender({ q: "hollow", ready: true });
    vi.advanceTimersByTime(RECORD_DELAY_MS * 2);
    expect(loadRecent("games")[0].at).toBe(at);
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  addToCompare,
  clearCompare,
  COMPARE_CAP,
  getCompareList,
  isCompared,
  removeFromCompare,
  subscribe,
  toggleCompare,
} from "./compareList";

const STORAGE_KEY = "prospect:compare-list:v1";

beforeEach(() => {
  clearCompare();
  localStorage.removeItem(STORAGE_KEY);
});

describe("compareList", () => {
  it("adds entries and reports membership", () => {
    expect(addToCompare(294100, "RimWorld")).toBe(true);
    expect(isCompared(294100)).toBe(true);
    expect(getCompareList()).toEqual([{ appid: 294100, name: "RimWorld" }]);
  });

  it("dedupes by appid", () => {
    addToCompare(1, "A");
    expect(addToCompare(1, "A again")).toBe(false);
    expect(getCompareList()).toHaveLength(1);
  });

  it("caps the list at COMPARE_CAP", () => {
    for (let i = 1; i <= COMPARE_CAP; i++) expect(addToCompare(i, `G${i}`)).toBe(true);
    expect(addToCompare(999, "Overflow")).toBe(false);
    expect(getCompareList()).toHaveLength(COMPARE_CAP);
    expect(toggleCompare(999, "Overflow")).toBe("full");
  });

  it("removes and clears", () => {
    addToCompare(1, "A");
    addToCompare(2, "B");
    removeFromCompare(1);
    expect(getCompareList().map((e) => e.appid)).toEqual([2]);
    clearCompare();
    expect(getCompareList()).toEqual([]);
  });

  it("toggle adds then removes", () => {
    expect(toggleCompare(5, "E")).toBe("added");
    expect(toggleCompare(5, "E")).toBe("removed");
    expect(isCompared(5)).toBe(false);
  });

  it("persists to the versioned localStorage key", () => {
    addToCompare(42, "Answer");
    const raw = localStorage.getItem(STORAGE_KEY);
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw!)).toEqual([{ appid: 42, name: "Answer" }]);
  });

  it("notifies subscribers on every mutation and supports unsubscribe", () => {
    const spy = vi.fn();
    const unsub = subscribe(spy);
    addToCompare(1, "A");
    removeFromCompare(1);
    clearCompare();
    expect(spy).toHaveBeenCalledTimes(3);
    unsub();
    addToCompare(2, "B");
    expect(spy).toHaveBeenCalledTimes(3);
  });

  it("keeps a stable snapshot reference between mutations (useSyncExternalStore contract)", () => {
    addToCompare(1, "A");
    const a = getCompareList();
    const b = getCompareList();
    expect(a).toBe(b); // same reference until the next mutation
    addToCompare(2, "B");
    expect(getCompareList()).not.toBe(a);
  });
});

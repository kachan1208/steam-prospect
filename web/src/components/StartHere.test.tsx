import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import { START_HERE_STORAGE_KEY, StartHere } from "./StartHere";

function renderStrip(onDismiss?: () => void) {
  return render(
    <MemoryRouter>
      <StartHere onDismiss={onDismiss} />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  window.localStorage.removeItem(START_HERE_STORAGE_KEY);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("StartHere — the first-visit path", () => {
  it("lays out the three steps in order, as an ordered list", () => {
    renderStrip();
    const strip = screen.getByTestId("start-here");
    const steps = within(strip).getAllByRole("listitem").map((li) => li.textContent ?? "");
    expect(steps).toHaveLength(3);
    expect(steps[0]).toMatch(/Find a niche on the Radar/);
    expect(steps[1]).toMatch(/Read this first/);
    expect(steps[1]).toMatch(/games/);
    expect(steps[2]).toMatch(/competitors and launch timing/i);
  });

  it("links the places each step sends you, and the guide", () => {
    renderStrip();
    const href = (name: string | RegExp) => screen.getByRole("link", { name }).getAttribute("href");
    expect(href("Niche Finder")).toBe("/niches");
    expect(href("competing games")).toBe("/games");
    expect(href("Launch timing")).toBe("/timing");
    expect(href(/Read the guide/)).toBe("/docs");
  });

  it("dismisses, and stays dismissed on the next visit", () => {
    const onDismiss = vi.fn();
    renderStrip(onDismiss);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss the Start here guide" }));
    expect(screen.queryByTestId("start-here")).toBeNull();
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(window.localStorage.getItem(START_HERE_STORAGE_KEY)).toBe("1");
    cleanup();
    renderStrip();
    expect(screen.queryByTestId("start-here")).toBeNull();
  });

  it("survives storage that throws — shows, and still dismisses for this page", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    // The setup shim may not be a Storage subclass; cover it directly too.
    const ls = window.localStorage;
    const origGet = ls.getItem;
    const origSet = ls.setItem;
    ls.getItem = () => {
      throw new Error("SecurityError");
    };
    ls.setItem = () => {
      throw new Error("QuotaExceededError");
    };
    try {
      renderStrip();
      expect(screen.getByTestId("start-here")).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Dismiss the Start here guide" }));
      expect(screen.queryByTestId("start-here")).toBeNull();
    } finally {
      ls.getItem = origGet;
      ls.setItem = origSet;
    }
  });
});

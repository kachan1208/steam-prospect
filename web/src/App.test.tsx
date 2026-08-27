import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import App, { NAV_ITEMS } from "./App";
import { ThemeProvider } from "./lib/theme";

/**
 * NAV DEMOTION (2026-08-27 directive: "do we need list of niches as separate tab then?
 * … It seems odd"): "Niches" left the top navigation, but this is a DEMOTION, not a
 * removal — the /niches route and the NicheFinder page must stay fully reachable (the
 * radar header's "Open Niche Finder →" link and every in-page link still point there).
 * Both halves are pinned so neither can silently regress the other.
 */

function renderAt(path: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={client}>
      <ThemeProvider>
        <MemoryRouter initialEntries={[path]}>
          <App />
        </MemoryRouter>
      </ThemeProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const body = url.includes("/api/niches?") ? { items: [], total: 0, limit: 50, offset: 0 } : {};
      return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("App — Niches nav demotion", () => {
  it("the top nav no longer carries a Niches item", () => {
    expect(NAV_ITEMS.some((i) => i.to === "/niches" || i.label === "Niches")).toBe(false);
    renderAt("/games");
    const nav = document.querySelector("nav")!;
    expect(nav.textContent).not.toContain("Niches");
    // The surviving destinations are all still there.
    for (const label of ["Radar", "Games", "Studios", "Timing", "Watchlist"]) {
      expect(nav.textContent).toContain(label);
    }
  });

  it("the /niches route still serves the Niche Finder page (demoted, not removed)", async () => {
    renderAt("/niches");
    expect(await screen.findByText("Niche Finder")).toBeTruthy();
  });
});

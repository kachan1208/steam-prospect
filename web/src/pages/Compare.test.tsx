import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import Compare from "./Compare";
import { ThemeProvider } from "../lib/theme";
import { addToCompare, clearCompare, isCompared } from "../lib/compareList";
import type { GameProfile } from "../lib/api";

/**
 * Three behaviours are pinned here, all silently breakable by a restyle:
 *
 * 1. The ids ride the URL (?ids=1,2) — with no ids param, a stored (localStorage) list
 *    still normalizes the URL to match, so a returning visitor's view is shareable too.
 * 2. The metric grid's best-in-row highlight (bold + accent-300 / brand) picks the right
 *    column per row, and the "Players 7d" row uses trend-verdict coloring (accent-300 up
 *    / muted down) instead — it is never marked "best".
 * 3. Removing a game via its ✕ drops it from BOTH the URL and the stored compare list.
 */

const STORAGE_KEY = "prospect:compare-list:v1";

function profile(overrides: Partial<GameProfile> & { appid: number; name: string }): GameProfile {
  return {
    release_year: 2024,
    release_date: "2024-01-01",
    price_initial: 19.99,
    is_free: 0,
    primary_genre: "Simulation",
    developers: "Dev Studio",
    publishers: "Dev Studio",
    self_published: 1,
    is_indie: 1,
    owners_mid: 50_000,
    total_reviews: 1000,
    positive_ratio: 0.9,
    est_rev_reviews: 500_000,
    est_rev_owners: 500_000,
    metacritic_score: null,
    achievements_count: 10,
    avg_playtime_forever: 300,
    header_image: null,
    short_description: "",
    rev_pct_in_genre: 60,
    reviews_pct_in_genre: 60,
    owners_pct_in_genre: 60,
    top_tags: ["Simulation", "Colony Sim"],
    n_reviews_sampled: 1000,
    n_reviews_first_30d: 100,
    n_reviews_first_90d: 200,
    n_reviews_first_365d: 500,
    n_reviews_trailing_30d: 50,
    playtime_p25: 100,
    playtime_p50: 200,
    playtime_p75: 400,
    live_players: 500,
    first_seen: "2024-01-01",
    players_trend_7d_pct: 5,
    ...overrides,
  };
}

const PROFILES: Record<number, GameProfile> = {
  1: profile({
    appid: 1,
    name: "Frostharbor",
    est_rev_reviews: 1_240_000,
    owners_mid: 71_400,
    positive_ratio: 0.91,
    live_players: 8204,
    players_trend_7d_pct: 6.8,
  }),
  2: profile({
    appid: 2,
    name: "Loam & Ledger",
    est_rev_reviews: 890_000,
    owners_mid: 62_800,
    positive_ratio: 0.93,
    live_players: 5910,
    players_trend_7d_pct: 2.1,
  }),
  // GET /api/games/367520 and /api/games/1030300, verbatim — the pair that exposed the mixed
  // estimators. Silksong carries a HIGHER price, a LOWER reviews-based revenue and a HIGHER
  // owners_mid than Hollow Knight, so pairing revenue-from-reviews with units-from-owners made
  // the grid say "more units, less revenue, higher price" — three claims that cannot all hold.
  367520: profile({
    appid: 367520,
    name: "Hollow Knight",
    price_initial: 14.99,
    total_reviews: 559_257,
    est_rev_reviews: 251_497_872.9,
    est_rev_owners: 112_425_000,
    owners_mid: 7_500_000,
  }),
  1030300: profile({
    appid: 1030300,
    name: "Hollow Knight: Silksong",
    price_initial: 19.99,
    total_reviews: 418_766,
    est_rev_reviews: 251_133_970.2,
    est_rev_owners: 218_852_556.77,
    owners_mid: 10_948_101.89,
  }),
};

let lastLocation = { pathname: "", search: "" };

function LocationSpy() {
  const loc = useLocation();
  lastLocation = { pathname: loc.pathname, search: loc.search };
  return null;
}

function renderCompare(initialPath: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={client}>
      <ThemeProvider>
        <MemoryRouter initialEntries={[initialPath]}>
          <Routes>
            <Route path="/compare" element={<Compare />} />
          </Routes>
          <LocationSpy />
        </MemoryRouter>
      </ThemeProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  lastLocation = { pathname: "", search: "" };
  clearCompare();
  localStorage.removeItem(STORAGE_KEY);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const m = url.match(/^\/api\/games\/(\d+)(\/trends)?/);
      if (m?.[2]) {
        // Trends overlay: CompareTrendsChart is owned by another agent — an empty,
        // ineligible response is enough to exercise this page without asserting on it.
        return new Response(JSON.stringify({ appid: Number(m[1]), eligible: false, points: [], comps: null }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (m) {
        const p = PROFILES[Number(m[1])];
        if (!p) return new Response(JSON.stringify({ detail: "not found" }), { status: 404 });
        return new Response(JSON.stringify(p), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify({}), { status: 200, headers: { "Content-Type": "application/json" } });
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Compare empty / single-game states", () => {
  it("shows an empty state with no ids and no stored selection", async () => {
    renderCompare("/compare");
    expect(await screen.findByText("Nothing to compare yet")).toBeTruthy();
  });

  it("normalizes the URL from the stored compare list when ?ids is missing", async () => {
    addToCompare(1, "Frostharbor");
    addToCompare(2, "Loam & Ledger");
    renderCompare("/compare");
    await waitFor(() => expect(lastLocation.search).toBe("?ids=1%2C2"));
  });

  it("asks for a second game when only one id is given", async () => {
    renderCompare("/compare?ids=1");
    expect(await screen.findByText("Only one game selected — Frostharbor")).toBeTruthy();
  });
});

describe("Compare metric grid", () => {
  it("renders both games, the slot caption, and bolds the best value per numeric row", async () => {
    renderCompare("/compare?ids=1,2");

    // The chart panel's legend and the metric grid's header both name every game (by
    // design — the legend swatch ties a column to its trend line); wait for the grid
    // itself (gated on the profile fetches) rather than the ambiguous name text.
    await screen.findByLabelText("Remove Frostharbor from comparison");
    await screen.findByLabelText("Remove Loam & Ledger from comparison");
    expect(screen.getByText("2 of 6 slots · share this view by URL")).toBeTruthy();
    // Room left under the compare cap -> the add-game affordance is present.
    expect(screen.getByText("+ Add game")).toBeTruthy();

    // Est. gross revenue: Frostharbor ($1.24M) beats Loam & Ledger ($890.0K).
    const bestRevenue = await screen.findByText("$1.2M");
    expect(bestRevenue.className).toContain("text-brand");
    expect(bestRevenue.className).toContain("font-semibold");

    const otherRevenue = screen.getByText("$890.0K");
    expect(otherRevenue.className).not.toContain("font-semibold");

    // Rating: Loam & Ledger (93.0%) beats Frostharbor (91.0%).
    const bestRating = await screen.findByText("93.0%");
    expect(bestRating.className).toContain("text-brand");
    const otherRating = screen.getByText("91.0%");
    expect(otherRating.className).not.toContain("font-semibold");
  });

  it("colors the Players 7d row by trend direction, not by best-in-row", async () => {
    renderCompare("/compare?ids=1,2");
    await screen.findByLabelText("Remove Frostharbor from comparison");

    const up1 = screen.getByText((_, el) => el?.tagName === "SPAN" && el.textContent === "▲ +6.8%");
    const up2 = screen.getByText((_, el) => el?.tagName === "SPAN" && el.textContent === "▲ +2.1%");
    expect(up1.className).toContain("text-brand");
    expect(up2.className).toContain("text-brand");
    // Both are "up" — neither should carry the best-in-row bold treatment.
    expect(up1.className).not.toContain("font-semibold");
    expect(up2.className).not.toContain("font-semibold");
  });

  it("hides the add-game affordance once the compare cap is reached", async () => {
    addToCompare(1, "Frostharbor");
    renderCompare("/compare?ids=1,2,3,4,5,6");
    await screen.findByText("6 of 6 slots · share this view by URL");
    expect(screen.queryByText("+ Add game")).toBeNull();
  });

  it("takes units from the same estimator as revenue, so price × units reproduces the row above", async () => {
    renderCompare("/compare?ids=367520,1030300");
    await screen.findByLabelText("Remove Hollow Knight from comparison");

    // Reviews-based on both rows: 559,257 × 30 × $14.99 = $251.5M over 16.8M units at $14.99;
    // 418,766 × 30 × $19.99 = $251.1M over 12.6M units at $19.99.
    expect(screen.getByText("$251.5M")).toBeTruthy();
    expect(screen.getByText("$251.1M")).toBeTruthy();
    expect(screen.getByText("16.8M")).toBeTruthy();
    expect(screen.getByText("12.6M")).toBeTruthy();

    // The owners-based counts must no longer appear in the units row — pairing them with the
    // reviews-based revenue is what produced "more units AND less revenue at a higher price".
    expect(screen.queryByText("7.5M")).toBeNull();
    expect(screen.queryByText("10.9M")).toBeNull();

    // Best-in-row now agrees with itself: the higher-revenue game is also the higher-units game.
    const bestRevenue = screen.getByText("$251.5M");
    const bestUnits = screen.getByText("16.8M");
    expect(bestRevenue.className).toContain("font-semibold");
    expect(bestUnits.className).toContain("font-semibold");
  });

  it("removes a game from both the URL and the stored compare list", async () => {
    addToCompare(1, "Frostharbor");
    addToCompare(2, "Loam & Ledger");
    renderCompare("/compare?ids=1,2");

    fireEvent.click(await screen.findByLabelText("Remove Frostharbor from comparison"));

    await waitFor(() => expect(lastLocation.search).toBe("?ids=2"));
    expect(isCompared(1)).toBe(false);
    expect(isCompared(2)).toBe(true);
  });
});

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import Compare, { bestOf } from "./Compare";
import { ThemeProvider } from "../lib/theme";
import { addToCompare, clearCompare, isCompared } from "../lib/compareList";
import type { GameProfile, GameTrendPoint } from "../lib/api";

/**
 * Pinned here, all silently breakable by a restyle:
 *
 * 1. The ids ride the URL (?ids=1,2) — with no ids param, a stored (localStorage) list
 *    still normalizes the URL to match, so a returning visitor's view is shareable too.
 * 2. The metric grid's best-in-row highlight picks the right column per row, judged on the
 *    DISPLAYED value: every tied best wins, and a row where every game ties has no winner
 *    (three "top 1%" ranks used to show one of them "best"). The "7-day players trend" row
 *    uses trend-verdict coloring instead — it is never marked "best".
 * 3. Every row explains itself — an ⓘ with the formula worked through for each game.
 * 4. Removing a game via its ✕ drops it from BOTH the URL and the stored compare list.
 * 5. Below 640px the grid is metric-major (every game's value per metric), not a 670px
 *    table in a 340px scroller.
 */

// Recharts' ResponsiveContainer observes its box; jsdom ships no ResizeObserver.
beforeAll(() => {
  if (typeof globalThis.ResizeObserver === "undefined") {
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  }
});

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
  // GET /api/games/2379780, 646570, 1145360 (2026-09-21 mart): three roguelike hits whose
  // revenue ranks in genre are 99.63, 99.81 and 99.59 — all "top 1%". The grid printed
  // "P100" three times and highlighted ONE of them "best".
  2379780: profile({
    appid: 2379780,
    name: "Balatro",
    release_date: "2024-02-20",
    price_initial: 14.99,
    total_reviews: 198_820,
    est_rev_reviews: 89_409_354,
    rev_pct_in_genre: 99.62807996280799,
    players_trend_7d_pct: -0.55,
    top_tags: ["Card Game", "Roguelike Deckbuilder", "Pixel Graphics"],
  }),
  646570: profile({
    appid: 646570,
    name: "Slay the Spire",
    release_date: "2019-01-23",
    price_initial: 24.99,
    total_reviews: 218_661,
    est_rev_reviews: 163_931_451,
    rev_pct_in_genre: 99.81403998140401,
    players_trend_7d_pct: -2.29,
    top_tags: ["Card Game", "Roguelike Deckbuilder", "Card Battler"],
  }),
  1145360: profile({
    appid: 1145360,
    name: "Hades",
    release_date: "2020-09-17",
    price_initial: 24.99,
    total_reviews: 308_633,
    est_rev_reviews: 231_389_000,
    rev_pct_in_genre: 99.59400374765771,
    players_trend_7d_pct: -5.35,
    top_tags: ["Action Roguelike", "Hack and Slash", "Mythology"],
  }),
  // The 2026-09-23 mart's market-relative trend: Hades +0.36% in a +0.75% Steam week.
  11: {
    ...profile({ appid: 11, name: "Market Laggard", players_trend_7d_pct: 0.36 }),
    players_trend_7d_market_pct: 0.75,
    players_trend_7d_rel_pct: -0.39,
  } as GameProfile,
  12: {
    ...profile({ appid: 12, name: "Market Leader", players_trend_7d_pct: 1.75 }),
    players_trend_7d_market_pct: 0.75,
    players_trend_7d_rel_pct: 1.0,
  } as GameProfile,
  // Grand Theft Auto V Legacy: $0 with is_free 0 — a price we don't know, not a free game.
  271590: profile({
    appid: 271590,
    name: "Grand Theft Auto V Legacy",
    price_initial: 0,
    is_free: 0,
    est_rev_reviews: 0,
    total_reviews: 2_078_793,
  }),
};

/** Monthly histograms for the trends mock, keyed by appid. */
const TRENDS: Record<number, GameTrendPoint[]> = {
  2379780: [
    { period: "2024-02", n_reviews: 10_384, ccu_avg: null },
    { period: "2024-03", n_reviews: 13_110, ccu_avg: null },
    { period: "2024-04", n_reviews: 6_631, ccu_avg: null },
    { period: "2024-05", n_reviews: 4_385, ccu_avg: null },
  ],
  // Slay the Spire sold in Early Access from Nov 2017; its release_date is the 1.0 (Jan 2019).
  646570: [
    { period: "2017-11", n_reviews: 89, ccu_avg: null },
    { period: "2017-12", n_reviews: 1_021, ccu_avg: null },
    { period: "2019-01", n_reviews: 5_000, ccu_avg: null },
    { period: "2019-02", n_reviews: 3_000, ccu_avg: null },
    { period: "2019-03", n_reviews: 2_000, ccu_avg: null },
  ],
  1145360: [
    { period: "2020-09", n_reviews: 9_000, ccu_avg: null },
    { period: "2020-10", n_reviews: 5_000, ccu_avg: null },
    { period: "2020-11", n_reviews: 3_000, ccu_avg: null },
  ],
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

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
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
        const primary = Number(m[1]);
        const comps = (new URL(url, "http://x").searchParams.get("comps") ?? "")
          .split(",")
          .filter(Boolean)
          .map(Number);
        const known = TRENDS[primary];
        return json({
          appid: primary,
          eligible: !!known,
          points: known ?? [],
          comps: {
            requested: comps,
            matched: comps.filter((c) => TRENDS[c]),
            series: comps.filter((c) => TRENDS[c]).map((c) => ({ appid: c, points: TRENDS[c] })),
            cohort: [],
          },
        });
      }
      if (m) {
        const p = PROFILES[Number(m[1])];
        if (!p) return json({ detail: "not found" }, 404);
        return json(p);
      }
      // /api/health: a data date, so the running month is known (Sep 2026).
      if (url.startsWith("/api/health")) {
        return json({ status: "ok", mart_version: "20260921", built_at: "2026-09-21T22:28:20+00:00", source_db: null });
      }
      return json({});
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.innerWidth = 1024;
});

/** The value span of a row's cell for one game (the grid's cells are in id order). */
function rowOf(key: string): HTMLElement {
  return screen.getByTestId(`compare-row-${key}`);
}

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

    // Est. revenue: Frostharbor ($1.24M) beats Loam & Ledger ($890.0K).
    const bestRevenue = within(rowOf("revenue")).getByText("$1.2M");
    expect(bestRevenue.className).toContain("text-brand");
    expect(bestRevenue.className).toContain("font-semibold");
    const otherRevenue = within(rowOf("revenue")).getByText("$890.0K");
    expect(otherRevenue.className).not.toContain("font-semibold");

    // Positive reviews: Loam & Ledger (93.0%) beats Frostharbor (91.0%).
    const bestRating = within(rowOf("rating")).getByText("93.0%");
    expect(bestRating.className).toContain("text-brand");
    expect(within(rowOf("rating")).getByText("91.0%").className).not.toContain("font-semibold");
  });

  it("colors the 7-day players trend by direction, not by best-in-row", async () => {
    renderCompare("/compare?ids=1,2");
    await screen.findByLabelText("Remove Frostharbor from comparison");

    const up1 = within(rowOf("players_7d")).getByText("▲ +6.8%");
    const up2 = within(rowOf("players_7d")).getByText("▲ +2.1%");
    expect(up1.className).toContain("text-brand");
    expect(up2.className).toContain("text-brand");
    // Both are "up" — neither should carry the best-in-row bold treatment.
    expect(up1.className).not.toContain("font-semibold");
    expect(up2.className).not.toContain("font-semibold");
  });

  it("reads the week against Steam when the market baseline is there — an up week can still trail", async () => {
    renderCompare("/compare?ids=11,12");
    await screen.findByLabelText("Remove Market Laggard from comparison");
    const row = rowOf("players_7d");
    // +0.36% is UP (its arrow matches the printed number), but 0.39 pts behind Steam's +0.75%:
    // the relative note carries its own ▼ so the week still reads as trailing the market.
    const laggard = within(row).getByText("▲ +0.4%");
    expect(laggard.className).toContain("text-brand");
    expect(within(row).getByText("vs Steam +0.8%: ▼ −0.4 pts")).toBeTruthy();
    expect(within(row).getByText("▲ +1.8%").className).toContain("text-brand");
    fireEvent.click(within(row).getByRole("button", { name: "About 7-day players trend" }));
    expect((await screen.findByRole("tooltip")).textContent).toContain("Market Laggard: +0.4% − Steam +0.8% = −0.4 pts");
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
    expect(screen.getByText("$251.5M").className).toContain("font-semibold");
    expect(screen.getByText("16.8M").className).toContain("font-semibold");
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

describe("Compare — every row explains itself", () => {
  it("gives every metric row an ⓘ, in the glossary's names", async () => {
    renderCompare("/compare?ids=1,2");
    await screen.findByLabelText("Remove Frostharbor from comparison");
    for (const name of [
      "About Est. revenue",
      "About Est. units sold",
      "About Positive reviews",
      "About Players now",
      "About 7-day players trend",
      "About Reviews",
      "About Revenue rank vs genre",
      "About Reviews, first 3 months",
      "About Reviews, first 12 months",
      "About Median playtime",
      "About Primary genre",
      "About Top tags",
    ]) {
      expect(screen.getByRole("button", { name }), name).toBeTruthy();
    }
    // The retired names are gone.
    expect(screen.queryByText("Est. gross revenue")).toBeNull();
    expect(screen.queryByText("Live players (now)")).toBeNull();
  });

  it("works the revenue formula through EACH game's own numbers", async () => {
    renderCompare("/compare?ids=2379780,646570");
    await screen.findByLabelText("Remove Balatro from comparison");
    fireEvent.click(screen.getByRole("button", { name: "About Est. revenue" }));
    const tip = await screen.findByRole("tooltip");
    expect(tip.textContent).toContain("Balatro: 198,820 reviews × 30 × $14.99 = $89.4M");
    expect(tip.textContent).toContain("Slay the Spire: 218,661 reviews × 30 × $24.99 = $163.9M");
  });
});

describe("Compare — ranks, ties and tags", () => {
  it("never prints 'P100', and highlights none when every game ties on what's shown", async () => {
    renderCompare("/compare?ids=2379780,646570,1145360");
    await screen.findByLabelText("Remove Hades from comparison");
    const row = rowOf("rev_pct");
    // 99.63, 99.81 and 99.59 all floor into the top percent: "top 1%", three times.
    expect(within(row).getAllByText("top 1%")).toHaveLength(3);
    expect(row.textContent).not.toContain("P100");
    // …and a three-way tie has no winner — the old grid highlighted exactly one of them.
    for (const el of within(row).getAllByText("top 1%")) expect(el.className).not.toContain("text-brand");
    expect(within(row).getByText("(all tied)")).toBeTruthy();
  });

  it("highlights EVERY tied best when two of three share it", () => {
    const cell = (shown: string, num: number) => ({ node: shown, shown, num });
    expect([...bestOf([
      { id: 1, cell: cell("97.8%", 0.978) },
      { id: 2, cell: cell("98.0%", 0.9801) },
      { id: 3, cell: cell("98.0%", 0.9799) },
    ])]).toEqual([2, 3]);
    // A lone comparable value has nothing to beat.
    expect(bestOf([{ id: 1, cell: cell("1", 1) }, { id: 2, cell: { node: "x", shown: null, num: null } }]).size).toBe(0);
  });

  it("highlights only the shared tags; the rest carry no unexplained colour", async () => {
    renderCompare("/compare?ids=2379780,646570,1145360");
    await screen.findByLabelText("Remove Hades from comparison");
    const shared = screen.getAllByText("Card Game");
    for (const el of shared) expect(el.className).toContain("border-brand");
    // "Pixel Graphics" is on one game only: plain — it used to wear a red genre-tint outline.
    const lone = screen.getByText("Pixel Graphics");
    expect(lone.className).not.toContain("border-brand");
    expect(lone.getAttribute("style")).toBeNull();
  });

  it("tags an unknown price in the column header instead of calling it free", async () => {
    renderCompare("/compare?ids=271590,1");
    await screen.findByLabelText("Remove Grand Theft Auto V Legacy from comparison");
    const tags = screen.getAllByText("Price unknown");
    expect(tags.length).toBeGreaterThanOrEqual(2); // header caption + revenue row
    expect(screen.queryByText("Free")).toBeNull();
  });
});

describe("Compare — the histogram rows, the takeaway and launch alignment", () => {
  it("counts the first 3 months from Steam's full monthly histogram, launch month included", async () => {
    renderCompare("/compare?ids=2379780,646570,1145360");
    await screen.findByLabelText("Remove Hades from comparison");
    const row = rowOf("first3");
    // Balatro: Feb–Apr 2024 = 10,384 + 13,110 + 6,631 = 30,125 → "30.1K", the fastest start.
    await waitFor(() => expect(within(row).getByText("30.1K").className).toContain("text-brand"));
    // Slay the Spire is aligned on its 1.0 date and says its EA months aren't counted.
    expect(within(row).getByText("from 1.0 — sold in EA before")).toBeTruthy();
    fireEvent.click(within(row).getByRole("button", { name: "About Reviews, first 3 months" }));
    const tip = await screen.findByRole("tooltip");
    expect(tip.textContent).toContain("Balatro: Feb 2024 – Apr 2024: 10,384 + 13,110 + 6,631 = 30,125");
    // The sample-based first-N-day counts are named and refused, not silently swapped.
    expect(tip.textContent).toMatch(/SAMPLE/);
  });

  it("leads with a plain takeaway — the bearish reading first", async () => {
    renderCompare("/compare?ids=2379780,646570,1145360");
    const line = await screen.findByTestId("compare-takeaway");
    await waitFor(() => expect(line.textContent).toContain("started fastest"));
    // All three lost players (−0.55%, −2.29%, −5.35%): that is the FIRST thing it says.
    expect(line.textContent!.startsWith("All 3 are losing players this week (−0.6% to −5.3%).")).toBe(true);
    expect(line.textContent!.indexOf("losing players")).toBeLessThan(line.textContent!.indexOf("earned the most"));
    expect(line.textContent).toContain("Hades has earned the most (est. $231.4M, 2.6× Balatro)");
    expect(line.textContent).toContain("Balatro started fastest (30.1K reviews in its first 3 months)");
  });

  it("'Since launch' rides the URL as ?align=launch", async () => {
    renderCompare("/compare?ids=2379780,646570");
    await screen.findByLabelText("Remove Balatro from comparison");
    fireEvent.click(screen.getByRole("button", { name: "Since launch" }));
    await waitFor(() => expect(lastLocation.search).toBe("?ids=2379780%2C646570&align=launch"));
    fireEvent.click(screen.getByRole("button", { name: "Calendar" }));
    await waitFor(() => expect(lastLocation.search).toBe("?ids=2379780%2C646570"));
  });
});

describe("Compare — phones get a metric-major list, not a 670px table", () => {
  it("renders every game's value inside each metric block below 640px", async () => {
    window.innerWidth = 390;
    renderCompare("/compare?ids=2379780,646570,1145360");
    await screen.findByLabelText("Remove Hades from comparison");
    expect(screen.getByTestId("compare-stack")).toBeTruthy();
    const revenue = rowOf("revenue");
    for (const v of ["$89.4M", "$163.9M", "$231.4M"]) expect(within(revenue).getByText(v)).toBeTruthy();
    for (const n of ["Balatro", "Slay the Spire", "Hades"]) expect(within(revenue).getByText(n)).toBeTruthy();
  });
});

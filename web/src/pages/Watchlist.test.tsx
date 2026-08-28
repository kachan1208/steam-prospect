import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import Watchlist from "./Watchlist";
import { ThemeProvider } from "../lib/theme";
import { addGameToWatchlist, addNicheToWatchlist, clearWatchlist, getWatchlist, isGameWatchlisted } from "../lib/watchlist";

/**
 * Watchlist has no backend of its own — everything here either exercises the localStorage
 * store (lib/watchlist.test.ts covers that module in isolation) or the page's honesty
 * contract: alerts are evaluated against whatever the API answers RIGHT NOW, and nothing on
 * screen may claim a "fired on <date>" history the app has no way to know.
 */

const STORAGE_KEY = "prospect:watchlist:v1";

function nicheFixture(overrides: Record<string, unknown> = {}) {
  return {
    dimension: "tag",
    key: "Colony Sim",
    tier: "micro",
    variants: [
      {
        dimension: "tag",
        key: "Colony Sim",
        window: "24m",
        min_reviews: 50,
        opportunity_v2: 87.4,
        saturation_yoy: -0.12,
        players_trend_7d_pct: 24,
      },
    ],
    players: { players_trend_7d_pct: 24, total_players_now: 1000, players_coverage: 1, n_games_panel: 1, series: [] },
    saturation_trend: [],
    revenue_histogram: [],
    representative_games: [],
    themes: [],
    press: null,
    hit_rates: {},
    ...overrides,
  };
}

function gameFixture(overrides: Record<string, unknown> = {}) {
  return { appid: 1, name: "Frostharbor", price_initial: 14.99, players_trend_7d_pct: 6.8, ...overrides };
}

function mockFetch(opts: { niches?: Record<string, unknown>; games?: Record<number, unknown>; builtAt?: string | null }) {
  const niches = opts.niches ?? {};
  const games = opts.games ?? {};
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

    if (url.startsWith("/api/health")) {
      return json({ status: "ok", mart_version: "v1", built_at: opts.builtAt ?? null, source_db: "marts.duckdb" });
    }
    const nicheMatch = url.match(/^\/api\/niches\/([^/]+)\/([^/?]+)/);
    if (nicheMatch) {
      const key = decodeURIComponent(nicheMatch[2]);
      const data = niches[key];
      return data ? json(data) : json({ detail: "not found" }, 404);
    }
    const gameMatch = url.match(/^\/api\/games\/(\d+)/);
    if (gameMatch) {
      const data = games[Number(gameMatch[1])];
      return data ? json(data) : json({ detail: "not found" }, 404);
    }
    return json({});
  });
}

function renderWatchlist() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={client}>
      <ThemeProvider>
        <MemoryRouter initialEntries={["/watchlist"]}>
          <Routes>
            <Route path="/watchlist" element={<Watchlist />} />
          </Routes>
        </MemoryRouter>
      </ThemeProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  clearWatchlist();
  localStorage.removeItem(STORAGE_KEY);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("empty state", () => {
  it("looks deliberate, not broken, when nothing is watchlisted", async () => {
    vi.stubGlobal("fetch", mockFetch({}));
    renderWatchlist();
    expect(await screen.findByText("Nothing on your watchlist yet")).toBeTruthy();
    // The "+ Watchlist" affordance lives on OTHER pages (NicheDetail/GameProfile) — this
    // page just points at it, it doesn't try to reimplement an add flow of its own.
    expect(screen.getByText("+ Watchlist", { exact: false })).toBeTruthy();
    expect(screen.queryByRole("row")).toBeNull();
  });
});

describe("alerts section honesty (pending / failed / resolved)", () => {
  beforeEach(() => {
    addNicheToWatchlist("tag", "Colony Sim", "Colony Sim", {
      metric: "players_trend_7d_pct",
      comparator: "gt",
      threshold: 20,
    });
    addGameToWatchlist(1, "Frostharbor", { metric: "price_initial", comparator: "lt", threshold: 14.99 });
  });

  it("shows a loading state — never a confident bannerless page — while any fan-out query is pending", async () => {
    // Health resolves; the niche/game fan-out hangs forever.
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.startsWith("/api/health")) {
          return Promise.resolve(
            new Response(JSON.stringify({ status: "ok", mart_version: "v1", built_at: null, source_db: "m" }), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            }),
          );
        }
        return new Promise<Response>(() => {}); // pending forever
      }),
    );
    renderWatchlist();

    expect(await screen.findByText("Checking alert rules against live data…")).toBeTruthy();
    // No fired-banner and no failure claim while the answer isn't in yet.
    expect(screen.queryByText("Open deep dive")).toBeNull();
    expect(screen.queryByText(/Couldn.t check alerts/)).toBeNull();
  });

  it("names failed items with a retry instead of pretending nothing fired — and retry recovers", async () => {
    // First pass: the niche query fails, the game resolves below its threshold (no fire).
    let nicheFails = true;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        const json = (body: unknown, status = 200) =>
          new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
        if (url.startsWith("/api/health")) return json({ status: "ok", mart_version: "v1", built_at: null, source_db: "m" });
        if (/^\/api\/niches\//.test(url)) return nicheFails ? json({ detail: "boom" }, 500) : json(nicheFixture());
        if (/^\/api\/games\//.test(url)) return json(gameFixture({ price_initial: 19.99 })); // 19.99 > 14.99 -> no fire
        return json({});
      }),
    );
    renderWatchlist();

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Colony Sim");
    expect(alert.textContent).not.toContain("Frostharbor"); // only the FAILED item is named
    expect(screen.queryByText("Open deep dive")).toBeNull();
    expect(screen.queryByText("Checking alert rules against live data…")).toBeNull();

    // Retry: the niche now resolves at 24% > 20% — the banner appears, the error clears.
    nicheFails = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Open deep dive")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("claims nothing fired only after every query resolved below its threshold", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({
        niches: { "Colony Sim": nicheFixture({ players: { players_trend_7d_pct: 5 } }) }, // 5 < 20
        games: { 1: gameFixture({ price_initial: 19.99 }) }, // 19.99 > 14.99
      }),
    );
    renderWatchlist();

    // Settled: live trend values are on screen…
    await waitFor(() => expect(screen.getByText("$19.99")).toBeTruthy());
    // …and only THEN is the bannerless page an honest all-clear (no loading, no error).
    expect(screen.queryByText("Checking alert rules against live data…")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText("Open deep dive")).toBeNull();
  });

  it("banners a resolved rule that fires", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({
        niches: { "Colony Sim": nicheFixture() }, // 24 > 20 -> fires
        games: { 1: gameFixture({ price_initial: 19.99 }) }, // no fire
      }),
    );
    renderWatchlist();

    const banners = await screen.findAllByText("Open deep dive");
    expect(banners).toHaveLength(1); // exactly the fired rule, not the resolved-quiet one
    expect(document.body.textContent).toMatch(/Colony Sim\s*currently meets your alert/);
    expect(screen.queryByText("Checking alert rules against live data…")).toBeNull();
  });
});

describe("populated watchlist", () => {
  beforeEach(() => {
    addNicheToWatchlist("tag", "Colony Sim", "Colony Sim", {
      metric: "players_trend_7d_pct",
      comparator: "gt",
      threshold: 20,
    });
    addGameToWatchlist(1, "Frostharbor", { metric: "price_initial", comparator: "lt", threshold: 14.99 });
  });

  it("renders both kinds with the right type tag, links, rule text and live trend", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({
        niches: { "Colony Sim": nicheFixture() },
        games: { 1: gameFixture({ price_initial: 9.99 }) }, // below the $14.99 threshold -> fires
        builtAt: "2026-08-19T09:00:00Z",
      }),
    );
    renderWatchlist();

    const nicheLink = await screen.findByRole("link", { name: "Colony Sim" });
    expect(nicheLink.getAttribute("href")).toBe("/niches/tag/Colony%20Sim");
    const gameLink = screen.getByRole("link", { name: "Frostharbor" });
    expect(gameLink.getAttribute("href")).toBe("/games/1");

    expect(screen.getByText("niche")).toBeTruthy();
    expect(screen.getByText("game")).toBeTruthy();

    expect(screen.getByText("players 7d ▲ > +20%")).toBeTruthy();
    expect(screen.getByText("price drops below $14.99")).toBeTruthy();

    // Live trend values, once the fan-out queries resolve.
    await waitFor(() => expect(screen.getByText("▲ +24.0%")).toBeTruthy());
    expect(screen.getByText("$9.99")).toBeTruthy();

    // The one honest timestamp on the page: the mart build date, clearly labeled as such.
    expect(screen.getByText((_, el) => el?.textContent === "2 items · alerts evaluated live against current data · data as of Aug 19")).toBeTruthy();
  });

  it("bannering a fired rule states CURRENT status only — no invented crossing date", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({
        niches: { "Colony Sim": nicheFixture() }, // players_trend_7d_pct 24 > 20 -> fires
        games: { 1: gameFixture({ price_initial: 9.99 }) }, // 9.99 < 14.99 -> fires
        builtAt: null,
      }),
    );
    renderWatchlist();

    const banners = await screen.findAllByText("Open deep dive");
    expect(banners).toHaveLength(2);

    const body = document.body.textContent ?? "";
    expect(body).toMatch(/Colony Sim\s*currently meets your alert/);
    expect(body).toMatch(/Frostharbor\s*currently meets your alert/);

    // Never claim a dated crossing event — there's no history to back one.
    expect(body).not.toContain("crossed your alert");
    expect(body).not.toContain("passed the");
    expect(body).not.toMatch(/on Aug \d/); // "passed the threshold on Aug 19"-shaped claim
  });

  it("does not banner a rule that hasn't crossed its threshold", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({
        niches: { "Colony Sim": nicheFixture({ players: { players_trend_7d_pct: 5 } }) }, // 5 < 20 -> not fired
        games: { 1: gameFixture({ price_initial: 19.99 }) }, // 19.99 > 14.99 -> not fired
        builtAt: null,
      }),
    );
    renderWatchlist();

    await screen.findByText("players 7d ▲ > +20%"); // page settled
    expect(screen.queryByText("Open deep dive")).toBeNull();
    expect(screen.queryByText(/currently meets your alert/)).toBeNull();
  });

  it("never invents a per-item change history — Last change is always an honest em dash", async () => {
    vi.stubGlobal("fetch", mockFetch({ niches: { "Colony Sim": nicheFixture() }, games: { 1: gameFixture() } }));
    renderWatchlist();
    await screen.findByRole("link", { name: "Colony Sim" });
    const dashes = screen.getAllByTitle(
      "Prospect doesn't keep a change-event history for watchlist items — only the current value shown in Trend.",
    );
    expect(dashes).toHaveLength(2);
    for (const d of dashes) expect(d.textContent).toBe("—");
  });

  it("removes an item from the table and from storage", async () => {
    vi.stubGlobal("fetch", mockFetch({ niches: { "Colony Sim": nicheFixture() }, games: { 1: gameFixture() } }));
    renderWatchlist();
    await screen.findByRole("link", { name: "Frostharbor" });

    fireEvent.click(screen.getByLabelText("Remove Frostharbor from watchlist"));

    await waitFor(() => expect(screen.queryByRole("link", { name: "Frostharbor" })).toBeNull());
    expect(isGameWatchlisted(1)).toBe(false);
    expect(getWatchlist()).toHaveLength(1);
  });

  it("edits a rule inline and persists the change", async () => {
    vi.stubGlobal("fetch", mockFetch({ niches: { "Colony Sim": nicheFixture() }, games: { 1: gameFixture() } }));
    renderWatchlist();

    fireEvent.click(await screen.findByText("price drops below $14.99"));
    const input = screen.getByLabelText("Alert threshold for Frostharbor");
    fireEvent.change(input, { target: { value: "9.99" } });
    fireEvent.click(screen.getByText("Done"));

    expect(await screen.findByText("price drops below $9.99")).toBeTruthy();
    const gameEntry = getWatchlist().find((e) => e.kind === "game");
    expect(gameEntry?.rule).toEqual({ metric: "price_initial", comparator: "lt", threshold: 9.99 });
  });
});

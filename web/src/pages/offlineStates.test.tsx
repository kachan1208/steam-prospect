import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import Compare from "./Compare";
import GameProfile from "./GameProfile";
import LaunchTiming from "./LaunchTiming";
import NicheDetail, { NICHE_ROUTE_PATH } from "./NicheDetail";
import { DEFAULT_QUERY_OPTIONS } from "../lib/api";
import { ThemeProvider } from "../lib/theme";

/**
 * What the app says when it cannot REACH the API — as opposed to when the API says no.
 *
 * Reproduced against production 2026-09-01 by aborting every `**\/api\/**` request in
 * Playwright. On six of seven routes the app reported a dropped connection as a fact about
 * the catalog:
 *
 *   /games/1962700           "Game not found: Failed to fetch"
 *   /niches/tag/Action RTS   "Niche not found: Failed to fetch"
 *   /compare?ids=730,570     "App 730 · Not in catalog"   (Counter-Strike 2)
 *   /timing                  "TypeError: Failed to fetch" on four cards, and three more
 *                            cards — Release day × month, Launch shape by genre, Price
 *                            distribution — rendering an empty framed box with NO message.
 *
 * The silent boxes are the worse half: an empty chart reads as "no data for this genre",
 * which is also a claim about the catalog. And no route offered a retry.
 *
 * These are rendered assertions, not helper assertions, for the reason notFoundStates.tsx
 * gives: the helpers can be right while a page still says the wrong thing.
 */

function offlineFetch() {
  // Exactly how fetch rejects when the request never lands: a TypeError, no status, no body.
  return vi.fn(async () => {
    throw new TypeError("Failed to fetch");
  });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/** The REAL app defaults, so a hook that declares its own retry (useTimingOverview does)
 * still runs the shipped policy. Only gcTime and retryDelay move, neither of which changes
 * what is rendered — retryDelay: 0 just stops a legitimate retry from spending react-query's
 * ~1s backoff inside a 1s findBy timeout. */
/** The <Card> a heading belongs to — lets an assertion be scoped to ONE panel instead of
 * counting matches across the whole page (see the launch-curve case below). */
function card(heading: HTMLElement): HTMLElement {
  const el = heading.closest(".rounded-card");
  if (!(el instanceof HTMLElement)) throw new Error("heading is not inside a Card");
  return el;
}

function client() {
  return new QueryClient({
    defaultOptions: { queries: { ...DEFAULT_QUERY_OPTIONS, gcTime: 0, retryDelay: 0 } },
  });
}

function renderAt(path: string, routes: React.ReactNode) {
  return render(
    <QueryClientProvider client={client()}>
      <ThemeProvider>
        <MemoryRouter initialEntries={[path]}>
          <Routes>{routes}</Routes>
        </MemoryRouter>
      </ThemeProvider>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

// ---- the not-found pages must stop claiming "not found" ---------------------------------

describe("GameProfile with the API unreachable", () => {
  beforeEach(() => vi.stubGlobal("fetch", offlineFetch()));

  it("does not tell the user their game is missing", async () => {
    renderAt("/games/1962700", <Route path="/games/:appid" element={<GameProfile />} />);
    expect(await screen.findByText("Couldn't load this game")).toBeTruthy();
    // The shipped bug, in full: "Game not found: Failed to fetch".
    expect(screen.queryByText(/Game not found/)).toBeNull();
    expect(screen.queryByText(/not found/i)).toBeNull();
  });

  it("never prints the exception", async () => {
    renderAt("/games/1962700", <Route path="/games/:appid" element={<GameProfile />} />);
    await screen.findByText("Couldn't load this game");
    expect(document.body.textContent).not.toContain("TypeError");
    expect(document.body.textContent).not.toContain("Failed to fetch");
  });

  it("offers a retry AND a way out", async () => {
    renderAt("/games/1962700", <Route path="/games/:appid" element={<GameProfile />} />);
    expect(await screen.findByRole("button", { name: "Retry" })).toBeTruthy();
    expect(screen.getByText("Back to search").closest("a")?.getAttribute("href")).toBe("/games");
  });
});

describe("GameProfile with a real 404 — the not-found copy must survive", () => {
  beforeEach(() => vi.stubGlobal("fetch", vi.fn(async () => json({ detail: "game not found: 999999999" }, 404))));

  it("still says 'Game not found', with the appid", async () => {
    renderAt("/games/999999999", <Route path="/games/:appid" element={<GameProfile />} />);
    const line = await screen.findByText(/^Game not found/);
    expect(line.textContent).toBe("Game not found: 999999999");
    expect(screen.queryByText("Couldn't load this game")).toBeNull();
  });
});

describe("GameProfile with an unparseable appid", () => {
  beforeEach(() => vi.stubGlobal("fetch", offlineFetch()));

  it("offers the same way out its sibling dead ends do", async () => {
    // /games/notanumber was the ONE not-found state on the site with no link anywhere —
    // /games/999999999, /games/0, /games/-5 and /niches/tag/<bogus> all had one.
    renderAt("/games/notanumber", <Route path="/games/:appid" element={<GameProfile />} />);
    expect(await screen.findByText("Invalid game ID in the URL.")).toBeTruthy();
    expect(screen.getByText("Back to search").closest("a")?.getAttribute("href")).toBe("/games");
  });
});

describe("NicheDetail with the API unreachable", () => {
  beforeEach(() => vi.stubGlobal("fetch", offlineFetch()));

  it("does not tell the user their niche is missing", async () => {
    renderAt("/niches/tag/Action%20RTS", <Route path={NICHE_ROUTE_PATH} element={<NicheDetail />} />);
    expect(await screen.findByText("Couldn't load this niche")).toBeTruthy();
    expect(screen.queryByText(/Niche not found/)).toBeNull();
    expect(document.body.textContent).not.toContain("Failed to fetch");
    expect(await screen.findByRole("button", { name: "Retry" })).toBeTruthy();
  });
});

describe("NicheDetail with a real 404", () => {
  beforeEach(() => vi.stubGlobal("fetch", vi.fn(async () => json({ detail: "niche not found: tag/Nope" }, 404))));

  it("still says 'Niche not found'", async () => {
    renderAt("/niches/tag/Nope", <Route path={NICHE_ROUTE_PATH} element={<NicheDetail />} />);
    const line = await screen.findByText(/^Niche not found/);
    expect(line.textContent).toBe("Niche not found: tag/Nope");
  });
});

// ---- /compare must not call a live game "not in catalog" ---------------------------------

describe("Compare with the API unreachable", () => {
  beforeEach(() => vi.stubGlobal("fetch", offlineFetch()));

  it("does not claim the games are absent from the catalog", async () => {
    renderAt("/compare?ids=730,570", <Route path="/compare" element={<Compare />} />);
    // Two columns, both unloadable — and neither is a statement about Steam's catalog.
    expect((await screen.findAllByText("Couldn't load")).length).toBe(2);
    expect(screen.queryByText("Not in catalog")).toBeNull();
  });

  it("explains the empty grid once and offers a retry", async () => {
    renderAt("/compare?ids=730,570", <Route path="/compare" element={<Compare />} />);
    expect(await screen.findByText(/Couldn't load any of these games/)).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Retry" }).length).toBeGreaterThan(0);
  });
});

describe("Compare with a real 404 on one column", () => {
  beforeEach(() =>
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (/\/games\/730(\?|$)/.test(url)) return json({ detail: "game not found: 730" }, 404);
        if (/\/games\/570(\?|$)/.test(url)) {
          return json({ appid: 570, name: "Dota 2", top_tags: [], price_initial: 0 });
        }
        return json({ appid: 570, eligible: false, points: [], comps: null });
      }),
    ),
  );

  it("keeps 'Not in catalog' for the column the API actually looked up", async () => {
    renderAt("/compare?ids=730,570", <Route path="/compare" element={<Compare />} />);
    expect(await screen.findByText("Not in catalog")).toBeTruthy();
    expect(screen.queryByText("Couldn't load")).toBeNull();
    // A 404 on one column is not an "unreachable API" banner.
    expect(screen.queryByText(/Couldn't load any of these games/)).toBeNull();
  });
});

// ---- /timing: four loud cards and three silent ones ---------------------------------------

describe("LaunchTiming with the API unreachable", () => {
  beforeEach(() => vi.stubGlobal("fetch", offlineFetch()));

  it("never prints TypeError, on any card", async () => {
    renderAt("/timing", <Route path="/timing" element={<LaunchTiming />} />);
    await screen.findAllByText("Couldn't load timing data");
    expect(document.body.textContent).not.toContain("TypeError");
    expect(document.body.textContent).not.toContain("Failed to fetch");
  });

  it("gives the three previously-SILENT cards a message of their own", async () => {
    renderAt("/timing", <Route path="/timing" element={<LaunchTiming />} />);
    // Each of these rendered an empty framed box — heading, subtitle, nothing else.
    expect(await screen.findByText("Couldn't load release-date data")).toBeTruthy();
    expect(await screen.findByText("Couldn't load the price distribution")).toBeTruthy();

    // The third is the launch-curve small multiples, which report per genre inside their own
    // tiles — so the assertion is SCOPED to that card. A page-wide count passes on the six
    // other failures alone, which is exactly how a silent chart survives a test suite.
    const shapeCard = card(await screen.findByText(/^Launch shape by genre/));
    expect(within(shapeCard).getAllByText(/Couldn't reach the API/).length).toBeGreaterThan(0);
  });

  it("offers a retry on every failed card, including the small multiples", async () => {
    renderAt("/timing", <Route path="/timing" element={<LaunchTiming />} />);
    await screen.findByText("Couldn't load the price distribution");
    // 4 overview cards + seasonality + price.
    expect(screen.getAllByRole("button", { name: "Retry" }).length).toBeGreaterThanOrEqual(6);
    // …and one inside each launch-curve tile, counted where it lives.
    const shapeCard = card(screen.getByText(/^Launch shape by genre/));
    expect(within(shapeCard).getAllByRole("button", { name: "Retry" }).length).toBeGreaterThan(0);
  });
});

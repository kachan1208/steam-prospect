import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation, useParams } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import NicheFinder from "./NicheFinder";
import { parseCombineMode, parseNicheSelection } from "../lib/nicheSelection";
import { ThemeProvider } from "../lib/theme";

/**
 * Two behaviours are pinned here, both of which are silently breakable:
 *
 * 1. A niche row is a LINK to /niches/:dimension/:key. Keys carry spaces and (defensively)
 *    slashes, so the test clicks the real <Link> and reads what useParams hands the page
 *    back — a percent-encoding bug shows up as a wrong param, not as a compile error.
 * 2. The multi-select lives in the URL. Ticking rows must produce a link that parses back
 *    into exactly the niches that were ticked, and "Analyse combined" must refuse to fire
 *    below two.
 */

// Mirrors NICHE_ROUTE_PATH in NicheDetail.tsx (that page owns the route; this test only
// needs to match against it).
const NICHE_ROUTE = "/niches/:dimension/:key";

const KEYS = ["Massively Multiplayer", "Rogue/Like", "Point & Click"];

function nicheRow(key: string) {
  return {
    dimension: "tag",
    key,
    window: "24m",
    min_reviews: 50,
    n_games: 120,
    n_recent: 30,
    median_rev: 12000,
    p25_rev: 1000,
    p75_rev: 60000,
    p90_rev: 250000,
    median_reviews: 40,
    median_price: 9.99,
    median_positive_ratio: 0.85,
    median_owners: 5000,
    total_owners: 900000,
    total_rev: 4000000,
    total_reviews: 90000,
    market_size: 1,
    recent_velocity: 1,
    self_pub_share: 0.5,
    winner_concentration: 0.7,
    hit_rate_200k: 0.1,
    hit_rate_500k: 0.05,
    beatable_share: 0.4,
    saturation_yoy: 0.02,
    demand: 55,
    competition: 40,
    quality_gap: 30,
    opportunity: 40,
    opportunity_v2: 42.5,
    decline_gate: 1,
    entrant_ratio: 1.1,
    solo_viability: 0.9,
    tier: "micro",
  };
}

let lastLocation = { pathname: "", search: "" };

function LocationSpy() {
  const loc = useLocation();
  lastLocation = { pathname: loc.pathname, search: loc.search };
  return null;
}

function ParamEcho() {
  const params = useParams();
  return <div data-testid="params">{JSON.stringify(params)}</div>;
}

function renderFinder() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={client}>
      <ThemeProvider>
        <MemoryRouter initialEntries={["/niches"]}>
          <Routes>
            <Route path="/niches" element={<NicheFinder />} />
            <Route path="/niches/combined" element={<div>combined</div>} />
            <Route path={NICHE_ROUTE} element={<ParamEcho />} />
          </Routes>
          <LocationSpy />
        </MemoryRouter>
      </ThemeProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  lastLocation = { pathname: "", search: "" };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const body = url.startsWith("/api/niches?")
        ? { items: KEYS.map(nicheRow), total: KEYS.length, limit: 50, offset: 0 }
        : {};
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("NicheFinder niche links", () => {
  it("links each row to the deep-dive page, and the key survives the round trip", async () => {
    renderFinder();
    // "Rogue/Like" is the hostile case: a naive link would split it into two path segments.
    const link = await screen.findByTitle("Open the Rogue/Like deep dive");
    expect(link.getAttribute("href")).toBe("/niches/tag/Rogue%2FLike");

    fireEvent.click(link);

    const params = JSON.parse((await screen.findByTestId("params")).textContent ?? "{}");
    expect(params).toEqual({ dimension: "tag", key: "Rogue/Like" });
  });

  it("round-trips a key with spaces and an ampersand too", async () => {
    renderFinder();
    fireEvent.click(await screen.findByTitle("Open the Point & Click deep dive"));

    const params = JSON.parse((await screen.findByTestId("params")).textContent ?? "{}");
    expect(params.key).toBe("Point & Click");
  });
});

describe("NicheFinder multi-select", () => {
  it("puts the selection in the URL and round-trips it back", async () => {
    renderFinder();
    await screen.findByLabelText("Add Rogue/Like to the combined analysis");

    // Nothing selected -> no selection affordance at all.
    expect(screen.queryByTestId("niche-combine-bar")).toBeNull();

    fireEvent.click(screen.getByLabelText("Add Massively Multiplayer to the combined analysis"));
    fireEvent.click(screen.getByLabelText("Add Rogue/Like to the combined analysis"));

    await waitFor(() =>
      expect(parseNicheSelection(new URLSearchParams(lastLocation.search))).toEqual([
        { dimension: "tag", key: "Massively Multiplayer" },
        { dimension: "tag", key: "Rogue/Like" },
      ]),
    );
    // The checkbox reflects the URL, not a second private copy of the state.
    expect(screen.getByLabelText("Remove Rogue/Like from the combined analysis")).toBeTruthy();
  });

  it("needs two niches before it will combine", async () => {
    renderFinder();
    await screen.findByLabelText("Add Rogue/Like to the combined analysis");

    fireEvent.click(screen.getByLabelText("Add Rogue/Like to the combined analysis"));

    const bar = await screen.findByTestId("niche-combine-bar");
    const button = screen.getByText("Analyse combined (1)") as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(bar.textContent).toContain("a combination needs at least two");

    fireEvent.click(screen.getByLabelText("Add Point & Click to the combined analysis"));
    const ready = (await screen.findByText("Analyse combined (2)")) as HTMLButtonElement;
    expect(ready.disabled).toBe(false);
  });

  it("navigates to the combined page with the whole selection and the current cut", async () => {
    renderFinder();
    await screen.findByLabelText("Add Rogue/Like to the combined analysis");

    fireEvent.click(screen.getByLabelText("Add Rogue/Like to the combined analysis"));
    fireEvent.click(screen.getByLabelText("Add Point & Click to the combined analysis"));
    fireEvent.click(await screen.findByText("Analyse combined (2)"));

    await waitFor(() => expect(lastLocation.pathname).toBe("/niches/combined"));
    const sp = new URLSearchParams(lastLocation.search);
    expect(parseNicheSelection(sp)).toEqual([
      { dimension: "tag", key: "Rogue/Like" },
      { dimension: "tag", key: "Point & Click" },
    ]);
    expect(parseCombineMode(sp.get("mode"))).toBe("intersect");
    // The cut the user was looking at travels with them — combined stats for a different
    // window would silently answer a different question.
    expect(sp.get("win")).toBe("24m");
    expect(sp.get("min_reviews")).toBe("50");
  });

  it("drops one niche and clears them all", async () => {
    renderFinder();
    await screen.findByLabelText("Add Rogue/Like to the combined analysis");

    fireEvent.click(screen.getByLabelText("Add Rogue/Like to the combined analysis"));
    fireEvent.click(screen.getByLabelText("Add Point & Click to the combined analysis"));
    await screen.findByText("Analyse combined (2)");

    fireEvent.click(screen.getByLabelText("Remove Rogue/Like from the combination"));
    await waitFor(() =>
      expect(parseNicheSelection(new URLSearchParams(lastLocation.search))).toEqual([
        { dimension: "tag", key: "Point & Click" },
      ]),
    );

    fireEvent.click(screen.getByText("Clear"));
    await waitFor(() => expect(screen.queryByTestId("niche-combine-bar")).toBeNull());
    expect(new URLSearchParams(lastLocation.search).getAll("niches")).toEqual([]);
  });
});

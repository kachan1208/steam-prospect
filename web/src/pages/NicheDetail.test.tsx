import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useParams, useSearchParams } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import NicheDetail, {
  GAMES_PAGE_SIZE,
  NICHE_ROUTE_PATH,
  nicheDetailPath,
  readGamesParams,
  readSelection,
  writeSelection,
  type DistMetric,
} from "./NicheDetail";
import { ThemeProvider } from "../lib/theme";

afterEach(cleanup);

/** Renders whatever the real route pattern resolves for `path` and reports the decoded
 * params + query string — i.e. it exercises the SAME matching the app does, not a
 * re-implementation of it. */
function Probe() {
  const { dimension, key } = useParams<{ dimension: string; key: string }>();
  const [sp] = useSearchParams();
  return (
    <div>
      <span data-testid="dimension">{dimension}</span>
      <span data-testid="key">{key}</span>
      <span data-testid="search">{sp.toString()}</span>
    </div>
  );
}

function visit(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path={NICHE_ROUTE_PATH} element={<Probe />} />
        <Route path="*" element={<span data-testid="key">NO MATCH</span>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("niche detail URL round-trip", () => {
  // Niche keys are raw Steam tag/genre strings. Two of them break naive routing: keys with
  // SPACES ("Action Roguelike") and keys with SLASHES (Steam's own "Massively Multiplayer"
  // family, and genre keys generally) — a slash would otherwise split into a third path
  // segment and never match /niches/:dimension/:key at all. The link builder must encode
  // and React Router must hand back the original string, byte for byte.
  const KEYS = [
    "Action Roguelike",
    "Massively Multiplayer/RPG",
    "Free to Play",
    "RPG/Adventure/Indie",
    "Rogue-like",
  ];

  for (const key of KEYS) {
    it(`round-trips ${JSON.stringify(key)} through the route`, () => {
      const path = nicheDetailPath("tag", key);
      // The key never leaks a raw space or slash into the path.
      expect(path.startsWith("/niches/tag/")).toBe(true);
      expect(path.slice("/niches/tag/".length)).not.toContain(" ");
      expect(path.slice("/niches/tag/".length)).not.toContain("/");

      const { getByTestId } = visit(path);
      expect(getByTestId("dimension").textContent).toBe("tag");
      expect(getByTestId("key").textContent).toBe(key);
    });
  }

  it("encodes a slash as %2F and a space as %20 in the built path", () => {
    expect(nicheDetailPath("genre", "Massively Multiplayer/RPG")).toBe("/niches/genre/Massively%20Multiplayer%2FRPG");
    expect(nicheDetailPath("tag", "Action Roguelike")).toBe("/niches/tag/Action%20Roguelike");
  });

  it("carries a query string through to the page", () => {
    const path = nicheDetailPath("tag", "Action Roguelike", {
      tab: "games",
      rev_min: 1000,
      rev_max: 10000,
      win: undefined,
    });
    const { getByTestId } = visit(path);
    expect(getByTestId("key").textContent).toBe("Action Roguelike");
    const search = new URLSearchParams(getByTestId("search").textContent ?? "");
    expect(search.get("tab")).toBe("games");
    expect(search.get("rev_min")).toBe("1000");
    expect(search.get("rev_max")).toBe("10000");
    // Undefined values are dropped rather than serialized as "undefined".
    expect(search.has("win")).toBe(false);
  });
});

describe("bucket selection <-> query params", () => {
  const cut = { win: "24m", min_reviews: 50 } as const;

  it("writes a revenue selection into the query string and feeds it to the games request", () => {
    const next = writeSelection(new URLSearchParams("tab=games"), "revenue", { min: 1000, max: 10000 });
    expect(next.get("rev_min")).toBe("1000");
    expect(next.get("rev_max")).toBe("10000");
    expect(next.get("tab")).toBe("games"); // unrelated params survive

    const params = readGamesParams(next, cut);
    expect(params.rev_min).toBe(1000);
    expect(params.rev_max).toBe(10000);
    expect(params.price_min).toBeUndefined();
    expect(params.price_max).toBeUndefined();
  });

  it("writes a price selection to price_min/price_max, independently of the revenue one", () => {
    let sp = writeSelection(new URLSearchParams(), "revenue", { min: 5, max: 50 });
    sp = writeSelection(sp, "price", { min: 9.99, max: 19.99 });

    const params = readGamesParams(sp, cut);
    expect(params.rev_min).toBe(5);
    expect(params.rev_max).toBe(50);
    expect(params.price_min).toBe(9.99);
    expect(params.price_max).toBe(19.99);
  });

  it("clears only its own axis when a selection is dropped", () => {
    let sp = writeSelection(new URLSearchParams(), "revenue", { min: 1000, max: 10000 });
    sp = writeSelection(sp, "price", { min: 0, max: 5 });
    sp = writeSelection(sp, "revenue", null);

    expect(sp.has("rev_min")).toBe(false);
    expect(sp.has("rev_max")).toBe(false);
    expect(readSelection(sp, "price")).toEqual({ min: 0, max: 5 });
    expect(readSelection(sp, "revenue")).toBeNull();
  });

  it("re-pages to the top whenever the selection changes", () => {
    const sp = writeSelection(new URLSearchParams("offset=75&tab=games"), "revenue", { min: 1, max: 2 });
    // An offset from the unfiltered result set would point past the filtered one.
    expect(sp.has("offset")).toBe(false);
    expect(readGamesParams(sp, cut).offset).toBe(0);
  });

  it("treats a half-written or inverted selection as no filter at all", () => {
    for (const query of ["rev_min=1000", "rev_max=10000", "rev_min=10000&rev_max=1000", "rev_min=abc&rev_max=5"]) {
      const sp = new URLSearchParams(query);
      expect(readSelection(sp, "revenue")).toBeNull();
      expect(readGamesParams(sp, cut).rev_min).toBeUndefined();
      expect(readGamesParams(sp, cut).rev_max).toBeUndefined();
    }
  });

  it("survives a full URL round-trip: selection -> shareable link -> parsed back", () => {
    const sp = writeSelection(new URLSearchParams("tab=games"), "revenue", { min: 1000, max: 10000 });
    const link = nicheDetailPath("tag", "Action Roguelike", Object.fromEntries(sp));

    const { getByTestId } = visit(link);
    expect(getByTestId("key").textContent).toBe("Action Roguelike");

    const parsed = new URLSearchParams(getByTestId("search").textContent ?? "");
    expect(readSelection(parsed, "revenue")).toEqual({ min: 1000, max: 10000 });
    expect(readGamesParams(parsed, cut)).toMatchObject({
      win: "24m",
      min_reviews: 50,
      rev_min: 1000,
      rev_max: 10000,
      limit: GAMES_PAGE_SIZE,
      offset: 0,
    });
  });
});

describe("games request defaults", () => {
  const cut = { win: "all", min_reviews: 100 } as const;

  it("defaults to revenue desc on the cut from the page, not from the URL", () => {
    expect(readGamesParams(new URLSearchParams(), cut)).toEqual({
      win: "all",
      min_reviews: 100,
      sort: "revenue",
      order: "desc",
      limit: GAMES_PAGE_SIZE,
      offset: 0,
      rev_min: undefined,
      rev_max: undefined,
      price_min: undefined,
      price_max: undefined,
    });
  });

  it("honours a whitelisted sort key and rejects anything else", () => {
    expect(readGamesParams(new URLSearchParams("sort=reviews&order=asc"), cut).sort).toBe("reviews");
    expect(readGamesParams(new URLSearchParams("sort=reviews&order=asc"), cut).order).toBe("asc");
    // These are the API's REQUEST-side names; the row field names are not sort keys, and
    // "owners_est" isn't sortable at all. Anything off the whitelist would 422 — fall back.
    for (const bad of ["DROP TABLE", "est_revenue", "total_reviews", "owners_est", "price_initial"]) {
      expect(readGamesParams(new URLSearchParams(`sort=${bad}`), cut).sort).toBe("revenue");
    }
  });

  it("never sends a negative, fractional or out-of-range offset", () => {
    expect(readGamesParams(new URLSearchParams("offset=-40"), cut).offset).toBe(0);
    expect(readGamesParams(new URLSearchParams("offset=12.7"), cut).offset).toBe(12);
    // The API caps offset at 50_000 (ge=0, le=50000).
    expect(readGamesParams(new URLSearchParams("offset=999999"), cut).offset).toBe(50_000);
  });
});

describe("selection labels", () => {
  it("labels both metrics with the right currency formatting", async () => {
    const { selectionLabel } = await import("./NicheDetail");
    const metrics: DistMetric[] = ["revenue", "price"];
    expect(metrics).toHaveLength(2);
    expect(selectionLabel("revenue", { min: 1000, max: 10000 })).toBe("Revenue $1.0K – $10.0K");
    expect(selectionLabel("price", { min: 0, max: 9.99 })).toBe("Price Free – $9.99");
  });
});

/**
 * The Saturation YoY tile sits in the same 4-cell KPI strip as "P90 revenue · N scored games",
 * directly under the window/review-floor controls. Clicking those controls moves the scored-games
 * count (Souls-like, live API: 624 -> 223 -> 177 -> 739 across the six materialized cuts) while
 * the saturation figures never move — saturation_yoy is computed once per dimension+key over the
 * whole niche with NO review floor (mart_niche.sql's `sat` CTE), and that is deliberate. What is
 * not acceptable is leaving a reader to infer it: two numbers side by side in one row read as one
 * population. So the tile has to disown the controls in its own footnote.
 *
 * (This tile already carries scar tissue from the related bug where the percentage and the count
 * came from different populations — n_recent, a 24m AND review-floored count, printed under a
 * two-full-calendar-year percentage. Both numbers asserted below come from the `sat` CTE, so the
 * fix for the tile's basis disclosure cannot reintroduce that shape.)
 */
describe("NicheDetail — the Saturation YoY tile disowns the cut controls", () => {
  // GET /api/niches/tag/Souls-like, verbatim: six materialized cuts, one saturation figure.
  const VARIANTS = [
    { window: "24m", min_reviews: 0, n_games: 624, opportunity_v2: 57.73 },
    { window: "24m", min_reviews: 50, n_games: 223, opportunity_v2: 77.25 },
    { window: "24m", min_reviews: 100, n_games: 177, opportunity_v2: 80.52 },
    { window: "all", min_reviews: 0, n_games: 1841, opportunity_v2: 57.87 },
    { window: "all", min_reviews: 50, n_games: 739, opportunity_v2: 70.81 },
    { window: "all", min_reviews: 100, n_games: 584, opportunity_v2: 72.37 },
  ].map((v) => ({
    dimension: "tag",
    key: "Souls-like",
    median_rev: 100_000,
    p90_rev: 5_000_000,
    median_price: 14.99,
    supply_brake: 1,
    // Identical on every cut — one value per dimension+key, no review floor.
    saturation_yoy: 0.01764705882352941,
    n_recent_year: 346,
    n_prior_year: 340,
    ...v,
  }));

  const DETAIL = {
    dimension: "tag",
    key: "Souls-like",
    tier: "micro",
    variants: VARIANTS,
    saturation_trend: [],
    revenue_histogram: [],
    representative_games: [],
    players: null,
    themes: [],
    press: null,
    hit_rates: { hit_rate_200k: null, hit_rate_500k: null, median_rev: null, n_games: null, winner_concentration: null },
  };

  function renderNiche() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    return render(
      <QueryClientProvider client={client}>
        <ThemeProvider>
          <MemoryRouter initialEntries={["/niches/tag/Souls-like"]}>
            <Routes>
              <Route path={NICHE_ROUTE_PATH} element={<NicheDetail />} />
            </Routes>
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
        const body = url.includes("/niches/tag/")
          ? DETAIL
          : url.includes("/market/benchmarks")
            ? { cited: { pct_new_releases_over_100k: 0.085, revenue_benchmark_marks: [], dev_tiers: [] } }
            : {};
        return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
      }),
    );
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("states in the tile that the figure covers the whole niche and ignores the controls", async () => {
    renderNiche();
    expect(
      await screen.findByText(
        /Whole niche, every review count — this tile alone ignores the window and review-floor controls above/,
      ),
    ).toBeTruthy();
  });

  it("keeps the percentage and its counts on one population — the sat CTE's, not the cut's", async () => {
    renderNiche();
    // 346 vs 340 IS +1.76% -> "+2%". The counts printed must be the ones the % divides.
    expect(await screen.findByText(/346 released last full year vs 340 the year before/)).toBeTruthy();
    expect(await screen.findByText("▲ +2%")).toBeTruthy();
    // The cut-dependent count lives in the neighbouring tile and must not leak into this one.
    expect(screen.queryByText(/223 released/)).toBeNull();
  });

  it("holds the disclosure while the neighbouring scored-games count moves with the cut", async () => {
    renderNiche();
    expect(await screen.findByText(/223 scored games/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Last 24m · ≥0 reviews" }));
    expect(await screen.findByText(/624 scored games/)).toBeTruthy();
    // Same tile, same three numbers, disclosure still on screen.
    expect(screen.getByText(/346 released last full year vs 340 the year before/)).toBeTruthy();
    expect(screen.getByText("▲ +2%")).toBeTruthy();
    expect(screen.getByText(/this tile alone ignores the window and review-floor controls above/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "All-time · ≥50 reviews" }));
    expect(await screen.findByText(/739 scored games/)).toBeTruthy();
    expect(screen.getByText(/346 released last full year vs 340 the year before/)).toBeTruthy();
    expect(screen.getByText("▲ +2%")).toBeTruthy();
  });
});

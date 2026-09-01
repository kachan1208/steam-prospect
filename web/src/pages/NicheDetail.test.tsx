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
      // "this tile ALONE ignores…" until 2026-09-01 — the Players / 7d cell in the same
      // strip turned out to be cut-independent too (798 measured games against the row's
      // 223), so it now carries the same sentence and "alone" had to go. The leading clause
      // is what keeps each tile's disclosure identifiable.
      await screen.findByText(
        /Whole niche, every review count — this tile ignores the window and review-floor controls above/,
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
    expect(
      screen.getByText(/Whole niche, every review count — this tile ignores the window and review-floor controls above/),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "All-time · ≥50 reviews" }));
    expect(await screen.findByText(/739 scored games/)).toBeTruthy();
    expect(screen.getByText(/346 released last full year vs 340 the year before/)).toBeTruthy();
    expect(screen.getByText("▲ +2%")).toBeTruthy();
  });
});

/**
 * The overview's "Top games in the niche" panel, and the KPI strip's live-player cell.
 *
 * Both were reported by the 2026-09-01 data-consistency audit of /niches/tag/Souls-like, and
 * both had the same shape of defect: a panel summarising a population that is not the one its
 * own header names ("window 24m · ≥50 reviews", "223 scored games").
 *
 *   Top games   rendered detail.representative_games = mart_niche_top, ONE cut-independent
 *               list per (dimension, key). Live API at 24m/≥50 it showed Black Myth $2.2B and
 *               ELDEN RING $2.1B; appids 2358720 and 1245620 are not among those 223 at all
 *               (200 of the 223 fetched by revenue desc — as members they would rank #1/#2).
 *               The cut's real top game is Clair Obscur at $414.3M: panel top-1 was 5.24x the
 *               truth, its top-5 sum 4.82x, and the same rows were served under all six cuts
 *               while only the "All N →" label moved. The mart_niche_top list IS the
 *               (all, 50) ranking — right in exactly one of the six selectable cuts.
 *   Players now the column joined players.distribution.top_games, which is the top 8 BY
 *               PLAYERS. Rank 9+ fell through to "—", so DARK SOULS III read "—" here and
 *               "Players now 3,849" on /games/374320.
 *   Players/7d  207.0K over n_games_panel = 798, which is none of the six cuts
 *               (624/223/177/1841/739/584) — and cannot be made into one, because the marts
 *               behind it carry no window/review-floor key. Disclosed, like Saturation YoY.
 *
 * The fixtures below are the live API's own rows, so every expectation is checkable against
 * production. The games-tab table was ALREADY correct and is deliberately untouched — these
 * tests exist to pin that the overview now shares its data path.
 */
describe("NicheDetail — the overview Top games panel is the SELECTED CUT's top games", () => {
  const VARIANTS = [
    { window: "24m", min_reviews: 0, n_games: 624 },
    { window: "24m", min_reviews: 50, n_games: 223 },
    { window: "24m", min_reviews: 100, n_games: 177 },
    { window: "all", min_reviews: 0, n_games: 1841 },
    { window: "all", min_reviews: 50, n_games: 739 },
    { window: "all", min_reviews: 100, n_games: 584 },
  ].map((v) => ({
    dimension: "tag",
    key: "Souls-like",
    median_rev: 152898,
    p90_rev: 9431453.58,
    median_price: 14.99,
    supply_brake: 1,
    opportunity_v2: 77.25,
    saturation_yoy: 0.01764705882352941,
    n_recent_year: 346,
    n_prior_year: 340,
    // Cut-independent in the mart — the same pair is stamped on every one of the six rows.
    total_players_now: 207006,
    players_trend_7d_pct: -5.26,
    ...v,
  }));

  // GET /api/niches/tag/Souls-like -> representative_games[0..4], verbatim. This is
  // mart_niche_top: the (all, 50) ranking, served under every cut.
  const REPRESENTATIVE = [
    [1, 2358720, "Black Myth: Wukong", 2024, 59.99, 2172027335.1, 1206883, 0.9651167511680917],
    [2, 1245620, "ELDEN RING", 2022, 59.99, 2067907491.3, 1149029, 0.9307876476572828],
    [3, 374320, "DARK SOULS III", 2016, 59.99, 790876365.3, 439449, 0.9434450869156603],
    [4, 814380, "Sekiro: Shadows Die Twice - GOTY Edition", 2019, 59.99, 638787317.7, 354941, 0.9525075998546237],
    [5, 1903340, "Clair Obscur: Expedition 33", 2025, 49.99, 414290625.3, 276249, 0.9528070689848651],
  ].map(([rank_in_niche, appid, name, release_year, price_initial, est_rev_reviews, total_reviews, positive_ratio]) => ({
    rank_in_niche,
    appid,
    name,
    release_year,
    price_initial,
    est_rev_reviews,
    total_reviews,
    positive_ratio,
    owners_mid: null,
    self_published: 0,
    header_image: null,
  }));

  // GET /api/niches/tag/Souls-like/games?win=…&min_reviews=…&sort=revenue&order=desc&limit=5,
  // verbatim, plus the live_players column this fix added (each value cross-checked against
  // /api/games/{appid} on the same day).
  const CUT_GAMES: Record<string, { total: number; items: unknown[] }> = {
    "24m:50": {
      total: 223,
      items: [
        [1903340, "Clair Obscur: Expedition 33", 2025, 49.99, 414290625.3, 276249, 0.9528070689848651, 6453],
        [1030300, "Hollow Knight: Silksong", 2025, 19.99, 251133970.2, 418766, 0.8941031506855858, 4820],
        [2622380, "ELDEN RING NIGHTREIGN", 2025, 39.99, 227657471.4, 189762, 0.8172078709119844, 9836],
        [2694490, "Path of Exile 2", 2024, 29.99, 202068121.5, 224595, 0.7471537656670897, 19230],
        [3489700, "Stellar Blade", 2025, 59.99, 167906610.9, 93297, 0.9, 1204],
      ],
    },
    "all:50": {
      total: 739,
      items: [
        [2358720, "Black Myth: Wukong", 2024, 59.99, 2172027335.1, 1206883, 0.9651167511680917, 8392],
        [1245620, "ELDEN RING", 2022, 59.99, 2067907491.3, 1149029, 0.9307876476572828, 32145],
        [374320, "DARK SOULS III", 2016, 59.99, 790876365.3, 439449, 0.9434450869156603, 3849],
        [814380, "Sekiro: Shadows Die Twice - GOTY Edition", 2019, 59.99, 638787317.7, 354941, 0.9525075998546237, 2716],
        [1903340, "Clair Obscur: Expedition 33", 2025, 49.99, 414290625.3, 276249, 0.9528070689848651, 6453],
      ],
    },
  };

  function gamesPage(cut: string) {
    const page = CUT_GAMES[cut] ?? { total: 0, items: [] };
    return {
      total: page.total,
      limit: 5,
      offset: 0,
      items: (page.items as [number, string, number, number, number, number, number, number][]).map(
        ([appid, name, release_year, price_initial, est_revenue, total_reviews, positive_ratio, live_players]) => ({
          appid,
          name,
          release_year,
          price_initial,
          est_revenue,
          total_reviews,
          positive_ratio,
          live_players,
          owners_est: null,
          header_image: null,
        }),
      ),
    };
  }

  const DETAIL = {
    dimension: "tag",
    key: "Souls-like",
    tier: "micro",
    variants: VARIANTS,
    saturation_trend: [],
    revenue_histogram: [],
    representative_games: REPRESENTATIVE,
    // The live payload, trimmed to the fields this page reads. n_games_panel 798 matches no
    // cut; the top_games list is the top 8 BY PLAYERS that used to be joined per row.
    players: {
      total_players_now: 207006,
      players_trend_7d_pct: -5.26,
      players_coverage: 1,
      n_games_panel: 798,
      series: [],
      monthly: [],
      distribution: {
        median_players_now: 1,
        players_top5_share: 0.4283,
        n_games_now: 798,
        histogram: [],
        top_games: [
          { rank: 1, appid: 1245620, name: "ELDEN RING", players: 32145, share: 0.1553 },
          { rank: 2, appid: 2694490, name: "Path of Exile 2", players: 19230, share: 0.0929 },
          { rank: 3, appid: 2584270, name: "Mortal Shell II", players: 17006, share: 0.0822 },
          { rank: 4, appid: 3564740, name: "Where Winds Meet", players: 10446, share: 0.0505 },
          { rank: 5, appid: 2622380, name: "ELDEN RING NIGHTREIGN", players: 9836, share: 0.0475 },
          { rank: 6, appid: 3282300, name: "Mistfall Hunter", players: 9222, share: 0.0445 },
          { rank: 7, appid: 3513350, name: "Wuthering Waves", players: 9212, share: 0.0445 },
          { rank: 8, appid: 2358720, name: "Black Myth: Wukong", players: 8392, share: 0.0405 },
        ],
      },
    },
    themes: [],
    press: null,
    hit_rates: { hit_rate_200k: null, hit_rate_500k: null, median_rev: null, n_games: null, winner_concentration: null },
  };

  function json(body: unknown, status = 200) {
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  }

  /** `gamesStatus` simulates the hours-after-deploy state: mart_niche_game not rebuilt yet. */
  function stubApi(gamesStatus?: number) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input), "http://test.local");
        if (url.pathname.endsWith("/games")) {
          if (gamesStatus) return json({ detail: "mart_niche_game is missing — run task etl" }, gamesStatus);
          return json(gamesPage(`${url.searchParams.get("win")}:${url.searchParams.get("min_reviews")}`));
        }
        if (url.pathname.includes("/market/benchmarks")) {
          return json({ cited: { pct_new_releases_over_100k: 0.085, revenue_benchmark_marks: [], dev_tiers: [] } });
        }
        if (url.pathname.includes("/niches/tag/")) return json(DETAIL);
        return json({});
      }),
    );
  }

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

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("lists the 24m/≥50 cut's top games — not the two that aren't in the cut at all", async () => {
    stubApi();
    renderNiche();

    // The header this panel sits under says 223 scored games; these five are those 223's top.
    expect(await screen.findByText("Clair Obscur: Expedition 33")).toBeTruthy();
    for (const name of ["Hollow Knight: Silksong", "ELDEN RING NIGHTREIGN", "Path of Exile 2", "Stellar Blade"]) {
      expect(screen.getByText(name)).toBeTruthy();
    }
    // appid 2358720 / 1245620: outside the cut, and they used to head this panel.
    expect(screen.queryByText("Black Myth: Wukong")).toBeNull();
    expect(screen.queryByText("ELDEN RING")).toBeNull();
    // Top-1 revenue is the cut's $414.3M, not the 5.24x-larger $2.2B.
    expect(screen.getByText("$414.3M")).toBeTruthy();
    expect(screen.queryByText("$2.2B")).toBeNull();
    // The reviews column survived the data-source switch (positive_ratio now rides /games).
    expect(screen.getByText(/95\.3% · 276,249/)).toBeTruthy();
  });

  it("re-reads the panel when the cut changes, instead of relabelling the same five rows", async () => {
    stubApi();
    renderNiche();
    expect(await screen.findByText("Clair Obscur: Expedition 33")).toBeTruthy();
    expect(screen.getByText("All 223 →")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "All-time · ≥50 reviews" }));
    // All-time IS the cut mart_niche_top happens to describe, so this is where the old panel
    // was right — the rows must arrive here, and only here.
    expect(await screen.findByText("Black Myth: Wukong")).toBeTruthy();
    expect(screen.getByText("ELDEN RING")).toBeTruthy();
    expect(screen.getByText("$2.2B")).toBeTruthy();
    expect(screen.getByText("All 739 →")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Last 24m · ≥50 reviews" }));
    expect(await screen.findByText("Hollow Knight: Silksong")).toBeTruthy();
    expect(screen.queryByText("Black Myth: Wukong")).toBeNull();
    expect(screen.queryByText("ELDEN RING")).toBeNull();
  });

  it("prints players now per row, including games outside the top-8-by-players list", async () => {
    stubApi();
    renderNiche();

    // Clair Obscur is not in players.distribution.top_games, so the old join printed "—"
    // while /api/games/1903340 answered 6,453 for the same moment.
    expect(await screen.findByText("6,453")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "All-time · ≥50 reviews" }));
    // Same for DARK SOULS III (3,849 on /games/374320) and Sekiro (2,716 on /games/814380).
    expect(await screen.findByText("3,849")).toBeTruthy();
    expect(screen.getByText("2,716")).toBeTruthy();
    // ELDEN RING IS in that top-8; its number must be the same either way.
    expect(screen.getByText("32.1K")).toBeTruthy();
  });

  it("says the live-player tile covers the whole measured niche, at every cut", async () => {
    stubApi();
    renderNiche();

    const disclosure = /Every measured game in the niche \(798\) — this tile ignores the window and review-floor controls above/;
    expect(await screen.findByText(disclosure)).toBeTruthy();
    expect(screen.getByText(/207\.0K playing now/)).toBeTruthy();
    expect(screen.getByText(/223 scored games/)).toBeTruthy();

    // The neighbouring count moves 223 -> 739; the players figure is the same 207.0K over the
    // same 798 games, and still says so.
    fireEvent.click(screen.getByRole("button", { name: "All-time · ≥50 reviews" }));
    expect(await screen.findByText(/739 scored games/)).toBeTruthy();
    expect(screen.getByText(/207\.0K playing now/)).toBeTruthy();
    expect(screen.getByText(disclosure)).toBeTruthy();
  });

  it("labels the fallback list when the game mart hasn't been rebuilt yet", async () => {
    stubApi(503);
    renderNiche();

    // mart_niche_top is still the best list available — but it is all-time, and the panel is
    // under a header that says 24m/≥50, so the substitution has to be visible.
    expect(await screen.findByText(/these are the niche’s biggest games all-time at every review count/)).toBeTruthy();
    expect(screen.getByText("Black Myth: Wukong")).toBeTruthy();
    // And it must NOT fall back to the players top-8 for the players column: that ranking is
    // exactly what made the same fact read two ways.
    expect(screen.queryByText("32.1K")).toBeNull();
  });
});

/**
 * The Games & distribution table has to multiply out ACROSS a row.
 *
 * It used to print three numbers side by side that came from two different estimators: the
 * price and the revenue are the reviews-based (Boxleiter) pair — mart_game.est_rev_reviews =
 * total_reviews x 30 x price_initial — while the copy count was mart_game.owners_mid, the
 * owners-based SteamSpy bucket midpoint the API serves as `owners_est`. Dividing the two
 * columns the layout invites you to divide gave a price per copy that the price column in the
 * same row contradicts.
 *
 * Measured on the live API, GET /api/niches/tag/Souls-like/games?win=24m&min_reviews=50
 * &sort=revenue&order=desc (2026-09-01) — the fixture below is that response, verbatim:
 *
 *   game                     est_revenue      price   owners_est    est_revenue/owners_est
 *   Clair Obscur            $414,290,625.30   49.99    3,500,000    $118.37   (2.37x price)
 *   Hollow Knight: Silksong $251,133,970.20   19.99   10,948,102    $ 22.94   (1.15x price)
 *   ELDEN RING NIGHTREIGN   $227,657,471.40   39.99    3,500,000    $ 65.04   (1.63x price)
 *   Path of Exile 2         $202,068,121.50   29.99   35,000,000    $  5.77   (0.19x price)
 *   Stellar Blade           $167,906,610.90   59.99    2,439,131    $ 68.84   (1.15x price)
 *
 * Cross-surface, the same mismatch was visible without any arithmetic at all: /compare prints
 * Silksong "Est. units 12.6M" (251,133,970.2 / 19.99) where this table printed "10.9M".
 *
 * These tests assert the DISPLAYED strings, not the helper — lib/estimates.test.ts already
 * covers the helper, and the bug was never in the maths, it was in which column got rendered.
 */
describe("NicheDetail — the games table multiplies out across the row", () => {
  // GET /api/niches/tag/Souls-like/games?win=24m&min_reviews=50&sort=revenue&order=desc, verbatim.
  const GAMES = {
    total: 223,
    limit: 25,
    offset: 0,
    items: [
      {
        appid: 1903340,
        name: "Clair Obscur: Expedition 33",
        release_year: 2025,
        price_initial: 49.99,
        est_revenue: 414290625.3,
        total_reviews: 276249,
        owners_est: 3500000.0,
      },
      {
        appid: 1030300,
        name: "Hollow Knight: Silksong",
        release_year: 2025,
        price_initial: 19.99,
        est_revenue: 251133970.2,
        total_reviews: 418766,
        owners_est: 10948101.889666468,
      },
      {
        appid: 2694490,
        name: "Path of Exile 2",
        release_year: 2024,
        price_initial: 29.99,
        est_revenue: 202068121.5,
        total_reviews: 224595,
        owners_est: 35000000.0,
      },
    ],
  };

  const DETAIL = {
    dimension: "tag",
    key: "Souls-like",
    tier: "micro",
    variants: [
      {
        dimension: "tag",
        key: "Souls-like",
        window: "24m",
        min_reviews: 50,
        n_games: 223,
        median_rev: 100_000,
        p90_rev: 5_000_000,
        median_price: 14.99,
        opportunity_v2: 77.25,
        saturation_yoy: 0.0176,
        n_recent_year: 346,
        n_prior_year: 340,
      },
    ],
    saturation_trend: [],
    revenue_histogram: [],
    representative_games: [],
    players: null,
    themes: [],
    press: null,
    hit_rates: { hit_rate_200k: null, hit_rate_500k: null, median_rev: null, n_games: null, winner_concentration: null },
  };

  function renderGamesTab() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    return render(
      <QueryClientProvider client={client}>
        <ThemeProvider>
          <MemoryRouter initialEntries={["/niches/tag/Souls-like?tab=games&win=24m&min_reviews=50"]}>
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
        const body = url.includes("/games")
          ? GAMES
          : url.includes("/niches/tag/")
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

  /** The rendered cells of the row whose first cell links to /games/{appid}. */
  async function rowCells(appid: number): Promise<string[]> {
    const link = await screen.findByRole("link", { name: new RegExp(GAMES.items.find((g) => g.appid === appid)!.name) });
    const row = link.closest("tr");
    expect(row).toBeTruthy();
    return Array.from((row as HTMLTableRowElement).querySelectorAll("td")).map((td) => td.textContent?.trim() ?? "");
  }

  it("prints copies from the SAME estimator as the revenue in that row, not SteamSpy owners", async () => {
    renderGamesTab();
    // 414,290,625.30 / 49.99 = 8,287,470 copies -> "8.3M". The owners-based figure for this row
    // is 3,500,000 -> "3.5M", which is what the table used to print beside a $49.99 price.
    const clair = await rowCells(1903340);
    expect(clair).toContain("8.3M");
    expect(clair).not.toContain("3.5M");

    // The worst offender: 202,068,121.50 / 29.99 = 6,737,850 -> "6.7M", against the 35,000,000
    // owners ("35.0M") that made this row read $5.77 a copy at a $29.99 price.
    const poe2 = await rowCells(2694490);
    expect(poe2).toContain("6.7M");
    expect(poe2).not.toContain("35.0M");
  });

  it("agrees with /compare on the same game — Silksong is 12.6M units on both", async () => {
    renderGamesTab();
    // 251,133,970.20 / 19.99 = 12,562,980 -> "12.6M", exactly what Compare.tsx's Est. units row
    // prints from the same helper. The old column printed the owners figure, "10.9M".
    const silksong = await rowCells(1030300);
    expect(silksong).toContain("12.6M");
    expect(silksong).not.toContain("10.9M");
  });

  it("names the column for what it now is, and disowns the owners method in the header", async () => {
    renderGamesTab();
    const header = await screen.findByText("Est. units");
    expect(screen.queryByText("Owners (est.)")).toBeNull();
    // The header says which estimator the number came from and where the other one lives.
    expect(header.getAttribute("title")).toMatch(/est\. revenue ÷ launch price/i);
    expect(header.getAttribute("title")).toMatch(/different method/i);
  });

  it("holds price × units === the revenue printed in the same row, for every row", async () => {
    renderGamesTab();
    await screen.findByText("Est. units");
    for (const g of GAMES.items) {
      const cells = await rowCells(g.appid);
      // Cells: name, year, price, reviews, units, revenue. Parse the two the reader divides.
      const price = Number(cells[2].replace(/[$,]/g, ""));
      const units = Number(cells[4].replace("M", "")) * 1_000_000;
      expect(price).toBeCloseTo(g.price_initial, 2);
      // fmtCompact rounds to one decimal at M scale, so the reader's own division has to land
      // within that rounding — 0.05M of slack, not an arbitrary tolerance.
      expect(units * price).toBeGreaterThan(g.est_revenue - 0.05e6 * price);
      expect(units * price).toBeLessThan(g.est_revenue + 0.05e6 * price);
      // And the old pairing must fail that same check, which is the whole point.
      expect(Math.abs(g.owners_est * price - g.est_revenue)).toBeGreaterThan(0.05e6 * price);
    }
  });
});

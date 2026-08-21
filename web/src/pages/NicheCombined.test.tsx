import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import NicheCombined, {
  NICHE_COMBINE_CAP,
  formatNicheRef,
  nicheCombinedPath,
  nicheFinderPath,
  parseCombineMode,
  parseNicheRef,
  parseNicheSelection,
  type NicheSelection,
} from "./NicheCombined";

/**
 * The URL contract is the load-bearing part of this feature: the finder WRITES these links
 * and this page READS them, so anything that survives a round trip through a URL survives
 * being pasted into Slack. Niche keys are hostile to naive string joins — spaces,
 * ampersands, apostrophes, and (defensively) slashes — so every tricky key is exercised.
 */
const TRICKY_KEYS = [
  "Massively Multiplayer", // spaces
  "Point & Click", // an ampersand: would truncate a hand-joined query string
  "Beat 'em up", // an apostrophe
  "Design &amp; Illustration", // a literally-stored HTML entity (real mart_niche row)
  "Rogue/Like", // a slash: must not become a second path segment
  "Action: Reloaded", // a colon: must not confuse the dimension separator
];

// ---- pure URL-contract tests ------------------------------------------------------------

describe("niche URL contract", () => {
  it("round-trips every tricky key through format/parse", () => {
    for (const key of TRICKY_KEYS) {
      const sel: NicheSelection = { dimension: "tag", key };
      expect(parseNicheRef(formatNicheRef(sel))).toEqual(sel);
    }
  });

  it("round-trips a whole selection through the combined URL (space + slash included)", () => {
    const selection: NicheSelection[] = [
      { dimension: "tag", key: "Massively Multiplayer" },
      { dimension: "tag", key: "Rogue/Like" },
      { dimension: "genre", key: "Point & Click" },
    ];
    const path = nicheCombinedPath(selection, "intersect", { win: "24m", min_reviews: 50 });

    expect(path.startsWith("/niches/combined?")).toBe(true);
    const sp = new URLSearchParams(path.slice(path.indexOf("?") + 1));
    expect(parseNicheSelection(sp)).toEqual(selection);
    expect(parseCombineMode(sp.get("mode"))).toBe("intersect");
    expect(sp.get("win")).toBe("24m");
    expect(sp.get("min_reviews")).toBe("50");
    // The slash must be encoded, never left to split the path.
    expect(path).not.toContain("Rogue/Like");
    expect(sp.getAll("niches")).toContain("tag:Rogue/Like");
  });

  it("matches the frozen API shape: repeated niches= params, not a comma join", () => {
    const path = nicheCombinedPath(
      [
        { dimension: "tag", key: "Roguelike" },
        { dimension: "tag", key: "Deckbuilding" },
      ],
      "intersect",
    );
    expect(path).toBe("/niches/combined?niches=tag%3ARoguelike&niches=tag%3ADeckbuilding&mode=intersect");
  });

  it("round-trips the back-link to the finder", () => {
    const selection: NicheSelection[] = [
      { dimension: "tag", key: "Point & Click" },
      { dimension: "genre", key: "Massively Multiplayer" },
    ];
    const path = nicheFinderPath(selection);
    const sp = new URLSearchParams(path.slice(path.indexOf("?") + 1));
    expect(parseNicheSelection(sp)).toEqual(selection);
    expect(nicheFinderPath([])).toBe("/niches");
  });

  it("drops malformed refs instead of inventing niches", () => {
    const sp = new URLSearchParams();
    for (const raw of ["tag:Roguelike", "nonsense:Roguelike", "tag:", ":Roguelike", "Roguelike"]) {
      sp.append("niches", raw);
    }
    expect(parseNicheSelection(sp)).toEqual([{ dimension: "tag", key: "Roguelike" }]);
  });

  it("dedupes and caps the selection", () => {
    const sp = new URLSearchParams();
    sp.append("niches", "tag:Roguelike");
    sp.append("niches", "tag:Roguelike");
    for (let i = 0; i < NICHE_COMBINE_CAP + 3; i++) sp.append("niches", `tag:N${i}`);
    const parsed = parseNicheSelection(sp);
    expect(parsed).toHaveLength(NICHE_COMBINE_CAP);
    expect(parsed.filter((s) => s.key === "Roguelike")).toHaveLength(1);
  });

  it("defaults the mode to intersect and only accepts a known alternative", () => {
    expect(parseCombineMode(null)).toBe("intersect");
    expect(parseCombineMode("")).toBe("intersect");
    expect(parseCombineMode("nonsense")).toBe("intersect");
    expect(parseCombineMode("union")).toBe("union");
  });
});

// ---- page tests ---------------------------------------------------------------------------

let lastLocation = { pathname: "", search: "" };

function LocationSpy() {
  const loc = useLocation();
  lastLocation = { pathname: loc.pathname, search: loc.search };
  return null;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const TWO = "?niches=tag%3ARoguelike&niches=tag%3ADeckbuilding&mode=intersect&win=24m&min_reviews=50";

/** Mirrors api/app/schemas.py::NicheCombined as shipped. */
function combinedBody(overrides: Record<string, unknown> = {}) {
  return {
    mode: "intersect",
    win: "24m",
    min_reviews: 50,
    n_games: 40,
    total: 40,
    limit: 25,
    offset: 0,
    median_rev: 21000,
    p25_rev: 4000,
    p75_rev: 90000,
    p90_rev: 310000,
    median_price: 14.99,
    inputs: [
      { dimension: "tag", key: "Roguelike", n_games: 8000 },
      { dimension: "tag", key: "Deckbuilding", n_games: 3000 },
    ],
    items: [
      {
        appid: 646570,
        name: "Slay the Spire",
        release_year: 2019,
        price_initial: 24.99,
        total_reviews: 200000,
        owners_est: 8000000,
        est_revenue: 90000000,
      },
    ],
    ...overrides,
  };
}

/** Detail-endpoint stub — the degraded path reads each niche's own size from here. */
function detailBody(key: string, nGames: number) {
  return {
    dimension: "tag",
    key,
    tier: "micro",
    variants: [{ dimension: "tag", key, window: "24m", min_reviews: 50, n_games: nGames }],
    saturation_trend: [],
    revenue_histogram: [],
    representative_games: [],
    players: null,
    themes: [],
    press: null,
    hit_rates: {},
  };
}

let combinedCalls: string[] = [];

function stubFetch(combined: () => Response) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith("/api/niches/combined")) {
      combinedCalls.push(url);
      return combined();
    }
    if (url.startsWith("/api/niches/tag/Roguelike")) return jsonResponse(detailBody("Roguelike", 8000));
    if (url.startsWith("/api/niches/tag/Deckbuilding")) return jsonResponse(detailBody("Deckbuilding", 3000));
    return jsonResponse({});
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function renderPage(search: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[`/niches/combined${search}`]}>
        <Routes>
          <Route path="/niches/combined" element={<NicheCombined />} />
          <Route path="/niches" element={<div>finder</div>} />
          <Route path="/niches/:dimension/:key" element={<div>detail</div>} />
        </Routes>
        <LocationSpy />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  combinedCalls = [];
  lastLocation = { pathname: "", search: "" };
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("NicheCombined page", () => {
  it("refuses to combine fewer than two niches, and says why", async () => {
    stubFetch(() => jsonResponse(combinedBody()));
    renderPage("?niches=tag%3ARoguelike&mode=intersect");

    expect(screen.getByText(/Only one niche selected/)).toBeTruthy();
    expect(document.body.textContent).toContain("needs at least two niches");
    // and it never asks the API a question the API would reject
    await waitFor(() => expect(combinedCalls).toHaveLength(0));
  });

  it("renders the combined figures and every input niche's own size", async () => {
    stubFetch(() => jsonResponse(combinedBody()));
    renderPage(TWO);

    await screen.findByText("Games in ALL 2 niches");
    expect(screen.getByText("40")).toBeTruthy();
    // The drop (8,000 and 3,000 -> 40) is the insight, so both inputs are on screen.
    const funnel = screen.getByTestId("per-niche-funnel");
    expect(funnel.textContent).toContain("8,000 games");
    expect(funnel.textContent).toContain("3,000 games");
    expect(funnel.textContent).toContain("40 games");
    // ...and the mode is stated in words, not just implied by a toggle.
    expect(document.body.textContent).toContain("carries ALL 2 niches — Roguelike AND Deckbuilding");
    expect(screen.getByText("Slay the Spire")).toBeTruthy();
  });

  it("switches mode, and the switch changes the URL, the request and the wording", async () => {
    stubFetch(() => jsonResponse(combinedBody({ n_games: 10500 })));
    renderPage(TWO);

    await screen.findByText("Games in ALL 2 niches");
    expect(combinedCalls[0]).toContain("mode=intersect");

    fireEvent.click(screen.getByText("Union (any)"));

    await screen.findByText("Games in ANY of 2 niches");
    expect(new URLSearchParams(lastLocation.search).get("mode")).toBe("union");
    await waitFor(() => expect(combinedCalls.some((u) => u.includes("mode=union"))).toBe(true));
    expect(document.body.textContent).toContain("carries AT LEAST ONE of these 2 niches");
    // A union is reach, not a segment — the page says so rather than letting the reader
    // mistake it for market size.
    expect(document.body.textContent).toContain("A union sizes total reach");
  });

  it("treats an empty intersection as a finding, not an error", async () => {
    stubFetch(() => jsonResponse(combinedBody({ n_games: 0, items: [], median_rev: null })));
    renderPage(TWO);

    await screen.findByText("Nobody has built this combination");
    expect(document.body.textContent).not.toContain("Failed to combine");
    expect(screen.getByText("Widen to all-time")).toBeTruthy();
    expect(screen.getByText("Show the union instead")).toBeTruthy();
    // The inputs are still sized, so "0" reads as a real overlap of two real niches.
    expect(screen.getByTestId("per-niche-funnel").textContent).toContain("8,000 games");
  });

  it("reads the per-input sizes under the originally-specced `per_niche` name too", async () => {
    const { inputs, ...rest } = combinedBody();
    stubFetch(() => jsonResponse({ ...rest, per_niche: inputs }));
    renderPage(TWO);

    await screen.findByText("Games in ALL 2 niches");
    expect(screen.getByTestId("per-niche-funnel").textContent).toContain("8,000 games");
  });

  it("treats an unmaterialised cut as a cut problem, not a failure", async () => {
    stubFetch(() =>
      jsonResponse(
        {
          detail:
            "cut (win=24m, min_reviews=0) is not materialised in mart_niche_game; available: (all, 50), (24m, 50)",
        },
        422,
      ),
    );
    renderPage("?niches=tag%3ARoguelike&niches=tag%3ADeckbuilding&mode=intersect&win=24m&min_reviews=0");

    await screen.findByText(/available for combined analysis/);
    expect(document.body.textContent).toContain("available: (all, 50), (24m, 50)");
    expect(document.body.textContent).not.toContain("Failed to combine");
    expect(screen.getByText(/Use the default cut/)).toBeTruthy();
  });

  it("states the degraded case honestly when the combined mart is not built yet", async () => {
    stubFetch(() => jsonResponse({ detail: "combined niche mart not built yet" }, 503));
    renderPage(TWO);

    await screen.findByText(/be computed yet/);
    // No spinner, no blank page, no invented numbers — but it still shows what the
    // combination WOULD be, including each input's own size from the live marts.
    expect(document.body.textContent).toContain("carries ALL 2 niches — Roguelike AND Deckbuilding");
    await waitFor(() =>
      expect(screen.getByTestId("per-niche-funnel").textContent).toContain("8,000 games"),
    );
    expect(screen.getByTestId("per-niche-funnel").textContent).toContain("not computed yet");
    expect(screen.getByText("Check again")).toBeTruthy();
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation, useParams } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import NicheFinder from "./NicheFinder";
import { parseCombineMode, parseNicheSelection } from "../lib/nicheSelection";
import { DOSSIER_LABEL, RING_COLOR } from "../lib/radarVerdict";
import { ThemeProvider } from "../lib/theme";
import { radarListRow, readRadarTooltip } from "../test/radarTooltip";

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
/** Every /api URL this render asked for, in order — the URL contract is only real if the
 * REQUEST changes with it (a page can restore a chip and still fetch the default cut). */
let requests: string[] = [];

function LocationSpy() {
  const loc = useLocation();
  lastLocation = { pathname: loc.pathname, search: loc.search };
  return null;
}

function ParamEcho() {
  const params = useParams();
  return <div data-testid="params">{JSON.stringify(params)}</div>;
}

function renderFinder(entry = "/niches") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={client}>
      <ThemeProvider>
        <MemoryRouter initialEntries={[entry]}>
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
  requests = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      requests.push(url);
      const body = url.startsWith("/api/niches?")
        // `total` is deliberately larger than the page size so Next/Prev are live —
        // the pager is part of the URL contract, and a 3-row fixture disables it.
        ? { items: KEYS.map(nicheRow), total: 120, limit: 50, offset: 0 }
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

/**
 * THE WHOLE VIEW IS THE URL (2026-09-01).
 *
 * Until now only the multi-select was routed, on the argument recorded in NicheFinder.tsx
 * that "filters stay in component state: they're a browsing pose". They are not a pose:
 * mart_niche precomputes its aggregates PER (window, min_reviews) population, so the cut
 * chips swap in different medians and a different opportunity_v2 for the same niche — and
 * this page already handed win/min_reviews to /niches/combined and to Export CSV. A shared
 * link therefore restored the ticked rows onto the WRONG cut and produced a different
 * combined page than the sender got.
 *
 * Reproduction of the old behaviour: click Genres, type "card", click All-time — the URL
 * stays /niches; hard reload and the search is empty, the dimension is back to Tags and
 * the rows are the default cut's.
 *
 * Every assertion below checks the REQUEST as well as the chrome where it can: restoring a
 * lit chip while still fetching the default population is the failure that reads as fixed.
 */
describe("NicheFinder — the whole view is shareable", () => {
  /** The most recent /api/niches request — what the table is actually showing. */
  const lastNichesRequest = (): string => {
    // The TABLE's request (limit=50) — not the pinned-cut verdict query (limit=500).
    const hits = requests.filter((u) => u.startsWith("/api/niches?") && u.includes("limit=50&"));
    return hits[hits.length - 1] ?? "";
  };
  const url = (): string => `${lastLocation.pathname}${lastLocation.search}`;
  const searchBox = () => screen.getByPlaceholderText("Search niches…") as HTMLInputElement;

  it("the reported reproduction — Genres + 'card' + All-time — is one shareable URL", async () => {
    renderFinder();
    await screen.findByTitle("Open the Rogue/Like deep dive");
    // Defaults omitted: a pristine /niches stays a clean URL, and the default cut it
    // fetches is stated here so "defaults omitted" can't drift into "defaults forgotten".
    expect(url()).toBe("/niches");
    const pristine = lastNichesRequest();
    expect(pristine).toContain("window=24m");
    expect(pristine).toContain("min_reviews=50");
    expect(pristine).toContain("tiers=micro%2Ctheme");
    expect(pristine).toContain("sort=opportunity_v2");
    expect(pristine).toContain("order=desc");

    fireEvent.click(screen.getByRole("button", { name: "Genres" }));
    fireEvent.change(searchBox(), { target: { value: "card" } });
    fireEvent.click(screen.getByRole("button", { name: "All-time" }));

    await waitFor(() => expect(url()).toContain("q=card"));
    const u = url();
    expect(u).toContain("dim=genre");
    expect(u).toContain("win=all");
    // …and the request agrees with the address bar.
    await waitFor(() => expect(lastNichesRequest()).toContain("q=card"));
    const req = lastNichesRequest();
    expect(req).toContain("dimension=genre");
    expect(req).toContain("window=all");
  });

  it("a fresh mount on that URL asks the API for that exact slice and lights the controls", async () => {
    renderFinder("/niches?dim=genre&win=all&min_reviews=100&q=card");
    await waitFor(() => expect(lastNichesRequest()).not.toBe(""));

    const req = lastNichesRequest();
    expect(req).toContain("dimension=genre");
    expect(req).toContain("window=all");
    expect(req).toContain("min_reviews=100");
    expect(req).toContain("q=card");
    // Genres carries no tier filter — the chips only exist on the tag dimension.
    expect(req).not.toContain("tiers=");
    // The chrome shows the shared slice rather than the defaults.
    expect(searchBox().value).toBe("card");
    expect(screen.getByRole("button", { name: "All-time" }).style.backgroundColor).toBe("var(--brand)");
    expect(screen.getByRole("button", { name: "Genres" }).style.backgroundColor).toBe("var(--brand)");
    expect(screen.getByRole("button", { name: "≥100" }).style.backgroundColor).toBe("var(--brand)");
    // The URL is left exactly as shared — no echo rewrite on mount.
    expect(url()).toBe("/niches?dim=genre&win=all&min_reviews=100&q=card");
  });

  it("min_reviews=0 is a REAL cut, not the absent default", async () => {
    // Number(null) is also 0, so an unguarded parse turns "no param" into the All-games
    // population — a different set of medians under an unchanged-looking page.
    renderFinder("/niches?min_reviews=0");
    await waitFor(() => expect(lastNichesRequest()).toContain("min_reviews=0"));
    expect(screen.getByRole("button", { name: "All games" }).style.backgroundColor).toBe("var(--brand)");
  });

  it("sort headers, tier chips, paging and More metrics all write their param", async () => {
    renderFinder();
    await screen.findByTitle("Open the Rogue/Like deep dive");

    fireEvent.click(screen.getByRole("button", { name: /^Games/ }));
    await waitFor(() => expect(url()).toContain("sort=n_games"));

    fireEvent.click(screen.getByRole("button", { name: "Broad genres" }));
    await waitFor(() => expect(url()).toContain("tiers=micro%2Ctheme%2Cumbrella"));

    fireEvent.click(screen.getByRole("button", { name: /More metrics/ }));
    await waitFor(() => expect(url()).toContain("more=1"));

    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(url()).toContain("offset=50"));
    expect(lastNichesRequest()).toContain("offset=50");
  });

  it("a filter change re-pages to the top; a disclosure or a tick does not", async () => {
    renderFinder("/niches?offset=50");
    await screen.findByTitle("Open the Rogue/Like deep dive");
    expect(lastNichesRequest()).toContain("offset=50");

    // Opening the panel keeps your place in the list…
    fireEvent.click(screen.getByRole("button", { name: /More metrics/ }));
    await waitFor(() => expect(url()).toContain("more=1"));
    expect(url()).toContain("offset=50");

    // …ticking a row keeps it too (a selection is not a filter)…
    fireEvent.click(screen.getByLabelText("Add Rogue/Like to the combined analysis"));
    await waitFor(() => expect(url()).toContain("niches=tag%3ARogue%2FLike"));
    expect(url()).toContain("offset=50");

    // …but changing the population must not leave offset pointing past the new result set.
    fireEvent.click(screen.getByRole("button", { name: "All-time" }));
    await waitFor(() => expect(url()).not.toContain("offset="));
    expect(url()).toContain("niches=tag%3ARogue%2FLike"); // the selection survives
  });

  it("reads each param strictly: real values land, garbage falls back to the defaults", async () => {
    // Both halves in one test on purpose — "garbage becomes the default" would also hold
    // on a page that ignores the params entirely, which is exactly the bug this describes.
    const good = renderFinder("/niches?win=all&min_reviews=100&sort=n_games&order=asc&tiers=micro%2Cumbrella");
    await waitFor(() => expect(lastNichesRequest()).toContain("window=all"));
    const honoured = lastNichesRequest();
    expect(honoured).toContain("min_reviews=100");
    expect(honoured).toContain("sort=n_games");
    expect(honoured).toContain("order=asc");
    expect(honoured).toContain("tiers=micro%2Cumbrella");
    good.unmount();

    requests = [];
    renderFinder("/niches?dim=wizard&win=forever&min_reviews=7&sort=nope&order=sideways&tiers=bogus");
    await waitFor(() => expect(lastNichesRequest()).not.toBe(""));
    const req = lastNichesRequest();
    expect(req).toContain("dimension=tag");
    expect(req).toContain("window=24m");
    expect(req).toContain("min_reviews=50");
    expect(req).toContain("sort=opportunity_v2");
    expect(req).toContain("order=desc");
    expect(req).toContain("tiers=micro%2Ctheme");
  });

  it("the cut in the URL is the cut 'Analyse combined' hands on — the reason this matters", async () => {
    // The old split state made this wrong: a shared link restored the SELECTION but reset
    // the cut, so the recipient's combined page answered a different question.
    renderFinder("/niches?win=all&min_reviews=100&niches=tag%3ARogue%2FLike&niches=tag%3APoint+%26+Click");
    fireEvent.click(await screen.findByText("Analyse combined (2)"));

    await waitFor(() => expect(lastLocation.pathname).toBe("/niches/combined"));
    const sp = new URLSearchParams(lastLocation.search);
    expect(sp.get("win")).toBe("all");
    expect(sp.get("min_reviews")).toBe("100");
    expect(parseNicheSelection(sp)).toEqual([
      { dimension: "tag", key: "Rogue/Like" },
      { dimension: "tag", key: "Point & Click" },
    ]);
  });
});

/**
 * THE TABLE SPEAKS THE RADAR'S VOCABULARY (2026-09-09). Same user report as the deep dive —
 * "OPP V2 77.7 ×0.96" beside three percentile meters the board never draws. The middle columns
 * are now the board's two axes and its verdict, through the same radarDossier() strings, and the
 * oracle for "the same" is a real RadarBoard tooltip (src/test/radarTooltip.tsx).
 */
describe("NicheFinder — ranked and labelled as on the Radar", () => {
  const lastNichesRequest = (): string =>
    requests.filter((u) => u.startsWith("/api/niches?") && u.includes("limit=50&")).at(-1) ?? "";

  it("draws the verdict's inputs, the verdict and the score, each header with a plain name and an ⓘ", async () => {
    renderFinder();
    await screen.findByText("Massively Multiplayer");
    for (const name of ["Niche", "Games", "Top 10% rev", "Demand 24m", "Releases YoY", "Opportunity", "Players 7d"]) {
      expect(screen.getByRole("button", { name }), name).toBeTruthy();
    }
    // Every header explains itself in place (not a hover-only title): the glossary's ⓘ.
    for (const about of [
      "About Games",
      "About Top-10% revenue",
      "About Demand trend, 24 months",
      "About Releases, year over year",
      "About Radar verdict",
      "About Opportunity score",
    ]) {
      expect(screen.getByRole("button", { name: about }), about).toBeTruthy();
    }
    // The verdict is the board's call, computed per row — a label, not a sort button.
    expect(screen.getByText("Verdict")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Verdict" })).toBeNull();
    for (const gone of ["Opp v2", "P90 rev", "Competition", "Quality gap"]) {
      expect(screen.queryByRole("button", { name: gone }), gone).toBeNull();
    }
    // The Releases/Demand ⓘ never calls them the Radar's axes any more (the board is a dial).
    fireEvent.click(screen.getByRole("button", { name: "About Demand trend, 24 months" }));
    expect(screen.getByRole("tooltip").textContent).not.toMatch(/axis/i);
    expect(screen.getByTestId("finder-summary").textContent).toContain(
      "numbers for last 24 months · ≥50 reviews · ranked by Opportunity score · verdicts judged at the Radar’s cut (last 24 months · ≥50 reviews)",
    );
    // Saturation YoY left the More-metrics panel: it is the grid's Releases YoY column now.
    fireEvent.click(screen.getByRole("button", { name: /More metrics/ }));
    expect(await screen.findByRole("button", { name: "Longevity" })).toBeTruthy();
    expect(screen.queryByText("Saturation YoY")).toBeNull();
    expect(screen.queryByText(/21–22:00 UTC/)).toBeNull();
  });

  it("prints each row's verdict, demand, releases and score exactly as the board's tooltip does", async () => {
    // -12.3% / 24m is "softening": a Watch with no caution — a verdict the fixture's 42.5 score
    // alone would never produce, so the column is visibly reading the inputs.
    const row = radarListRow({
      ...nicheRow("Massively Multiplayer"),
      demand_trend_24m_pct: -12.3,
      saturation_yoy: 0.02,
      n_recent_year: 51,
      n_prior_year: 50,
      winner_concentration: 0.7,
      opportunity_v2: 42.5,
    });
    const tip = readRadarTooltip(row);
    expect(tip.rows[DOSSIER_LABEL.verdict]).toBe("Watch");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        const body = url.startsWith("/api/niches?") ? { items: [row], total: 1, limit: 50, offset: 0 } : {};
        return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
      }),
    );
    renderFinder();
    await screen.findByText("Massively Multiplayer");

    const verdictCell = screen.getByText(tip.rows[DOSSIER_LABEL.verdict]!).closest("[data-verdict]")!;
    expect(verdictCell.getAttribute("data-verdict")).toBe("watch");
    expect(RING_COLOR.watch).toBe(tip.dotFill);
    expect(screen.getByText(tip.rows[DOSSIER_LABEL.demand]!)).toBeTruthy();
    expect(tip.rows[DOSSIER_LABEL.demand]).toBe("▼ −12.3%");
    expect(screen.getByText(tip.rows[DOSSIER_LABEL.releases]!)).toBeTruthy();
    expect(tip.rows[DOSSIER_LABEL.releases]).toBe("+2%");
    expect(screen.getAllByText(tip.rows[DOSSIER_LABEL.opportunity]!).length).toBeGreaterThan(0);
    expect(tip.rows[DOSSIER_LABEL.opportunity]).toBe("42.5");
  });

  it("never prints the score alone — its parts ride beside it", async () => {
    const row = radarListRow({
      ...nicheRow("Massively Multiplayer"),
      momentum: 61.2,
      market_pull: 44,
      revenue_spread: 80,
      quality_gap: 30,
      supply_room: 50,
      supply_brake: 0.675,
      opportunity_v2: 36.1,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const body = String(input).startsWith("/api/niches?") ? { items: [row], total: 1, limit: 50, offset: 0 } : {};
        return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
      }),
    );
    renderFinder();
    const compact = await screen.findByTestId("opportunity-breakdown-compact");
    expect(compact.textContent).toContain("Momentum 61.2");
    expect(compact.textContent).toContain("supply brake ×0.68");
  });

  it("sorts by the verdict's inputs through the URL — the same contract as every other column", async () => {
    renderFinder();
    await screen.findByText("Massively Multiplayer");
    fireEvent.click(screen.getByRole("button", { name: "Releases YoY" }));
    await waitFor(() => expect(new URLSearchParams(lastLocation.search).get("sort")).toBe("saturation_yoy"));
    await waitFor(() => expect(lastNichesRequest()).toContain("sort=saturation_yoy"));
    fireEvent.click(screen.getByRole("button", { name: "Demand 24m" }));
    await waitFor(() => expect(new URLSearchParams(lastLocation.search).get("sort")).toBe("demand_trend_24m_pct"));
    await waitFor(() => expect(lastNichesRequest()).toContain("sort=demand_trend_24m_pct"));
  });

  it("a link still carrying a retired meter's sort key falls back to the default order", async () => {
    renderFinder("/niches?sort=competition");
    await waitFor(() => expect(lastNichesRequest()).not.toBe(""));
    expect(lastNichesRequest()).toContain("sort=opportunity_v2");
    expect(lastNichesRequest()).not.toContain("sort=competition");
  });

  it("keeps every verdict at the Radar's cut when the chips leave it — All-time never flips a verdict", async () => {
    // Roguelike Deckbuilder's reported flip: on the All-time cut its row is winner-take-most
    // (a Crowded read), while at the Radar's cut (24m × ≥50) it is surging into a flooding
    // pipeline — Watch. The column must print the Radar's call, whichever chip is lit.
    const allTime = radarListRow({
      ...nicheRow("Roguelike Deckbuilder"),
      window: "all",
      n_games: 459,
      demand_trend_24m_pct: 196,
      saturation_yoy: 0.409,
      winner_concentration: 0.93,
    });
    const pinned = { ...allTime, window: "24m", n_games: 210, winner_concentration: 0.836 };
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        urls.push(url);
        const body = url.includes("window=all")
          ? { items: [allTime], total: 1, limit: 50, offset: 0 }
          : url.startsWith("/api/niches?")
            ? { items: [pinned], total: 1, limit: 500, offset: 0 }
            : {};
        return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
      }),
    );
    renderFinder("/niches?win=all");
    await screen.findByText("Roguelike Deckbuilder");
    const cell = await waitFor(() => {
      const el = document.querySelector("[data-verdict]");
      if (!el) throw new Error("no verdict yet");
      return el;
    });
    expect(cell.getAttribute("data-verdict")).toBe("watch");
    // …read from the pinned-cut list, the Radar's own query.
    expect(urls.some((u) => u.includes("window=24m") && u.includes("min_reviews=50") && u.includes("limit=500"))).toBe(true);
    expect(screen.getByTestId("finder-summary").textContent).toContain("numbers for all time · ≥50 reviews");
    expect(screen.getByTestId("finder-summary").textContent).toContain("— not this table's");
  });

  it("a niche with no row at the Radar's cut gets a sentinel, never a verdict from another cut", async () => {
    const allOnly = radarListRow({ ...nicheRow("Tiny Niche"), window: "all" });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        const body = url.includes("window=all")
          ? { items: [allOnly], total: 1, limit: 50, offset: 0 }
          : url.startsWith("/api/niches?")
            ? { items: [], total: 0, limit: 500, offset: 0 }
            : {};
        return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
      }),
    );
    renderFinder("/niches?win=all");
    expect(await screen.findByText("not scored at the Radar’s cut")).toBeTruthy();
    expect(document.querySelector("[data-verdict]")).toBeNull();
  });

  it("reads the players trend against the market when the data has it", async () => {
    const row = radarListRow({
      ...nicheRow("Massively Multiplayer"),
      players_trend_7d_pct: -10.66,
      players_trend_7d_market_pct: 0.75,
      players_trend_7d_rel_pct: -11.41,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const body = String(input).startsWith("/api/niches?") ? { items: [row], total: 1, limit: 50, offset: 0 } : {};
        return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
      }),
    );
    renderFinder();
    expect(await screen.findByText("▼ −10.7%")).toBeTruthy();
    expect(screen.getByText("−11.4 pts vs market")).toBeTruthy();
    expect(screen.getByRole("button", { name: "About 7-day players trend vs market" })).toBeTruthy();
  });

  it("marks revenue the mart withheld for too few paid games — never a bare dash", async () => {
    const row = radarListRow({ ...nicheRow("MOBA"), n_games: 33, n_paid: 12, n_free: 20, n_price_unknown: 1, p90_rev: null });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const body = String(input).startsWith("/api/niches?") ? { items: [row], total: 1, limit: 50, offset: 0 } : {};
        return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
      }),
    );
    renderFinder();
    expect(await screen.findByText("withheld: only 12 paid games")).toBeTruthy();
  });
});

describe("NicheFinder — cards below 640px", () => {
  function setViewport(width: number) {
    Object.defineProperty(window, "innerWidth", { value: width, configurable: true, writable: true });
    window.dispatchEvent(new Event("resize"));
  }
  afterEach(() => setViewport(1024));

  it("shows each niche as a card that leads with the verdict, demand and the score's parts", async () => {
    setViewport(390);
    renderFinder();
    const card = await screen.findByTestId("finder-card-Massively Multiplayer");
    expect(within(card).getByText("Massively Multiplayer")).toBeTruthy();
    expect(card.querySelector("[data-verdict]")).toBeTruthy();
    expect(card.textContent).toContain("Demand");
    expect(card.textContent).toContain("Opportunity");
    expect(card.textContent).toContain("120 games · last 24 months · ≥50 reviews");
    // No 980px grid squeezed into a phone.
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("sorts from a control, since there are no headers to click", async () => {
    setViewport(390);
    renderFinder();
    await screen.findByTestId("finder-cards");
    fireEvent.change(screen.getByLabelText("Sort by"), { target: { value: "demand_trend_24m_pct" } });
    await waitFor(() => expect(new URLSearchParams(lastLocation.search).get("sort")).toBe("demand_trend_24m_pct"));
    fireEvent.click(screen.getByRole("button", { name: /Sorted high to low/ }));
    await waitFor(() => expect(new URLSearchParams(lastLocation.search).get("order")).toBe("asc"));
  });
});

describe("NicheFinder solo/indie lens (2026-09-24)", () => {
  const listRequests = () => requests.filter((u) => u.startsWith("/api/niches?"));

  it("is ON by default: the list asks for solo/indie-friendly niches only, and the CSV follows it", async () => {
    renderFinder();
    await screen.findByTitle("Open the Rogue/Like deep dive");
    expect(listRequests().some((u) => new URLSearchParams(u.split("?")[1]).get("indie_friendly") === "1")).toBe(true);
    expect(screen.getByRole("button", { name: "Solo/indie-friendly" }).getAttribute("aria-pressed") ?? "").not.toBe("false");
    expect(screen.getByText("Export CSV").getAttribute("href")).toContain("indie_friendly=1");
  });

  it("'All niches' drops the lens and remembers it in the URL (?solo=off, the Radar's param)", async () => {
    renderFinder();
    await screen.findByTitle("Open the Rogue/Like deep dive");
    requests = [];
    fireEvent.click(screen.getByRole("button", { name: "All niches" }));
    await screen.findByTitle("Open the Rogue/Like deep dive");
    expect(lastLocation.search).toContain("solo=off");
    const last = listRequests().at(-1) ?? "";
    expect(new URLSearchParams(last.split("?")[1]).get("indie_friendly")).toBeNull();
  });

  it("on a mart without the evidence it says so and offers the full list instead of a generic error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        requests.push(url);
        if (url.startsWith("/api/niches?") && url.includes("indie_friendly=1")) {
          return new Response(
            JSON.stringify({ detail: "mart_niche predates the solo/indie evidence columns — rebuild the marts (task etl)." }),
            { status: 503, headers: { "Content-Type": "application/json" } },
          );
        }
        const body = url.startsWith("/api/niches?") ? { items: KEYS.map(nicheRow), total: 3, limit: 50, offset: 0 } : {};
        return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
      }),
    );
    renderFinder();
    const notice = await screen.findByTestId("finder-lens-unavailable");
    fireEvent.click(within(notice).getByRole("button", { name: "show all niches" }));
    expect(await screen.findByTitle("Open the Rogue/Like deep dive")).toBeTruthy();
  });
});

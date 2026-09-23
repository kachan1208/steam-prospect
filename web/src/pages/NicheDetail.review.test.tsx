import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation, useNavigate, useNavigationType } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import NicheDetail, { NICHE_ROUTE_PATH, nichePressTimeline, reviewsText } from "./NicheDetail";
import { ThemeProvider } from "../lib/theme";
import { radarListRow } from "../test/radarTooltip";

/**
 * The 2026-09-23 review, pinned on the niche page:
 *   - the verdict names every check it failed, and "Read this first" sits ABOVE the numbers;
 *   - figures the rebuilt mart withholds (too few paid games) are marked, never blank or 0;
 *   - the 7-day players trend is read against the market;
 *   - an old tag spelling redirects to the canonical niche and says so;
 *   - Export CSV exports THIS cut's games, not a substring search of the niche list;
 *   - tab / sort / page changes are history entries (Back undoes them);
 *   - hit-rate ticks are the same bar, and a fallback headline cut is flagged.
 */

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.removeItem("prospect-detail-view");
});

function detailOf(variants: object[], extra: Record<string, unknown> = {}) {
  return {
    dimension: "tag",
    key: "Souls-like",
    canonical_key: "Souls-like",
    requested_key: "Souls-like",
    alias_of: null,
    tier: "micro",
    variants,
    saturation_trend: [],
    revenue_histogram: [],
    representative_games: [],
    players: null,
    themes: [],
    press: null,
    hit_rates: { hit_rate_200k: 0.47, hit_rate_500k: 0.36, median_rev: 165_000, n_games: 812, winner_concentration: 0.88 },
    hit_rates_cut: { window: "all", min_reviews: 50, fallback: false },
    ...extra,
  };
}

/** Souls-like's 24m × ≥50 row on the 2026-09-23 build: surging, calm pipeline, but
 * winner-take-most (0.87) — so Watch, with the failure named. */
const SOULS = radarListRow({
  key: "Souls-like",
  n_games: 234,
  n_paid: 200,
  n_free: 28,
  n_price_unknown: 6,
  demand_trend_24m_pct: 56.3,
  reviews_24m: 3_445_676,
  reviews_prev_24m: 2_204_613,
  saturation_yoy: 0.006006006006006006,
  n_recent_year: 335,
  n_prior_year: 333,
  winner_concentration: 0.8705689395019661,
  entrant_ratio: 0.9749,
  opportunity_v2: 67.21,
  median_rev: 161_306.25,
  p90_rev: 10_627_161.48,
});

type Json = Record<string, unknown>;
interface StubOpts {
  detail: Json | ((path: string) => Json);
  games?: (url: URL) => Json;
  health?: Json;
}

let requested: URL[] = [];

function stub({ detail, games, health }: StubOpts) {
  requested = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), "http://test.local");
      requested.push(url);
      let body: unknown = {};
      if (url.pathname.endsWith("/games")) {
        body = games ? games(url) : { total: 0, items: [], limit: 5, offset: 0, scope: url.searchParams.get("scope") ?? "all", n_scope_unknown: 0 };
      } else if (url.pathname.startsWith("/api/niches/tag/")) {
        body = typeof detail === "function" ? detail(url.pathname) : detail;
      } else if (url.pathname.startsWith("/api/health")) {
        body = health ?? { status: "ok", mart_version: "20260923", built_at: "2026-09-23T00:00:00Z", source_db: null, data_as_of: "2026-09-23" };
      }
      return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    }),
  );
}

function Probe() {
  const loc = useLocation();
  const type = useNavigationType();
  const navigate = useNavigate();
  return (
    <>
      <div data-testid="loc">{`${loc.pathname}${loc.search}`}</div>
      <div data-testid="nav-type">{type}</div>
      <button type="button" onClick={() => navigate(-1)}>
        test-back
      </button>
    </>
  );
}

function renderAt(entry: string, history: string[] = []) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={client}>
      <ThemeProvider>
        <MemoryRouter initialEntries={[...history, entry]} initialIndex={history.length}>
          <Routes>
            <Route path={NICHE_ROUTE_PATH} element={<NicheDetail />} />
            <Route path="*" element={<div data-testid="elsewhere">elsewhere</div>} />
          </Routes>
          <Probe />
        </MemoryRouter>
      </ThemeProvider>
    </QueryClientProvider>,
  );
}

describe("the verdict names what it failed, and the red flags come before the numbers", () => {
  it("a surging winner-take-most niche is Watch — and the failing check is spelled out under it", async () => {
    stub({ detail: detailOf([SOULS]) });
    renderAt("/niches/tag/Souls-like");
    const chip = await screen.findByTestId("radar-verdict-chip");
    expect(chip.textContent).toBe("Watch");
    expect(screen.getByText("demand surging, but winner-take-most revenue")).toBeTruthy();
    const failed = screen.getByTestId("verdict-failed-checks");
    const items = within(failed).getAllByRole("listitem").map((li) => li.textContent);
    // The deciding failure first, then the warning sign that never moves the ring.
    expect(items[0]).toContain("Fails");
    expect(items[0]).toContain("Top-5% revenue share 87.1% (bar ≤ 85%; above is winner-take-most)");
    expect(items[1]).toContain("Warning sign");
    expect(items[1]).toContain("Newcomer earnings 0.97×");
  });

  it("puts Read this first above the headline numbers (reading order = DOM order, on every width)", async () => {
    stub({ detail: detailOf([SOULS]) });
    renderAt("/niches/tag/Souls-like");
    const flags = await screen.findByTestId("read-this-first");
    const demandTile = screen.getByText("Demand trend, 24 months");
    expect(flags.compareDocumentPosition(demandTile) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(flags.textContent).toContain("Winner-take-most");
  });

  it("works the demand and release tiles through this niche's own counts", async () => {
    stub({ detail: detailOf([SOULS]) });
    renderAt("/niches/tag/Souls-like");
    await screen.findByTestId("radar-dossier");
    const demandTip = screen.getByRole("button", { name: "About Demand trend, 24 months" });
    fireEvent.click(demandTip);
    expect(screen.getByRole("tooltip").textContent).toContain("(3,445,676 − 2,204,613) ÷ 2,204,613 = +56.3%");
    fireEvent.click(demandTip); // a second press unpins it
    fireEvent.click(screen.getByRole("button", { name: "About Releases, year over year" }));
    expect(screen.getByRole("tooltip").textContent).toContain("(335 − 333) ÷ 333 = +0.6%");
    // The footnote carries both windows, so the % can be recomputed on the page.
    expect(screen.getByText("3.4M reviews in the last 24 months vs 2.2M in the 24 before")).toBeTruthy();
  });
});

describe("paid-only revenue — withheld figures are marked, never blank", () => {
  it("a niche with 12 paid games says its revenue is withheld and why", async () => {
    const moba = radarListRow({
      key: "Souls-like",
      n_games: 33,
      n_paid: 12,
      n_free: 20,
      n_price_unknown: 1,
      median_rev: null,
      p25_rev: null,
      p75_rev: null,
      p90_rev: null,
      winner_concentration: null,
      hit_rate_200k: null,
      hit_rate_500k: null,
    });
    stub({ detail: detailOf([moba]) });
    renderAt("/niches/tag/Souls-like");
    const dossier = await screen.findByTestId("radar-dossier");
    expect(within(dossier).getAllByText("withheld: only 12 paid games").length).toBeGreaterThan(0);
    expect(within(dossier).getByText(/median withheld · paid games only — 20 free and 1 unknown-price games left out/)).toBeTruthy();
    // The concentration check says withheld, not a bare "unknown".
    expect(screen.getByTestId("read-this-first").textContent).toContain("Only 12 of its 33 games sell for a price");
  });

  it("the games tile adds up paid + free + unpriced", async () => {
    stub({ detail: detailOf([SOULS]) });
    renderAt("/niches/tag/Souls-like");
    await screen.findByTestId("radar-dossier");
    fireEvent.click(screen.getByRole("button", { name: "About Games" }));
    expect(screen.getByRole("tooltip").textContent).toContain(
      "234 games (last 24 months · ≥50 reviews) = 200 paid + 28 free + 6 with no known price",
    );
  });
});

describe("the 7-day players trend is read against the market", () => {
  it("prints the niche's move beside the market's, and works the difference", async () => {
    stub({
      detail: detailOf([SOULS], {
        players: {
          total_players_now: 232_389,
          players_trend_7d_pct: -10.66,
          players_trend_7d_market_pct: 0.75,
          players_trend_7d_rel_pct: -11.41,
          players_coverage: 1,
          n_games_panel: 811,
          series: [],
        },
      }),
    });
    renderAt("/niches/tag/Souls-like");
    await screen.findByTestId("radar-dossier");
    expect(screen.getByText("▼ −10.7%")).toBeTruthy();
    expect(screen.getByTestId("players-vs-market").textContent).toBe("vs market +0.8% (−11.4 pts)");
    fireEvent.click(screen.getByRole("button", { name: "About 7-day players trend vs market" }));
    expect(screen.getByRole("tooltip").textContent).toContain("−10.7% − (+0.8%) = −11.4 pts");
    // A niche trailing the market by >10 points is a red flag, worded against the market.
    expect(screen.getByTestId("read-this-first").textContent).toContain("the niche trailed the whole market");
  });

  it("without the market figure it says so in the ⓘ instead of implying momentum", async () => {
    stub({
      detail: detailOf([SOULS], {
        players: { total_players_now: 1000, players_trend_7d_pct: 4, players_coverage: 1, n_games_panel: 50, series: [] },
      }),
    });
    renderAt("/niches/tag/Souls-like");
    await screen.findByTestId("radar-dossier");
    fireEvent.click(screen.getByRole("button", { name: "About 7-day players trend" }));
    expect(screen.getByRole("tooltip").textContent).toContain("No market comparison in this data build yet");
  });
});

describe("tag aliases", () => {
  it("replaces an old spelling's URL with the canonical niche and says what happened", async () => {
    stub({
      detail: (path) =>
        path.endsWith("/Rogue-like")
          ? detailOf([SOULS], { key: "Roguelike", canonical_key: "Roguelike", requested_key: "Rogue-like", alias_of: "Roguelike" })
          : detailOf([SOULS], { key: "Roguelike", canonical_key: "Roguelike", requested_key: "Roguelike", alias_of: null }),
    });
    renderAt("/niches/tag/Rogue-like?tab=games", ["/niches"]);
    await waitFor(() => expect(screen.getByTestId("loc").textContent).toBe("/niches/tag/Roguelike?tab=games"));
    // Replaced, not pushed: Back goes where the reader came from, not to the old spelling.
    expect(screen.getByTestId("nav-type").textContent).toBe("REPLACE");
    expect((await screen.findByTestId("alias-note")).textContent).toBe(
      "‘Rogue-like’ is now ‘Roguelike’ on Steam — the two spellings are merged into this one niche.",
    );
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Roguelike");
    fireEvent.click(screen.getByText("test-back"));
    await waitFor(() => expect(screen.getByTestId("loc").textContent).toBe("/niches"));
  });
});

describe("Export CSV — this cut's games", () => {
  it("pages the games endpoint with the page's cut, scope and buckets, and downloads the rows", async () => {
    const createObjectURL = vi.fn(() => "blob:test");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL, revokeObjectURL }));
    const clicks: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      clicks.push(this.download);
    });
    stub({
      detail: detailOf([SOULS, { ...SOULS, window: "all", n_games: 812 }]),
      games: (url) => ({
        total: 2,
        items: [
          { appid: 1, name: "=cmd", release_year: 2025, price_initial: 9.99, is_free: 0, est_revenue: 99_900, total_reviews: 333, owners_est: null, positive_ratio: 0.9, live_players: 5 },
          { appid: 2, name: "Two", release_year: 2024, price_initial: 0, is_free: 1, est_revenue: 0, total_reviews: 100, owners_est: null, positive_ratio: 0.8, live_players: null },
        ],
        limit: Number(url.searchParams.get("limit")),
        offset: Number(url.searchParams.get("offset")),
        scope: url.searchParams.get("scope"),
        n_scope_unknown: 0,
      }),
    });
    renderAt("/niches/tag/Souls-like?win=all&tab=games&rev_min=1000&rev_max=10000");
    fireEvent.click(await screen.findByTestId("export-csv"));
    await waitFor(() => expect(screen.getByTestId("export-csv-status").textContent).toBe("Exported 2 indie games."));
    const exportCalls = requested.filter((u) => u.pathname.endsWith("/games") && u.searchParams.get("limit") === "200");
    expect(exportCalls).toHaveLength(1);
    const sp = exportCalls[0].searchParams;
    expect(exportCalls[0].pathname).toBe("/api/niches/tag/Souls-like/games");
    expect(sp.get("win")).toBe("all");
    expect(sp.get("min_reviews")).toBe("50");
    expect(sp.get("scope")).toBe("indie");
    expect(sp.get("rev_min")).toBe("1000");
    expect(sp.get("rev_max")).toBe("10000");
    // Never the niche list's export, and never a substring search on the key.
    expect(requested.some((u) => u.pathname.endsWith("/export.csv") || u.searchParams.has("q"))).toBe(false);
    expect(clicks).toEqual(["souls-like_all_min50_indie_filtered_games.csv"]);
    expect(createObjectURL).toHaveBeenCalledTimes(1);
  });
});

describe("history — a tab, a sort or a page is a step Back undoes", () => {
  it("switching tabs PUSHES a history entry; Back returns to the overview, not off the page", async () => {
    stub({ detail: detailOf([SOULS]) });
    renderAt("/niches/tag/Souls-like", ["/niches"]);
    await screen.findByTestId("radar-dossier");
    fireEvent.click(screen.getByRole("button", { name: "Games & distribution" }));
    await waitFor(() => expect(screen.getByTestId("loc").textContent).toBe("/niches/tag/Souls-like?tab=games"));
    expect(screen.getByTestId("nav-type").textContent).toBe("PUSH");
    fireEvent.click(screen.getByText("test-back"));
    await waitFor(() => expect(screen.getByTestId("loc").textContent).toBe("/niches/tag/Souls-like"));
  });

  it("the scope toggle writes ?scope=all (the default indie leaves the URL clean)", async () => {
    stub({ detail: detailOf([SOULS]) });
    renderAt("/niches/tag/Souls-like?tab=games");
    await screen.findByTestId("radar-dossier");
    fireEvent.click(screen.getAllByRole("button", { name: "All games" })[0]);
    await waitFor(() => expect(screen.getByTestId("loc").textContent).toBe("/niches/tag/Souls-like?tab=games&scope=all"));
    fireEvent.click(screen.getAllByRole("button", { name: "Indie games" })[0]);
    await waitFor(() => expect(screen.getByTestId("loc").textContent).toBe("/niches/tag/Souls-like?tab=games"));
  });
});

describe("hit rates — matching benchmarks, flagged fallbacks", () => {
  function detailed() {
    localStorage.setItem("prospect-detail-view", "detailed");
  }

  it("ticks each bar with the SAME bar for the headline cut — never the catalog's $100K rate", async () => {
    detailed();
    stub({ detail: detailOf([{ ...SOULS, hit_rate_200k: 0.475, hit_rate_500k: 0.33 }]) });
    renderAt("/niches/tag/Souls-like");
    const meter = await screen.findByRole("img", { name: /^Games earning \$200K\+/ });
    expect(meter.getAttribute("aria-label")).toBe("Games earning $200K+: 47.5%; tick: this niche, all time · ≥50 reviews: 47.0%");
    const meter500 = screen.getByRole("img", { name: /^Games earning \$500K\+/ });
    expect(meter500.getAttribute("aria-label")).toContain("tick: this niche, all time · ≥50 reviews: 36.0%");
    expect(screen.queryByText(/clear \$100K \(lower bar, cited for scale\)/)).toBeNull();
  });

  it("flags a fallback headline cut in place", async () => {
    detailed();
    stub({
      detail: detailOf([SOULS], { hit_rates_cut: { window: "all", min_reviews: 0, fallback: true } }),
    });
    renderAt("/niches/tag/Souls-like");
    const line = await screen.findByTestId("hit-rates-cut");
    expect(line.textContent).toContain("all time · every game — too few games for the all-time ≥50-review cut");
  });
});

describe("small helpers", () => {
  it("labels both numbers of a reviews cell", () => {
    expect(reviewsText({ positive_ratio: 0.611, total_reviews: 201_684 })).toBe("61.1% positive · 201,684 reviews");
  });

  it("fills the press timeline's empty months with zeros", () => {
    expect(
      nichePressTimeline([
        { month: "2026-05", n_articles: 3 },
        { month: "2026-08", n_articles: 1 },
      ]),
    ).toEqual([
      { period: "2026-05", n_mentions: 3 },
      { period: "2026-06", n_mentions: 0 },
      { period: "2026-07", n_mentions: 0 },
      { period: "2026-08", n_mentions: 1 },
    ]);
  });
});

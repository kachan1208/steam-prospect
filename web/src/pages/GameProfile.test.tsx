import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import GameProfile from "./GameProfile";
import { ThemeProvider } from "../lib/theme";
import { installChartLayout } from "../test/recharts";

/**
 * Three displayed-number contracts on /games/:appid, all pinned against the LIVE payloads for
 * appid 367520 (Hollow Knight) so a regression has to disagree with production data, not with
 * a fixture someone invented:
 *
 * 1. "In niches" quotes the app-default cut (24m, >=50 reviews) — the cut the niche page it
 *    links to opens on. It used to read variants[0]/the first 24m row, the >=0-reviews cut:
 *    Souls-like showed 57.7 here against 77.3 on /niches/tag/Souls-like, the Niche Finder and
 *    the Radar; Metroidvania showed 58.7 here against 30.1 there.
 * 2. Gross revenue and Units sold come from ONE estimator, so revenue / units === launch price.
 *    The panel used to pair reviews-based revenue ($251,497,872.9) with the owners-based unit
 *    count (7,500,000) at a $14.99 price — $33.53 a copy, under a footnote spelling out the
 *    division.
 * 3. (2026-09-23) Every figure explains itself and no placeholder passes for a value — see the
 *    Estimates, rank, comparables, press, launch-shape and error-state blocks below.
 */

const PROFILE = {
  appid: 367520,
  name: "Hollow Knight",
  release_year: 2017,
  release_date: "2017-02-24",
  price_initial: 14.99,
  is_free: 0,
  primary_genre: "Action",
  developers: "Team Cherry",
  publishers: "Team Cherry",
  self_published: 1,
  is_indie: 1,
  owners_mid: 7_500_000,
  total_reviews: 559_257,
  positive_ratio: 0.9691590807088691,
  est_rev_reviews: 251_497_872.9,
  est_rev_owners: 112_425_000,
  metacritic_score: 87,
  achievements_count: 63,
  avg_playtime_forever: 0,
  header_image: null,
  short_description: "An epic action adventure through a vast ruined kingdom of insects and heroes.",
  rev_pct_in_genre: 99.6,
  reviews_pct_in_genre: 99.8,
  owners_pct_in_genre: 98.9,
  top_tags: ["Metroidvania", "Souls-like", "Platformer"],
  n_reviews_sampled: 22_880,
  n_reviews_first_30d: 0,
  n_reviews_first_90d: 0,
  n_reviews_first_365d: 0,
  n_reviews_trailing_30d: 3_002,
  playtime_p25: 836.75,
  playtime_p50: 2_255,
  playtime_p75: 4_290,
  live_players: 6_679,
  players_7d_avg: 7_677.83,
  players_trend_7d_pct: -3.49,
  first_seen: "2026-07-05T20:32:49.073129+00:00",
  lifetime_alive: true,
  metacritic_url: null,
};

/** GET /api/niches/tag/<key> variants, verbatim, in mart order — the >=0 cut FIRST, which is
 * exactly why matching on window alone picked the wrong population. */
const NICHE_VARIANTS: Record<string, { window: string; min_reviews: number; opportunity_v2: number }[]> = {
  Metroidvania: [
    { window: "24m", min_reviews: 0, opportunity_v2: 58.73 },
    { window: "24m", min_reviews: 50, opportunity_v2: 30.09 },
    { window: "24m", min_reviews: 100, opportunity_v2: 30.16 },
    { window: "all", min_reviews: 50, opportunity_v2: 36.24 },
  ],
  "Souls-like": [
    { window: "24m", min_reviews: 0, opportunity_v2: 57.73 },
    { window: "24m", min_reviews: 50, opportunity_v2: 77.25 },
    { window: "24m", min_reviews: 100, opportunity_v2: 80.52 },
    { window: "all", min_reviews: 50, opportunity_v2: 70.81 },
  ],
  // No >=50 cut materialized — the honest-degrade path.
  Platformer: [{ window: "24m", min_reviews: 0, opportunity_v2: 41.5 }],
};

const TEARDOWN = {
  appid: 367520,
  eligible_reviews: false,
  n_reviews_sampled: 22_880,
  review_aspects: [],
  caveats: [
    "Press coverage is fuzzy-matched (article_game_mentions, confidence-filtered) and skews recent.",
    "Press coverage tone is VADER sentiment of each matched article's headline + short summary.",
  ],
  press: {
    total_mentions: 101,
    n_sources: 6,
    first_seen: "2017-03-06 23:59:53",
    last_seen: "2026-02-05 12:26:12.474",
    by_source: [],
    timeline: [],
    notable: [
      {
        source: "pcgamer",
        title: "Hollow Knight is out",
        author: null,
        published_at: "2017-03-06 23:59:53",
        url: null,
        match_confidence: 0.99,
        is_earliest: true,
        sentiment: "positive",
        sentiment_compound: 0.5,
      },
    ],
    n_pos_articles: 58,
    n_neg_articles: 12,
    n_neutral_articles: 31,
    n_scored_articles: 101,
    press_pos_share: 0.8285714285714286,
    mean_compound: 0.28829405940594055,
  },
};

const BENCHMARKS = {
  cited: {
    median_indie_gross_usd: 249,
    pct_new_releases_over_100k: 0.085,
    bottom_30_pct_gross_usd: 37,
    reviews_1000_revenue_usd: 150_000,
    boxleiter_owners_per_review: { min: 20, mid: 30, max: 55 },
    wishlist_conversion_first_week: 0.1,
    first_week_to_first_year_mult: 5,
    steam_revenue_share_to_dev: 0.7,
    dev_tiers: [],
    opportunity_weights: { demand: 0.5, competition: 0.35, quality_gap: 0.3 },
    revenue_benchmark_marks: [],
  },
};

function renderProfile() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={client}>
      <ThemeProvider>
        <MemoryRouter initialEntries={["/games/367520"]}>
          <Routes>
            <Route path="/games/:appid" element={<GameProfile />} />
          </Routes>
        </MemoryRouter>
      </ThemeProvider>
    </QueryClientProvider>,
  );
}

/** Per-test route overrides, checked before the defaults below: a body to serve as JSON, or
 * a function building the Response (an error status, a network failure). */
type Route = unknown | ((url: string) => Response | Promise<Response>);
let overrides: Array<[RegExp, Route]> = [];
function serve(pattern: RegExp, route: Route) {
  overrides.push([pattern, route]);
}
function failWith(status: number) {
  return () => new Response(JSON.stringify({ detail: "boom" }), { status, headers: { "Content-Type": "application/json" } });
}

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const json = (body: unknown) =>
        new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
      for (const [re, route] of overrides) {
        if (re.test(url)) return typeof route === "function" ? (route as (u: string) => Response)(url) : json(route);
      }

      const niche = url.match(/^\/api\/niches\/tag\/([^?]+)/);
      if (niche) {
        const key = decodeURIComponent(niche[1]);
        return json({
          dimension: "tag",
          key,
          tier: "micro",
          variants: NICHE_VARIANTS[key] ?? [],
          saturation_trend: [],
          revenue_histogram: [],
          representative_games: [],
          players: null,
          themes: [],
          press: null,
          hit_rates: {},
        });
      }
      if (url.startsWith("/api/market/benchmarks")) return json(BENCHMARKS);
      if (url.includes("/teardown")) return json(TEARDOWN);
      if (url.includes("/comparables")) return json({ appid: 367520, primary_genre: "Action", price_band: { low: 9, high: 20 }, items: [] });
      if (url.includes("/reviews-summary")) {
        return json({
          appid: 367520,
          eligible: false,
          timeline: [],
          language_split: [],
          playtime_at_review: [],
          launch_curve: [],
        });
      }
      if (url.includes("/events")) return json({ appid: 367520, items: [] });
      if (url.includes("/channel-mix")) return json({ appid: 367520, channels: [] });
      if (url.startsWith("/api/launch-curve")) return json({ genre: "Action", eligible: false, points: [] });
      if (url.includes("/price-history")) return json({ appid: 367520, items: [], status: "ok" });
      if (url.startsWith("/api/health")) return json({ status: "ok", mart_version: "20260921", built_at: "2026-09-21T22:28:20+00:00", data_as_of: "2026-09-21", source_db: null });
      if (url.match(/^\/api\/games\/367520(\?|$)/)) return json(PROFILE);
      return json({});
    }),
  );
});

/** Undo installChartLayout after each test that drew charts. */
let restoreLayout: (() => void) | null = null;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  overrides = [];
  restoreLayout?.();
  restoreLayout = null;
  try {
    window.localStorage.removeItem("prospect-detail-view");
  } catch {
    // storage unavailable — nothing to reset
  }
});

/** Render with charts that actually draw (a fake ResizeObserver, a fixed box). */
function renderWithCharts() {
  restoreLayout ??= installChartLayout(900, 320);
  return renderProfile();
}

/** Render in the Detailed view, where the chart-heavy cards live. */
function renderDetailed() {
  window.localStorage.setItem("prospect-detail-view", "detailed");
  return renderWithCharts();
}

/** The "In niches" row for a tag: the link's row. */
async function nicheRow(tag: string): Promise<HTMLElement> {
  const link = await screen.findByRole("link", { name: tag });
  return link.parentElement as HTMLElement;
}

describe("GameProfile — In niches quotes the app-default cut", () => {
  it("shows the >=50-reviews score, the one the linked niche page opens on", async () => {
    // Souls-like: 24m/>=50 -> 77.3. The >=0 cut (57.7) and the >=100 cut (80.5) are both wrong.
    renderProfile();
    const row = await nicheRow("Souls-like");
    await waitForText(row, "77.3");
    expect(row.textContent).not.toContain("57.7");
    expect(row.textContent).not.toContain("80.5");
    // Named "Opportunity", never the retired "opp".
    expect(row.textContent).toContain("Opportunity");
    expect(document.body.textContent).not.toMatch(/\bopp \d/);
  });

  it("does not just read high or low — Metroidvania drops from 58.7 to its real 30.1", async () => {
    renderProfile();
    const row = await nicheRow("Metroidvania");
    await waitForText(row, "30.1");
    expect(row.textContent).not.toContain("58.7");
  });

  it("names the cut, and discloses when a niche has no >=50 variant to fall back from", async () => {
    renderProfile();
    expect(await screen.findByText(/On the default cut: games released in the last 24 months, ≥50 reviews/)).toBeTruthy();
    // Platformer only has the >=0 row: it still renders, but says which population it is.
    expect(await screen.findByText(/≥0 reviews — the ≥50 default cut isn't built for this niche/)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/Opportunity v2/);
  });
});

async function waitForText(el: HTMLElement, text: string) {
  for (let i = 0; i < 50 && !(el.textContent ?? "").includes(text); i++) {
    await new Promise((r) => setTimeout(r, 20));
  }
  expect(el.textContent).toContain(text);
}

/** The Estimates row with this test id. */
async function estRow(id: string): Promise<HTMLElement> {
  return screen.findByTestId(id);
}

describe("GameProfile — the Estimates panel prints one estimator", () => {
  it("pairs Est. revenue with the units that revenue implies at the launch price", async () => {
    renderProfile();
    // 559,257 x 30 x $14.99 = $251,497,872.9 -> "$251.5M"; / $14.99 = 16,777,710 -> "16.8M".
    const revenue = await estRow("est-revenue");
    expect(revenue.textContent).toContain("Est. revenue");
    expect(revenue.textContent).toContain("$251.5M");
    const units = await estRow("est-units");
    expect(units.textContent).toContain("Est. units sold");
    expect(units.textContent).toContain("16.8M");
    // The owners figure is still disclosed, named as the other method, with its vintage.
    expect(units.textContent).toContain("Owners (SteamSpy snapshot, date not reported): 7.5M — a different method");
    // The retired names are gone.
    expect(document.body.textContent).not.toMatch(/Gross revenue|Units sold/);
  });

  it("dates the owners figure when the mart stamps its SteamSpy snapshot", async () => {
    serve(/^\/api\/games\/367520(\?|$)/, { ...PROFILE, owners_as_of: "2026-07-07" });
    renderProfile();
    const units = await estRow("est-units");
    expect(units.textContent).toContain("Owners (SteamSpy, as of Jul 7, 2026): 7.5M");
  });

  it("shows the division a reader would do, and the range with its multipliers", async () => {
    renderProfile();
    expect((await estRow("est-units")).textContent).toContain("$251.5M ÷ $14.99 launch price");
    expect((await estRow("est-revenue")).textContent).toContain("range $167.7M – $461.1M (reviews × 20 to × 55 × price)");
  });

  it("works the formula through the game's own numbers in the ⓘ", async () => {
    renderProfile();
    await estRow("est-revenue");
    fireEvent.click(screen.getByRole("button", { name: "About Est. revenue" }));
    const tip = screen.getByRole("tooltip");
    expect(tip.textContent).toContain("reviews × 30 owners-per-review × launch price");
    expect(tip.textContent).toContain("559,257 reviews × 30 × $14.99 = $251.5M");
    expect(tip.textContent).toContain("× 20 = $167.7M … × 55 = $461.1M");
  });
});

/** GET /api/games/{appid} shapes on the 2026-09-23 mart. */
const ZERO_REVIEWS = {
  ...PROFILE,
  total_reviews: 0,
  positive_ratio: null,
  est_rev_reviews: 0,
  owners_mid: null,
  rev_pct_in_genre: null,
  reviews_pct_in_genre: null,
  owners_pct_in_genre: null,
  n_reviews_trailing_30d: 0,
  live_players: null,
  players_trend_7d_pct: null,
  price_initial: 7.99,
  price_status: "paid",
};

describe("GameProfile — placeholders are never shown as values", () => {
  it("a 0-review game says it can't be estimated instead of printing $0.00 and 0 units", async () => {
    serve(/^\/api\/games\/367520(\?|$)/, ZERO_REVIEWS);
    renderProfile();
    const revenue = await estRow("est-revenue");
    expect(revenue.textContent).toContain("Not enough reviews to estimate (0 reviews)");
    expect(revenue.textContent).toContain("not estimated");
    expect(revenue.textContent).not.toMatch(/\$0/);
    const units = await estRow("est-units");
    expect(units.textContent).toContain("not estimated");
    expect(units.textContent).not.toMatch(/^0|\b0\b(?! reviews)/);
    const reviews = await estRow("est-reviews");
    expect(reviews.textContent).toContain("0 reviews");
    expect(reviews.textContent).toContain("no rating yet");
    expect(reviews.textContent).not.toContain("—");
    expect((await estRow("est-players")).textContent).toContain("not measured");
  });

  it("a free-to-play game has no unit sales and no box revenue — not 296.1M units", async () => {
    serve(/^\/api\/games\/367520(\?|$)/, {
      ...PROFILE,
      price_initial: 0,
      is_free: 1,
      price_status: "free",
      est_rev_reviews: null,
      owners_mid: 150_000_000,
      rev_pct_in_genre: null,
    });
    renderProfile();
    const units = await estRow("est-units");
    expect(units.textContent).toContain("Free to play — no unit sales");
    expect(units.textContent).toContain("not applicable");
    expect(units.textContent).not.toContain("16.8M");
    expect(units.textContent).toContain("150.0M"); // the owners figure still reads, as owners
    expect((await estRow("est-revenue")).textContent).toContain("Free to play — no box sales to estimate");
  });

  it("an unknown price is 'Price unknown', not 'Free'", async () => {
    serve(/^\/api\/games\/367520(\?|$)/, { ...PROFILE, price_initial: 0, is_free: 0, price_status: "unknown", est_rev_reviews: null });
    renderProfile();
    const revenue = await estRow("est-revenue");
    expect(revenue.textContent).toContain("Price unknown — the estimate needs a list price");
    expect(revenue.textContent).not.toMatch(/Free/);
  });

  it("a handful of reviews reads '8 reviews · 100% positive' and is flagged a small sample", async () => {
    serve(/^\/api\/games\/367520(\?|$)/, {
      ...PROFILE,
      total_reviews: 8,
      positive_ratio: 1,
      est_rev_reviews: 8 * 30 * 14.99,
      rev_pct_in_genre: null,
      reviews_pct_in_genre: null,
      owners_pct_in_genre: null,
    });
    renderProfile();
    const reviews = await estRow("est-reviews");
    expect(reviews.textContent).toContain("8 reviews · 100% positive");
    expect(reviews.textContent).toContain("small sample");
    expect(reviews.textContent).not.toContain("100.0%");
    expect((await estRow("est-revenue")).textContent).toContain("small sample");
  });

  it("reads the 7-day players trend against the whole of Steam when the mart serves it", async () => {
    serve(/^\/api\/games\/367520(\?|$)/, {
      ...PROFILE,
      live_players: 6041,
      players_trend_7d_pct: -5.75,
      players_trend_7d_market_pct: 0.75,
      players_trend_7d_rel_pct: -6.5,
    });
    renderProfile();
    const players = await estRow("est-players");
    expect(players.textContent).toContain("-5.8% vs the prior 7 days · Steam overall +0.8% → -6.5 pts vs market");
    fireEvent.click(screen.getByRole("button", { name: "About Players now" }));
    expect(screen.getByRole("tooltip").textContent).toContain("-5.8% (this game) − +0.8% (all of Steam) = -6.5 pts");
  });

  it("never quotes a clock-time capture schedule", async () => {
    renderProfile();
    await estRow("est-players");
    fireEvent.click(screen.getByRole("button", { name: "About Players now" }));
    expect(document.body.textContent).not.toMatch(/21:00|21-22:00|UTC/);
  });
});

describe("GameProfile — rank vs genre", () => {
  it("floors the rank, names the 50-review population, and never prints P100", async () => {
    renderProfile();
    expect(await screen.findByText(/Where this game sits among Action games with 50\+ reviews/)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/≥10 reviews|P100/);
    expect(screen.getAllByText("top 1%").length).toBe(2); // 99.6 revenue, 99.8 reviews
    expect(screen.getByText("P98")).toBeTruthy(); // 98.9 owners, floored
  });

  it("marks a missing rank with its reason and draws no median tick on its empty rail", async () => {
    serve(/^\/api\/games\/367520(\?|$)/, ZERO_REVIEWS);
    renderProfile();
    await screen.findByText(/Where this game sits among/);
    const rails = screen.getAllByRole("img").filter((el) => /rank vs|no data/.test(el.getAttribute("aria-label") ?? ""));
    expect(rails.length).toBe(3);
    for (const rail of rails) {
      expect(rail.hasAttribute("data-empty")).toBe(true);
      // The tick at 50 on an empty rail read as "P50".
      expect(rail.querySelector("div")).toBeNull();
    }
    expect(screen.getAllByText("not ranked").length).toBeGreaterThanOrEqual(3);
  });
});

/** GET /api/games/2379780/comparables (Balatro), first rows, plus a free and an unknown price. */
const COMPARABLES = {
  appid: 2379780,
  primary_genre: "Strategy",
  price_band: { low: 5.5, high: 31.98 },
  items: [
    {
      appid: 646570,
      name: "Slay the Spire",
      release_year: 2019,
      price_initial: 24.99,
      is_free: 0,
      owners_mid: 7_500_000,
      total_reviews: 218_661,
      positive_ratio: 0.975,
      est_rev_reviews: 218_661 * 30 * 24.99,
      header_image: null,
      shared_tags: ["Card Game", "Roguelike Deckbuilder", "Deckbuilding", "Singleplayer", "Strategy", "Replay Value", "Rogue-lite", "Turn-Based", "Rogue-like"],
      jaccard: 9 / 11,
    },
    {
      appid: 1,
      name: "Free Cards",
      release_year: 2021,
      price_initial: 0,
      is_free: 1,
      owners_mid: 100_000,
      total_reviews: 4_000,
      positive_ratio: 0.8,
      est_rev_reviews: null,
      header_image: null,
      shared_tags: ["Card Game"],
      jaccard: 0.1,
    },
    {
      appid: 2,
      name: "Delisted Deck",
      release_year: 2018,
      price_initial: 0,
      is_free: 0,
      owners_mid: 50_000,
      total_reviews: 900,
      positive_ratio: 0.7,
      est_rev_reviews: null,
      header_image: null,
      shared_tags: ["Deckbuilding"],
      jaccard: 0.1,
    },
  ],
};

describe("GameProfile — Detailed cards in plain words", () => {
  it("reads playtime as a median and a middle half, not P25 / P50 / P75", async () => {
    serve(/\/reviews-summary/, {
      appid: 1145360,
      eligible: true,
      timeline: [],
      language_split: [],
      playtime_at_review: [
        { pctile: "p10", value: 194 },
        { pctile: "p25", value: 416 },
        { pctile: "p50", value: 1066 },
        { pctile: "p75", value: 2751 },
        { pctile: "p90", value: 5439.4 },
      ],
      launch_curve: [],
    });
    renderDetailed();
    const card = (await screen.findByText("Playtime", { selector: "h5" })).closest(".blueprint") as HTMLElement;
    await waitForText(card, "10% over");
    // 836.75 / 2,255 / 4,290 minutes = 13.9h / 37.6h / 71.5h.
    expect(card.textContent).toContain("Median 37.6h· middle half 13.9h–71.5h");
    expect(card.textContent).toContain("Median 17.8h· middle half 6.9h–45.9h· 10% under 3.2h· 10% over 90.7h");
    expect(card.textContent).not.toMatch(/\bP(10|25|50|75|90)\b/);
  });

  it("names every language in the split and prints its share", async () => {
    serve(/\/reviews-summary/, {
      appid: 1145360,
      eligible: true,
      timeline: [],
      language_split: [
        { language: "english", n: 2400, share: 0.48 },
        { language: "russian", n: 700, share: 0.14 },
        { language: "schinese", n: 600, share: 0.12 },
        { language: "spanish", n: 400, share: 0.08 },
        { language: "koreana", n: 150, share: 0.03 },
      ],
      playtime_at_review: [],
      launch_curve: [],
    });
    const { container } = renderDetailed();
    await screen.findByText("Language split", { selector: "h5" });
    await waitForText(container as HTMLElement, "Korean");
    const card = screen.getByText("Language split", { selector: "h5" }).closest(".blueprint") as HTMLElement;
    const names = Array.from(card.querySelectorAll(".recharts-yAxis .recharts-cartesian-axis-tick-value")).map((t) => t.textContent);
    expect(names).toEqual(["English", "Russian", "Chinese (Simp.)", "Spanish", "Korean"]);
    const shares = Array.from(card.querySelectorAll(".language-share-label text, text.language-share-label")).map((t) => t.textContent);
    expect(shares).toEqual(["48%", "14%", "12%", "8.0%", "3.0%"]);
  });
});

describe("GameProfile — an Early Access graduate's 1.0 on the velocity chart", () => {
  it("marks the 1.0 even when the event feed dropped it (CS2: beta review, then the Aug 2012 launch)", async () => {
    const month = (period: string, n: number) => ({
      period,
      n_reviews: n,
      n_positive: Math.round(n * 0.9),
      cum_reviews: 0,
      cum_positive: 0,
      cum_positive_share: null,
      trailing_reviews: null,
      trailing_positive_share: null,
    });
    serve(/\/reviews-summary/, {
      appid: 730,
      eligible: true,
      timeline: [month("2012-05", 1), month("2012-08", 1838), month("2012-09", 1091), month("2012-10", 570), month("2012-11", 653)],
      language_split: [],
      playtime_at_review: [],
      launch_curve: [],
    });
    serve(/\/events/, { appid: 730, items: [{ event_date: "2012-05-01", kind: "release", title: "Early Access launch (month approximate)", url: null }] });
    serve(/^\/api\/games\/367520(\?|$)/, {
      ...PROFILE,
      release_date: "2012-05-01",
      first_public_date: "2012-05-01",
      release_date_1_0: "2012-08-21",
      is_ea_graduate: true,
      release_date_source: "first_review_month",
    });
    const { container } = renderWithCharts();
    await screen.findByText("Early Access since ~May 2012 · 1.0 on Aug 21, 2012");
    await waitForText(container as HTMLElement, "EA LAUNCH");
    const labels = Array.from(container.querySelectorAll("text.plumb-label")).map((t) => t.textContent?.trim());
    expect(labels).toContain("EA LAUNCH");
    expect(labels.some((l) => l?.startsWith("1.0"))).toBe(true);
    expect(labels.some((l) => /\d{3,}×/.test(l ?? ""))).toBe(false);
  });
});

describe("GameProfile — comparables explain their columns", () => {
  it("names the price band of a game with no list price in words, not as $-0.01–$0.01", async () => {
    serve(/\/comparables/, { ...COMPARABLES, price_band: { low: -0.01, high: 0.01 } });
    renderProfile();
    expect(await screen.findByText(/Same genre \(Strategy\) · free or unknown price, like this game/)).toBeTruthy();
    expect(document.body.textContent).not.toContain("$-0.01");
  });

  it("works the tag overlap through the top row's own tags", async () => {
    serve(/\/comparables/, COMPARABLES);
    renderProfile();
    await screen.findByRole("link", { name: "Slay the Spire" });
    fireEvent.click(screen.getByRole("button", { name: "About Tag overlap" }));
    const tip = screen.getByRole("tooltip");
    expect(tip.textContent).toContain("Jaccard");
    expect(tip.textContent).toContain("Slay the Spire: 9 shared ÷ 11 distinct = 82%");
  });

  it("marks free and unknown-price comparables instead of a bare dash, and never calls $0 'Free' without the flag", async () => {
    serve(/\/comparables/, COMPARABLES);
    renderProfile();
    const free = (await screen.findByRole("link", { name: "Free Cards" })).closest("tr") as HTMLElement;
    expect(free.textContent).toContain("Free");
    expect(free.textContent).toContain("free to play");
    const delisted = screen.getByRole("link", { name: "Delisted Deck" }).closest("tr") as HTMLElement;
    expect(delisted.textContent).toContain("Price unknown");
    expect(delisted.textContent).toContain("no price");
    expect(delisted.textContent).not.toMatch(/Free/);
  });
});

/**
 * Est. revenue and Est. units used to open their own "growth over time" charts — the reviews
 * curve × 30, then × the price: the same shape three times. Only Reviews and Players now open
 * a drilldown now; the others say why they have none.
 */
describe("GameProfile — one growth chart, not three", () => {
  it("opens the reviews drilldown from Reviews, and revenue / units are not clickable", async () => {
    renderProfile();
    await estRow("est-revenue");
    expect(screen.queryByRole("button", { name: "Est. revenue" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Est. units sold" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Reviews" }));
    expect(await screen.findByText("Reviews — growth over time")).toBeTruthy();
    expect(screen.getByText(/Est\. revenue and Est\. units are this same curve × 30/)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/Owners \(est\.\) — growth over time|Est\. revenue — growth over time/);
  });
});

/**
 * The Press & attention card after the 2026-09-23 cleanup: no genre channel mix (press-only
 * since 2026-08-25, so it was always one "Press 100%" bar under copy promising creator
 * channels), no headline-VADER "coverage tone", and every outlet bar labelled.
 */
describe("GameProfile — Press & attention shows the footprint, not the retired reads", () => {
  it("drops the channel mix, the creator copy and every tone read", async () => {
    renderProfile();
    expect(await screen.findByText(/101/, { selector: "span.tabular" })).toBeTruthy();
    const body = document.body.textContent ?? "";
    expect(body).not.toMatch(/Where this genre gets attention/);
    expect(body).not.toMatch(/YouTube|Reddit|Twitch|creator mention/);
    expect(body).not.toMatch(/audience-weighted/);
    expect(body).not.toMatch(/Coverage tone|% positive of 70 rated|Mostly positive|Positive tone|Negative tone/);
    // No request for the retired genre mix either.
    const calls = (fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) => String(c[0]));
    expect(calls.some((u) => u.includes("/channel-mix"))).toBe(false);
  });

  it("states the footprint with its dates in the page's one date format", async () => {
    renderProfile();
    expect(await screen.findByText(/press mentions across/)).toBeTruthy();
    expect(screen.getByText(/Mar 6, 2017 – Feb 5, 2026/)).toBeTruthy();
    expect(document.body.textContent).not.toContain("2017-03-06");
  });

  it("drops the API's press-tone caveat along with the tone read it described", async () => {
    renderProfile();
    expect(await screen.findByText("Read this with caveats")).toBeTruthy();
    expect(screen.getByText(/Press coverage is fuzzy-matched/)).toBeTruthy();
    expect(screen.queryByText(/Press coverage tone is VADER/)).toBeNull();
  });
});

/**
 * The Estimates footnote describes an estimator that is NOT the one running.
 *
 * It read "Gross revenue = reviews x owners-per-review (genre-fitted) x launch price". The
 * multiplier is a flat 30 for every game in the catalog: mart_game.est_rev_reviews is
 * total_reviews x 30 x price_initial (etl/build_marts.py), and the low/high are the same
 * product at the 20 and 55 ends of /api/market/benchmarks' cited band. Verified on the live
 * payload above: 559,257 x 30 x $14.99 = $251,497,872.9, which IS est_rev_reviews to the cent.
 *
 * Genre-fitted multipliers do exist — /api/market/benchmarks' boxleiter_by_genre carries an
 * Action median of 106.99 and a slope of 26.14, and /api/estimate uses them — but neither
 * number reaches this panel. Nothing displayed here is wrong; only the sentence describing it
 * was, and the sentence is what gets fixed. Switching the estimator would move est_rev_reviews
 * under /compare, comparables, mart_niche.median_rev and mart_market at the same time.
 */
describe("GameProfile — the Estimates footnote describes the estimator that actually ran", () => {
  it("states the flat 30 rather than claiming a genre fit that is not applied", async () => {
    renderProfile();
    const note = await screen.findByText(/Est\. revenue = reviews/);
    expect(note.textContent).toContain("reviews × 30 owners-per-review × launch price");
    expect(note.textContent).toMatch(/not fitted per genre/);
    expect(note.textContent).toContain("Est. revenue ÷ launch price = units exactly");
    // The exact false claim, in the wording it shipped in.
    expect(note.textContent).not.toMatch(/owners-per-review \(genre-fitted\)/);
    // The method sits behind a disclosure, not as a screen-long paragraph.
    expect(note.closest("details")).not.toBeNull();
    expect(screen.getByText("How this is estimated")).toBeTruthy();
  });

  it("keeps the revenue arithmetic untouched while the copy changes", async () => {
    renderProfile();
    // Same figures as before the copy fix: 559,257 x 30 x $14.99, and its 20/55 band ends.
    expect((await estRow("est-revenue")).textContent).toContain("$251.5M");
    expect((await estRow("est-revenue")).textContent).toMatch(/\$167\.7M – \$461\.1M/);
  });
});

/** GET /api/launch-curve?genre=Action, median column verbatim (mart 20260921). */
const ACTION_CURVE = {
  genre: "Action",
  points: [
    [7, 0.3],
    [14, 0.38461538461538464],
    [30, 0.48],
    [60, 0.5852713178294574],
    [90, 0.66],
    [180, 0.8088235294117647],
    [365, 1],
  ].map(([day, median]) => ({ day, mean_cum_fraction: median, median_cum_fraction: median, n_games: 23443 })),
};

describe("GameProfile — Launch shape reads per week, with one takeaway", () => {
  it("states the front-loaded pace instead of grading every genre 'Balanced'", async () => {
    serve(/^\/api\/launch-curve/, ACTION_CURVE);
    renderDetailed();
    const headline = await screen.findByTestId("launch-shape-headline");
    expect(headline.textContent).toMatch(
      /^Front-loaded: a typical Action game collects 30% of its first-year reviews in week 1 alone, then 0\.7% a week in months 7–12/,
    );
    expect(document.body.textContent).not.toMatch(/Balanced\./);
    // The caption no longer points at a card that was removed on 2026-09-19.
    expect(document.body.textContent).not.toMatch(/Momentum card/);
    expect(screen.getByText(/Genre median across 23,443 Action titles/)).toBeTruthy();
  });
});

/** GET /api/games/1145360 on the rebuilt (2026-09-23) mart: an Early Access graduate. */
const HADES_DATES = {
  release_date: "2019-12-10",
  first_public_date: "2019-12-10",
  release_date_1_0: "2020-09-17",
  is_ea_graduate: true,
  release_date_source: "first_review",
};

describe("GameProfile — header dates and price read as what they are", () => {
  it("shows an Early Access graduate's EA start and its 1.0", async () => {
    serve(/^\/api\/games\/367520(\?|$)/, { ...PROFILE, ...HADES_DATES });
    renderProfile();
    expect((await screen.findByTestId("launch-dates")).textContent).toBe("Early Access since Dec 10, 2019 · 1.0 on Sep 17, 2020");
  });

  it("prints a month-precision launch as '~Aug 2018'", async () => {
    serve(/^\/api\/games\/367520(\?|$)/, {
      ...PROFILE,
      release_date: "2018-08-01",
      first_public_date: "2018-08-01",
      release_date_1_0: "2025-06-17",
      is_ea_graduate: true,
      release_date_source: "first_review_month",
    });
    renderProfile();
    expect((await screen.findByTestId("launch-dates")).textContent).toBe("Early Access since ~Aug 2018 · 1.0 on Jun 17, 2025");
  });

  it("prints one release date in the page's date format on a mart without the EA columns", async () => {
    renderProfile();
    expect((await screen.findByTestId("launch-dates")).textContent).toBe("Released Feb 24, 2017");
    expect(document.body.textContent).not.toContain("2017-02-24");
  });

  it("says 'Price unknown' — not 'Free' — for a $0 price Steam doesn't call free", async () => {
    serve(/^\/api\/games\/367520(\?|$)/, { ...PROFILE, price_initial: 0, is_free: 0, price_status: "unknown", est_rev_reviews: null });
    renderProfile();
    expect(await screen.findByText("Price unknown")).toBeTruthy();
  });

  it("names our own first sighting as ours, not as a fact about the game", async () => {
    renderProfile();
    expect(await screen.findByText("First seen by Prospect: Jul 5, 2026")).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/in catalog since/);
  });
});

/**
 * A card whose query failed used to render as an empty frame — reviews-summary, comparables,
 * the launch curve and the press card had no error branch at all, and an empty frame reads as
 * "no data here", which is a claim. Every one now says what failed and offers Retry.
 */
describe("GameProfile — every card says when its data failed to load", () => {
  it("shows a retryable error for the review history, comparables, launch curve and press", async () => {
    serve(/\/reviews-summary/, failWith(500));
    serve(/\/comparables/, failWith(500));
    serve(/^\/api\/launch-curve/, failWith(500));
    serve(/\/teardown/, failWith(500));
    renderDetailed();
    expect(await screen.findByText(/Couldn't load the review history/)).toBeTruthy();
    expect(screen.getByText(/Couldn't load comparable games/)).toBeTruthy();
    expect(await screen.findByText(/Couldn't load the genre's launch curve/)).toBeTruthy();
    expect(screen.getByText(/Couldn't load the review aspects/)).toBeTruthy();
    expect(screen.getByText(/Couldn't load the press coverage/)).toBeTruthy();
    expect(screen.getByText(/Couldn't load the language split/)).toBeTruthy();
    // Never the raw exception text.
    expect(document.body.textContent).not.toMatch(/Failed to load review aspects:/);
    expect(screen.getAllByRole("button", { name: "Retry" }).length).toBeGreaterThanOrEqual(5);
  });

  it("recovers on Retry", async () => {
    let fail = true;
    serve(/\/comparables/, () =>
      fail
        ? failWith(500)()
        : new Response(
            JSON.stringify({
              appid: 367520,
              primary_genre: "Action",
              price_band: { low: 9, high: 20 },
              items: [],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
    );
    renderProfile();
    const error = await screen.findByText(/Couldn't load comparable games/);
    fail = false;
    fireEvent.click(within(error.closest("[role=alert]") as HTMLElement).getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("No comparable titles")).toBeTruthy();
    expect(screen.queryByText(/Couldn't load comparable games/)).toBeNull();
  });
});

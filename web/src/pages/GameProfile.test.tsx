import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import GameProfile from "./GameProfile";
import { ThemeProvider } from "../lib/theme";

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
 * 3. The press tone percentage is printed with the base it is actually computed over.
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
  caveats: [],
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

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const json = (body: unknown) =>
        new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });

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
      if (url.match(/^\/api\/games\/367520(\?|$)/)) return json(PROFILE);
      return json({});
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("GameProfile — In niches quotes the app-default cut", () => {
  it("shows the >=50-reviews score, the one the linked niche page opens on", async () => {
    renderProfile();
    // Souls-like: 24m/>=50 -> 77.3. The >=0 cut (57.7) and the >=100 cut (80.5) are both wrong.
    expect(await screen.findByText("opp 77.3")).toBeTruthy();
    expect(screen.queryByText("opp 57.7")).toBeNull();
    expect(screen.queryByText("opp 80.5")).toBeNull();
  });

  it("does not just read high or low — Metroidvania drops from 58.7 to its real 30.1", async () => {
    renderProfile();
    expect(await screen.findByText("opp 30.1")).toBeTruthy();
    expect(screen.queryByText("opp 58.7")).toBeNull();
  });

  it("names the cut, and discloses when a niche has no >=50 variant to fall back from", async () => {
    renderProfile();
    expect(await screen.findByText(/Opportunity v2 on the default cut: last 24 months, ≥50 reviews/)).toBeTruthy();
    // Platformer only has the >=0 row: it still renders, but says which population it is.
    expect(await screen.findByText(/≥0 reviews — the ≥50 default cut isn't built for this niche/)).toBeTruthy();
  });
});

describe("GameProfile — the Estimates panel prints one estimator", () => {
  it("pairs gross revenue with the units that revenue implies at the launch price", async () => {
    renderProfile();
    // 559,257 x 30 x $14.99 = $251,497,872.9 -> "$251.5M"; / $14.99 = 16,777,710 -> "16.8M".
    expect(await screen.findByText("$251.5M")).toBeTruthy();
    expect(await screen.findByText("16.8M")).toBeTruthy();
    // The owners-based count must not be the headline any more...
    expect(screen.queryByText("7.5M")).toBeNull();
    // ...but it is still disclosed, named as the other method.
    expect(await screen.findByText(/owners-based estimate: 7.5M \(different method\)/)).toBeTruthy();
  });

  it("shows the division a reader would do, and says the footnote's formula now holds", async () => {
    renderProfile();
    expect(await screen.findByText(/\$251\.5M ÷ \$14\.99 launch price/)).toBeTruthy();
    expect(
      await screen.findByText(/gross revenue ÷ launch price = units exactly/),
    ).toBeTruthy();
  });
});

describe("GameProfile — press tone percentage and its base agree", () => {
  it("prints the rated base (positive + negative), not the all-scored base", async () => {
    renderProfile();
    // 58 / (58 + 12) = 83%. The old chip said "83% positive · 101 scored", and 58/101 = 57%.
    await waitFor(() => expect(screen.getAllByText(/83% positive of 70 rated/).length).toBeGreaterThan(0));
    expect(screen.queryByText(/83% positive · 101 scored/)).toBeNull();
    expect(await screen.findByText(/31 neutral excluded/)).toBeTruthy();
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
    const note = await screen.findByText(/Gross revenue = reviews/);
    expect(note.textContent).toContain("reviews × 30 owners-per-review × launch price");
    expect(note.textContent).toMatch(/not fitted per genre/);
    // The exact false claim, in the wording it shipped in.
    expect(note.textContent).not.toMatch(/owners-per-review \(genre-fitted\)/);
  });

  it("keeps the revenue arithmetic untouched while the copy changes", async () => {
    renderProfile();
    // Same figures as before the copy fix: 559,257 x 30 x $14.99, and its 20/55 band ends.
    expect(await screen.findByText("$251.5M")).toBeTruthy();
    expect(await screen.findByText(/\$167\.7M – \$461\.1M/)).toBeTruthy();
  });
});

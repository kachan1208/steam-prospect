import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation, useNavigate } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import LaunchTiming from "./LaunchTiming";
import { ThemeProvider } from "../lib/theme";

/**
 * BOTH GENRE SELECTS LIVE IN THE URL (?genre= / ?price_genre=).
 *
 * They were useState, so the reproduction was: set the first select to Strategy — the
 * page correctly refetches (GET /api/timing/overview?genre=Strategy and
 * /api/seasonality?genre=Strategy) — then reload, and both are back on "All genres"
 * with nothing in the address bar to explain what you were looking at.
 *
 * Pinned in both directions: applying a select WRITES the param (that is what you copy),
 * and a fresh mount on that URL asks the API for that genre and shows it selected. The
 * request assertions matter more than the <select> value here — a page could restore the
 * dropdown and still fetch __all__, which is the failure mode that reads as "fixed".
 */

// Recharts' ResponsiveContainer observes its box; jsdom 25 ships no ResizeObserver, so
// the page's charts would throw on mount. Same no-op stand-in NicheDistribution.test.tsx
// uses — nothing under test here reads a measured size.
beforeAll(() => {
  if (typeof globalThis.ResizeObserver === "undefined") {
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  }
});

const GENRE_ROWS = [
  { genre: "__all__" },
  { genre: "Strategy" },
  { genre: "Simulation" },
  { genre: "RPG" },
  { genre: "Indie" },
  { genre: "Action" },
  { genre: "Adventure" },
  { genre: "Casual" },
];

/** Timing sections that render without exercising the chart layer: the overview carries
 * no window recommendation (a stated "no recommendation" paragraph) and empty series. */
const OVERVIEW = {
  genre: "__all__",
  demand: [],
  congestion: [],
  decay: [],
  decay_summary: null,
  window_recommendation: null,
  notes: [],
};

let requests: string[] = [];

function respond(url: string): unknown {
  if (url.includes("/market/benchmarks")) return { boxleiter_by_genre: GENRE_ROWS, tiers: [] };
  if (url.includes("/timing/overview")) return OVERVIEW;
  if (url.includes("/seasonality")) return { genre: "__all__", month_weekday: [], month_year: [] };
  if (url.includes("/launch-curve")) return { genre: "__all__", points: [] };
  if (url.includes("/market/distribution")) {
    return { metric: "price", genre: "__all__", n: 0, buckets: [], percentiles: [], benchmark_marks: [] };
  }
  return {};
}

/** Mirrors the URL back out so the tests can assert what a share-link would carry. */
function LocationProbe() {
  const loc = useLocation();
  return <div data-testid="loc">{`${loc.pathname}${loc.search}`}</div>;
}

function url(): string {
  return screen.getByTestId("loc").textContent ?? "";
}

/** The browser back button, as MemoryRouter can see it (window.history is not its stack). */
function BackProbe() {
  const navigate = useNavigate();
  return (
    <button type="button" data-testid="go-back" onClick={() => navigate(-1)}>
      back
    </button>
  );
}

/** The two genre <select>s, in page order: [timing sections, price distribution]. */
function selects(): HTMLSelectElement[] {
  return screen.getAllByRole("combobox") as HTMLSelectElement[];
}

/** The genre list arrives from /market/benchmarks, and both <select>s render with only
 * "All genres" until it does — changing one before then would silently set "". */
async function readyWithGenres(): Promise<void> {
  await screen.findAllByRole("option", { name: "Strategy" });
  await waitFor(() => expect(selects()).toHaveLength(2));
}

/** Every request this render made against `path`, newest last. */
function requestsFor(path: string): string[] {
  return requests.filter((u) => u.includes(path));
}

function renderTiming(entry = "/timing") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={client}>
      <ThemeProvider>
        <MemoryRouter initialEntries={[entry]}>
          <LaunchTiming />
          <LocationProbe />
          <BackProbe />
        </MemoryRouter>
      </ThemeProvider>
    </QueryClientProvider>,
  );
}

/** What the fetch mock answers — the minimal fixture by default, a realistic one below. */
let responder: (url: string) => unknown = respond;

beforeEach(() => {
  responder = respond;
  requests = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const u = String(input);
      requests.push(u);
      return new Response(JSON.stringify(responder(u)), {
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

describe("LaunchTiming — shareable genre state", () => {
  it("the timing select writes ?genre=; the default view writes nothing", async () => {
    renderTiming();
    await readyWithGenres();
    // Defaults omitted — a pristine /timing stays a clean URL.
    expect(url()).toBe("/timing");

    fireEvent.change(selects()[0], { target: { value: "Strategy" } });
    expect(url()).toBe("/timing?genre=Strategy");

    // Back to All genres and the param drops out rather than lingering as noise.
    fireEvent.change(selects()[0], { target: { value: "__all__" } });
    expect(url()).toBe("/timing");
  });

  it("the price-distribution select writes its own param, independent of the timing one", async () => {
    renderTiming();
    await readyWithGenres();

    fireEvent.change(selects()[1], { target: { value: "RPG" } });
    expect(url()).toBe("/timing?price_genre=RPG");

    fireEvent.change(selects()[0], { target: { value: "Strategy" } });
    // Neither select clobbers the other — one URL carries both readings.
    const u = url();
    expect(u).toContain("price_genre=RPG");
    expect(u).toContain("genre=Strategy");
  });

  it("a fresh mount on ?genre=Strategy ASKS THE API for Strategy and shows it selected", async () => {
    renderTiming("/timing?genre=Strategy");
    await waitFor(() => expect(requestsFor("/timing/overview")).not.toHaveLength(0));

    // The reads that actually changed: both genre-scoped endpoints carry it… (the one other
    // overview read is the whole catalog's, asked on purpose to say whether the genre
    // changed the answer)
    const overviews = requestsFor("/timing/overview");
    expect(overviews.some((u) => u.includes("genre=Strategy"))).toBe(true);
    expect(overviews.every((u) => u.includes("genre=Strategy") || u.includes("genre=__all__"))).toBe(true);
    expect(requestsFor("/seasonality").every((u) => u.includes("genre=Strategy"))).toBe(true);
    // …the price distribution is NOT dragged along by the timing param…
    await waitFor(() => expect(requestsFor("/market/distribution")).not.toHaveLength(0));
    expect(requestsFor("/market/distribution").every((u) => u.includes("genre=__all__"))).toBe(true);
    // …the control agrees with the URL…
    await waitFor(() => expect(selects()[0].value).toBe("Strategy"));
    expect(selects()[1].value).toBe("__all__");
    // …and the card headings name the genre, so the page reads as the shared slice.
    expect(screen.getByText("Best launch windows — Strategy")).toBeTruthy();
  });

  it("a fresh mount on ?price_genre=RPG scopes ONLY the price distribution", async () => {
    renderTiming("/timing?price_genre=RPG");
    await waitFor(() => expect(requestsFor("/market/distribution")).not.toHaveLength(0));

    expect(requestsFor("/market/distribution").every((u) => u.includes("genre=RPG"))).toBe(true);
    expect(requestsFor("/timing/overview").every((u) => u.includes("genre=__all__"))).toBe(true);
    await waitFor(() => expect(selects()[1].value).toBe("RPG"));
    expect(selects()[0].value).toBe("__all__");
  });

  it("reads the genre param verbatim: a real genre lands, an unknown one shows All genres", async () => {
    // Both halves in one test on purpose — the fallback alone would also pass against a
    // page that ignores the param entirely, which is exactly the bug this file exists for.
    const good = renderTiming("/timing?genre=Simulation");
    await readyWithGenres();
    await waitFor(() => expect(selects()[0].value).toBe("Simulation"));
    good.unmount();

    renderTiming("/timing?genre=Wizardry");
    await readyWithGenres();
    // The <select> has no such option, so it must not silently show a blank control.
    expect(selects()[0].value).toBe("__all__");
  });

  it("the selects PUSH — the back button walks the genre history", async () => {
    renderTiming();
    await readyWithGenres();

    fireEvent.change(selects()[0], { target: { value: "Strategy" } });
    fireEvent.change(selects()[0], { target: { value: "Simulation" } });
    expect(url()).toBe("/timing?genre=Simulation");

    fireEvent.click(screen.getByTestId("go-back"));
    await waitFor(() => expect(url()).toBe("/timing?genre=Strategy"));
    await waitFor(() => expect(selects()[0].value).toBe("Strategy"));

    fireEvent.click(screen.getByTestId("go-back"));
    await waitFor(() => expect(url()).toBe("/timing"));
  });
});

// ---- 2026-09-23: every number explains itself -------------------------------------------------

/** GET /api/timing/overview?genre=__all__ on the 2026-09-23 mart: [month, demand_share,
 * demand_index, avg_releases, avg_big_releases, congestion_index, score]. */
const MONTHS: [number, number, number, number, number, number, number][] = [
  [1, 0.09304, 1.1165, 1068.0, 64.33, 0.8146, 0.3019],
  [2, 0.0766, 0.9192, 1136.33, 65.33, 0.8668, 0.0525],
  [3, 0.07993, 0.9591, 1330.0, 81.67, 1.0145, -0.0554],
  [4, 0.07216, 0.8659, 1258.33, 84.67, 0.9598, -0.0939],
  [5, 0.07753, 0.9303, 1300.67, 88.0, 0.9921, -0.0618],
  [6, 0.07715, 0.9258, 1243.33, 69.0, 0.9484, -0.0225],
  [7, 0.09244, 1.1093, 1346.33, 73.33, 1.027, 0.0824],
  [8, 0.07974, 0.9569, 1350.67, 83.67, 1.0303, -0.0734],
  [9, 0.06995, 0.8394, 1238.67, 98.0, 0.9448, -0.1055],
  [10, 0.07186, 0.8623, 1540.33, 99.33, 1.1749, -0.3126],
  [11, 0.11196, 1.3435, 1547.67, 97.0, 1.1805, 0.163],
  [12, 0.09764, 1.1717, 1371.67, 52.67, 1.0463, 0.1254],
];
const MONTH_REVIEWS = [
  7971425, 6563122, 6847749, 6182287, 6642327, 6610157, 7920260, 6831719, 5992796, 6156749, 9592180, 8365219,
];
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function realOverview(genre: string, best: number[]) {
  return {
    genre,
    demand: MONTHS.map(([m, share], i) => ({ month: m, demand_share: share, month_reviews: MONTH_REVIEWS[i], n_games: 33092 })),
    congestion: MONTHS.map(([m, , , avg, big]) => ({ month: m, avg_releases: avg, avg_big_releases: big, n_years: 3 })),
    decay: [0.1987, 0.0882, 0.0499, 0.0385].map((s, i) => ({ month_since_release: i, median_share: s, mean_share: s, n_games: 25237 })),
    decay_summary: { first_3_months_share: 0.4201, first_6_months_share: 0.5454, first_12_months_share: 0.7292, n_games: 25237 },
    window_recommendation: {
      best_months: best,
      best_month_names: best.map((m) => MONTH_NAMES[m - 1]),
      rationale: `${best.map((m) => MONTH_NAMES[m - 1]).join(", ")} look like the best windows (~1,068 January releases per year).`,
      method: "score = demand_share/(1/12) - avg_releases/mean(avg_releases)",
      months: MONTHS.map(([m, share, di, avg, big, ci, score]) => ({
        month: m,
        month_name: MONTH_NAMES[m - 1],
        demand_share: share,
        demand_index: di,
        avg_releases: avg,
        avg_big_releases: big,
        congestion_index: ci,
        score,
      })),
    },
    notes: [],
  };
}

/** GET /api/market/distribution?metric=price (2026-09-23): gaps above $50 and a lone $1,900. */
const PRICE = {
  metric: "price",
  genre: "__all__",
  window: "all",
  n: 95757,
  buckets: [
    [0, 17656],
    [2.5, 28377],
    [5, 8905],
    [7.5, 16790],
    [10, 2768],
    [12.5, 7956],
    [17.5, 6354],
    [57.5, 333],
    [87.5, 7],
    [107.5, 3],
    [1900, 1],
  ].map(([x, count], i) => ({ bucket_index: i, x_min: x, x_max: x + 2.5, count })),
  percentiles: [
    ["p10", 1.99],
    ["p25", 2.99],
    ["p50", 5.99],
    ["p75", 10.99],
    ["p90", 19.99],
    ["p95", 24.99],
    ["p99", 49.99],
  ].map(([pctile, value]) => ({ pctile, value })),
  benchmark_marks: [{ label: "$9.99", value: 9.99, cite: "common indie price point" }],
};

function realResponder(bestByGenre: Record<string, number[]>) {
  return (u: string): unknown => {
    if (u.includes("/timing/overview")) {
      const genre = new URL(u, "http://x").searchParams.get("genre") ?? "__all__";
      return realOverview(genre, bestByGenre[genre] ?? bestByGenre.__all__);
    }
    if (u.includes("/market/distribution")) return PRICE;
    if (u.includes("/seasonality")) {
      return {
        genre: "__all__",
        month_weekday: [
          // weekday is DuckDB's dayofweek: 0 = Sunday.
          { genre: "__all__", month: 1, weekday: 0, year: null, n_releases: 453, n_scored: 12, median_rev: 17_595.9, median_reviews: 90, median_positive_ratio: 0.8 },
          { genre: "__all__", month: 1, weekday: 2, year: null, n_releases: 1315, n_scored: 430, median_rev: 114_183.15, median_reviews: 178, median_positive_ratio: 0.8 },
        ],
        month: [],
        weekday: [],
        year: [],
      };
    }
    return respond(u);
  };
}

describe("LaunchTiming — every number explains itself", () => {
  it("works the window score through its parts, instead of printing the formula as code", async () => {
    responder = realResponder({ __all__: [1, 11, 12] });
    renderTiming();
    const tips = await screen.findAllByRole("button", { name: "About Window score" });
    // The formula printed as a code line is gone…
    expect(document.body.textContent).not.toContain("demand_share/(1/12)");
    // …and the ⓘ carries it in words, with January's own numbers.
    fireEvent.click(tips[0]);
    const tip = await screen.findByRole("tooltip");
    expect(tip.textContent).toContain("Buying index − Crowding index");
    // The arithmetic adds up AS PRINTED: 1.12 − 0.81 = +0.31 (the exact 1.1165 − 0.8146 =
    // 0.3019 would print "+0.30" beside two indices that subtract to 0.31).
    expect(tip.textContent).toContain(
      "Jan: buying 9.3% ÷ 8.33% = 1.12; crowding 1,068 ÷ 1,311 = 0.81; score 1.12 − 0.81 = +0.31",
    );
  });

  it("warns that Nov and Dec are Steam sale season — bearish reading first", async () => {
    responder = realResponder({ __all__: [1, 11, 12] });
    renderTiming();
    const caveat = await screen.findByTestId("sale-season-caveat");
    expect(caveat.textContent).toContain("Jan, Nov and Dec are Steam sale season");
    expect(caveat.textContent).toContain("Autumn Sale");
    expect(caveat.textContent).toContain("Winter Sale");
    expect(caveat.textContent).toMatch(/expect a launch discount/);
    // It comes BEFORE the recommendation's rationale.
    const text = document.body.textContent ?? "";
    expect(text.indexOf("Steam sale season")).toBeLessThan(text.indexOf("look like the best windows"));
  });

  it("says so when a genre filter doesn't change the answer", async () => {
    responder = realResponder({ __all__: [1, 11, 12], Indie: [12, 1, 11], Strategy: [2, 3, 9] });
    renderTiming("/timing?genre=Indie");
    const same = await screen.findByTestId("genre-same-answer");
    expect(same.textContent).toContain("Same months as the whole catalog.");
    expect(same.textContent).toContain("For Indie, the genre filter moves the numbers, not the answer");
    cleanup();
    renderTiming("/timing?genre=Strategy");
    const differs = await screen.findByTestId("genre-same-answer");
    expect(differs.textContent).toContain("Differs from the whole catalog, whose best months are Jan, Nov and Dec.");
  });

  it("puts Steam's event calendar on the month charts, clearly approximate", async () => {
    responder = realResponder({ __all__: [1, 11, 12] });
    renderTiming();
    await screen.findByTestId("sale-season-caveat");
    const strips = screen.getAllByTestId("steam-events");
    expect(strips.length).toBeGreaterThanOrEqual(3); // score, buying, crowding
    const strip = strips[0];
    expect(strip.textContent).toContain("Steam events, approximate");
    expect(strip.textContent).toContain("Steam Next Fest");
    expect(strip.querySelector('[data-event="fest-2"]')).not.toBeNull();
    expect(strip.querySelector('[data-event="sale-11"]')).not.toBeNull();
    expect(strip.querySelector('[data-event="sale-4"]')).toBeNull();
  });

  it("splits crowding into two single-axis charts and leads each section with a takeaway", async () => {
    responder = realResponder({ __all__: [1, 11, 12] });
    renderTiming();
    expect((await screen.findByTestId("crowding-takeaway")).textContent).toContain(
      "Nov is the most crowded (~1,548 releases a year, ~97 of them reaching $200K+); Jan the calmest (~1,068).",
    );
    expect(screen.getByTestId("demand-takeaway").textContent).toContain(
      "Nov is the busiest buying month (11.2% of the year, 1.34× an average month); Sep the quietest (7.0%).",
    );
    expect(screen.getByRole("button", { name: "About Releases per month" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "About $200K+ releases per month" })).toBeTruthy();
    // The dual-axis wording is gone.
    expect(document.body.textContent).not.toContain("on the right axis");
  });

  it("names price percentiles in plain words and says what the axis leaves out", async () => {
    responder = realResponder({ __all__: [1, 11, 12] });
    renderTiming();
    expect((await screen.findByTestId("price-takeaway")).textContent).toBe(
      "Half of paid games cost $5.99 or less; only 1 in 10 costs $19.99 or more.",
    );
    const text = document.body.textContent ?? "";
    expect(text).toContain("Cheapest 10%:");
    expect(text).toContain("Dearest 1%:");
    expect(text).not.toMatch(/\bP(10|25|50|75|90|95|99)\b/);
    // The tail past the drawn axis is counted in words, not stretched across it.
    expect(text).toContain("Not drawn: 11 games priced $70.00 or more");
    expect(text).toContain("the dearest at about $1,900");
  });

  it("gives the heatmap legend real values and a weekday grid that starts on Monday", async () => {
    responder = realResponder({ __all__: [1, 11, 12] });
    renderTiming();
    const legend = await screen.findByTestId("heatmap-legend");
    expect(legend.textContent).toContain("$17.6K");
    expect(legend.textContent).toContain("$114.2K");
    expect(legend.textContent).not.toContain("Low");
    // DuckDB weekday 0 is SUNDAY: the thin-sample cell is a Sunday, and says so.
    expect(screen.getByLabelText(/^Jan Sun: Median revenue \$17\.6K, 12 games with 50\+ reviews \(small sample\)$/)).toBeTruthy();
    expect(screen.getByLabelText(/^Jan Tue: Median revenue \$114\.2K/)).toBeTruthy();
  });
});

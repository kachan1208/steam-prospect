import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import type { PricePoint } from "../../lib/api";
import { ZoomRangeProvider } from "../../lib/zoomRange";
import { installChartLayout } from "../../test/recharts";
import {
  PriceHistoryChart,
  dayMs,
  discountLabel,
  priceChangeSummary,
  priceSeriesState,
  priceSteps,
  timeTicks,
} from "./PriceHistoryChart";

function point(overrides: Partial<PricePoint> = {}): PricePoint {
  return {
    captured_on: "2026-08-24",
    final_cents: 3999,
    original_cents: null,
    discount_pct: 0,
    is_free: false,
    country: "US",
    ...overrides,
  };
}

/** GET /api/games/292030/price-history (The Witcher 3), verbatim — the collector writes a row
 * only when Steam's price-change counter moves, so this is the whole series. */
const WITCHER3: PricePoint[] = [
  point({ captured_on: "2026-08-24", final_cents: 3999 }),
  point({ captured_on: "2026-08-26", final_cents: 4999 }),
];

describe("priceSeriesState — one record is a sentence, two are a chart", () => {
  it("empty series -> 'empty'", () => {
    expect(priceSeriesState([])).toBe("empty");
  });

  it("records with no plottable price -> 'empty', not a chart of nothing", () => {
    expect(priceSeriesState([point({ final_cents: null })])).toBe("empty");
  });

  it("one record -> 'single' (no change since tracking began), not a lone dot", () => {
    expect(priceSeriesState([point()])).toBe("single");
  });

  it("two or more records -> 'line'", () => {
    expect(priceSeriesState(WITCHER3)).toBe("line");
  });

  it("free to play (latest record) -> 'free', regardless of depth", () => {
    expect(priceSeriesState([point({ final_cents: null, is_free: true })])).toBe("free");
    expect(priceSeriesState([point(), point({ captured_on: "2026-08-25", final_cents: null, is_free: true })])).toBe("free");
  });
});

describe("priceSteps — a step series on real time", () => {
  it("carries the last price to the as-of day so the line reaches the right edge", () => {
    const steps = priceSteps(WITCHER3, "2026-09-21");
    expect(steps.map((s) => [s.captured_on, s.usd, s.carried ?? false])).toEqual([
      ["2026-08-24", 39.99, false],
      ["2026-08-26", 49.99, false],
      ["2026-09-21", 49.99, true],
    ]);
    // Real day spacing: Aug 24 -> Aug 26 is 2 days, Aug 26 -> Sep 21 is 26 — not two equal steps.
    expect((steps[1].t - steps[0].t) / 86_400_000).toBe(2);
    expect((steps[2].t - steps[1].t) / 86_400_000).toBe(26);
  });

  it("adds no endpoint when the data is no newer than the last record", () => {
    expect(priceSteps(WITCHER3, "2026-08-26")).toHaveLength(2);
    expect(priceSteps(WITCHER3, null)).toHaveLength(2);
  });
});

describe("priceChangeSummary", () => {
  it("names each change with its date in the page's date format", () => {
    expect(priceChangeSummary(priceSteps(WITCHER3, "2026-09-21"))).toBe("1 change: $39.99 → $49.99 on Aug 26, 2026.");
  });

  it("marks a sale as a sale", () => {
    const sale = [point({ final_cents: 2999 }), point({ captured_on: "2026-09-01", final_cents: 1499, original_cents: 2999, discount_pct: 50 })];
    expect(priceChangeSummary(priceSteps(sale, null))).toBe("1 change: $29.99 → $14.99 (−50% sale) on Sep 1, 2026.");
  });

  it("summarises a long run by its low and its latest price", () => {
    const days = ["2026-08-24", "2026-09-01", "2026-09-08", "2026-09-15", "2026-09-22"];
    const cents = [2999, 1499, 2999, 999, 2999];
    const rows = days.map((d, i) => point({ captured_on: d, final_cents: cents[i], discount_pct: cents[i] < 2999 ? 50 : 0 }));
    expect(priceChangeSummary(priceSteps(rows, null))).toBe(
      "4 changes; lowest $9.99 (−50% sale) on Sep 15, 2026; latest $29.99 since Sep 22, 2026.",
    );
  });
});

describe("timeTicks", () => {
  it("ticks weekly across a month-long history", () => {
    const t = timeTicks(dayMs("2026-08-24"), dayMs("2026-09-21"));
    expect(t.ticks.map(t.format)).toEqual(["Aug 24", "Aug 31", "Sep 7", "Sep 14", "Sep 21"]);
  });

  it("ticks on month starts across a longer history", () => {
    const t = timeTicks(dayMs("2026-08-24"), dayMs("2027-01-10"));
    expect(t.ticks.map(t.format)).toEqual(["Sep 2026", "Oct 2026", "Nov 2026", "Dec 2026", "Jan 2027"]);
  });
});

describe("discountLabel — tooltip emphasis row", () => {
  it("undiscounted record -> null (no row)", () => {
    expect(discountLabel(point())).toBeNull();
  });

  it("discounted record -> '−N% (was $X)'", () => {
    expect(discountLabel(point({ final_cents: 1999, original_cents: 3999, discount_pct: 50 }))).toBe("−50% (was $39.99)");
  });

  it("discount without a recorded original price omits the 'was' clause", () => {
    expect(discountLabel(point({ final_cents: 1999, original_cents: null, discount_pct: 50 }))).toBe("−50%");
  });
});

// ---- rendered states ------------------------------------------------------------------------

type Body = { status: number; json: unknown } | "network";
let priceBody: Body = { status: 200, json: { appid: 1, items: [], status: "ok" } };

function renderChart(props: { priceInitial?: number | null; isFree?: number | null } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <ZoomRangeProvider>
          <PriceHistoryChart
            appid={1}
            priceInitial={"priceInitial" in props ? (props.priceInitial ?? null) : 14.99}
            isFree={props.isFree ?? 0}
          />
        </ZoomRangeProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

let restore: () => void;
beforeEach(() => {
  restore = installChartLayout(800, 200);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const json = (status: number, body: unknown) =>
        new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
      if (url.startsWith("/api/health")) {
        return json(200, { status: "ok", mart_version: "20260921", built_at: "2026-09-21T22:28:20+00:00", data_as_of: "2026-09-21", source_db: null });
      }
      if (url.includes("/price-history")) {
        if (priceBody === "network") throw new TypeError("Failed to fetch");
        return json(priceBody.status, priceBody.json);
      }
      return json(404, { detail: "not stubbed" });
    }),
  );
});
afterEach(() => {
  cleanup();
  restore();
  vi.unstubAllGlobals();
  priceBody = { status: 200, json: { appid: 1, items: [], status: "ok" } };
});

describe("PriceHistoryChart — rendered", () => {
  it("says 'no change since tracking began' for a single record, with no lone dot", async () => {
    priceBody = { status: 200, json: { appid: 1, items: [point({ final_cents: 1499 })], status: "ok" } };
    const { container } = renderChart();
    const line = await screen.findByTestId("price-single");
    expect(line.textContent).toContain("No price change since tracking began (Aug 24, 2026): $14.99");
    expect(container.querySelector(".recharts-wrapper")).toBeNull();
    expect(container.textContent).not.toMatch(/builds daily/);
  });

  it("draws a step line on a time axis from the first record to the as-of date", async () => {
    priceBody = { status: 200, json: { appid: 292030, items: WITCHER3, status: "ok" } };
    const { container } = renderChart({ priceInitial: 39.99 });
    const summary = await screen.findByTestId("price-summary");
    expect(summary.textContent).toContain("Price changes since Aug 24, 2026");
    expect(summary.textContent).toContain("1 change: $39.99 → $49.99 on Aug 26, 2026.");
    expect(await screen.findByText(/No change since, through Sep 21, 2026/)).toBeTruthy();
    const ticks = Array.from(container.querySelectorAll(".recharts-xAxis .recharts-cartesian-axis-tick-value")).map((t) =>
      t.textContent?.trim(),
    );
    expect(ticks[0]).toBe("Aug 24");
    expect(ticks).toContain("Sep 21");
    // One path, drawn as steps: every segment is horizontal or vertical, never a slope.
    const d = container.querySelector(".recharts-line-curve")?.getAttribute("d") ?? "";
    const pts = [...d.matchAll(/([\d.]+),([\d.]+)/g)].map((m) => [Number(m[1]), Number(m[2])]);
    expect(pts.length).toBeGreaterThanOrEqual(4);
    for (let i = 1; i < pts.length; i++) {
      const [x0, y0] = pts[i - 1];
      const [x1, y1] = pts[i];
      expect(Math.abs(x1 - x0) < 1e-6 || Math.abs(y1 - y0) < 1e-6).toBe(true);
    }
    // ...and on a time axis: the Aug 26 step sits 2/28 of the way across, not halfway.
    const xs = [...new Set(pts.map(([x]) => x))].sort((a, b) => a - b);
    const frac = (xs[1] - xs[0]) / (xs[xs.length - 1] - xs[0]);
    expect(frac).toBeCloseTo(2 / 28, 2);
  });

  it("tells a missing price store apart from an empty one", async () => {
    priceBody = { status: 200, json: { appid: 1, items: [], status: "missing" } };
    renderChart();
    expect(await screen.findByText("Price tracking isn't running here")).toBeTruthy();
    expect(screen.queryByText(/No price recorded yet/)).toBeNull();
  });

  it("says 'unavailable', not 'no history', when the store can't be read", async () => {
    priceBody = { status: 200, json: { appid: 1, items: [], status: "unavailable" } };
    renderChart();
    expect(await screen.findByText("Price history unavailable")).toBeTruthy();
  });

  it("says the collector hasn't reached the game only when the store answered with nothing", async () => {
    priceBody = { status: 200, json: { appid: 1, items: [] } }; // pre-status API: reads as "ok"
    renderChart({ priceInitial: null, isFree: 0 });
    expect(await screen.findByText("No price recorded yet")).toBeTruthy();
    expect(screen.getByText(/Catalog list price: Price unknown/)).toBeTruthy();
  });

  it("shows a retryable error when the request fails, never an empty state", async () => {
    priceBody = { status: 500, json: { detail: "boom" } };
    renderChart();
    // One transient retry first (retryTransientOnce), then the error.
    expect(await screen.findByText(/Couldn't load the price history/, undefined, { timeout: 4000 })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(screen.queryByText(/No price recorded yet/)).toBeNull();
  });
});

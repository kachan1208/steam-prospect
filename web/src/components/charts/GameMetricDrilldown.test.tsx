import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { DRILLDOWN_META, GameMetricDrilldown } from "./GameMetricDrilldown";
import { axisTicks, installChartLayout } from "../../test/recharts";
import { ZoomRangeProvider } from "../../lib/zoomRange";

/** GET /api/games/1145360/trends and /players (Hades, mart 2026-09-23), trimmed. */
const TRENDS = {
  appid: 1145360,
  eligible: true,
  comps: null,
  points: [
    { period: "2026-05", n_reviews: 2600, ccu_avg: 4200 },
    { period: "2026-06", n_reviews: 2400, ccu_avg: 4100 },
    // 2026-07 skipped on purpose: the chart must still give it a slot.
    { period: "2026-08", n_reviews: 1323, ccu_avg: 3700 },
    { period: "2026-09", n_reviews: 610, ccu_avg: 2867 },
  ],
};
const PLAYERS = {
  appid: 1145360,
  days: 90,
  available: true,
  summary: {
    live_players: 2614,
    players_7d_avg: 2869.4,
    players_trend_7d_pct: 0.36,
    players_trend_7d_market_pct: 0.75,
    players_trend_7d_rel_pct: -0.39,
    n_days_measured: 49,
    first_date: "2026-07-18",
    last_date: "2026-09-21",
  },
  points: [
    { date: "2026-09-19", players: 3147 },
    { date: "2026-09-20", players: 3179 },
    { date: "2026-09-21", players: 2614 },
  ],
  monthly: [],
  data_as_of: "2026-09-21",
};

function renderDrill(metric: "reviews" | "live_players") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <ZoomRangeProvider>
          <GameMetricDrilldown
            appid={1145360}
            metric={metric}
            profile={{ total_reviews: 308_657, live_players: 2614 }}
            asOf={new Date(Date.UTC(2026, 8, 23))}
          />
        </ZoomRangeProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

let restore: () => void;
beforeEach(() => {
  restore = installChartLayout(900, 300);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const body = url.includes("/players") ? PLAYERS : url.includes("/trends") ? TRENDS : {};
      return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    }),
  );
});
afterEach(() => {
  cleanup();
  restore();
  vi.unstubAllGlobals();
});

describe("GameMetricDrilldown — one growth chart, not three", () => {
  it("offers only reviews and players; revenue and owners were the reviews curve × a constant", () => {
    expect(Object.keys(DRILLDOWN_META).sort()).toEqual(["live_players", "reviews"]);
    expect(DRILLDOWN_META.reviews.subtitle).toMatch(/Est\. revenue and Est\. units are this same curve × 30/);
  });

  it("fills the skipped month, hatches the partial one, and keeps one unit per axis", async () => {
    const { container } = renderDrill("reviews");
    await screen.findByText("Reviews added / month");
    const fills = Array.from(container.querySelectorAll(".recharts-bar-rectangle path")).map((p) => p.getAttribute("fill") ?? "");
    // May, Jun, (Jul = 0, not drawn), Aug, Sep — the last one hatched.
    expect(fills[fills.length - 1]).toMatch(/^url\(#drill-hatch-/);
    expect(Array.from(container.querySelectorAll("text.partial-month-label")).map((t) => t.textContent)).toEqual(["partial"]);
    const xTicks = axisTicks(container, "x", 1);
    expect(xTicks[0]).toBe("May 2026");
    // Monthly axis: one vocabulary (no "9,000" beside "18.0K").
    const yTicks = axisTicks(container, "y", 1);
    const kinds = new Set(yTicks.filter((t) => t !== "0").map((t) => (/K$/.test(t) ? "K" : /,/.test(t) ? "comma" : "plain")));
    expect(kinds.size).toBe(1);
    expect(screen.getByText(/Sep 2026 is a partial month — data through Sep 23, 2026 \(23 of 30 days\)/)).toBeTruthy();
  });

  it("reads the players trend against Steam and dates the series from its own as-of, no clock time", async () => {
    renderDrill("live_players");
    expect(await screen.findByText(/Steam overall \+0\.8% → -0\.4 pts vs market/)).toBeTruthy();
    expect(screen.getByText(/The series runs to Sep 21, 2026, the latest capture day/)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/UTC|21-22:00|nightly capture \(/);
  });
});

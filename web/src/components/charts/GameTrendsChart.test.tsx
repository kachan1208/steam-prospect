import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";

import { GameTrendsChart } from "./GameTrendsChart";
import { ZoomRangeProvider } from "../../lib/zoomRange";
import { installChartLayout } from "../../test/recharts";

/**
 * React #310 on /games/1867240 (2026-09-11): useDragZoom sat BELOW the chart's early returns,
 * so a render that returned "No monthly trend data" ran one hook fewer than the render after
 * the series arrived, and the error boundary replaced the whole game page. A fresh release is
 * exactly that sequence — empty series first, data later — so it is the sequence pinned here.
 */

const points = ["2026-06", "2026-07", "2026-08"].map((period, i) => ({
  period,
  n_reviews: 100 + i * 40,
  ccu_avg: null,
}));

let restore: () => void;
beforeEach(() => {
  restore = installChartLayout(900, 260);
});
afterEach(() => {
  cleanup();
  restore();
});

function wrap(ui: React.ReactNode, client: QueryClient) {
  return (
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <ZoomRangeProvider>{ui}</ZoomRangeProvider>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe("GameTrendsChart", () => {
  it("survives going from no series to a series (the #310 sequence)", () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { rerender } = render(wrap(<GameTrendsChart appid={1867240} points={[]} />, client));
    expect(screen.getByText(/No monthly trend data/)).toBeTruthy();

    rerender(wrap(<GameTrendsChart appid={1867240} points={points} />, client));
    expect(screen.queryByText(/No monthly trend data/)).toBeNull();
    expect(screen.getByText(/Sampled reviews/)).toBeTruthy();
  });

  it("and back again", () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { rerender } = render(wrap(<GameTrendsChart appid={1867240} points={points} />, client));
    rerender(wrap(<GameTrendsChart appid={1867240} points={[]} />, client));
    expect(screen.getByText(/No monthly trend data/)).toBeTruthy();
  });
});

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

/**
 * Catalog plumb lines carry the shared label treatment (lib/notable.ts + plumbLabels.tsx);
 * the org's own marketing labels keep their rows ABOVE the catalog rows so a month with both
 * never stacks two labels. Self-fetching mode, with every query seeded so nothing is fetched.
 */
describe("GameTrendsChart — catalog and marketing labels share the band", () => {
  const APPID = 4242;
  const VALUES = [50, 50, 50, 50, 200, 50, 50, 50, 10, 50, 50, 50];
  const trend = VALUES.map((n, i) => ({ period: `2020-${String(i + 1).padStart(2, "0")}`, n_reviews: n, ccu_avg: null }));

  /** Where a label's baseline lands, in SVG px from the chart's top edge. */
  const baseline = (text: Element) => Number(text.getAttribute("y")) + Number(text.getAttribute("dy") ?? 0);

  function renderSeeded(marketing: boolean) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(["game-trends", APPID], { appid: APPID, eligible: true, points: trend, comps: null });
    client.setQueryData(["game-catalog-events", APPID], [
      { event_date: "2020-01-10", kind: "release", title: "Released", url: null },
      { event_date: "2020-11-03", kind: "update", title: "Patch 1.1", url: null },
    ]);
    client.setQueryData(
      ["game-events", APPID],
      marketing ? [{ id: 1, appid: APPID, event_date: "2020-05-12", kind: "trailer", note: "launch trailer" }] : [],
    );
    return render(wrap(<GameTrendsChart appid={APPID} />, client));
  }

  it("labels every catalog line and explains them in the legend", () => {
    const { container } = renderSeeded(false);
    const labels = Array.from(container.querySelectorAll("text.plumb-label")).map((t) => t.textContent?.trim());
    // Release, the 4x spike, the 0.2x drop (sparse feed: every change), the update month.
    expect(labels).toEqual(["RELEASED", "▲ 4.0×", "▼ 0.2×", "UPDATE"]);
    expect(screen.getByText(/Release · catalog events · months that move ≥1\.75×/)).toBeTruthy();
    expect(screen.queryByText("Marketing event")).toBeNull();
  });

  it("keeps the marketing label above the catalog labels", () => {
    const { container } = renderSeeded(true);
    const catalog = Array.from(container.querySelectorAll("text.plumb-label")).map(baseline);
    expect(catalog.length).toBe(4);
    const marketing = screen.getByText("Trailer").closest("text");
    expect(marketing).not.toBeNull();
    expect(baseline(marketing!)).toBeLessThan(Math.min(...catalog));
    expect(baseline(marketing!)).toBeGreaterThanOrEqual(9); // still inside the SVG
    expect(screen.getByText("Marketing event")).toBeTruthy();
  });
});

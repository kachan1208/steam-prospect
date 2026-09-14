import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";

import { ReviewsTimelineChart } from "./ReviewsTimelineChart";
import { ZoomRangeProvider } from "../../lib/zoomRange";
import { installChartLayout } from "../../test/recharts";
import type { GameEvent, ReviewTimelinePoint } from "../../lib/api";

/**
 * The volume panel's plumb lines go through the same label treatment as the velocity chart
 * (lib/notable.ts + plumbLabels.tsx): every line labelled, inside the band, legend under it.
 * The catalog events come from react-query, seeded here so nothing is fetched.
 */

const APPID = 4242;

// Flat 50/month from 2020, one spike, one event-only month, release first.
const VALUES = [50, 50, 50, 50, 200, 50, 50, 50, 50, 50, 50, 50];
const POINTS: ReviewTimelinePoint[] = VALUES.map((n, i) => ({
  period: `2020-${String(i + 1).padStart(2, "0")}`,
  n_reviews: n,
  n_positive: Math.round(n * 0.8),
  cum_reviews: 0,
  cum_positive: 0,
  cum_positive_share: 0.8,
  trailing_reviews: n,
  trailing_positive_share: 0.8,
}));

const CATALOG: GameEvent[] = [
  { event_date: "2020-01-10", kind: "release", title: "Released", url: null },
  { event_date: "2020-08-03", kind: "update", title: "Patch 1.1", url: null },
];

let restore: () => void;
beforeEach(() => {
  restore = installChartLayout(900, 260);
});
afterEach(() => {
  cleanup();
  restore();
});

function renderChart() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(["game-catalog-events", APPID], CATALOG);
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <ZoomRangeProvider>
          <ReviewsTimelineChart points={POINTS} appid={APPID} />
        </ZoomRangeProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("ReviewsTimelineChart — labelled plumb lines", () => {
  it("labels the release, the spike and the update month on the volume panel", () => {
    const { container } = renderChart();
    const labels = Array.from(container.querySelectorAll("text.plumb-label")).map((t) => t.textContent?.trim());
    expect(labels).toEqual(["RELEASED", "▲ 4.0×", "UPDATE"]);
    expect(container.querySelector("text.plumb-label-release")?.textContent?.trim()).toBe("RELEASED");
  });

  it("explains the lines under the panel", () => {
    renderChart();
    expect(screen.getByText(/Release · catalog events · months that move ≥1\.75×/)).toBeTruthy();
  });
});

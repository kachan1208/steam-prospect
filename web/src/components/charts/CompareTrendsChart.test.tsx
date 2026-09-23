import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { CompareTrendsChart, seriesShapePath } from "./CompareTrendsChart";
import { COMPARE_SERIES } from "../../lib/palette";
import { axisTicks, installChartLayout } from "../../test/recharts";

/**
 * A2 — the three-games-in-one-colour defect, asserted on what the chart actually renders.
 *
 * Production /compare?ids=730,1962700,2393160 (2026-09-01) drew three <path
 * class="recharts-line-curve"> with strokes #b5d9fd, rgba(242,242,243,.75) and
 * rgba(242,242,243,.65) — 1.24:1 and 1.25:1 apart — all solid, all dotless. The colour
 * arithmetic lives in lib/palette.test.ts; this file pins that the chart WIRES it: three
 * different strokes, three different dash patterns, three different marker shapes.
 */

const MONTHS = Array.from({ length: 24 }, (_, i) => `2024-${String((i % 12) + 1).padStart(2, "0")}`).map(
  (_, i) => `${2024 + Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, "0")}`,
);
const series = (base: number) =>
  MONTHS.map((period, i) => ({ period, n_reviews: base + i * 37, ccu_avg: null }));

vi.mock("../../lib/api", () => ({
  useGameTrendsWithComps: () => ({
    isLoading: false,
    isError: false,
    error: null,
    data: {
      appid: 730,
      eligible: true,
      points: series(9_000),
      comps: {
        requested: [1962700, 2393160],
        matched: [1962700, 2393160],
        series: [
          { appid: 1962700, points: series(2_000) },
          { appid: 2393160, points: series(80) },
        ],
        cohort: [],
      },
    },
  }),
}));

let restore: () => void;
beforeEach(() => {
  restore = installChartLayout(900, 260);
});
afterEach(() => {
  cleanup();
  restore();
});

const IDS = [730, 1962700, 2393160];
const NAMES = new Map([
  [730, "Counter-Strike: Global Offensive"],
  [1962700, "Subnautica 2"],
  [2393160, "Nice Day for Fishing"],
]);

function renderChart() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={client}>
      <CompareTrendsChart ids={IDS} names={NAMES} />
    </QueryClientProvider>,
  );
}

function lines(container: HTMLElement): SVGPathElement[] {
  return Array.from(container.querySelectorAll<SVGPathElement>("path.recharts-line-curve"));
}

describe("CompareTrendsChart — three games are three distinguishable series", () => {
  it("draws one line per compared game", () => {
    const { container } = renderChart();
    expect(lines(container)).toHaveLength(3);
  });

  it("gives each line its own stroke", () => {
    const { container } = renderChart();
    const strokes = lines(container).map((l) => l.getAttribute("stroke"));
    expect(new Set(strokes).size).toBe(3);
    // And they are the audited slots, in order, not the withdrawn paper-alpha ramp
    // (whose slots 2 and 3 were color-mix()es of --text-primary at 75% and 65%).
    expect(strokes).toEqual(COMPARE_SERIES.slice(0, 3).map((s) => s.color));
    for (const s of strokes) expect(s).not.toMatch(/color-mix/);
  });

  it("gives each line its own dash pattern, so identity survives greyscale", () => {
    const { container } = renderChart();
    const dashes = lines(container).map((l) => l.getAttribute("stroke-dasharray") ?? "solid");
    expect(new Set(dashes).size).toBe(3);
  });

  it("stamps a distinct marker shape on each line", () => {
    const { container } = renderChart();
    const shapes = [0, 1, 2].map((i) => {
      const marks = container.querySelectorAll(`path[data-testid="compare-marker-${i}"]`);
      expect(marks.length, `slot ${i} drew no markers`).toBeGreaterThan(0);
      return marks[0].getAttribute("d");
    });
    expect(new Set(shapes).size).toBe(3);
  });

  it("repeats colour, dash AND marker in every legend key", () => {
    const { container } = renderChart();
    const keys = Array.from(container.querySelectorAll<SVGSVGElement>('svg[data-testid="series-key"]'));
    expect(keys.length).toBe(3);
    const dashes = keys.map((k) => k.querySelector("line")!.getAttribute("stroke-dasharray") ?? "solid");
    const shapes = keys.map((k) => k.querySelector("path")!.getAttribute("d"));
    expect(new Set(dashes).size).toBe(3);
    expect(new Set(shapes).size).toBe(3);
  });

  it("keeps the y-axis in one unit (A5, same chart)", () => {
    const { container } = renderChart();
    const ticks = axisTicks(container, "y").filter((t) => t !== "0");
    expect(ticks.length).toBeGreaterThan(1);
    const suffixes = new Set(ticks.map((t) => t.replace(/[\d.,-]/g, "")));
    expect(suffixes.size).toBe(1);
  });
});

describe("CompareTrendsChart — what the series is, and how it lines up (2026-09-23)", () => {
  function renderWith(props: Partial<Parameters<typeof CompareTrendsChart>[0]>) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    return render(
      <QueryClientProvider client={client}>
        <CompareTrendsChart ids={IDS} names={NAMES} {...props} />
      </QueryClientProvider>,
    );
  }

  it("names the series for what it is — Steam's full histogram, never 'SAMPLED'", () => {
    const { container } = renderWith({});
    expect(container.textContent).toContain("Steam's own review histogram");
    expect(container.textContent).toContain("full history, not a sample");
    expect(container.textContent).not.toMatch(/SAMPLED|undercount/);
  });

  it("leaves the running month out of every line, and says so", () => {
    // MONTHS runs 2024-01..2025-12; with Dec 2025 still running each line loses its last point.
    const full = renderWith({});
    const pointsFull = full.container.querySelectorAll('path[data-testid^="compare-marker-"]').length;
    full.unmount();
    const { container } = renderWith({ partialPeriod: "2025-12" });
    expect(container.textContent).toContain("Dec 2025 is still running, so it isn't drawn");
    expect(axisTicks(container, "x")).not.toContain("2025-12");
    expect(container.querySelectorAll('path[data-testid^="compare-marker-"]').length).toBeLessThanOrEqual(pointsFull);
  });

  it("aligned by launch: x is months since each game's launch month, with month 0 marked", () => {
    const anchors = new Map([
      [730, { iso: "2024-01-15", source: "release" as const }],
      [1962700, { iso: "2024-06-01", source: "first_public" as const }],
      [2393160, null],
    ]);
    const { container } = renderWith({ align: "launch", anchors });
    const ticks = axisTicks(container, "x");
    expect(ticks).toContain("0");
    // Subnautica 2 launched in Jun 2024, so its Jan–May points sit at negative months…
    expect(ticks.some((t) => t.startsWith("-"))).toBe(true);
    expect(container.textContent).toContain("launch");
    // …and a game with no launch date is named, not silently dropped.
    expect(container.textContent).toContain("Not drawn: Nice Day for Fishing — no release date to line up on.");
    expect(lines(container)).toHaveLength(2);
    expect(container.textContent).toContain("X = months since each game's launch month");
  });
});

describe("seriesShapePath", () => {
  it("emits a closed path for every shape in the ramp, and no two are the same", () => {
    const paths = COMPARE_SERIES.map((s) => seriesShapePath(s.shape, 10, 10, 3));
    for (const d of paths) {
      expect(d.startsWith("M")).toBe(true);
      expect(d.trimEnd().endsWith("Z")).toBe(true);
      expect(d).not.toMatch(/NaN|undefined/);
    }
    expect(new Set(paths).size).toBe(COMPARE_SERIES.length);
  });

  it("translates with its centre — the same shape at two points is not the same path", () => {
    expect(seriesShapePath("triangle", 10, 10, 3)).not.toBe(seriesShapePath("triangle", 40, 10, 3));
  });
});

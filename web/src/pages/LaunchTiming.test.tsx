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

beforeEach(() => {
  requests = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const u = String(input);
      requests.push(u);
      return new Response(JSON.stringify(respond(u)), {
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

    // The reads that actually changed: both genre-scoped endpoints carry it…
    expect(requestsFor("/timing/overview").every((u) => u.includes("genre=Strategy"))).toBe(true);
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

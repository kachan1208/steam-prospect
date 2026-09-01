import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import GameSearch from "./GameSearch";
import { DEFAULT_QUERY_OPTIONS } from "../lib/api";
import { ThemeProvider } from "../lib/theme";

/**
 * /games' two out-of-band inputs, and the column headers the numbers never had.
 *
 * All three reproduced on production 2026-09-01:
 *
 *  - PAGING CLIFF. The API caps `offset` at 10,000 (api/app/routers/games.py). At
 *    ?offset=10000 with "1–25 of 174,265" on screen the Next button was still enabled;
 *    clicking it requested offset=10025, got a 422, flipped the header to "0 matches" and
 *    printed FastAPI's raw pydantic array in the results area. The page advertised 6,971
 *    pages when 401 are reachable.
 *  - YEAR PREFIXES. `released_after` is ge=1970, and the Year inputs were the only ones on
 *    the page that committed a raw draft. Typing "2020" fired after=2 and after=202, each a
 *    422; a shared /games?after=202 showed a PERMANENT "0 matches" under an active
 *    "From 202" chip — indistinguishable from a genuine empty result.
 *  - UNLABELLED COLUMNS. The rows print "86% · 9.8M / $464.6M / 841.9K live" with no header
 *    row, no legend, and an sr-only <h1>. /studios and /niches label and explain every
 *    metric column; this page was the outlier.
 *
 * The bounds are asserted on the REQUEST, not on the input's value: the bug was that a URL
 * (shared, or back-navigated to) reached the API unclamped, which no keystroke-level
 * assertion would have caught.
 */

const PAGE = {
  total: 174_265,
  limit: 25,
  offset: 0,
  items: [
    {
      appid: 730,
      name: "Counter-Strike: Global Offensive",
      primary_genre: "Action",
      release_year: 2012,
      release_date: "2012-08-21",
      price_initial: 0,
      is_free: 1,
      owners_mid: 1,
      total_reviews: 9_800_000,
      positive_ratio: 0.86,
      est_rev_reviews: null,
      live_players: 841_900,
      header_image: null,
      top_tags: ["FPS", "Shooter"],
    },
  ],
};

let searchUrls: string[];
/** Every location the page has committed, in order — the draft debounce writes here. */
let committedUrls: string[];

function LocationProbe() {
  const { search } = useLocation();
  committedUrls.push(search);
  return null;
}

/** Every `after=` value the page has ever put in the URL. */
function committedYears(): string[] {
  return committedUrls
    .map((s) => new URLSearchParams(s).get("after"))
    .filter((v): v is string => v !== null);
}

function mockFetch() {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/games/search")) searchUrls.push(url);
    const body = url.includes("/market/benchmarks")
      ? { cited: { boxleiter_owners_per_review: { min: 1, mid: 2, max: 3 }, dev_tiers: [], revenue_benchmark_marks: [] }, boxleiter_by_genre: [] }
      : PAGE;
    return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  });
}

function renderAt(path: string) {
  const qc = new QueryClient({
    defaultOptions: { queries: { ...DEFAULT_QUERY_OPTIONS, gcTime: 0, retryDelay: 0 } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <ThemeProvider>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route
              path="/games"
              element={
                <>
                  <GameSearch />
                  <LocationProbe />
                </>
              }
            />
          </Routes>
        </MemoryRouter>
      </ThemeProvider>
    </QueryClientProvider>,
  );
}

/** The offset actually sent to the API (absent = the API's own default of 0). */
function requestedOffsets(): (string | null)[] {
  return searchUrls.map((u) => new URL(u, "http://x").searchParams.get("offset"));
}

beforeEach(() => {
  searchUrls = [];
  committedUrls = [];
  vi.stubGlobal("fetch", mockFetch());
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

// ---- NEW-1: the paging cliff ---------------------------------------------------------------

describe("offset is bounded by what the API will serve", () => {
  it("never asks for an offset past the API's cap, however the URL got there", async () => {
    renderAt("/games?offset=10025");
    await waitFor(() => expect(searchUrls.length).toBeGreaterThan(0));
    for (const offset of requestedOffsets()) {
      expect(Number(offset ?? 0)).toBeLessThanOrEqual(10_000);
    }
  });

  it("disables Next on the last reachable page instead of walking off it", async () => {
    renderAt("/games?offset=10000");
    const next = await screen.findByRole("button", { name: "Next" });
    // 174,265 matches remain — `total` alone said "there is more", and there is, but not
    // through this button.
    expect((next as HTMLButtonElement).disabled).toBe(true);
  });

  it("says WHY paging stopped, rather than looking like the end of the results", async () => {
    renderAt("/games?offset=10000");
    expect(await screen.findByText(/paging stops at 10,000/)).toBeTruthy();
    expect(screen.getByText(/of 174,265/)).toBeTruthy();
  });

  it("keeps Next enabled while a further page is genuinely reachable", async () => {
    // offset 9,975 + 25 = 10,000, which the API DOES serve. Over-clamping would strand the
    // reader one page early.
    renderAt("/games?offset=9975");
    const next = await screen.findByRole("button", { name: "Next" });
    expect((next as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByText(/paging stops at/)).toBeNull();
  });
});

// ---- NEW-2: half-typed years -----------------------------------------------------------------

describe("release-year bounds", () => {
  it("does not send a year the API will reject", async () => {
    renderAt("/games?after=202");
    await waitFor(() => expect(searchUrls.length).toBeGreaterThan(0));
    for (const u of searchUrls) {
      const v = new URL(u, "http://x").searchParams.get("released_after");
      // Either dropped (still being typed) or inside the API's 1970-2100 band. "202" is
      // neither, and it is what production sent.
      if (v !== null) expect(Number(v)).toBeGreaterThanOrEqual(1970);
      expect(v).not.toBe("202");
    }
  });

  it("clamps a complete but out-of-band year rather than 422-ing on it", async () => {
    renderAt("/games?after=1200&before=9999");
    await waitFor(() => expect(searchUrls.length).toBeGreaterThan(0));
    const sp = new URL(searchUrls[searchUrls.length - 1], "http://x").searchParams;
    // 1200 is a complete 4-digit year, so it clamps up to the floor rather than dropping.
    expect(sp.get("released_after")).toBe("1970");
    expect(sp.get("released_before")).toBe("2100");
  });

  it("shows real results instead of a permanent, unexplained '0 matches'", async () => {
    renderAt("/games?after=202");
    // The whole visible symptom: a "From 202" chip over 0 matches that looks like a finding.
    expect(await screen.findByText("174,265 matches")).toBeTruthy();
    expect(screen.queryByText("From 202")).toBeNull();
  });

  it("never writes an unusable year into the URL while it is being TYPED", async () => {
    // The draft path and the URL path are different funnels and BOTH have to clamp. The
    // request is already protected by readFilters, so this asserts what the draft path alone
    // owns: the URL the user would share, bookmark or walk back through. Unclamped, typing
    // 2020 left ?after=2 and ?after=202 in the history — each a state that reopens as a
    // filter chip over a rejected query.
    renderAt("/games");
    fireEvent.click(await screen.findByRole("button", { name: /More filters/ }));
    const from = screen.getByPlaceholderText("from");
    for (const value of ["2", "20", "202", "2020"]) {
      fireEvent.change(from, { target: { value } });
      // Past the 400ms commit debounce, so each prefix gets its chance to be committed.
      await new Promise((r) => setTimeout(r, 450));
    }
    await waitFor(() => expect(committedYears()).toContain("2020")); // the real year lands
    for (const y of committedYears()) {
      expect(Number(y)).toBeGreaterThanOrEqual(1970);
      expect(Number(y)).toBeLessThanOrEqual(2100);
    }
  });

  it("passes a normal year straight through", async () => {
    renderAt("/games?after=2020&before=2024");
    await waitFor(() => expect(searchUrls.length).toBeGreaterThan(0));
    const sp = new URL(searchUrls[searchUrls.length - 1], "http://x").searchParams;
    expect(sp.get("released_after")).toBe("2020");
    expect(sp.get("released_before")).toBe("2024");
  });
});

// ---- B3: the unlabelled metric columns --------------------------------------------------------

describe("result columns explain themselves", () => {
  it("labels each metric column above the rows", async () => {
    renderAt("/games?q=witch");
    // The three numbers a cold visitor could not name: 86% · 9.8M, $464.6M, 841.9K live.
    expect(await screen.findByText("Rating · reviews")).toBeTruthy();
    expect(screen.getByText("Est. gross")).toBeTruthy();
    expect(screen.getByText("Live players")).toBeTruthy();
  });

  it("carries the same explanatory tooltips /studios and /niches do", async () => {
    renderAt("/games?q=witch");
    const gross = await screen.findByText("Est. gross");
    // The estimator has to be disclosed wherever the number is: it is not reported sales.
    expect(gross.getAttribute("title")).toMatch(/estimate, not reported sales/i);
    expect(screen.getByText("Rating · reviews").getAttribute("title")).toMatch(/positive/i);
    expect(screen.getByText("Live players").getAttribute("title")).toMatch(/not a daily peak/i);
  });
});

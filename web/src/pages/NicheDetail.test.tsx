import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useParams, useSearchParams } from "react-router-dom";

import {
  GAMES_PAGE_SIZE,
  NICHE_ROUTE_PATH,
  nicheDetailPath,
  readGamesParams,
  readSelection,
  writeSelection,
  type DistMetric,
} from "./NicheDetail";

afterEach(cleanup);

/** Renders whatever the real route pattern resolves for `path` and reports the decoded
 * params + query string — i.e. it exercises the SAME matching the app does, not a
 * re-implementation of it. */
function Probe() {
  const { dimension, key } = useParams<{ dimension: string; key: string }>();
  const [sp] = useSearchParams();
  return (
    <div>
      <span data-testid="dimension">{dimension}</span>
      <span data-testid="key">{key}</span>
      <span data-testid="search">{sp.toString()}</span>
    </div>
  );
}

function visit(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path={NICHE_ROUTE_PATH} element={<Probe />} />
        <Route path="*" element={<span data-testid="key">NO MATCH</span>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("niche detail URL round-trip", () => {
  // Niche keys are raw Steam tag/genre strings. Two of them break naive routing: keys with
  // SPACES ("Action Roguelike") and keys with SLASHES (Steam's own "Massively Multiplayer"
  // family, and genre keys generally) — a slash would otherwise split into a third path
  // segment and never match /niches/:dimension/:key at all. The link builder must encode
  // and React Router must hand back the original string, byte for byte.
  const KEYS = [
    "Action Roguelike",
    "Massively Multiplayer/RPG",
    "Free to Play",
    "RPG/Adventure/Indie",
    "Rogue-like",
  ];

  for (const key of KEYS) {
    it(`round-trips ${JSON.stringify(key)} through the route`, () => {
      const path = nicheDetailPath("tag", key);
      // The key never leaks a raw space or slash into the path.
      expect(path.startsWith("/niches/tag/")).toBe(true);
      expect(path.slice("/niches/tag/".length)).not.toContain(" ");
      expect(path.slice("/niches/tag/".length)).not.toContain("/");

      const { getByTestId } = visit(path);
      expect(getByTestId("dimension").textContent).toBe("tag");
      expect(getByTestId("key").textContent).toBe(key);
    });
  }

  it("encodes a slash as %2F and a space as %20 in the built path", () => {
    expect(nicheDetailPath("genre", "Massively Multiplayer/RPG")).toBe("/niches/genre/Massively%20Multiplayer%2FRPG");
    expect(nicheDetailPath("tag", "Action Roguelike")).toBe("/niches/tag/Action%20Roguelike");
  });

  it("carries a query string through to the page", () => {
    const path = nicheDetailPath("tag", "Action Roguelike", {
      tab: "games",
      rev_min: 1000,
      rev_max: 10000,
      win: undefined,
    });
    const { getByTestId } = visit(path);
    expect(getByTestId("key").textContent).toBe("Action Roguelike");
    const search = new URLSearchParams(getByTestId("search").textContent ?? "");
    expect(search.get("tab")).toBe("games");
    expect(search.get("rev_min")).toBe("1000");
    expect(search.get("rev_max")).toBe("10000");
    // Undefined values are dropped rather than serialized as "undefined".
    expect(search.has("win")).toBe(false);
  });
});

describe("bucket selection <-> query params", () => {
  const cut = { win: "24m", min_reviews: 50 } as const;

  it("writes a revenue selection into the query string and feeds it to the games request", () => {
    const next = writeSelection(new URLSearchParams("tab=games"), "revenue", { min: 1000, max: 10000 });
    expect(next.get("rev_min")).toBe("1000");
    expect(next.get("rev_max")).toBe("10000");
    expect(next.get("tab")).toBe("games"); // unrelated params survive

    const params = readGamesParams(next, cut);
    expect(params.rev_min).toBe(1000);
    expect(params.rev_max).toBe(10000);
    expect(params.price_min).toBeUndefined();
    expect(params.price_max).toBeUndefined();
  });

  it("writes a price selection to price_min/price_max, independently of the revenue one", () => {
    let sp = writeSelection(new URLSearchParams(), "revenue", { min: 5, max: 50 });
    sp = writeSelection(sp, "price", { min: 9.99, max: 19.99 });

    const params = readGamesParams(sp, cut);
    expect(params.rev_min).toBe(5);
    expect(params.rev_max).toBe(50);
    expect(params.price_min).toBe(9.99);
    expect(params.price_max).toBe(19.99);
  });

  it("clears only its own axis when a selection is dropped", () => {
    let sp = writeSelection(new URLSearchParams(), "revenue", { min: 1000, max: 10000 });
    sp = writeSelection(sp, "price", { min: 0, max: 5 });
    sp = writeSelection(sp, "revenue", null);

    expect(sp.has("rev_min")).toBe(false);
    expect(sp.has("rev_max")).toBe(false);
    expect(readSelection(sp, "price")).toEqual({ min: 0, max: 5 });
    expect(readSelection(sp, "revenue")).toBeNull();
  });

  it("re-pages to the top whenever the selection changes", () => {
    const sp = writeSelection(new URLSearchParams("offset=75&tab=games"), "revenue", { min: 1, max: 2 });
    // An offset from the unfiltered result set would point past the filtered one.
    expect(sp.has("offset")).toBe(false);
    expect(readGamesParams(sp, cut).offset).toBe(0);
  });

  it("treats a half-written or inverted selection as no filter at all", () => {
    for (const query of ["rev_min=1000", "rev_max=10000", "rev_min=10000&rev_max=1000", "rev_min=abc&rev_max=5"]) {
      const sp = new URLSearchParams(query);
      expect(readSelection(sp, "revenue")).toBeNull();
      expect(readGamesParams(sp, cut).rev_min).toBeUndefined();
      expect(readGamesParams(sp, cut).rev_max).toBeUndefined();
    }
  });

  it("survives a full URL round-trip: selection -> shareable link -> parsed back", () => {
    const sp = writeSelection(new URLSearchParams("tab=games"), "revenue", { min: 1000, max: 10000 });
    const link = nicheDetailPath("tag", "Action Roguelike", Object.fromEntries(sp));

    const { getByTestId } = visit(link);
    expect(getByTestId("key").textContent).toBe("Action Roguelike");

    const parsed = new URLSearchParams(getByTestId("search").textContent ?? "");
    expect(readSelection(parsed, "revenue")).toEqual({ min: 1000, max: 10000 });
    expect(readGamesParams(parsed, cut)).toMatchObject({
      win: "24m",
      min_reviews: 50,
      rev_min: 1000,
      rev_max: 10000,
      limit: GAMES_PAGE_SIZE,
      offset: 0,
    });
  });
});

describe("games request defaults", () => {
  const cut = { win: "all", min_reviews: 100 } as const;

  it("defaults to revenue desc on the cut from the page, not from the URL", () => {
    expect(readGamesParams(new URLSearchParams(), cut)).toEqual({
      win: "all",
      min_reviews: 100,
      sort: "revenue",
      order: "desc",
      limit: GAMES_PAGE_SIZE,
      offset: 0,
      rev_min: undefined,
      rev_max: undefined,
      price_min: undefined,
      price_max: undefined,
    });
  });

  it("honours a whitelisted sort key and rejects anything else", () => {
    expect(readGamesParams(new URLSearchParams("sort=reviews&order=asc"), cut).sort).toBe("reviews");
    expect(readGamesParams(new URLSearchParams("sort=reviews&order=asc"), cut).order).toBe("asc");
    // These are the API's REQUEST-side names; the row field names are not sort keys, and
    // "owners_est" isn't sortable at all. Anything off the whitelist would 422 — fall back.
    for (const bad of ["DROP TABLE", "est_revenue", "total_reviews", "owners_est", "price_initial"]) {
      expect(readGamesParams(new URLSearchParams(`sort=${bad}`), cut).sort).toBe("revenue");
    }
  });

  it("never sends a negative, fractional or out-of-range offset", () => {
    expect(readGamesParams(new URLSearchParams("offset=-40"), cut).offset).toBe(0);
    expect(readGamesParams(new URLSearchParams("offset=12.7"), cut).offset).toBe(12);
    // The API caps offset at 50_000 (ge=0, le=50000).
    expect(readGamesParams(new URLSearchParams("offset=999999"), cut).offset).toBe(50_000);
  });
});

describe("selection labels", () => {
  it("labels both metrics with the right currency formatting", async () => {
    const { selectionLabel } = await import("./NicheDetail");
    const metrics: DistMetric[] = ["revenue", "price"];
    expect(metrics).toHaveLength(2);
    expect(selectionLabel("revenue", { min: 1000, max: 10000 })).toBe("Revenue $1.0K – $10.0K");
    expect(selectionLabel("price", { min: 0, max: 9.99 })).toBe("Price Free – $9.99");
  });
});

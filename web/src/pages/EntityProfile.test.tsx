import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import EntityProfile from "./EntityProfile";
import { ThemeProvider } from "../lib/theme";

/**
 * One displayed-number contract on /entity/:role?name=… — the same one GameProfile.test.tsx
 * pins for press tone: a percentage is printed with the base it is actually computed over.
 *
 * The career tiles all read mart_entity, whose revenue aggregates are over the releases that
 * HAVE an est_rev_reviews and no others (etl/marts/mart_entity.sql). The page put them beside a
 * "Games" tile carrying n_games and labelled the rate "Share of releases clearing $200K est.":
 * Hooded Horse rendered "GAMES 50", "91%", "median $3.9M per release" while 17 of those 50
 * releases were outside every one of those numbers — 91% is 30/33, and 30/50 is 60%.
 *
 * Payloads below are GET /api/entities/profile verbatim (prod, 2026-09-01), trimmed to the
 * fields the page reads.
 */

// 33 with an estimate (30 over $200K, 3 at $0), 17 without — in the API's seq order.
const HOODED_HORSE_REV: (number | null)[] = [
  25792599.599999998, 11192133.6, 3374998.5, 3958680, 8215545.600000001, 3621292.5,
  7807647.600000001, 33449946.299999997, 108251330.4, 16929654.9, 32607846, 9298399.5,
  890554.4999999999, 3850716, 1631783.7, 13741525.799999999, 376074.6, 2462368.1999999997,
  4256148.600000001, 3549624.3, 2932122.3, 11737864.8, 15771256.200000001, 1887570.5999999999,
  2013528.5999999999, 6927067.800000001, 26181053.1, 353223.3, 3762259.2, 1882444.2, null, 0,
  null, null, 0, null, null, null, 0, null, null, null, null, null, null, null, null, null,
  null, null,
];

function game(est_rev_reviews: number | null, seq: number) {
  return {
    appid: 1_000_000 + seq,
    seq,
    name: `Release ${seq}`,
    release_year: 2020,
    release_date: "2020-01-01",
    price_initial: 19.99,
    total_reviews: 500,
    positive_ratio: 0.9,
    est_rev_reviews,
    primary_genre: "Strategy",
    header_image: null,
  };
}

const HOODED_HORSE = {
  entity: {
    role: "publisher",
    name: "Hooded Horse",
    n_games: 50,
    first_release_year: 2017,
    last_release_year: 2026,
    n_recent_24m: 18,
    total_rev: 368707260.3000001,
    median_rev: 3850716.0,
    p90_rev: 26103362.4,
    hit_rate_200k: 0.9090909090909091,
    median_reviews: 2479.5,
    median_positive_ratio: 0.8697446148181838,
    self_published_share: 0.0,
    top_genres: ["Simulation", "RPG"],
    n_partners: 51,
    x_handle: "HoodedHorseInc",
  },
  games: HOODED_HORSE_REV.map((rev, i) => game(rev, i + 1)),
};

// The regression control. FromSoftware, Inc. (developer): 12 releases, ALL 12 estimated, 8 over
// $200K. Its 67% was correct before this change and every string on its page must be unchanged
// by it — which is precisely why the defect varies by entity instead of being a fixed offset.
const FROMSOFTWARE = {
  entity: {
    ...HOODED_HORSE.entity,
    role: "developer",
    name: "FromSoftware, Inc.",
    n_games: 12,
    hit_rate_200k: 0.6666666666666666,
    median_rev: 155915525.4,
    n_partners: null,
  },
  games: Array.from({ length: 12 }, (_, i) => game(i < 8 ? 5_000_000 : 100_000, i + 1)),
};

// The release-trajectory chart is Recharts' ResponsiveContainer, which observes its box; jsdom
// ships no ResizeObserver. Same no-op stub NicheDistribution.test.tsx uses — the tiles under
// test are plain HTML beside the SVG.
beforeAll(() => {
  if (typeof globalThis.ResizeObserver === "undefined") {
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  }
});

// Zeekerss (publisher) — the thin-base case, verbatim from prod. "GAMES 5" and "100%", where
// the 100% is 3 of 3 estimated releases (It Steals, The Upturned, Lethal Company) and two are
// unestimated. At that base a hit rate can only ever come out 0% or 100%, so the number stays
// (3-for-3 is a true fact about a five-release label) but the verdict colour does not.
const ZEEKERSS = {
  entity: {
    ...HOODED_HORSE.entity,
    name: "Zeekerss",
    n_games: 5,
    hit_rate_200k: 1.0,
    median_rev: 812786.4,
    total_rev: 154142394.6,
    p90_rev: 122540137.20000002,
  },
  games: [357633.3, null, 812786.4, 152971974.9, null].map((rev, i) => game(rev, i + 1)),
};

function renderProfile(role: string, name: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={client}>
      <ThemeProvider>
        <MemoryRouter initialEntries={[`/entity/${role}?name=${encodeURIComponent(name)}`]}>
          <Routes>
            <Route path="/entity/:role" element={<EntityProfile />} />
          </Routes>
        </MemoryRouter>
      </ThemeProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), {
          status,
          headers: { "Content-Type": "application/json" },
        });
      if (url.includes("name=Hooded")) {
        // The page also probes the OTHER role; only the publisher exists.
        return url.includes("role=publisher")
          ? json(HOODED_HORSE)
          : json({ detail: { error: "not found", suggestions: [] } }, 404);
      }
      if (url.includes("Zeekerss")) {
        return url.includes("role=publisher")
          ? json(ZEEKERSS)
          : json({ detail: { error: "not found", suggestions: [] } }, 404);
      }
      if (url.includes("FromSoftware")) {
        return url.includes("role=developer")
          ? json(FROMSOFTWARE)
          : json({ detail: { error: "not found", suggestions: [] } }, 404);
      }
      return json({}, 404);
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("EntityProfile revenue tiles", () => {
  it("never labels a rate 'share of releases' when releases sit outside its base", async () => {
    renderProfile("publisher", "Hooded Horse");
    await waitFor(() => expect(screen.getByText("Hit rate ≥ $200K")).toBeTruthy());

    // The rate itself is untouched — this is a disclosure fix, not a recomputation.
    expect(screen.getByText("91%")).toBeTruthy();
    // ...but it now says 33, the only base that produces 91%. 30/50 = 60%.
    expect(
      screen.getByText("Share of the 33 releases with a revenue estimate — 17 of 50 have none"),
    ).toBeTruthy();
    expect(screen.queryByText("Share of releases clearing $200K est.")).toBeNull();

    // Same base, same disclosure, on the two tiles that share it.
    expect(
      screen.getByText("median $3.9M — both over the 33 of 50 releases with an estimate"),
    ).toBeTruthy();
    expect(
      screen.getByText("Boxleiter gross over the 33 of 50 releases with an estimate"),
    ).toBeTruthy();
    expect(screen.queryByText("median $3.9M per release")).toBeNull();
    expect(screen.queryByText("Boxleiter gross across the catalog")).toBeNull();

    // The Games tile still counts all 50 — the fix discloses, it does not restate the count —
    // and now says how many of those 50 every tile beside it excludes.
    const gamesTile = screen.getByText("17 with no revenue estimate").parentElement;
    expect(gamesTile?.textContent).toBe("Games5017 with no revenue estimate");
  });

  it("withholds the strong-hit-rate colour when the base is under the floor", async () => {
    renderProfile("publisher", "Zeekerss");
    await waitFor(() => expect(screen.getByText("100%")).toBeTruthy());
    // The number and its base are both printed — nothing is hidden...
    expect(
      screen.getByText("Share of the 3 releases with a revenue estimate — 2 of 5 have none"),
    ).toBeTruthy();
    // ...but 3 estimated releases is under ENTITY_MIN_ESTIMATED_FOR_VERDICT, so the tile does
    // not also assert that this is a strong hit rate.
    expect(screen.getByText("100%").className).not.toContain("accent-300");
  });

  it("keeps the colour when the base clears the floor", async () => {
    renderProfile("publisher", "Hooded Horse");
    await waitFor(() => expect(screen.getByText("91%")).toBeTruthy());
    // 33 estimated releases clears ENTITY_MIN_ESTIMATED_FOR_VERDICT, so this one keeps it.
    expect(screen.getByText("91%").className).toContain("accent-300");
  });

  it("REGRESSION CONTROL: FromSoftware's page is unchanged, because it was already right", async () => {
    renderProfile("developer", "FromSoftware, Inc.");
    await waitFor(() => expect(screen.getByText("Hit rate ≥ $200K")).toBeTruthy());

    // 8/12 over all 12 listed releases: no hedge, no "of the N with an estimate", and the
    // verdict colour stays because a 12-release estimated career clears the floor.
    expect(screen.getByText("67%")).toBeTruthy();
    expect(screen.getByText("Share of all 12 releases clearing $200K est.")).toBeTruthy();
    expect(screen.getByText("67%").className).toContain("accent-300");
    expect(screen.getByText("median $155.9M per release")).toBeTruthy();
    expect(screen.getByText("Boxleiter gross across the catalog")).toBeTruthy();
    // Nothing is excluded, so the Games tile keeps its bare count with no sub-label at all.
    expect(screen.queryByText(/with no revenue estimate/)).toBeNull();
    expect(screen.queryByText(/have none/)).toBeNull();
  });
});

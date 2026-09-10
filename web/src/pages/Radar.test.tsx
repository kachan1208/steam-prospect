import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import Radar from "./Radar";
import { ThemeProvider } from "../lib/theme";

/**
 * The CLASS CONTROL contract, rebuilt 2026-09-10 (user: "Make it better, right now it looks
 * like a slop"):
 *
 * 1. ALL THREE CLASSES ARE ALWAYS ON THE BOARD, one 120° wedge each — that is what took the
 *    dial from 80 blips in a single full-circle sector to the reference's ~14 per quadrant.
 *    The picker (default Micro-genres) selects EMPHASIS: the chosen wedge reads at full
 *    strength and the other two recede, on the dial and in the rail alike. Nothing is
 *    removed and no count is hidden.
 * 2. EACH CLASS IS STILL RANKED ONLY AGAINST ITS OWN KIND — the 2026-08-27 directive's
 *    substance ("score Genres, Micro-genres and Themes separately"). The Top-N control
 *    distributes: Top 80 plots the top ~27 of EVERY class, so a genre never competes with a
 *    micro-tag for a slot.
 * 3. The SEARCH spans the whole pool, as it always did, and selecting a cross-class hit
 *    moves the emphasis to that niche's own wedge so its dot is the lit one.
 */

/** A minimal /api/niches row with everything Radar's pool builder reads. */
function row(
  dimension: "genre" | "tag",
  key: string,
  tier: string | null,
  demand: number | null,
  sat: number | null,
  opp: number,
) {
  return {
    dimension,
    key,
    tier,
    window: "24m",
    min_reviews: 50,
    n_games: 80,
    n_recent: 20,
    p90_rev: 400_000,
    opportunity_v2: opp,
    demand_trend_24m_pct: demand,
    demand_emerging: false,
    saturation_yoy: sat,
    winner_concentration: 0.5,
    entrant_ratio: 1.1,
    solo_viability: 0.9,
    reviews_24m: 120_000,
    reviews_prev_24m: 90_000,
    reviews_24m_new_share: 0.3,
  };
}

const GENRES = [row("genre", "Simulation", null, 60, 0.05, 70), row("genre", "Strategy", null, 10, 0.2, 55)];
// Verdict rings, which are also the board's zoom regions since the 2026-09-10 dial:
// Roguelike Deckbuilder (demand past the bar but supply flooding) = WATCH, City Builder
// (past the bar, pipeline calm) = ENTER NOW, Fishing = ENTER NOW, Horror (flooding against
// falling demand) = CROWDED. Two different rings per class, so a ring zoom really filters.
const TAGS = [
  row("tag", "Roguelike Deckbuilder", "micro", 196, 0.409, 71),
  row("tag", "City Builder", "micro", 90, 0.1, 60),
  row("tag", "Fishing", "theme", 80, 0.05, 65),
  row("tag", "Horror", "theme", -20, 0.3, 50),
];

/** Mirrors the URL back out so the tests can assert what a share-link would carry. */
function LocationProbe() {
  const loc = useLocation();
  return <div data-testid="loc">{`${loc.pathname}${loc.search}`}</div>;
}

function url(): string {
  return screen.getByTestId("loc").textContent ?? "";
}

function renderRadar(entry = "/radar") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={client}>
      <ThemeProvider>
        <MemoryRouter initialEntries={[entry]}>
          <Radar />
          <LocationProbe />
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
      const items = url.includes("dimension=genre") ? GENRES : url.includes("dimension=tag") ? TAGS : [];
      return new Response(JSON.stringify({ items, total: items.length, limit: 500, offset: 0 }), {
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

/** Re-stub fetch with a specific population (the default beforeEach serves GENRES/TAGS). */
function fetchMock(genres: unknown[], tags: unknown[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const items = url.includes("dimension=genre") ? genres : url.includes("dimension=tag") ? tags : [];
      return new Response(JSON.stringify({ items, total: items.length, limit: 500, offset: 0 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
}

describe("Radar — class sectors and the emphasis control", () => {
  it("plots EVERY class on one board and defaults the emphasis to Micro-genres", async () => {
    renderRadar();
    // All six niches, all three classes, one board — the density fix.
    expect(await screen.findByTestId("radar-row-tag:Roguelike Deckbuilder")).toBeTruthy();
    expect(screen.getByTestId("radar-row-tag:City Builder")).toBeTruthy();
    expect(screen.getByTestId("radar-row-genre:Simulation")).toBeTruthy();
    expect(screen.getByTestId("radar-row-tag:Fishing")).toBeTruthy();
    expect(screen.getByTestId("radar-row-genre:Strategy")).toBeTruthy();
    expect(screen.getByTestId("radar-row-tag:Horror")).toBeTruthy();
    // …and every one of them has a dot in its own wedge.
    for (const id of ["tag:Roguelike Deckbuilder", "genre:Simulation", "tag:Fishing"]) {
      expect(screen.getByTestId(`radar-blip-${id}`)).toBeTruthy();
    }
    // The header count is the whole plotted board now, not one class of it.
    expect(screen.getByText("Verdicts").parentElement?.textContent).toContain("6");
    // The kicker names the EMPHASISED class, and says that is what it is.
    expect(screen.getByText(/micro-genre tags emphasised/)).toBeTruthy();
    // The search still states the whole pool (all six niches, every class).
    expect((screen.getByTestId("radar-search") as HTMLInputElement).placeholder).toContain("all 6 niches");
  });

  it("switching the emphasis dims the other wedges instead of emptying the board", async () => {
    renderRadar();
    await screen.findByTestId("radar-row-tag:Roguelike Deckbuilder");
    const offClass = (id: string) => screen.getByTestId(`radar-row-${id}`).getAttribute("data-off-class");
    // Default micro: the tag micro rows read at full strength, the rest recede.
    expect(offClass("tag:Roguelike Deckbuilder")).toBeNull();
    expect(offClass("tag:Fishing")).toBe("theme");
    expect(offClass("genre:Simulation")).toBe("genre");

    fireEvent.click(screen.getByRole("button", { name: "Themes" }));
    expect(offClass("tag:Fishing")).toBeNull();
    expect(offClass("tag:Roguelike Deckbuilder")).toBe("micro");
    // Nothing left the board — the micro rows and their dots are still there.
    expect(screen.getByTestId("radar-row-tag:Roguelike Deckbuilder")).toBeTruthy();
    expect(screen.getByTestId("radar-blip-tag:Roguelike Deckbuilder")).toBeTruthy();
    expect(screen.getByText(/theme tags emphasised/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Genres" }));
    expect(offClass("genre:Simulation")).toBeNull();
    expect(offClass("genre:Strategy")).toBeNull();
    expect(offClass("tag:Fishing")).toBe("theme");
  });

  it("gives every class its OWN Top-N slice, so one class can never crowd another out", async () => {
    // Top 40 across three classes is the top 14 of EACH — not 40 of whichever class scores
    // highest. This fixture's six rows all fit, and the wedge counts say so at the rim.
    renderRadar("/radar?top=40");
    await screen.findByTestId("radar-row-tag:Roguelike Deckbuilder");
    expect(screen.getByTestId("radar-sector-label-genre").textContent).toContain("GENRES · 2");
    expect(screen.getByTestId("radar-sector-label-micro").textContent).toContain("MICRO-GENRES · 2");
    expect(screen.getByTestId("radar-sector-label-theme").textContent).toContain("THEMES · 2");
  });

  it("a cross-class search hit moves the emphasis to its wedge and opens its dossier", async () => {
    renderRadar();
    await screen.findByTestId("radar-row-tag:Roguelike Deckbuilder");

    // Search spans ALL classes (as it always did — the board now does too).
    fireEvent.change(screen.getByTestId("radar-search"), { target: { value: "simulation" } });
    const hit = screen.getByTestId("radar-row-genre:Simulation");
    expect(hit).toBeTruthy();

    fireEvent.click(hit);
    // The dossier opens, and Simulation is plotted (top of its own class), so no beyond-plot
    // note appears.
    const dossier = screen.getByTestId("verdict-dossier");
    expect(dossier.textContent).toContain("Simulation");
    expect(dossier.textContent).not.toContain("Beyond the Top");

    // Back + clear: the emphasis really moved to Genres — and the micro rows are still on
    // the board, just dimmed.
    fireEvent.click(screen.getByRole("button", { name: /back to all verdicts/i }));
    fireEvent.keyDown(screen.getByTestId("radar-search"), { key: "Escape" });
    expect(screen.getByTestId("radar-row-genre:Strategy").getAttribute("data-off-class")).toBeNull();
    expect(screen.getByTestId("radar-row-tag:Roguelike Deckbuilder").getAttribute("data-off-class")).toBe("micro");
  });
});

/**
 * URL STATE (2026-08-28). The flagship page was the only surface whose view couldn't be
 * linked — class, solo lens, Top-N and the open dossier all lived in useState. They ride
 * search params now, with DEFAULTS OMITTED so a pristine /radar stays a clean URL.
 */
describe("Radar — every ring the board draws is reachable", () => {
  /**
   * The board labels five bands, so all five must be able to hold dots. They could not: the
   * plotted set was the head of an opportunity_v2-sorted pool, and the very thing that puts a
   * niche in DECLINING (demand in sustained decay) also puts it at the bottom of that sort.
   * Measured on production, the five declining tag niches ranked 179, 185, 207, 208 and 209
   * of 209 — so DECLINING was drawn, labelled and permanently empty at every cap the control
   * offers, which reads as "there are none" and is a claim about the market, not the cut.
   */
  it("plots a declining niche even though it ranks last on opportunity", async () => {
    // 30 healthy micro tags outrank the decliner on opportunity by a mile; a plain
    // slice(0, cap) at Top 40 (cap 14 per class) could never reach it.
    const crowd = Array.from({ length: 30 }, (_, i) =>
      row("tag", `Healthy ${i}`, "micro", 120, 0.05, 90 - i),
    );
    const dying = row("tag", "Dying Tag", "micro", -55, 0.05, 4);
    fetchMock([...GENRES], [...crowd, dying]);

    renderRadar("/radar?top=40");
    expect(await screen.findByText("Dying Tag")).toBeTruthy();
  });

  it("still gives the bulk of the slots to the ring that holds the bulk", async () => {
    const crowd = Array.from({ length: 30 }, (_, i) =>
      row("tag", `Healthy ${i}`, "micro", 120, 0.05, 90 - i),
    );
    const dying = row("tag", "Dying Tag", "micro", -55, 0.05, 4);
    fetchMock([...GENRES], [...crowd, dying]);

    renderRadar("/radar?top=40");
    await screen.findByText("Dying Tag");
    // The floor is a handful, not an equal split: the healthy ring keeps most of the cap.
    const healthy = crowd.filter((r) => screen.queryByText(r.key) !== null).length;
    expect(healthy).toBeGreaterThan(5);
  });
});

describe("Radar — shareable URL state", () => {
  it("writes nothing for the default view", async () => {
    renderRadar();
    await screen.findByTestId("radar-row-tag:Roguelike Deckbuilder");
    expect(url()).toBe("/radar");
  });

  it("restores class, solo lens and Top-N from the URL on load", async () => {
    // ?class= is unchanged as a contract and changed in meaning: it now selects the
    // EMPHASISED wedge. An old ?class=theme link still opens the view it named — the themes
    // wedge, lit — it just also shows the other two classes around it.
    renderRadar("/radar?class=theme&solo=off&top=40");
    expect(await screen.findByTestId("radar-row-tag:Fishing")).toBeTruthy();
    expect(screen.getByTestId("radar-row-tag:Horror")).toBeTruthy();
    expect(screen.getByTestId("radar-row-tag:Fishing").getAttribute("data-off-class")).toBeNull();
    expect(screen.getByTestId("radar-row-tag:Roguelike Deckbuilder").getAttribute("data-off-class")).toBe("micro");
    // The controls reflect the URL, not their defaults.
    expect(screen.getByText(/theme tags emphasised/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Off" }).className).toContain("bg-brand");
    expect(screen.getByRole("button", { name: "40" }).className).toContain("bg-brand");
  });

  it("opens the dossier named by ?niche= — a deep link to one verdict", async () => {
    renderRadar("/radar?niche=tag%3ACity+Builder");
    const dossier = await screen.findByTestId("verdict-dossier");
    expect(dossier.textContent).toContain("City Builder");
  });

  it("every control writes its param, and returning to a default clears it", async () => {
    renderRadar();
    await screen.findByTestId("radar-row-tag:Roguelike Deckbuilder");

    fireEvent.click(screen.getByRole("button", { name: "Themes" }));
    expect(url()).toBe("/radar?class=theme");

    fireEvent.click(screen.getByRole("button", { name: "Off" }));
    expect(url()).toContain("solo=off");

    fireEvent.click(screen.getByRole("button", { name: "40" }));
    expect(url()).toContain("top=40");

    // Back to every default: the params drop out rather than lingering as noise.
    fireEvent.click(screen.getByRole("button", { name: "Micro-genres" }));
    fireEvent.click(screen.getByRole("button", { name: "On" }));
    fireEvent.click(screen.getByRole("button", { name: "80" }));
    expect(url()).toBe("/radar");
  });

  it("a cross-class selection writes BOTH params in one go — neither clobbers the other", async () => {
    renderRadar();
    await screen.findByTestId("radar-row-tag:Roguelike Deckbuilder");

    fireEvent.change(screen.getByTestId("radar-search"), { target: { value: "simulation" } });
    fireEvent.click(screen.getByTestId("radar-row-genre:Simulation"));

    const u = url();
    expect(u).toContain("class=genre");
    expect(u).toContain("niche=genre%3ASimulation");
  });

  it("garbage params fall back to the defaults instead of breaking the board", async () => {
    // ?zoom=growing-open is a REAL link the XY plate used to mint, before the 2026-09-10
    // rebuild made RADAR_REGIONS the ring vocabulary — it must degrade to the full board,
    // exactly like any other unknown value.
    renderRadar("/radar?class=nonsense&top=9999&zoom=growing-open");
    expect(await screen.findByTestId("radar-row-tag:Roguelike Deckbuilder")).toBeTruthy();
    expect(screen.getByText(/micro-genre tags/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "80" }).className).toContain("bg-brand");
    // An unknown ring is the FULL board, not an empty one.
    expect(screen.queryByTestId("radar-zoom-chip")).toBeNull();
    expect(screen.getByTestId("radar-row-tag:City Builder")).toBeTruthy();
  });
});

/**
 * THE RING ZOOM RIDES THE URL TOO (2026-09-01) — it was the one radar control that didn't,
 * while class / solo / top / niche all did. Reproduction: click a region, the rail filters
 * to a chip and the plate titles itself "— ZOOMED", but the address bar still says /radar
 * and a reload loses it.
 *
 * The zoom's vocabulary changed with the 2026-09-10 concentric-ring rebuild: the regions
 * were the XY plate's four quadrants plus its strip, and they are now the five VERDICT
 * RINGS (RADAR_REGIONS === RING_ORDER). An old ?zoom=growing-open link falls back to the
 * unzoomed board, which is the same graceful fallback any garbage value gets — see the
 * "garbage params" test above, which pins exactly that shape.
 */
describe("Radar — the ring zoom is shareable", () => {
  it("clicking a ring writes ?zoom= and filters the rail to its members", async () => {
    renderRadar();
    await screen.findByTestId("radar-row-tag:Roguelike Deckbuilder");
    expect(url()).toBe("/radar");

    fireEvent.click(screen.getByTestId("radar-region-watch"));

    expect(url()).toBe("/radar?zoom=watch");
    expect(screen.getByTestId("radar-zoom-chip").textContent).toContain("WATCH");
    expect(screen.getByTestId("radar-row-tag:Roguelike Deckbuilder")).toBeTruthy();
    expect(screen.queryByTestId("radar-row-tag:City Builder")).toBeNull();
  });

  it("a fresh mount on ?zoom= opens ZOOMED — the copied URL is the whole view", async () => {
    renderRadar("/radar?zoom=enter");
    // The zoomed slice, from the first paint: only that ring's member.
    expect(await screen.findByTestId("radar-row-tag:City Builder")).toBeTruthy();
    expect(screen.queryByTestId("radar-row-tag:Roguelike Deckbuilder")).toBeNull();
    // …with every zoom affordance the click-path produces.
    expect(screen.getByTestId("radar-zoom-chip").textContent).toContain("ENTER NOW");
    expect(screen.getByText("ENTER NOW — ZOOMED")).toBeTruthy();
    expect(screen.getByTestId("radar-zoom-exit")).toBeTruthy();
    expect(screen.queryByTestId("radar-region-enter")).toBeNull();
    // The zoomed band owns the whole dial; the other four are not drawn at all.
    expect(screen.getByTestId("ring-band-enter")).toBeTruthy();
    expect(screen.queryByTestId("ring-band-declining")).toBeNull();
    // The scoped search names the zoomed ring, not the whole pool.
    expect((screen.getByTestId("radar-search") as HTMLInputElement).placeholder).toContain("in ENTER NOW");
    // The URL is left exactly as shared.
    expect(url()).toBe("/radar?zoom=enter");
  });

  it("all three exits clear the param, not just the view", async () => {
    renderRadar();
    await screen.findByTestId("radar-row-tag:Roguelike Deckbuilder");
    const zoomIn = () => fireEvent.click(screen.getByTestId("radar-region-watch"));

    // Each leg asserts the zoom really landed in the URL first — otherwise "it's gone
    // afterwards" would also hold on a page that never wrote it.
    zoomIn();
    expect(url()).toBe("/radar?zoom=watch");
    fireEvent.click(screen.getByTestId("radar-zoom-chip"));
    expect(url()).toBe("/radar");

    zoomIn();
    expect(url()).toBe("/radar?zoom=watch");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(url()).toBe("/radar");

    zoomIn();
    expect(url()).toBe("/radar?zoom=watch");
    fireEvent.click(screen.getByTestId("radar-zoom-exit"));
    expect(url()).toBe("/radar");
    expect(screen.getByTestId("radar-row-tag:City Builder")).toBeTruthy();
  });

  it("keeps the sector labels while zoomed — the wedges do not go away, so their names must not", async () => {
    // Reported after the ring rebuild: "why themes/genres/micro themes gets missing when you
    // zoom in into category on a radar". The zoom banner had REPLACED the rim labels in the
    // annotation layer, while the three divider spokes kept drawing — so the reader was left
    // with three unlabelled wedges and no way to tell which class was which.
    renderRadar("/radar?zoom=enter");
    expect(await screen.findByText("ENTER NOW — ZOOMED")).toBeTruthy();
    for (const sector of ["genre", "micro", "theme"]) {
      expect(screen.getByTestId(`radar-sector-label-${sector}`)).toBeTruthy();
    }
    // And the spokes they name are still on the dial.
    expect(screen.getByTestId("radar-spoke-genre")).toBeTruthy();
  });

  it("the zoom composes with its four siblings in one shareable URL", async () => {
    renderRadar("/radar?class=theme&solo=off&top=40");
    await screen.findByTestId("radar-row-tag:Fishing");
    // Fishing (demand 80 / sat 0.05) is the themes board's ENTER NOW member.
    fireEvent.click(screen.getByTestId("radar-region-enter"));

    const u = url();
    expect(u).toContain("class=theme");
    expect(u).toContain("solo=off");
    expect(u).toContain("top=40");
    expect(u).toContain("zoom=enter");
    expect(screen.getByTestId("radar-row-tag:Fishing")).toBeTruthy();
    expect(screen.queryByTestId("radar-row-tag:Horror")).toBeNull();
  });

  it("a dot click inside the zoom keeps BOTH params — the dossier doesn't drop the zoom", async () => {
    renderRadar("/radar?zoom=watch");
    const dot = await screen.findByTestId("radar-blip-tag:Roguelike Deckbuilder");
    // The board really is zoomed, not merely carrying an inert param: the other ring's
    // dot is not on the dial.
    expect(screen.queryByTestId("radar-blip-tag:City Builder")).toBeNull();

    fireEvent.click(dot);

    const u = url();
    expect(u).toContain("zoom=watch");
    expect(u).toContain("niche=tag%3ARoguelike+Deckbuilder");
    expect(screen.getByTestId("verdict-dossier").textContent).toContain("Roguelike Deckbuilder");
    // Back out of the dossier and the zoom is still there — one URL, two live params.
    fireEvent.click(screen.getByRole("button", { name: /back to all verdicts/i }));
    expect(screen.getByTestId("radar-zoom-chip")).toBeTruthy();
    expect(url()).toBe("/radar?zoom=watch");
  });
});

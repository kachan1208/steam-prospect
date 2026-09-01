import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import Radar from "./Radar";
import { ThemeProvider } from "../lib/theme";

/**
 * The CLASS PICKER contract (2026-08-27 directive: "score Genres, Micro-genres and
 * Themes separately — user has to pick what he wants to research"):
 *
 * 1. The board scores ONE class at a time — default Micro-genres — and the rail list +
 *    counts follow the picker honestly (a themes count never leaks into a micro view).
 * 2. The SEARCH deliberately ignores the picker: it spans the whole pool across all
 *    classes, and selecting a cross-class hit switches the picker to that class first,
 *    so the dossier always opens over the board that contains the niche.
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
const TAGS = [
  row("tag", "Roguelike Deckbuilder", "micro", 196, 0.409, 71),
  row("tag", "City Builder", "micro", 12, 0.1, 60),
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

describe("Radar — class picker", () => {
  it("defaults to Micro-genres and scopes the board + rail to that class, honest counts", async () => {
    renderRadar();
    expect(await screen.findByTestId("radar-row-tag:Roguelike Deckbuilder")).toBeTruthy();
    expect(screen.getByTestId("radar-row-tag:City Builder")).toBeTruthy();
    // No cross-class leakage into the rail list…
    expect(screen.queryByTestId("radar-row-genre:Simulation")).toBeNull();
    expect(screen.queryByTestId("radar-row-tag:Fishing")).toBeNull();
    // …and the header count is the CLASS count, not the pool count.
    expect(screen.getByText("Verdicts").parentElement?.textContent).toContain("2");
    // The kicker names the active class.
    expect(screen.getByText(/micro-genre tags/)).toBeTruthy();
    // The search still states the whole pool (all six niches, every class).
    expect((screen.getByTestId("radar-search") as HTMLInputElement).placeholder).toContain("all 6 niches");
  });

  it("switching the class re-scopes the board and recomputes the counts", async () => {
    renderRadar();
    await screen.findByTestId("radar-row-tag:Roguelike Deckbuilder");

    fireEvent.click(screen.getByRole("button", { name: "Themes" }));
    expect(screen.getByTestId("radar-row-tag:Fishing")).toBeTruthy();
    expect(screen.getByTestId("radar-row-tag:Horror")).toBeTruthy();
    expect(screen.queryByTestId("radar-row-tag:Roguelike Deckbuilder")).toBeNull();
    expect(screen.getByText(/theme tags/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Genres" }));
    expect(screen.getByTestId("radar-row-genre:Simulation")).toBeTruthy();
    expect(screen.getByTestId("radar-row-genre:Strategy")).toBeTruthy();
    expect(screen.queryByTestId("radar-row-tag:Fishing")).toBeNull();
  });

  it("a cross-class search hit switches the picker to its class and opens its dossier", async () => {
    renderRadar();
    await screen.findByTestId("radar-row-tag:Roguelike Deckbuilder");

    // Search spans ALL classes while the board shows micro only.
    fireEvent.change(screen.getByTestId("radar-search"), { target: { value: "simulation" } });
    const hit = screen.getByTestId("radar-row-genre:Simulation");
    expect(hit).toBeTruthy();

    fireEvent.click(hit);
    // The dossier opens — and because the picker switched to Genres first, Simulation
    // is now PLOTTED (top of its class), so no beyond-plot note appears.
    const dossier = screen.getByTestId("verdict-dossier");
    expect(dossier.textContent).toContain("Simulation");
    expect(dossier.textContent).not.toContain("Beyond the Top");

    // Back + clear: the rail now lists the GENRE class — the picker really moved.
    fireEvent.click(screen.getByRole("button", { name: /back to all verdicts/i }));
    fireEvent.keyDown(screen.getByTestId("radar-search"), { key: "Escape" });
    expect(screen.getByTestId("radar-row-genre:Strategy")).toBeTruthy();
    expect(screen.queryByTestId("radar-row-tag:Roguelike Deckbuilder")).toBeNull();
  });
});

/**
 * URL STATE (2026-08-28). The flagship page was the only surface whose view couldn't be
 * linked — class, solo lens, Top-N and the open dossier all lived in useState. They ride
 * search params now, with DEFAULTS OMITTED so a pristine /radar stays a clean URL.
 */
describe("Radar — shareable URL state", () => {
  it("writes nothing for the default view", async () => {
    renderRadar();
    await screen.findByTestId("radar-row-tag:Roguelike Deckbuilder");
    expect(url()).toBe("/radar");
  });

  it("restores class, solo lens and Top-N from the URL on load", async () => {
    renderRadar("/radar?class=theme&solo=off&top=40");
    expect(await screen.findByTestId("radar-row-tag:Fishing")).toBeTruthy();
    expect(screen.getByTestId("radar-row-tag:Horror")).toBeTruthy();
    expect(screen.queryByTestId("radar-row-tag:Roguelike Deckbuilder")).toBeNull();
    // The controls reflect the URL, not their defaults.
    expect(screen.getByText(/theme tags/)).toBeTruthy();
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
    renderRadar("/radar?class=nonsense&top=9999&zoom=narnia");
    expect(await screen.findByTestId("radar-row-tag:Roguelike Deckbuilder")).toBeTruthy();
    expect(screen.getByText(/micro-genre tags/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "80" }).className).toContain("bg-brand");
    // An unknown region is the FULL board, not an empty one.
    expect(screen.queryByTestId("radar-zoom-chip")).toBeNull();
    expect(screen.getByTestId("radar-row-tag:City Builder")).toBeTruthy();
  });
});

/**
 * THE QUADRANT ZOOM RIDES THE URL TOO (2026-09-01) — it was the one radar control that
 * didn't, while class / solo / top / niche all did. Reproduction: click a quadrant, the
 * rail filters to a chip ("FLAT/SHRINKING · OPEN 32 niches ✕") and the plate titles
 * itself "— ZOOMED", but the address bar still says /radar and a reload loses it.
 *
 * The fixture puts exactly one micro niche in each of two quadrants (the verdict bars
 * are +40% demand / +15% saturation YoY): Roguelike Deckbuilder at demand 196 / sat
 * 0.409 is GROWING · FLOODING, City Builder at 12 / 0.1 is FLAT/SHRINKING · OPEN.
 */
describe("Radar — the quadrant zoom is shareable", () => {
  it("clicking a quadrant writes ?zoom= and filters the rail to its members", async () => {
    renderRadar();
    await screen.findByTestId("radar-row-tag:Roguelike Deckbuilder");
    expect(url()).toBe("/radar");

    fireEvent.click(screen.getByTestId("radar-region-growing-flooding"));

    expect(url()).toBe("/radar?zoom=growing-flooding");
    expect(screen.getByTestId("radar-zoom-chip").textContent).toContain("GROWING · FLOODING");
    expect(screen.getByTestId("radar-row-tag:Roguelike Deckbuilder")).toBeTruthy();
    expect(screen.queryByTestId("radar-row-tag:City Builder")).toBeNull();
  });

  it("a fresh mount on ?zoom= opens ZOOMED — the copied URL is the whole view", async () => {
    renderRadar("/radar?zoom=shrinking-open");
    // The zoomed slice, from the first paint: only that quadrant's member.
    expect(await screen.findByTestId("radar-row-tag:City Builder")).toBeTruthy();
    expect(screen.queryByTestId("radar-row-tag:Roguelike Deckbuilder")).toBeNull();
    // …with every zoom affordance the click-path produces.
    expect(screen.getByTestId("radar-zoom-chip").textContent).toContain("FLAT/SHRINKING · OPEN");
    expect(screen.getByText("FLAT/SHRINKING · OPEN — ZOOMED")).toBeTruthy();
    expect(screen.getByTestId("radar-zoom-exit")).toBeTruthy();
    expect(screen.queryByTestId("radar-region-shrinking-open")).toBeNull();
    // The scoped search names the zoomed region, not the whole pool.
    expect((screen.getByTestId("radar-search") as HTMLInputElement).placeholder).toContain(
      "in FLAT/SHRINKING · OPEN",
    );
    // The URL is left exactly as shared.
    expect(url()).toBe("/radar?zoom=shrinking-open");
  });

  it("all three exits clear the param, not just the view", async () => {
    renderRadar();
    await screen.findByTestId("radar-row-tag:Roguelike Deckbuilder");
    const zoomIn = () => fireEvent.click(screen.getByTestId("radar-region-growing-flooding"));

    // Each leg asserts the zoom really landed in the URL first — otherwise "it's gone
    // afterwards" would also hold on a page that never wrote it.
    zoomIn();
    expect(url()).toBe("/radar?zoom=growing-flooding");
    fireEvent.click(screen.getByTestId("radar-zoom-chip"));
    expect(url()).toBe("/radar");

    zoomIn();
    expect(url()).toBe("/radar?zoom=growing-flooding");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(url()).toBe("/radar");

    zoomIn();
    expect(url()).toBe("/radar?zoom=growing-flooding");
    fireEvent.click(screen.getByTestId("radar-zoom-exit"));
    expect(url()).toBe("/radar");
    expect(screen.getByTestId("radar-row-tag:City Builder")).toBeTruthy();
  });

  it("the zoom composes with its four siblings in one shareable URL", async () => {
    renderRadar("/radar?class=theme&solo=off&top=40");
    await screen.findByTestId("radar-row-tag:Fishing");
    // Fishing (demand 80 / sat 0.05) is the themes board's GROWING · OPEN member.
    fireEvent.click(screen.getByTestId("radar-region-growing-open"));

    const u = url();
    expect(u).toContain("class=theme");
    expect(u).toContain("solo=off");
    expect(u).toContain("top=40");
    expect(u).toContain("zoom=growing-open");
    expect(screen.getByTestId("radar-row-tag:Fishing")).toBeTruthy();
    expect(screen.queryByTestId("radar-row-tag:Horror")).toBeNull();
  });

  it("a dot click inside the zoom keeps BOTH params — the dossier doesn't drop the zoom", async () => {
    renderRadar("/radar?zoom=growing-flooding");
    const dot = await screen.findByTestId("radar-blip-tag:Roguelike Deckbuilder");
    // The board really is zoomed, not merely carrying an inert param: the other
    // quadrant's dot is not on the plate.
    expect(screen.queryByTestId("radar-blip-tag:City Builder")).toBeNull();

    fireEvent.click(dot);

    const u = url();
    expect(u).toContain("zoom=growing-flooding");
    expect(u).toContain("niche=tag%3ARoguelike+Deckbuilder");
    expect(screen.getByTestId("verdict-dossier").textContent).toContain("Roguelike Deckbuilder");
    // Back out of the dossier and the zoom is still there — one URL, two live params.
    fireEvent.click(screen.getByRole("button", { name: /back to all verdicts/i }));
    expect(screen.getByTestId("radar-zoom-chip")).toBeTruthy();
    expect(url()).toBe("/radar?zoom=growing-flooding");
  });
});

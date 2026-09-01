import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation, useNavigate } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import Studios from "./Studios";
import { ThemeProvider } from "../lib/theme";
import type { EntityRole, EntitySearchRow } from "../lib/api";

/**
 * THE FILTER STATE IS THE URL (?role=developer&q=larian).
 *
 * Both controls used to be useState, and the reproduction was: click Developers (first
 * row → "FromSoftware, Inc."), type "larian" (→ "Larian Studios"), reload — Publishers,
 * empty box, Electronic Arts / Bandai Namco / Ubisoft. /niches/:dim/:key promises on
 * screen that its filter lives in the URL; this page silently dropped yours.
 *
 * Pinned here, in both directions, because either half alone is worthless:
 *  1. WRITE — applying a control puts it in the URL (that is what you copy), with the
 *     defaults omitted so a pristine /studios stays clean.
 *  2. READ — a fresh mount on that URL renders the same slice: the request carries the
 *     role and q, the toggle shows the right side, the box shows the text.
 *  3. The role toggle PUSHES, so the back button walks it (matching /games); the
 *     debounced box REPLACES, so typing doesn't bury the previous page in history.
 */

function studioRow(name: string, role: EntityRole): EntitySearchRow {
  return {
    role,
    name,
    n_games: 12,
    first_release_year: 2010,
    last_release_year: 2025,
    n_recent_24m: 2,
    total_rev: 5_000_000,
    median_rev: 200_000,
    p90_rev: 1_000_000,
    hit_rate_200k: 0.5,
    top_genres: ["RPG"],
  };
}

// What production actually serves for each of the four slices this test drives.
const PUBLISHERS = ["Electronic Arts", "Bandai Namco Entertainment", "Ubisoft"];
const DEVELOPERS = ["FromSoftware, Inc.", "Capcom", "Ubisoft Montreal"];

let requests: string[] = [];

function rowsFor(url: string): EntitySearchRow[] {
  const role: EntityRole = url.includes("role=developer") ? "developer" : "publisher";
  const q = /[?&]q=([^&]*)/.exec(url)?.[1] ?? "";
  if (decodeURIComponent(q).toLowerCase() === "larian") return [studioRow("Larian Studios", role)];
  return (role === "developer" ? DEVELOPERS : PUBLISHERS).map((n) => studioRow(n, role));
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

function goBack() {
  fireEvent.click(screen.getByTestId("go-back"));
}

/** The rendered leaderboard, in row order. */
function names(): string[] {
  return screen
    .getAllByRole("row")
    .slice(1) // header
    .map((r) => r.querySelector("td")?.textContent?.trim() ?? "");
}

function searchBox(): HTMLInputElement {
  return screen.getByPlaceholderText(/^Search (publishers|developers) by name…$/) as HTMLInputElement;
}

/** A FRESH mount on `entry` — the "open the copied URL in a new tab" case. */
function renderStudios(entry = "/studios") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={client}>
      <ThemeProvider>
        <MemoryRouter initialEntries={[entry]}>
          <Studios />
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
      const items = rowsFor(u);
      return new Response(JSON.stringify({ items, total: items.length, limit: 50 }), {
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

describe("Studios — shareable URL state", () => {
  it("the role toggle writes ?role=developer; the default view writes nothing", async () => {
    renderStudios();
    await screen.findByText("Electronic Arts");
    // Defaults omitted — a pristine /studios stays a clean URL.
    expect(url()).toBe("/studios");

    fireEvent.click(screen.getByRole("button", { name: "Developers" }));
    expect(url()).toBe("/studios?role=developer");
    await screen.findByText("FromSoftware, Inc.");

    fireEvent.click(screen.getByRole("button", { name: "Publishers" }));
    expect(url()).toBe("/studios");
  });

  it("the search box writes ?q= after its debounce", async () => {
    renderStudios();
    await screen.findByText("Electronic Arts");

    fireEvent.change(searchBox(), { target: { value: "larian" } });
    await waitFor(() => expect(url()).toBe("/studios?q=larian"));
    await screen.findByText("Larian Studios");
  });

  it("a fresh mount on ?role=developer&q=larian restores BOTH — request, toggle and box", async () => {
    renderStudios("/studios?role=developer&q=larian");
    // The slice the URL asked for, not the default one.
    expect(await screen.findByText("Larian Studios")).toBeTruthy();
    expect(names()).toEqual(["Larian Studios"]);
    expect(screen.queryByText("Electronic Arts")).toBeNull();
    // The controls agree with the URL…
    expect(searchBox().value).toBe("larian");
    expect(screen.getByRole("button", { name: "Developers" }).className).toContain("bg-surface ");
    // …and the request carried both, so this is the real slice, not a relabeled default.
    const req = requests.find((u) => u.includes("/entities/search"))!;
    expect(req).toContain("role=developer");
    expect(req).toContain("q=larian");
    // Searching drops the browse floor to 1 (BROWSE_MIN_GAMES only applies while browsing).
    expect(req).toContain("min_games=1");
    // The URL is left exactly as shared — no echo rewrite.
    expect(url()).toBe("/studios?role=developer&q=larian");
  });

  it("a fresh mount on ?role=developer alone browses developers with the browse floor", async () => {
    renderStudios("/studios?role=developer");
    expect(await screen.findByText("FromSoftware, Inc.")).toBeTruthy();
    expect(names()).toEqual(DEVELOPERS);
    const req = requests.find((u) => u.includes("/entities/search"))!;
    expect(req).toContain("role=developer");
    expect(req).toContain("min_games=3");
  });

  it("reads the role param strictly: 'developer' is honoured, garbage falls back to Publishers", async () => {
    // Both halves in one test on purpose — the fallback alone would pass against a page
    // that ignores the param entirely, which is exactly the bug this file exists for.
    const good = renderStudios("/studios?role=developer");
    expect(await screen.findByText("FromSoftware, Inc.")).toBeTruthy();
    good.unmount();

    requests = [];
    renderStudios("/studios?role=wizard");
    expect(await screen.findByText("Electronic Arts")).toBeTruthy();
    expect(requests.find((u) => u.includes("/entities/search"))!).toContain("role=publisher");
  });

  it("the role toggle pushes (back undoes it) and the box resyncs from the URL", async () => {
    renderStudios();
    await screen.findByText("Electronic Arts");

    fireEvent.click(screen.getByRole("button", { name: "Developers" }));
    await screen.findByText("FromSoftware, Inc.");

    goBack();
    await waitFor(() => expect(url()).toBe("/studios"));
    expect(await screen.findByText("Electronic Arts")).toBeTruthy();
  });

  it("typing REPLACES — one back from a typed slice reaches the entry before it, not a keystroke", async () => {
    renderStudios();
    await screen.findByText("Electronic Arts");

    fireEvent.click(screen.getByRole("button", { name: "Developers" })); // one history entry
    await screen.findByText("FromSoftware, Inc.");
    fireEvent.change(searchBox(), { target: { value: "larian" } }); // replaces it, adds none
    await waitFor(() => expect(url()).toBe("/studios?role=developer&q=larian"));

    // Six keystrokes did NOT become six history entries: ONE back leaves the whole
    // typed slice behind, exactly as /games behaves.
    goBack();
    await waitFor(() => expect(url()).toBe("/studios"));
    // …and the box follows the URL back rather than keeping the stale draft.
    await waitFor(() => expect(searchBox().value).toBe(""));
  });
});

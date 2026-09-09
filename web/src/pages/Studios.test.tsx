import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation, useNavigate } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import Studios from "./Studios";
import { ThemeProvider } from "../lib/theme";
import type { EntityRole, EntitySearchRow } from "../lib/api";

/**
 * THE FILTER STATE IS THE URL (?role=developer&q=larian&sort=n_games&order=asc&offset=25).
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
 *
 * Sort, order and offset joined the URL when the page moved onto /games' search
 * primitives (components/search/*); they follow the same three rules, and the offset is
 * bounded by what the API will serve — the /games paging cliff, pre-empted here.
 */

function studioRow(name: string, role: EntityRole, overrides: Partial<EntitySearchRow> = {}): EntitySearchRow {
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
    ...overrides,
  };
}

// What production actually serves for each of the slices this test drives.
const PUBLISHERS = ["Electronic Arts", "Bandai Namco Entertainment", "Ubisoft"];
const DEVELOPERS = ["FromSoftware, Inc.", "Capcom", "Ubisoft Montreal"];
// Per-row top genres for the browse slices: RPG and Action twice each, Strategy once.
const GENRES = [["RPG"], ["RPG", "Action"], ["Action", "Strategy"]];

let requests: string[] = [];
/** The `total` the mock reports — larger than the page when a test needs paging. */
let totalOverride: number | null = null;

function params(url: string): URLSearchParams {
  return new URL(url, "http://x").searchParams;
}

function rowsFor(url: string): EntitySearchRow[] {
  const sp = params(url);
  const role: EntityRole = sp.get("role") === "developer" ? "developer" : "publisher";
  const q = (sp.get("q") ?? "").toLowerCase();
  if (q === "larian") return [studioRow("Larian Studios", role)];
  // A two-game record: enough to list, not enough for a hit rate.
  if (q === "thin") return [studioRow("Two Hit Wonder", role, { n_games: 2, hit_rate_200k: 1 })];
  return (role === "developer" ? DEVELOPERS : PUBLISHERS).map((n, i) => studioRow(n, role, { top_genres: GENRES[i] }));
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

/** The rendered leaderboard, in row order — the first line of each profile link. */
function names(): string[] {
  return screen
    .getAllByRole("link")
    .filter((a) => (a.getAttribute("href") ?? "").startsWith("/entity/"))
    .map((a) => a.firstElementChild?.textContent?.trim() ?? "");
}

function searchBox(): HTMLInputElement {
  return screen.getByPlaceholderText(/^Search (publishers|developers) by name…$/) as HTMLInputElement;
}

function lastSearchRequest(): URLSearchParams {
  const u = [...requests].reverse().find((r) => r.includes("/entities/search"));
  if (!u) throw new Error("no /entities/search request yet");
  return params(u);
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
  totalOverride = null;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const u = String(input);
      requests.push(u);
      const items = rowsFor(u);
      const sp = params(u);
      const body = {
        items,
        total: totalOverride ?? items.length,
        limit: Number(sp.get("limit") ?? 25),
        offset: Number(sp.get("offset") ?? 0),
      };
      return new Response(JSON.stringify(body), {
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
    // Defaults omitted — a pristine /studios stays a clean URL…
    expect(url()).toBe("/studios");
    // …while the request spells every default out, so the API contract is explicit.
    const req = lastSearchRequest();
    expect(req.get("role")).toBe("publisher");
    expect(req.get("sort")).toBe("total_rev");
    expect(req.get("order")).toBe("desc");
    expect(req.get("limit")).toBe("25");
    expect(req.get("offset")).toBe("0");

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
    expect(screen.getByRole("button", { name: "Developers" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "Publishers" }).getAttribute("aria-pressed")).toBe("false");
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

describe("Studios — sort and paging ride the URL like /games", () => {
  it("the sort control writes ?sort=&order= and the request carries them; re-picking flips the direction", async () => {
    renderStudios();
    await screen.findByText("Electronic Arts");

    fireEvent.change(screen.getByLabelText("Sort by"), { target: { value: "n_games" } });
    expect(url()).toBe("/studios?sort=n_games&order=desc");
    await waitFor(() => expect(lastSearchRequest().get("sort")).toBe("n_games"));
    expect(lastSearchRequest().get("order")).toBe("desc");

    fireEvent.click(screen.getByRole("button", { name: "Toggle sort direction" }));
    expect(url()).toBe("/studios?sort=n_games&order=asc");
    await waitFor(() => expect(lastSearchRequest().get("order")).toBe("asc"));

    // Names read A→Z first, as on /games.
    fireEvent.change(screen.getByLabelText("Sort by"), { target: { value: "name" } });
    expect(url()).toBe("/studios?sort=name&order=asc");
  });

  it("a fresh mount on ?sort=name&order=asc&offset=25 restores all three — request and footer", async () => {
    totalOverride = 60;
    renderStudios("/studios?sort=name&order=asc&offset=25");
    await screen.findByText("Electronic Arts");
    const req = lastSearchRequest();
    expect(req.get("sort")).toBe("name");
    expect(req.get("order")).toBe("asc");
    expect(req.get("offset")).toBe("25");
    expect(await screen.findByText(/26–50 of 60/)).toBeTruthy();
    expect((screen.getByLabelText("Sort by") as HTMLSelectElement).value).toBe("name");
    // The URL is left exactly as shared — no echo rewrite.
    expect(url()).toBe("/studios?sort=name&order=asc&offset=25");
  });

  it("Next pushes ?offset=25 and Prev returns to the clean URL", async () => {
    totalOverride = 60;
    renderStudios();
    await screen.findByText("Electronic Arts");
    expect(await screen.findByText(/1–25 of 60/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Prev" }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(url()).toBe("/studios?offset=25");
    await waitFor(() => expect(lastSearchRequest().get("offset")).toBe("25"));
    expect(await screen.findByText(/26–50 of 60/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Prev" }));
    expect(url()).toBe("/studios");
    await waitFor(() => expect(lastSearchRequest().get("offset")).toBe("0"));
  });

  it("a role or search change restarts paging", async () => {
    totalOverride = 60;
    renderStudios("/studios?offset=25");
    await screen.findByText("Electronic Arts");

    fireEvent.click(screen.getByRole("button", { name: "Developers" }));
    expect(url()).toBe("/studios?role=developer");
    await screen.findByText("FromSoftware, Inc.");

    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(url()).toBe("/studios?role=developer&offset=25");
    fireEvent.change(searchBox(), { target: { value: "larian" } });
    await waitFor(() => expect(url()).toBe("/studios?role=developer&q=larian"));
  });

  it("never asks for an offset past the API's cap, and an unknown sort falls back to the default", async () => {
    renderStudios("/studios?offset=10025&sort=owners");
    await screen.findByText("Electronic Arts");
    for (const r of requests.filter((u) => u.includes("/entities/search"))) {
      expect(Number(params(r).get("offset") ?? 0)).toBeLessThanOrEqual(10_000);
      expect(params(r).get("sort")).toBe("total_rev");
    }
    // Not rewritten either — the URL is what was shared; only the request is bounded.
    expect(url()).toBe("/studios?offset=10025&sort=owners");
  });
});

describe("Studios — the rows", () => {
  it("opens the profile from a two-line title: name, then games · years · top genre", async () => {
    renderStudios();
    await screen.findByText("Electronic Arts");
    const link = screen.getByRole("link", { name: /Electronic Arts/ });
    expect(link.getAttribute("href")).toBe("/entity/publisher?name=Electronic%20Arts");
    expect(link.textContent).toContain("12 games · 2010–2025 · RPG");
    // Every metric column is labelled and explained on hover, as on /games.
    expect(screen.getByText("Total est. revenue").getAttribute("title")).toMatch(/estimate, not reported sales/i);
    expect(screen.getByText("Hit rate").getAttribute("title")).toMatch(/\$200K/);
    expect(screen.getByText("Games").getAttribute("title")).toMatch(/3\+/);
  });

  it("withholds the hit rate under three games, and says why", async () => {
    renderStudios("/studios?q=thin");
    await screen.findByText("Two Hit Wonder");
    const cell = screen.getByTitle("needs 3+ games");
    expect(cell.textContent).toBe("—");
    // …while a real record prints it.
    cleanup();
    renderStudios();
    await screen.findByText("Electronic Arts");
    expect(screen.queryByTitle("needs 3+ games")).toBeNull();
    expect(screen.getAllByText("50%").length).toBe(3);
  });

  it("pivots on the genres present in these results, most common first, into /games", async () => {
    renderStudios();
    await screen.findByText("Genres in these results:");
    const chips = screen
      .getAllByRole("link")
      .filter((a) => (a.getAttribute("href") ?? "").startsWith("/games?genre="));
    expect(chips.map((a) => a.textContent)).toEqual(["RPG", "Action", "Strategy"]);
    expect(chips[0].getAttribute("href")).toBe("/games?genre=RPG");
  });
});

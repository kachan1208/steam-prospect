import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import EntityProfile from "./EntityProfile";
import GameProfile from "./GameProfile";
import { ThemeProvider } from "../lib/theme";
import { ApiError, DEFAULT_QUERY_OPTIONS, notFoundReason, retryTransientOnce } from "../lib/api";

/**
 * The dead-end pages: what a user sees after typing (or being linked) a URL that names
 * something the catalog does not have. A live browser audit found three defects here, all of
 * them invisible to the happy-path tests, and all three are pinned below.
 *
 * 1. RETRY STORM. React Query's app-wide default was `retry: 1`, which applies to 404s.
 *    /games/999999999 fans out to five endpoints, so a missing game cost TEN failing
 *    requests — and, because every one of them had to drain before `isLoading` cleared, the
 *    page sat as header-and-footer-only for 6-9 SECONDS before printing a message the first
 *    response had already fully justified. A 404 is a fact, not a blip.
 * 2. DOUBLED PREFIX. The API's detail is already a sentence ("game not found: 999999999")
 *    and GameProfile prefixed it again: "Game not found: game not found: 999999999".
 * 3. NO WAY OUT. /entity/bogus?name=Valve printed one red line and offered no link
 *    anywhere — a dead end in the literal sense, unlike every other not-found state here.
 *
 * These are user-visible states, so they are asserted through a real render (routing, hooks
 * and all) rather than against the helpers alone: the helpers were already right for niches
 * when GameProfile was still stuttering, which is precisely the drift a unit test misses.
 */

/** The REAL app defaults (main.tsx builds its client from this exact object), so the retry
 * COUNT under test is the shipped policy and not a test-local invention. Only two knobs are
 * overridden, neither of which affects how many attempts happen: gcTime so nothing leaks
 * between tests, and retryDelay so a case that legitimately DOES retry doesn't spend
 * react-query's default ~1s backoff doing it. */
function testClient() {
  return new QueryClient({
    defaultOptions: { queries: { ...DEFAULT_QUERY_OPTIONS, gcTime: 0, retryDelay: 0 } },
  });
}

let fetchMock: ReturnType<typeof vi.fn>;

/** Every /api/... URL the render asked for, in order — the retry storm is counted here. */
function apiCalls(): string[] {
  return fetchMock.mock.calls.map((c) => String(c[0]));
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function renderAt(path: string) {
  return render(
    <QueryClientProvider client={testClient()}>
      <ThemeProvider>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/games/:appid" element={<GameProfile />} />
            <Route path="/entity/:role" element={<EntityProfile />} />
          </Routes>
        </MemoryRouter>
      </ThemeProvider>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

// ---- 1 + 2: the missing game ------------------------------------------------------------

describe("GameProfile — a game that does not exist", () => {
  beforeEach(() => {
    // Exactly what the API answers for an unknown appid, on EVERY /games/* endpoint the
    // page fans out to.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json({ detail: "game not found: 999999999" }, 404)),
    );
    fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
  });

  it("says 'Game not found' ONCE, not twice", async () => {
    renderAt("/games/999999999");
    // The bug rendered "Game not found: game not found: 999999999". Match the whole line so
    // a second copy of the phrase anywhere inside it fails the assertion.
    const line = await screen.findByText(/^Game not found/);
    expect(line.textContent).toBe("Game not found: 999999999");
    expect(line.textContent?.toLowerCase().match(/not found/g)).toHaveLength(1);
  });

  it("still shows the appid — the message keeps its reason, it just stops stuttering", async () => {
    renderAt("/games/999999999");
    const line = await screen.findByText(/^Game not found/);
    expect(line.textContent).toContain("999999999");
  });

  it("keeps a way back to search", async () => {
    renderAt("/games/999999999");
    const link = await screen.findByText("Back to search");
    expect(link.closest("a")?.getAttribute("href")).toBe("/games");
  });

  it("never re-requests a 404 — one attempt per endpoint, no storm", async () => {
    renderAt("/games/999999999");
    await screen.findByText(/^Game not found/);
    // Let any retry that WOULD have been scheduled fire before counting.
    await new Promise((r) => setTimeout(r, 50));

    const calls = apiCalls();
    expect(calls.length).toBeGreaterThan(0); // the page really did fetch
    const seen = new Set<string>();
    for (const url of calls) {
      expect(seen.has(url)).toBe(false); // a repeat of any URL IS the storm
      seen.add(url);
    }
  });

  it("reaches the not-found state without waiting on a retry backoff", async () => {
    // The 6-9s blank page was `isLoading` staying true until the retries drained. With
    // retries off for 4xx the state is reachable on the FIRST response — asserted here
    // against a client that has react-query's real (~1s) backoff, so a reinstated retry
    // cannot pass this in the few hundred ms waitFor allows.
    vi.stubGlobal("fetch", vi.fn(async () => json({ detail: "game not found: 4242" }, 404)));
    render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { ...DEFAULT_QUERY_OPTIONS, gcTime: 0 } } })}
      >
        <ThemeProvider>
          <MemoryRouter initialEntries={["/games/4242"]}>
            <Routes>
              <Route path="/games/:appid" element={<GameProfile />} />
            </Routes>
          </MemoryRouter>
        </ThemeProvider>
      </QueryClientProvider>,
    );
    await waitFor(() => expect(screen.getByText(/^Game not found/)).toBeTruthy(), { timeout: 800 });
  });

  it("DOES retry a 5xx — the fix must not disable retries wholesale", async () => {
    let profileCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        // The profile endpoint only (not its /trends, /teardown, … siblings).
        if (/\/api\/games\/4242$/.test(url)) {
          profileCalls += 1;
          return json({ detail: "boom" }, 500);
        }
        return json({ detail: "boom" }, 500);
      }),
    );
    renderAt("/games/4242");
    // 500 is a blip: one retry, so two attempts total.
    await waitFor(() => expect(profileCalls).toBe(2));
  });
});

// ---- 3: the malformed entity URL --------------------------------------------------------

describe("EntityProfile — an unroutable role in the URL", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json({ detail: "should never be called" }, 404)),
    );
    fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
  });

  it("explains the problem AND offers a way out", async () => {
    renderAt("/entity/bogus?name=Valve");
    expect(await screen.findByText(/Invalid entity role in the URL/)).toBeTruthy();
    // The defect: this state used to be a bare red sentence with no anchor at all.
    const back = await screen.findByText("Back to studios");
    expect(back.closest("a")?.getAttribute("href")).toBe("/studios");
  });

  it("offers the two valid spellings of the URL the user actually typed", async () => {
    renderAt("/entity/bogus?name=Valve");
    const dev = await screen.findByText("Valve as developer");
    const pub = await screen.findByText("Valve as publisher");
    expect(dev.closest("a")?.getAttribute("href")).toBe("/entity/developer?name=Valve");
    expect(pub.closest("a")?.getAttribute("href")).toBe("/entity/publisher?name=Valve");
  });

  it("fetches nothing at all — a bad role is decidable client-side", async () => {
    renderAt("/entity/bogus?name=Valve");
    await screen.findByText(/Invalid entity role in the URL/);
    expect(apiCalls()).toHaveLength(0);
  });

  it("still handles a missing ?name= and links out of that too", async () => {
    renderAt("/entity/developer");
    expect(await screen.findByText(/Missing \?name= in the URL/)).toBeTruthy();
    expect((await screen.findByText("Back to studios")).closest("a")).toBeTruthy();
    // No role/name pair to suggest here, so no did-you-mean links.
    expect(screen.queryByText(/ as developer$/)).toBeNull();
  });
});

// ---- the helpers the three fixes are built on -------------------------------------------

describe("notFoundReason", () => {
  it("strips the API's own lead-in so the page's heading doesn't stutter", () => {
    expect(notFoundReason(new ApiError(404, "game not found: 999999999"))).toBe("999999999");
    expect(notFoundReason(new ApiError(404, "niche not found: tag/Foo"))).toBe("tag/Foo");
  });

  it("returns nothing when the lead-in was the whole message", () => {
    // FastAPI's bare detail for an unrouted path. The caller's heading already says it.
    expect(notFoundReason(new ApiError(404, "Not Found"))).toBe("");
    expect(notFoundReason(new ApiError(404, "not found"))).toBe("");
  });

  it("passes a non-not-found message through — there the detail IS the information", () => {
    expect(notFoundReason(new ApiError(503, "marts are rebuilding"))).toBe("marts are rebuilding");
    expect(notFoundReason(new TypeError("Failed to fetch"))).toBe("Failed to fetch");
  });

  it("is safe on a non-Error rejection", () => {
    expect(notFoundReason(undefined)).toBe("");
    expect(notFoundReason("game not found: 1")).toBe("");
  });
});

describe("retryTransientOnce (the app-wide default)", () => {
  it("never retries a 4xx", () => {
    for (const status of [400, 401, 403, 404, 409, 422, 429]) {
      expect(retryTransientOnce(0, new ApiError(status, "no"))).toBe(false);
    }
  });

  it("retries a 5xx or a network error exactly once", () => {
    expect(retryTransientOnce(0, new ApiError(500, "boom"))).toBe(true);
    expect(retryTransientOnce(1, new ApiError(500, "boom"))).toBe(false);
    expect(retryTransientOnce(0, new TypeError("Failed to fetch"))).toBe(true);
    expect(retryTransientOnce(1, new TypeError("Failed to fetch"))).toBe(false);
  });

  it("never retries a cancelled fetch", () => {
    const abort = new Error("aborted");
    abort.name = "AbortError";
    expect(retryTransientOnce(0, abort)).toBe(false);
  });

  it("is what the app actually ships as its default", () => {
    // main.tsx builds its QueryClient straight from this object; if someone re-inlines a
    // bare `retry: 1` there, that is a two-line diff nothing else would notice.
    expect(DEFAULT_QUERY_OPTIONS.retry).toBe(retryTransientOnce);
  });
});

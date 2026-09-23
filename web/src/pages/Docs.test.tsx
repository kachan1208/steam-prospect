import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import Docs from "./Docs";

/**
 * The user guide states facts about the product, so it drifts silently when the product
 * moves. Pinned here (2026-09-23) are the claims the UX review caught false: a "footer
 * health dot" the shell no longer has, "exports aren't offered" beside two Export CSV
 * buttons, "Rogue-like and Roguelike are different tags" after the ETL merged them, a
 * corpus pinned to a month-old build, a first-10-minutes that began off-site, and an MCP
 * tool count the server outgrew.
 */

function json(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/health")) {
        return json({
          status: "ok",
          mart_version: "20260923",
          built_at: "2026-09-23T10:07:35+00:00",
          data_as_of: "2026-09-23",
          age_hours: 5,
          owners_as_of: "2026-07-07",
          source_db: null,
        });
      }
      if (url.startsWith("/api/market/benchmarks")) {
        return json({ cited: {}, computed: { n_games_total: 181_140 }, boxleiter_by_genre: [], tiers: [] });
      }
      if (url.startsWith("/api/refresh/history")) {
        return json({ runs: [{ result: "OK", counts: { games: 181_140, reviews: 63_070_000, articles: 1_130_000 } }] });
      }
      return json({});
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderDocs() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/docs"]}>
        <Docs />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("Docs — no claim the product has outgrown", () => {
  it("points at the footer's data date, never the retired 'health dot'", async () => {
    renderDocs();
    await waitFor(() => expect(document.body.textContent).toContain("Data as of Sep 23, 2026"));
    const text = document.body.textContent ?? "";
    expect(text).not.toMatch(/health dot/i);
    expect(text).toContain("the footer shows the same on every page");
  });

  it("reads the corpus size from the API instead of a month-old constant", async () => {
    renderDocs();
    await waitFor(() =>
      expect(document.body.textContent).toContain(
        "As of Sep 23, 2026: 181,140 games in the catalog, 63.1M reviews and 1.1M press articles",
      ),
    );
    expect(document.body.textContent).not.toContain("~52M");
    expect(document.body.textContent).not.toContain("mart 20260831:");
  });

  it("dates the SteamSpy snapshot behind every Owners figure", async () => {
    renderDocs();
    await waitFor(() => expect(document.body.textContent).toContain("taken Jul 7, 2026"));
  });

  it("says exports exist — the Finder and niche pages have Export CSV", () => {
    renderDocs();
    const text = document.body.textContent ?? "";
    expect(text).not.toContain("aren't offered.");
    expect(text).toContain("Export CSV");
  });

  it("describes merged tag twins, not 'different tags'", () => {
    renderDocs();
    const text = document.body.textContent ?? "";
    expect(text).not.toMatch(/as\s+different tags/);
    expect(text).toContain("“Rogue-like” is “Roguelike”");
    expect(text).toContain("Spelling twins are merged");
    expect(text).not.toContain("case- and hyphenation-sensitive");
  });

  it("starts the first 10 minutes on the Radar, and gets to the MCP last", () => {
    renderDocs();
    const section = document.getElementById("first-10")!;
    const steps = within(section).getAllByRole("listitem").map((li) => li.textContent ?? "");
    expect(steps[0]).toContain("Start on the Radar.");
    expect(steps[1]).toContain("Open its niche page");
    expect(steps[2]).toContain("Study a game that works there.");
    expect(steps[steps.length - 1]).toMatch(/ask your own Claude/);
  });

  it("states the verdict rule that landed: winner-take-most never rings Enter now", () => {
    renderDocs();
    expect(document.body.textContent).toContain("A winner-take-most niche never rings Enter now");
    expect(document.body.textContent).toContain("demand surging, but winner-take-most revenue");
  });

  it("names every MCP tool it counts", () => {
    renderDocs();
    const box = screen.getByText(/read-only analytics tools/).closest("div")!;
    const count = Number(/(\d+) read-only analytics tools/.exec(box.textContent ?? "")![1]);
    const names = within(box).getAllByText(/^[a-z_]+$/, { selector: "code" }).map((c) => c.textContent);
    // `methodology` is named twice (in the list and in the advice after it).
    expect(new Set(names).size).toBe(count);
    expect(names).toContain("niche_games");
    expect(names).toContain("methodology");
  });

  it("uses the glossary's names — no P90, no Opportunity v2, no 'Est. gross'", () => {
    renderDocs();
    const text = document.body.textContent ?? "";
    expect(text).not.toMatch(/\bP90\b/);
    expect(text).not.toContain("Opportunity v2");
    expect(text).not.toMatch(/Est\. gross/);
    expect(text).toContain("top-10% revenue");
  });
});

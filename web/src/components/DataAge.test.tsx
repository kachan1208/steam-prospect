import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

import { DataAge, DataAgeBanner } from "./DataAge";
import App from "../App";
import { ThemeProvider } from "../lib/theme";

/**
 * The shell's freshness readout and stale-data banner, against both /api/health shapes.
 * Time is pinned (fake Date only — react-query's timers stay real) so "N days old" is exact.
 */

const NOW = new Date("2026-09-22T12:00:00Z");

function memoryStorage(): Storage {
  let m = new Map<string, string>();
  return {
    get length() {
      return m.size;
    },
    clear: () => (m = new Map()),
    getItem: (k: string) => m.get(k) ?? null,
    key: (i: number) => [...m.keys()][i] ?? null,
    removeItem: (k: string) => void m.delete(k),
    setItem: (k: string, v: string) => void m.set(k, String(v)),
  } as Storage;
}

let session: Storage;

function stubHealth(body: unknown, status = 200) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/health")) {
        return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
      }
      const empty = url.includes("/api/niches?") ? { items: [], total: 0, limit: 50, offset: 0 } : {};
      return new Response(JSON.stringify(empty), { status: 200, headers: { "Content-Type": "application/json" } });
    }),
  );
}

function withClient(ui: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  session = memoryStorage();
  Object.defineProperty(window, "sessionStorage", { configurable: true, value: session });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const FRESH = { status: "ok", mart_version: "20260921", built_at: "2026-09-21T21:34:12+00:00", source_db: "x" };
const STALE = { ...FRESH, mart_version: "20260917", built_at: "2026-09-17T21:00:00+00:00" };

describe("DataAge — the footer readout", () => {
  it("says how old the data is, not just which build it is", async () => {
    stubHealth(FRESH);
    withClient(<DataAge />);
    const el = await screen.findByTestId("data-age");
    await waitFor(() => expect(el.textContent).toContain("Data as of Sep 21, 2026"));
    expect(el.textContent).toBe("API connected · Data as of Sep 21, 2026 · under a day old");
  });

  it("puts the build details in its ⓘ — mart version, pending build, owners snapshot", async () => {
    stubHealth({ ...FRESH, loaded_mart_version: "20260920", target_mart_version: "20260921", owners_as_of: "2026-09-01" });
    withClient(<DataAge />);
    const btn = await screen.findByRole("button", { name: "About Data freshness" });
    act(() => btn.focus());
    const tip = screen.getByRole("tooltip").textContent ?? "";
    expect(tip).toContain("Data build (mart) 20260920");
    expect(tip).toContain("A newer build (20260921) is ready but not loaded yet");
    expect(tip).toContain("SteamSpy snapshot of Sep 1, 2026");
  });

  it("flags an undated build instead of printing nothing", async () => {
    stubHealth({ status: "ok", mart_version: null, built_at: null, source_db: null });
    withClient(<DataAge />);
    await waitFor(() => expect(screen.getByTestId("data-age").textContent).toContain("data date unknown"));
  });

  it("reports an unreachable API without inventing a date", async () => {
    stubHealth({ detail: "boom" }, 500);
    withClient(<DataAge />);
    // useHealth retries a 5xx once (retryTransientOnce, ~1s back-off) before settling.
    await waitFor(() => expect(screen.getByTestId("data-age").textContent).toBe("API unreachable"), { timeout: 4000 });
  });
});

describe("DataAgeBanner — the stale-data warning", () => {
  it("renders nothing while the data is fresh", async () => {
    stubHealth(FRESH);
    withClient(<DataAgeBanner />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByTestId("data-age-banner")).toBeNull();
  });

  it("warns once the data is more than three days old", async () => {
    stubHealth(STALE);
    withClient(<DataAgeBanner />);
    const banner = await screen.findByTestId("data-age-banner");
    expect(banner.getAttribute("role")).toBe("status");
    expect(banner.textContent).toContain("Data hasn't refreshed in 4 days — numbers are as of Sep 17, 2026.");
  });

  it("uses the server's age_hours when the API sends it", async () => {
    stubHealth({ ...FRESH, age_hours: 80, data_as_of: "2026-09-19" });
    withClient(<DataAgeBanner />);
    expect((await screen.findByTestId("data-age-banner")).textContent).toContain(
      "Data hasn't refreshed in 3 days — numbers are as of Sep 19, 2026.",
    );
  });

  it("dismisses for the session — and a later stale build warns again", async () => {
    stubHealth(STALE);
    const first = withClient(<DataAgeBanner />);
    fireEvent.click(await screen.findByRole("button", { name: "Dismiss" }));
    expect(screen.queryByTestId("data-age-banner")).toBeNull();
    first.unmount();

    // Same build, same session (e.g. the next page load): stays dismissed.
    withClient(<DataAgeBanner />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByTestId("data-age-banner")).toBeNull();
    cleanup();

    // A different build that is also stale: warn again.
    stubHealth({ ...STALE, mart_version: "20260918", built_at: "2026-09-18T01:00:00+00:00" });
    withClient(<DataAgeBanner />);
    expect(await screen.findByTestId("data-age-banner")).toBeTruthy();
  });

  it("still works when session storage throws (private mode)", async () => {
    Object.defineProperty(window, "sessionStorage", {
      configurable: true,
      get() {
        throw new Error("SecurityError");
      },
    });
    stubHealth(STALE);
    withClient(<DataAgeBanner />);
    fireEvent.click(await screen.findByRole("button", { name: "Dismiss" }));
    expect(screen.queryByTestId("data-age-banner")).toBeNull();
  });
});

describe("App shell", () => {
  function renderApp() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    return render(
      <QueryClientProvider client={client}>
        <ThemeProvider>
          <MemoryRouter initialEntries={["/docs"]}>
            <App />
          </MemoryRouter>
        </ThemeProvider>
      </QueryClientProvider>,
    );
  }

  it("shows the data age in the footer, links Docs, and never states a refresh schedule", async () => {
    stubHealth(FRESH);
    renderApp();
    const footer = document.querySelector("footer")!;
    await waitFor(() => expect(footer.textContent).toContain("Data as of Sep 21, 2026 · under a day old"));
    expect(footer.textContent).not.toMatch(/mart 20260921/);
    expect(footer.textContent).not.toMatch(/UTC/);
    const docs = [...footer.querySelectorAll("a")].find((a) => a.textContent === "Docs");
    expect(docs?.getAttribute("href")).toBe("/docs");
  });

  it("raises the stale banner above every page", async () => {
    stubHealth(STALE);
    renderApp();
    expect(await screen.findByTestId("data-age-banner")).toBeTruthy();
  });
});

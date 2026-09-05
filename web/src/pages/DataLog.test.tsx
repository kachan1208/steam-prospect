import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import DataLog from "./DataLog";

/**
 * The nightly appends one JSON record per run; since 2026-09 `result` is OK / FAILED /
 * HELD / SKIPPED, and a HELD or SKIPPED row (nothing ran: a build hold was on, or the
 * refresh lock was already held) carries a `reason` and NO counts/deltas keys at all. The
 * page has to read those as a neutral state — not as a failure, and not as the "baseline
 * snapshot" that a missing `deltas` used to mean.
 */

const COUNTS = { games: 120_000, reviews: 16_000_000, articles: 1_128_930, players: 900_000 };
const FRESHNESS = { reviews: 1.5, articles: 2.0, players: 0.5, games: 3.0 };

const OK_RUN = {
  finished_at: "2026-09-03T02:41:10Z",
  result: "OK",
  duration_s: 20_470,
  step: "done",
  mart_version: "20260903",
  serving_version: "20260903",
  etl_rc: 0,
  etl_duration_s: 9_800,
  error: null,
  counts: COUNTS,
  deltas: { games: 12, reviews: 5_000, articles: 300, players: 4_000 },
  freshness_hours: FRESHNESS,
};

const ETL_ERROR =
  "duckdb.duckdb.OutOfMemoryException: Out of Memory Error: failed to allocate data of size 1.2 GiB (14.9 GiB/15.0 GiB used)";

const FAILED_RUN = {
  finished_at: "2026-09-02T03:12:00Z",
  result: "FAILED",
  duration_s: 15_300,
  step: "etl",
  mart_version: "20260901",
  serving_version: "20260901",
  etl_rc: 137,
  etl_duration_s: 7_200,
  error: ETL_ERROR,
  counts: COUNTS,
  deltas: { games: 0, reviews: 0, articles: 0, players: 0 },
  freshness_hours: FRESHNESS,
};

// A build that published its mart and then failed to bring the app back: the newest mart
// on disk is not the one being served.
const RESTART_FAILED_RUN = {
  ...FAILED_RUN,
  step: "restart",
  etl_rc: 0,
  error: null,
  mart_version: "20260903",
  serving_version: "20260902",
};

const HELD_RUN = {
  finished_at: "2026-09-03T21:00:05Z",
  result: "HELD",
  duration_s: 0,
  step: "hold",
  reason: "rescore in progress — do not rebuild the marts until it lands",
  mart_version: "20260903",
  serving_version: "20260903",
  etl_rc: null,
  etl_duration_s: null,
  error: null,
};

const SKIPPED_RUN = {
  finished_at: "2026-09-04T21:00:02Z",
  result: "SKIPPED",
  duration_s: 0,
  step: "lock",
  reason: "lock held: /root/.prospect-refresh.lock",
  mart_version: "20260903",
  serving_version: "20260903",
  etl_rc: null,
  etl_duration_s: null,
  error: null,
};

const NOTHING_RAN = "Nothing ran — the previous mart stayed in service.";

function mockHistory(runs: unknown[]) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    if (url.startsWith("/api/refresh/history")) return json({ runs, total: runs.length, limit: 60 });
    return json({ detail: `unexpected request: ${url}` }, 404);
  });
}

function renderDataLog(runs: unknown[]) {
  vi.stubGlobal("fetch", mockHistory(runs));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/datalog"]}>
        <DataLog />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** The status dot of the only card on screen. */
function dot(container: HTMLElement): Element {
  const el = container.querySelector(".h-2.w-2.rounded-full");
  if (!el) throw new Error("no status dot rendered");
  return el;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("run verdicts", () => {
  it("OK: green dot and label, the deltas, the mart — and no reason, error or serving line", async () => {
    const { container } = renderDataLog([OK_RUN]);
    const label = await screen.findByText("success");
    expect(label.className).toContain("text-verdict-good");
    expect(dot(container).className).toContain("text-verdict-good");
    expect(screen.getByText("+12 games")).toBeTruthy();
    expect(screen.getByText("mart").querySelector("code")?.textContent).toBe("20260903");
    expect(screen.getByText("took 341m 10s")).toBeTruthy();

    const body = document.body.textContent ?? "";
    expect(body).not.toContain("serving"); // same version as the mart — nothing to add
    expect(body).not.toContain("stopped at");
    expect(body).not.toContain(NOTHING_RAN);
  });

  it("FAILED: red treatment, where it stopped with the ETL's exit code, and the last error line in mono, truncated, full text in the title", async () => {
    const { container } = renderDataLog([FAILED_RUN]);
    const label = await screen.findByText("failed");
    expect(label.className).toContain("text-verdict-serious");
    expect(dot(container).className).toContain("text-verdict-serious");
    expect(screen.getByText("stopped at: etl (rc 137)").className).toContain("text-verdict-serious");

    const err = screen.getByTitle(ETL_ERROR);
    expect(err.textContent).toBe(ETL_ERROR);
    expect(err.className).toContain("font-mono");
    expect(err.className).toContain("truncate");

    // A FAILED night still ran: its deltas line and duration read exactly as before.
    expect(screen.getByText("No changes since the previous run.")).toBeTruthy();
    expect(screen.getByText("took 255m")).toBeTruthy();
  });

  it("names the mart actually in service only when it is not the newest one", async () => {
    renderDataLog([RESTART_FAILED_RUN]);
    await screen.findByText("failed");
    expect(screen.getByText("mart").querySelector("code")?.textContent).toBe("20260903");
    expect(screen.getByText("serving").querySelector("code")?.textContent).toBe("20260902");
    expect(screen.getByText("stopped at: restart")).toBeTruthy(); // rc 0 adds nothing
    expect(screen.queryByTitle(ETL_ERROR)).toBeNull(); // no error line without an error
  });

  it("HELD: muted dot and label, the hold reason where FAILED shows stopped-at, no baseline-snapshot or took-0s claim", async () => {
    const { container } = renderDataLog([HELD_RUN]);
    const label = await screen.findByText("held");
    expect(label.className).toContain("text-ink-muted");
    expect(dot(container).className).toContain("text-ink-muted");
    expect(container.querySelector(".text-verdict-serious")).toBeNull();
    expect(container.querySelector(".text-verdict-good")).toBeNull();
    expect(screen.getByText(HELD_RUN.reason)).toBeTruthy();
    expect(screen.getByText(NOTHING_RAN)).toBeTruthy();
    expect(screen.getByText("mart").querySelector("code")?.textContent).toBe("20260903");

    const body = document.body.textContent ?? "";
    expect(body).not.toContain("Baseline snapshot");
    expect(body).not.toContain("failed");
    expect(body).not.toContain("took 0s");
    expect(body).not.toContain("stopped at");
  });

  it("SKIPPED: the same neutral treatment, with the lock as the reason", async () => {
    const { container } = renderDataLog([SKIPPED_RUN]);
    const label = await screen.findByText("skipped");
    expect(label.className).toContain("text-ink-muted");
    expect(dot(container).className).toContain("text-ink-muted");
    expect(container.querySelector(".text-verdict-serious")).toBeNull();
    expect(screen.getByText("lock held: /root/.prospect-refresh.lock")).toBeTruthy();
    expect(screen.getByText(NOTHING_RAN)).toBeTruthy();
    expect(document.body.textContent).not.toContain("Baseline snapshot");
  });

  it("renders every kind together, in the order the API sent, with no state leaking between cards", async () => {
    renderDataLog([SKIPPED_RUN, HELD_RUN, OK_RUN, FAILED_RUN]); // the API already sorts newest-first
    await screen.findByText("skipped");
    const labels = screen.getAllByText(/^(success|failed|held|skipped)$/).map((el) => el.textContent);
    expect(labels).toEqual(["skipped", "held", "success", "failed"]);
    expect(screen.getAllByText(NOTHING_RAN)).toHaveLength(2);
    expect(screen.getAllByTitle(ETL_ERROR)).toHaveLength(1);
    expect(screen.getAllByText("+12 games")).toHaveLength(1);
  });
});

describe("schedule copy", () => {
  it("says when the nightly really runs: starts 21:00 UTC, usually done 00:45–03:30 — never the old 04:00", async () => {
    renderDataLog([OK_RUN]);
    await screen.findByText("success");
    const body = document.body.textContent ?? "";
    expect(body).toContain("starts at 21:00");
    expect(body).toContain("between 00:45 and 03:30");
    expect(body).not.toContain("04:00");
  });

  it("and so does the empty state", async () => {
    renderDataLog([]);
    await screen.findByText("No refreshes recorded yet");
    const body = document.body.textContent ?? "";
    expect(body).toContain("starts at 21:00");
    expect(body).not.toContain("04:00");
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";

import { fillMonthGaps, partialMonth } from "./monthSeries";
import { CSV_COLUMNS, csvField, exportNicheGamesCsv, nicheCsvFilename, nicheGamesCsv } from "./nicheCsv";
import { paidOnlyNote, paidStatSentinel, paidWithheld, PAID_MIN } from "./nichePaid";
import { medianNicheTrend, noMarketNote, readPlayersTrend } from "./playersTrend";
import type { NicheGameRow } from "./api";

describe("readPlayersTrend — the 7-day trend read against the market", () => {
  it("states the niche's move beside the market's, and works the difference", () => {
    // Souls-like on the 2026-09-21 build: −17.7% in a −4.9% week = −12.8 points.
    const t = readPlayersTrend({ players_trend_7d_pct: -17.7, players_trend_7d_market_pct: -4.9, players_trend_7d_rel_pct: -12.8 });
    expect(t.value).toBe("▼ −17.7%");
    expect(t.vsMarket).toBe("vs market −4.9% (−12.8 pts)");
    expect(t.relative).toBe("−12.8 pts");
    expect(t.worked).toBe("−17.7% − (−4.9%) = −12.8 pts");
    expect(t.hasMarket).toBe(true);
    expect(t.up).toBe(false);
  });

  it("prints no worked line when the served relative figure doesn't reproduce", () => {
    const t = readPlayersTrend({ players_trend_7d_pct: -17.7, players_trend_7d_market_pct: -4.9, players_trend_7d_rel_pct: -3 });
    expect(t.vsMarket).toBe("vs market −4.9% (−3.0 pts)");
    expect(t.worked).toBeNull();
  });

  it("without the market fields it prints the raw trend and says there is no comparison", () => {
    const t = readPlayersTrend({ players_trend_7d_pct: 4 });
    expect(t.value).toBe("▲ +4.0%");
    expect(t.vsMarket).toBeNull();
    expect(t.hasMarket).toBe(false);
    expect(noMarketNote()).toMatch(/No market comparison in this data build yet/);
    // When the typical niche moved a lot this week, the note says how far.
    expect(noMarketNote(-4.885)).toMatch(/the median niche moved −4\.9%/);
    expect(noMarketNote(0.5)).not.toMatch(/median niche/);
  });

  it("an unknown trend is null, not 0", () => {
    const t = readPlayersTrend({ players_trend_7d_pct: null });
    expect(t.value).toBeNull();
    expect(t.up).toBeNull();
  });

  it("the median niche trend needs 10+ readings", () => {
    const rows = Array.from({ length: 12 }, (_, i) => ({ players_trend_7d_pct: i - 6 }));
    expect(medianNicheTrend(rows)).toBe(-0.5);
    expect(medianNicheTrend(rows.slice(0, 9))).toBeNull();
    expect(medianNicheTrend([...rows, { players_trend_7d_pct: null }])).toBe(-0.5);
  });
});

describe("fillMonthGaps — a monthly category axis never skips a month", () => {
  const zero = (month: string) => ({ month, n: 0 });

  it("inserts zeros between the first and last months, across year boundaries", () => {
    const out = fillMonthGaps(
      [
        { month: "2025-11", n: 3 },
        { month: "2026-02", n: 1 },
      ],
      (p) => p.month,
      zero,
    );
    expect(out).toEqual([
      { month: "2025-11", n: 3 },
      { month: "2025-12", n: 0 },
      { month: "2026-01", n: 0 },
      { month: "2026-02", n: 1 },
    ]);
  });

  it("never invents history before the first point or future after the last, sorts, and dedupes", () => {
    const out = fillMonthGaps(
      [
        { month: "2026-03", n: 2 },
        { month: "2026-01", n: 5 },
        { month: "2026-01", n: 9 },
        { month: "garbage", n: 7 },
      ],
      (p) => p.month,
      zero,
    );
    expect(out.map((p) => `${p.month}:${p.n}`)).toEqual(["2026-01:5", "2026-02:0", "2026-03:2"]);
    expect(fillMonthGaps([], (p: { month: string }) => p.month, zero)).toEqual([]);
  });

  it("flags the data's own month as partial", () => {
    expect(partialMonth(["2026-08", "2026-09"], new Date("2026-09-21T22:00:00Z"))).toBe("2026-09");
    expect(partialMonth(["2026-07", "2026-08"], new Date("2026-09-21T22:00:00Z"))).toBeNull();
    expect(partialMonth(["2026-09"], null)).toBeNull();
  });
});

describe("paid-only revenue figures — withheld, never bare", () => {
  it("marks a NULL paid-only figure as withheld when the mart held it back", () => {
    const row = { n_games: 41, n_paid: 12, n_free: 25, n_price_unknown: 4 };
    expect(paidWithheld(row)).toBe(true);
    expect(paidStatSentinel(row, null)).toEqual({
      tag: "withheld: only 12 paid games",
      detail: `Revenue, price and hit-rate figures count paid games only, and are withheld below ${PAID_MIN} of them — 12 is too few to read.`,
    });
    // A real value is never flagged.
    expect(paidStatSentinel(row, 50_000)).toBeUndefined();
    // An older mart (no n_paid): a NULL is plain "no data".
    expect(paidStatSentinel({ n_games: 41 }, null)).toBe("no data");
    expect(paidWithheld({ n_paid: PAID_MIN })).toBe(false);
  });

  it("says which games the figures leave out", () => {
    expect(paidOnlyNote({ n_paid: 200, n_free: 25, n_price_unknown: 4 })).toBe(
      "paid games only — 25 free and 4 unknown-price games left out",
    );
    expect(paidOnlyNote({ n_paid: 200, n_free: 1, n_price_unknown: 0 })).toBe("paid games only — 1 free game left out");
    expect(paidOnlyNote({ n_free: 12 })).toBe("excludes 12 free games");
    expect(paidOnlyNote({ n_paid: 200, n_free: 0, n_price_unknown: 0 })).toBeNull();
    expect(paidOnlyNote(null)).toBeNull();
  });
});

describe("the niche page's CSV — THIS cut's games", () => {
  afterEach(() => vi.unstubAllGlobals());

  const game = (over: Partial<NicheGameRow>): NicheGameRow => ({
    appid: 1,
    name: "A",
    release_year: 2025,
    price_initial: 19.99,
    is_free: 0,
    est_revenue: 199_900,
    total_reviews: 333,
    owners_est: null,
    positive_ratio: 0.91,
    live_players: 12,
    header_image: null,
    ...over,
  });

  it("quotes what needs quoting and defuses spreadsheet formulas", () => {
    expect(csvField('Say "hi", world')).toBe('"Say ""hi"", world"');
    expect(csvField("=HYPERLINK(1)")).toBe("'=HYPERLINK(1)");
    expect(csvField("-Kaiju-")).toBe("'-Kaiju-");
    expect(csvField(-3)).toBe("-3"); // a number is a number
    expect(csvField(null)).toBe("");
    expect(csvField(Number.NaN)).toBe("");
  });

  it("writes one row per game with units that multiply out and free games left blank", () => {
    const csv = nicheGamesCsv([game({}), game({ appid: 2, name: "Free One", price_initial: 0, is_free: 1, est_revenue: 0 })]);
    const [head, a, b] = csv.trim().split("\n");
    expect(head).toBe(CSV_COLUMNS.join(","));
    expect(a).toBe("1,A,2025,19.99,0,199900,10000,333,0.91,12,https://store.steampowered.com/app/1/");
    // Free: no box revenue cell (never a fabricated $0); units from reviews × 30.
    expect(b).toBe("2,Free One,2025,0,1,,9990,333,0.91,12,https://store.steampowered.com/app/2/");
  });

  it("names the file after the slice it holds", () => {
    expect(nicheCsvFilename("Souls-like", { win: "24m", min_reviews: 50, sort: "revenue", order: "desc" }, "indie")).toBe(
      "souls-like_24m_min50_indie_games.csv",
    );
    expect(
      nicheCsvFilename("Point & Click", { win: "all", min_reviews: 0, sort: "revenue", order: "desc", rev_min: 1, rev_max: 2 }, "all"),
    ).toBe("point-click_all_min0_all_filtered_games.csv");
  });

  it("pages the games endpoint with the page's cut, scope and buckets — never the niche list's q= search", async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        urls.push(url);
        const offset = Number(new URL(url, "http://x").searchParams.get("offset"));
        const items = Array.from({ length: offset === 0 ? 200 : 50 }, (_, i) => game({ appid: offset + i + 1 }));
        return new Response(JSON.stringify({ total: 250, items, limit: 200, offset, scope: "indie", n_scope_unknown: 3 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }),
    );
    const res = await exportNicheGamesCsv("tag", "Souls-like", {
      win: "24m",
      min_reviews: 50,
      sort: "revenue",
      order: "desc",
      scope: "indie",
      rev_min: 1000,
      rev_max: 10_000,
    });
    expect(urls).toHaveLength(2);
    for (const u of urls) {
      expect(u.startsWith("/api/niches/tag/Souls-like/games?")).toBe(true);
      expect(u).not.toContain("export.csv");
      expect(u).not.toContain("q=");
      const sp = new URL(u, "http://x").searchParams;
      expect(sp.get("win")).toBe("24m");
      expect(sp.get("min_reviews")).toBe("50");
      expect(sp.get("scope")).toBe("indie");
      expect(sp.get("rev_min")).toBe("1000");
      expect(sp.get("limit")).toBe("200");
    }
    expect(res.rows).toBe(250);
    expect(res.truncated).toBe(false);
    expect(res.scope).toBe("indie");
    expect(res.nScopeUnknown).toBe(3);
    expect(res.csv.trim().split("\n")).toHaveLength(251);
  });

  it("reports the scope the API actually applied — an older API ignoring scope serves all games", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ total: 1, items: [game({})], limit: 200, offset: 0 }), { status: 200 })),
    );
    const res = await exportNicheGamesCsv("tag", "X", { win: "24m", min_reviews: 50, sort: "revenue", order: "desc", scope: "indie" });
    expect(res.scope).toBe("all");
    expect(res.filename).toContain("_all_");
  });
});

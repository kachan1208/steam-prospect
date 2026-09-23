/**
 * THE NICHE PAGE'S CSV EXPORT — this cut's GAMES, built in the browser (2026-09-23).
 *
 * The niche page's "Export CSV" used to link to /api/niches/export.csv?q=<key>: the NICHE
 * list's export, filtered by a SUBSTRING match on the key over the default tiers. On
 * /niches/tag/Roguelike it downloaded every niche whose name contains "Roguelike" (Action
 * Roguelike, Roguelike Deckbuilder, …) at niche level — not this niche, and not its games.
 * No games export endpoint exists, so the page now pages through the same
 * /niches/{d}/{k}/games endpoint its table reads — with the page's cut, scope and bucket
 * filters — and writes those rows out. What you export is what the table lists.
 */

import { nichePath, request, type Dimension, type NicheGameRow, type NicheGamesList, type NicheGamesParams, type NicheScope } from "./api";
import { estimatedUnits } from "./estimates";
import { priceKind } from "./format";

/** The /games endpoint's maximum page size. */
export const CSV_PAGE_SIZE = 200;
/** Safety cap on one export; a cut larger than this says so in the result. */
export const CSV_MAX_ROWS = 10_000;

export type NicheCsvParams = Omit<NicheGamesParams, "limit" | "offset">;

export interface NicheCsvExport {
  csv: string;
  filename: string;
  /** Rows written. */
  rows: number;
  /** Games matching the request — more than `rows` only when the cap was hit. */
  total: number;
  truncated: boolean;
  /** The scope the API APPLIED — "all" when it predates `scope` and ignored the param. */
  scope: NicheScope;
  /** Under scope=indie, the members left out for an unknown indie flag. */
  nScopeUnknown: number | null;
}

/** Page through /niches/{d}/{k}/games until the cut is exhausted (or the cap is hit). */
export async function fetchAllNicheGames(
  dimension: Dimension,
  key: string,
  params: NicheCsvParams,
  signal?: AbortSignal,
): Promise<{ items: NicheGameRow[]; total: number; scope: NicheScope; nScopeUnknown: number | null }> {
  const items: NicheGameRow[] = [];
  let total = 0;
  let scope: NicheScope = "all";
  let nScopeUnknown: number | null = null;
  for (let offset = 0; offset < CSV_MAX_ROWS; offset += CSV_PAGE_SIZE) {
    const sp = new URLSearchParams();
    const page = { ...params, limit: CSV_PAGE_SIZE, offset };
    for (const [k, v] of Object.entries(page)) if (v !== undefined && v !== null) sp.set(k, String(v));
    const res = await request<NicheGamesList>(`${nichePath(dimension, key, "/games")}?${sp.toString()}`, { signal });
    total = res.total;
    scope = res.scope ?? "all";
    nScopeUnknown = res.n_scope_unknown ?? null;
    items.push(...res.items);
    if (res.items.length < CSV_PAGE_SIZE || items.length >= total) break;
  }
  return { items: items.slice(0, CSV_MAX_ROWS), total, scope, nScopeUnknown };
}

/** One CSV field: quoted when it needs to be, and never read as a spreadsheet formula
 * (a game called "=HYPERLINK(…)" or "-Kaiju-" must stay text). */
export function csvField(v: string | number | null | undefined): string {
  if (v === null || v === undefined) return "";
  let s = typeof v === "number" ? (Number.isFinite(v) ? String(v) : "") : v;
  if (typeof v === "string" && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export const CSV_COLUMNS = [
  "appid",
  "name",
  "release_year",
  "price_usd",
  "price_kind",
  "est_revenue_usd",
  "est_units",
  "total_reviews",
  "positive_ratio",
  "players_now",
  "steam_url",
] as const;

function roundOrNull(v: number | null): number | null {
  return v === null || !Number.isFinite(v) ? null : Math.round(v);
}

export function nicheGamesCsv(rows: readonly NicheGameRow[]): string {
  const lines = [CSV_COLUMNS.join(",")];
  for (const g of rows) {
    // The one price reading every page shares (lib/format.ts priceKind): a $0 price Steam
    // doesn't flag free is "unknown", not free — its price cell stays EMPTY rather than a
    // fabricated 0, and so does its revenue (the table prints "Price unknown" there).
    const kind = priceKind(g);
    lines.push(
      [
        g.appid,
        g.name ?? "",
        g.release_year,
        kind === "unknown" ? null : g.price_initial,
        kind,
        // Free titles carry no box revenue — an empty cell, never a fabricated $0 (the table
        // prints "Free" there). Units come from the table's own helper, so the two agree.
        kind === "paid" ? g.est_revenue : null,
        roundOrNull(estimatedUnits(g.est_revenue, g.price_initial, g.total_reviews)),
        g.total_reviews,
        g.positive_ratio ?? null,
        g.live_players ?? null,
        `https://store.steampowered.com/app/${g.appid}/`,
      ]
        .map(csvField)
        .join(","),
    );
  }
  return `${lines.join("\n")}\n`;
}

/** "souls-like_24m_min50_indie_games.csv" — the file says which slice it holds. */
export function nicheCsvFilename(key: string, params: NicheCsvParams, scope: NicheScope): string {
  const slug = key.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "niche";
  const brushed = params.rev_min != null || params.price_min != null ? "_filtered" : "";
  return `${slug}_${params.win}_min${params.min_reviews}_${scope}${brushed}_games.csv`;
}

export async function exportNicheGamesCsv(
  dimension: Dimension,
  key: string,
  params: NicheCsvParams,
  signal?: AbortSignal,
): Promise<NicheCsvExport> {
  const { items, total, scope, nScopeUnknown } = await fetchAllNicheGames(dimension, key, params, signal);
  return {
    csv: nicheGamesCsv(items),
    filename: nicheCsvFilename(key, params, scope),
    rows: items.length,
    total,
    truncated: items.length < total,
    scope,
    nScopeUnknown,
  };
}

/** Hand the CSV to the browser as a download. */
export function downloadCsv(filename: string, csv: string): void {
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  try {
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    // Revoke on the next tick: some engines start the download asynchronously.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

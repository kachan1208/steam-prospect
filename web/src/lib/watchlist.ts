import { useSyncExternalStore } from "react";

import type { Dimension } from "./api";

/**
 * The watchlist — a localStorage-backed store of niches and games the user wants to keep an
 * eye on, each with an optional alert rule (mockup 4f). Same shape of problem as
 * lib/compareList.ts (read that file first if this one is confusing): a persisted list, a
 * pub/sub layer so every subscribed component re-renders in step, and a versioned storage
 * key so a shape change can't crash a returning user.
 *
 * HONESTY NOTE — there is no backend for this feature. The design spec (README §4f) describes
 * alert rules "evaluated on the nightly mart build"; that mart job does not exist. What DOES
 * exist is the live API the rest of the app already calls (useNicheDetail / useGameProfile),
 * so a rule here is evaluated client-side, on demand, against whatever the API answers right
 * now. Two consequences fall out of that and are load-bearing for callers of this module:
 *
 *  1. `ruleFires()` reports CURRENT state only ("is this true right now"), never a history of
 *     when a threshold first crossed. There is no event log anywhere in this stack, so a
 *     "fired on <date>" claim would be invented. Don't add one.
 *  2. Every metric this module knows how to evaluate (see AlertMetric) maps onto a field that
 *     genuinely exists on NicheRow/NichePlayers/GameProfile in lib/api.ts — nothing here is a
 *     placeholder metric invented for the mockup's sake. Notably "demand" (the opportunity-
 *     score component) is NOT one of them: it's a normalized 0-1 score, not a %-over-time
 *     trend, so a rule like the mockup's illustrative "demand +20% over 90 days" isn't reproducible
 *     honestly — the nearest served equivalents are players_trend_7d_pct (short-term
 *     momentum, the closest in spirit to the mockup's horizon) and demand_trend_12m_pct
 *     (the Radar board's year-over-year structural read; not wired as an AlertMetric).
 */

export type WatchlistKind = "niche" | "game";

export type AlertMetric = "players_trend_7d_pct" | "opportunity_v2" | "saturation_yoy" | "price_initial";

export interface AlertRule {
  metric: AlertMetric;
  comparator: "gt" | "lt";
  /** Same units and scale as the underlying API field — deliberately NOT normalized across
   * metrics, because the API itself doesn't normalize them (see METRIC_META's `unit` for the
   * per-metric contract): players_trend_7d_pct is already a percent number (20 = +20%, see
   * NicheDetail.tsx's own `< -10` decline check), saturation_yoy is a fraction (0.2 = +20%,
   * see NicheFinder's `* 100` display and format.ts's fmtSigned), opportunity_v2 is its raw
   * ~0-100 score, price_initial is raw USD. Use editorValueToThreshold/thresholdToEditorValue
   * below rather than hand-rolling the scaling. */
  threshold: number;
}

export interface WatchlistEntry {
  id: string;
  kind: WatchlistKind;
  /** Niche identity — set when kind === "niche". */
  dimension?: Dimension;
  key?: string;
  /** Game identity — set when kind === "game". */
  appid?: number;
  name: string;
  /** ISO timestamp of when the USER added this entry, recorded locally at add time. Real,
   * not inferred — this is the one date this module is allowed to show without evidence. */
  addedAt: string;
  rule: AlertRule | null;
}

export const WATCHLIST_CAP = 100;

const STORAGE_KEY = "prospect:watchlist:v1";

// ---- metric metadata (drives both the rule-label formatter and the page's rule editor) ----

export const METRICS_BY_KIND: Record<WatchlistKind, AlertMetric[]> = {
  niche: ["players_trend_7d_pct", "opportunity_v2", "saturation_yoy"],
  game: ["players_trend_7d_pct", "price_initial"],
};

export const METRIC_META: Record<
  AlertMetric,
  {
    label: string;
    /** "percent": already a plain percent number (players_trend_7d_pct). "fraction_percent":
     * a fraction that reads as percent (saturation_yoy — ×100 to display). "score": raw
     * opportunity_v2 scale. "usd": raw price_initial dollars. */
    unit: "percent" | "fraction_percent" | "score" | "usd";
    defaultComparator: "gt" | "lt";
    defaultThreshold: number;
  }
> = {
  players_trend_7d_pct: { label: "Players 7d", unit: "percent", defaultComparator: "gt", defaultThreshold: 20 },
  opportunity_v2: { label: "Opp v2", unit: "score", defaultComparator: "gt", defaultThreshold: 80 },
  saturation_yoy: { label: "Saturation YoY", unit: "fraction_percent", defaultComparator: "gt", defaultThreshold: 0 },
  price_initial: { label: "Price", unit: "usd", defaultComparator: "lt", defaultThreshold: 14.99 },
};

export function defaultRuleFor(kind: WatchlistKind): AlertRule {
  const metric: AlertMetric = kind === "niche" ? "players_trend_7d_pct" : "price_initial";
  const meta = METRIC_META[metric];
  return { metric, comparator: meta.defaultComparator, threshold: meta.defaultThreshold };
}

/** "players 7d ▲ > +20%" / "opp v2 crosses 80" / "price drops below $14.99" — the mockup's
 * rule-column phrasing, generated from a real rule instead of hand-authored per row. */
export function formatRuleLabel(rule: AlertRule): string {
  const up = rule.comparator === "gt";
  switch (rule.metric) {
    case "players_trend_7d_pct": {
      const pct = Math.abs(rule.threshold).toFixed(0);
      return `players 7d ${up ? "▲" : "▼"} > ${up ? "+" : "−"}${pct}%`;
    }
    case "saturation_yoy": {
      if (rule.threshold === 0) return `saturation YoY turns ${up ? "positive" : "negative"}`;
      const pct = Math.abs(rule.threshold * 100).toFixed(0);
      return `saturation YoY ${up ? "▲" : "▼"} > ${up ? "+" : "−"}${pct}%`;
    }
    case "opportunity_v2":
      return up ? `opp v2 crosses ${rule.threshold}` : `opp v2 drops below ${rule.threshold}`;
    case "price_initial":
      return up ? `price rises above $${rule.threshold.toFixed(2)}` : `price drops below $${rule.threshold.toFixed(2)}`;
    default:
      return "";
  }
}

/** Format a live metric VALUE (not a rule threshold) for the table's current-value column,
 * honoring each metric's native unit — same scaling contract as METRIC_META.unit above. */
export function formatMetricValue(metric: AlertMetric, value: number): string {
  // Signed metrics use the same "−" (not a plain hyphen) minus glyph as every other
  // verdict in the app (NicheFinder's Players 7d column, NicheDetail's saturation readout).
  switch (metric) {
    case "players_trend_7d_pct":
      return `${value >= 0 ? "+" : "−"}${Math.abs(value).toFixed(1)}%`;
    case "saturation_yoy":
      return `${value >= 0 ? "+" : "−"}${Math.abs(value * 100).toFixed(1)}%`;
    case "opportunity_v2":
      return value.toFixed(1);
    case "price_initial":
      return `$${value.toFixed(2)}`;
    default:
      return String(value);
  }
}

/** Metrics that are directional deltas worth a ▲/▼ glyph; opportunity_v2 (a level, not a
 * change) and price_initial (no inherent "up is good") render as plain numbers instead. */
export function metricIsSigned(metric: AlertMetric): boolean {
  return metric === "players_trend_7d_pct" || metric === "saturation_yoy";
}

/** The rule editor always shows/accepts a human percent number ("20" meaning 20%) regardless
 * of metric — these two convert that to/from the threshold's actual storage unit, so the one
 * place that knows saturation_yoy is a fraction (and players_trend_7d_pct isn't) is here. */
export function thresholdToEditorValue(rule: AlertRule): number {
  if (rule.metric === "saturation_yoy") return Math.round(rule.threshold * 1000) / 10;
  return rule.threshold;
}

export function editorValueToThreshold(metric: AlertMetric, editorValue: number): number {
  if (metric === "saturation_yoy") return editorValue / 100;
  return editorValue;
}

/** Does `currentValue` satisfy the rule right now? null = can't tell (no live data yet for
 * this metric) — a caller should render "unknown", never treat null as "not fired". */
export function ruleFires(rule: AlertRule, currentValue: number | null | undefined): boolean | null {
  if (currentValue === null || currentValue === undefined || Number.isNaN(currentValue)) return null;
  return rule.comparator === "gt" ? currentValue > rule.threshold : currentValue < rule.threshold;
}

// ---- id scheme ------------------------------------------------------------------------

export function nicheWatchlistId(dimension: Dimension, key: string): string {
  return `niche:${dimension}:${key}`;
}

export function gameWatchlistId(appid: number): string {
  return `game:${appid}`;
}

// ---- storage ---------------------------------------------------------------------------

let cache: WatchlistEntry[] = load();
const listeners = new Set<() => void>();

function isValidRule(r: unknown): r is AlertRule {
  if (!r || typeof r !== "object") return false;
  const rule = r as Record<string, unknown>;
  return (
    typeof rule.metric === "string" &&
    rule.metric in METRIC_META &&
    (rule.comparator === "gt" || rule.comparator === "lt") &&
    typeof rule.threshold === "number" &&
    Number.isFinite(rule.threshold)
  );
}

function load(): WatchlistEntry[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const out: WatchlistEntry[] = [];
    const seen = new Set<string>();
    for (const e of parsed) {
      const entry = e as Partial<WatchlistEntry>;
      if (typeof entry.id !== "string" || seen.has(entry.id)) continue;
      if (entry.kind !== "niche" && entry.kind !== "game") continue;
      if (typeof entry.name !== "string") continue;
      if (entry.kind === "niche" && (typeof entry.dimension !== "string" || typeof entry.key !== "string")) continue;
      if (entry.kind === "game" && typeof entry.appid !== "number") continue;
      const addedAt = typeof entry.addedAt === "string" ? entry.addedAt : new Date().toISOString();
      const rule = isValidRule(entry.rule) ? entry.rule : null;
      seen.add(entry.id);
      out.push(
        entry.kind === "niche"
          ? { id: entry.id, kind: "niche", dimension: entry.dimension as Dimension, key: entry.key, name: entry.name, addedAt, rule }
          : { id: entry.id, kind: "game", appid: entry.appid, name: entry.name, addedAt, rule },
      );
      if (out.length >= WATCHLIST_CAP) break;
    }
    return out;
  } catch {
    return []; // corrupt JSON / storage unavailable — start empty, never throw
  }
}

function persist(next: WatchlistEntry[]): void {
  cache = next;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // storage full/unavailable (private mode): the in-memory list still works this session
  }
  for (const l of listeners) l();
}

export function getWatchlist(): WatchlistEntry[] {
  return cache;
}

export function isNicheWatchlisted(dimension: Dimension, key: string): boolean {
  const id = nicheWatchlistId(dimension, key);
  return cache.some((e) => e.id === id);
}

export function isGameWatchlisted(appid: number): boolean {
  const id = gameWatchlistId(appid);
  return cache.some((e) => e.id === id);
}

/** Add a niche. Returns false (list unchanged) when already present or the cap is reached. */
export function addNicheToWatchlist(dimension: Dimension, key: string, name?: string | null, rule?: AlertRule | null): boolean {
  const id = nicheWatchlistId(dimension, key);
  if (cache.some((e) => e.id === id) || cache.length >= WATCHLIST_CAP) return false;
  const entry: WatchlistEntry = {
    id,
    kind: "niche",
    dimension,
    key,
    name: name ?? key,
    addedAt: new Date().toISOString(),
    rule: rule ?? defaultRuleFor("niche"),
  };
  persist([...cache, entry]);
  return true;
}

/** Add a game. Returns false (list unchanged) when already present or the cap is reached. */
export function addGameToWatchlist(appid: number, name?: string | null, rule?: AlertRule | null): boolean {
  const id = gameWatchlistId(appid);
  if (cache.some((e) => e.id === id) || cache.length >= WATCHLIST_CAP) return false;
  const entry: WatchlistEntry = {
    id,
    kind: "game",
    appid,
    name: name ?? `App ${appid}`,
    addedAt: new Date().toISOString(),
    rule: rule ?? defaultRuleFor("game"),
  };
  persist([...cache, entry]);
  return true;
}

export function removeFromWatchlist(id: string): void {
  if (!cache.some((e) => e.id === id)) return;
  persist(cache.filter((e) => e.id !== id));
}

/** Add-or-remove a niche; "full" means it was NOT added because the cap is reached. */
export function toggleNicheWatchlist(dimension: Dimension, key: string, name?: string | null): "added" | "removed" | "full" {
  const id = nicheWatchlistId(dimension, key);
  if (cache.some((e) => e.id === id)) {
    removeFromWatchlist(id);
    return "removed";
  }
  return addNicheToWatchlist(dimension, key, name) ? "added" : "full";
}

/** Add-or-remove a game; "full" means it was NOT added because the cap is reached. */
export function toggleGameWatchlist(appid: number, name?: string | null): "added" | "removed" | "full" {
  const id = gameWatchlistId(appid);
  if (cache.some((e) => e.id === id)) {
    removeFromWatchlist(id);
    return "removed";
  }
  return addGameToWatchlist(appid, name) ? "added" : "full";
}

/** Replace (or clear, with `null`) the alert rule on one entry. No-op if the id isn't stored. */
export function setWatchlistRule(id: string, rule: AlertRule | null): void {
  if (!cache.some((e) => e.id === id)) return;
  persist(cache.map((e) => (e.id === id ? { ...e, rule } : e)));
}

export function clearWatchlist(): void {
  persist([]);
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// Cross-tab sync: another tab's write fires `storage` here — reload and notify.
if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (e.key !== STORAGE_KEY) return;
    cache = load();
    for (const l of listeners) l();
  });
}

/** React binding: the current list, live across any component that mutates it. */
export function useWatchlist(): WatchlistEntry[] {
  return useSyncExternalStore(subscribe, getWatchlist);
}

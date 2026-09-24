/**
 * Recent searches — a tiny per-browser store of the queries a user actually ran, one list per
 * search surface (games, studios, niches), shown when a search box is focused and empty.
 *
 * Browser-local on purpose, like the watchlist and the compare list: it is a convenience, not
 * data anyone else needs, and every read/write is wrapped so a private window or blocked
 * storage degrades to "no history" instead of an error.
 *
 * WHAT COUNTS AS A SEARCH. Typing is not searching: a query is recorded once it has been left
 * alone for RECORD_DELAY_MS and returned results (the surface decides "returned results"), or
 * when the user commits it explicitly (Enter / picking a result / picking a recent entry).
 * Pausing mid-word would otherwise record "hol" on the way to "hollow" — so an entry that is a
 * prefix of (or extends) the newest one within PREFIX_MERGE_MS replaces it instead of
 * stacking beside it.
 */
import { useCallback, useEffect, useRef, useState } from "react";

export type RecentScope = "games" | "studios" | "niches";

export const RECENT_MAX = 8;
export const RECENT_MIN_CHARS = 2;
export const RECORD_DELAY_MS = 1200;
export const PREFIX_MERGE_MS = 60_000;

const KEY_PREFIX = "prospect.recentSearches.v1.";
const CHANGE_EVENT = "prospect:recent-searches";

export interface RecentEntry {
  q: string;
  /** epoch ms of the last time this query was run */
  at: number;
}

/** Trim and collapse inner whitespace — "  hollow   knight " and "hollow knight" are one entry. */
export function normalizeQuery(q: string): string {
  return q.trim().replace(/\s+/g, " ");
}

function storageKey(scope: RecentScope): string {
  return KEY_PREFIX + scope;
}

export function loadRecent(scope: RecentScope): RecentEntry[] {
  try {
    const raw = window.localStorage.getItem(storageKey(scope));
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((e): e is RecentEntry => !!e && typeof e.q === "string" && typeof e.at === "number")
      .slice(0, RECENT_MAX);
  } catch {
    return [];
  }
}

function save(scope: RecentScope, entries: RecentEntry[]): void {
  try {
    window.localStorage.setItem(storageKey(scope), JSON.stringify(entries.slice(0, RECENT_MAX)));
  } catch {
    // Storage full/blocked: the list just doesn't persist. Never break the search itself.
  }
  try {
    window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: scope }));
  } catch {
    /* no window (tests tearing down) */
  }
}

/** Record a query as the newest entry. Case-insensitive dedupe (the latest casing wins); a
 * query that extends — or is extended by — the newest entry recorded within PREFIX_MERGE_MS
 * replaces it. Returns the new list. */
export function pushRecent(scope: RecentScope, query: string, now: number = Date.now()): RecentEntry[] {
  const q = normalizeQuery(query);
  const current = loadRecent(scope);
  if (q.length < RECENT_MIN_CHARS) return current;
  const lower = q.toLowerCase();
  let rest = current.filter((e) => e.q.toLowerCase() !== lower);
  const newest = rest[0];
  if (newest && now - newest.at <= PREFIX_MERGE_MS) {
    const nl = newest.q.toLowerCase();
    if (lower.startsWith(nl) || nl.startsWith(lower)) rest = rest.slice(1);
  }
  const next = [{ q, at: now }, ...rest].slice(0, RECENT_MAX);
  save(scope, next);
  return next;
}

export function removeRecent(scope: RecentScope, query: string): RecentEntry[] {
  const lower = normalizeQuery(query).toLowerCase();
  const next = loadRecent(scope).filter((e) => e.q.toLowerCase() !== lower);
  save(scope, next);
  return next;
}

export function clearRecent(scope: RecentScope): void {
  save(scope, []);
}

/** The scope's list, kept in sync across every mounted consumer and across tabs. */
export function useRecentSearches(scope: RecentScope) {
  const [items, setItems] = useState<RecentEntry[]>(() => loadRecent(scope));

  useEffect(() => {
    setItems(loadRecent(scope));
    const onLocal = (e: Event) => {
      if ((e as CustomEvent<RecentScope>).detail === scope) setItems(loadRecent(scope));
    };
    const onStorage = (e: StorageEvent) => {
      if (e.key === null || e.key === storageKey(scope)) setItems(loadRecent(scope));
    };
    window.addEventListener(CHANGE_EVENT, onLocal);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(CHANGE_EVENT, onLocal);
      window.removeEventListener("storage", onStorage);
    };
  }, [scope]);

  const add = useCallback((q: string) => setItems(pushRecent(scope, q)), [scope]);
  const remove = useCallback((q: string) => setItems(removeRecent(scope, q)), [scope]);
  const clear = useCallback(() => {
    clearRecent(scope);
    setItems([]);
  }, [scope]);

  return { items, add, remove, clear };
}

/** Record `query` once it has been left alone for RECORD_DELAY_MS while `ready` (the surface's
 * "this query returned results") holds. Each distinct query is recorded at most once per
 * mount, so a re-render or a refetch never re-stamps it. */
export function useRecordRecentSearch(scope: RecentScope, query: string, ready: boolean): void {
  const lastRecorded = useRef<string | null>(null);
  useEffect(() => {
    const q = normalizeQuery(query);
    if (!ready || q.length < RECENT_MIN_CHARS || q.toLowerCase() === lastRecorded.current) return;
    const t = window.setTimeout(() => {
      lastRecorded.current = q.toLowerCase();
      pushRecent(scope, q);
    }, RECORD_DELAY_MS);
    return () => window.clearTimeout(t);
  }, [scope, query, ready]);
}

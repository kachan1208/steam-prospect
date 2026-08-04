import { useSyncExternalStore } from "react";

/**
 * The compare list — a tiny localStorage-backed store of games the user has queued for
 * side-by-side comparison (/compare), with a pub/sub layer so every subscribed component
 * (search-row buttons, the profile-header button, the CompareTray) re-renders in step.
 *
 * Entries carry {appid, name} rather than bare appids so the tray can render name chips
 * without fetching anything. Capped at COMPARE_CAP (the compare table and the trends
 * overlay both stop being readable past ~6 columns/series), deduped by appid.
 *
 * The storage key is versioned: if the entry shape ever changes, bump the suffix and old
 * payloads are simply ignored (load() re-validates and drops anything malformed) instead
 * of crashing a returning user.
 */
export interface CompareEntry {
  appid: number;
  name: string | null;
}

export const COMPARE_CAP = 6;

const STORAGE_KEY = "prospect:compare-list:v1";

let cache: CompareEntry[] = load();
const listeners = new Set<() => void>();

function load(): CompareEntry[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const out: CompareEntry[] = [];
    const seen = new Set<number>();
    for (const e of parsed) {
      const appid = (e as CompareEntry)?.appid;
      if (typeof appid !== "number" || !Number.isFinite(appid) || seen.has(appid)) continue;
      const name = (e as CompareEntry)?.name;
      seen.add(appid);
      out.push({ appid, name: typeof name === "string" ? name : null });
      if (out.length >= COMPARE_CAP) break;
    }
    return out;
  } catch {
    return []; // corrupt JSON / storage unavailable — start empty, never throw
  }
}

function persist(next: CompareEntry[]): void {
  cache = next;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // storage full/unavailable (private mode): the in-memory list still works this session
  }
  for (const l of listeners) l();
}

export function getCompareList(): CompareEntry[] {
  return cache;
}

export function isCompared(appid: number): boolean {
  return cache.some((e) => e.appid === appid);
}

/** Add a game. Returns false (and leaves the list unchanged) when full or already present. */
export function addToCompare(appid: number, name: string | null): boolean {
  if (isCompared(appid) || cache.length >= COMPARE_CAP) return false;
  persist([...cache, { appid, name }]);
  return true;
}

export function removeFromCompare(appid: number): void {
  if (!isCompared(appid)) return;
  persist(cache.filter((e) => e.appid !== appid));
}

/** Add-or-remove; "full" means it was NOT added because the cap is reached. */
export function toggleCompare(appid: number, name: string | null): "added" | "removed" | "full" {
  if (isCompared(appid)) {
    removeFromCompare(appid);
    return "removed";
  }
  return addToCompare(appid, name) ? "added" : "full";
}

export function clearCompare(): void {
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
export function useCompareList(): CompareEntry[] {
  return useSyncExternalStore(subscribe, getCompareList);
}

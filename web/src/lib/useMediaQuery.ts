import { useSyncExternalStore } from "react";

/**
 * A reactive CSS media query — for the few layouts that must render DIFFERENT MARKUP per
 * breakpoint, not just restyle it: the Niche Finder's table becomes cards below 640px, the
 * niche page's top-games table likewise, and the Radar widens its dot hit areas on a coarse
 * (touch) pointer. Rendering both variants and hiding one with CSS would double every link,
 * label and checkbox in the accessibility tree (and in every test query), so the switch is
 * made in JS.
 *
 * `fallback` is what a non-browser environment (or one without matchMedia) answers. Under
 * jsdom the test setup installs a matchMedia that evaluates (min-width: Npx) against
 * window.innerWidth and answers false for anything else — so `useMinWidth(640)` is true at
 * jsdom's default 1024px and a test flips it with `window.innerWidth = 390` + a resize event.
 */
export function useMediaQuery(query: string, fallback = false): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const mql = mediaQueryList(query);
      if (!mql) return () => {};
      mql.addEventListener("change", onChange);
      return () => mql.removeEventListener("change", onChange);
    },
    () => mediaQueryList(query)?.matches ?? fallback,
    () => fallback,
  );
}

/** One MediaQueryList per query string, reused across renders (getSnapshot runs on every
 * render; a fresh matchMedia() per call would allocate a new list — and a new listener in
 * some engines — each time). Keyed by the matchMedia implementation too, so a test that
 * swaps window.matchMedia gets fresh lists. */
const lists = new Map<string, MediaQueryList>();
let listsFor: typeof window.matchMedia | null = null;

function mediaQueryList(query: string): MediaQueryList | null {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return null;
  if (listsFor !== window.matchMedia) {
    lists.clear();
    listsFor = window.matchMedia;
  }
  let mql = lists.get(query);
  if (!mql) {
    mql = window.matchMedia(query);
    lists.set(query, mql);
  }
  return mql;
}

/** True at or above `px` CSS pixels of viewport width (Tailwind's `sm` is 640). Defaults to
 * the wide layout where the query cannot be evaluated. */
export function useMinWidth(px: number): boolean {
  return useMediaQuery(`(min-width: ${px}px)`, true);
}

/** True when the primary pointer is coarse (a finger): hit areas grow to ≥ 24px there. */
export function useCoarsePointer(): boolean {
  return useMediaQuery("(pointer: coarse)", false);
}

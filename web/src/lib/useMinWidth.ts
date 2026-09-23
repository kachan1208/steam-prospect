import { useCallback, useSyncExternalStore } from "react";

/**
 * Reactive "the viewport is at least `px` wide" flag, for the rare layout that has to render
 * DIFFERENT markup per width rather than restyle one tree with Tailwind breakpoints (/compare's
 * metric grid, which is a column-per-game table on a desktop and a metric-per-block list on a
 * phone). Rendering both and hiding one with CSS would duplicate every ⓘ in the DOM.
 * Defaults to the wide layout where matchMedia is unavailable (and on the server).
 */
export function useMinWidth(px: number): boolean {
  const query = `(min-width: ${px}px)`;
  const subscribe = useCallback(
    (cb: () => void) => {
      if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => {};
      const mql = window.matchMedia(query);
      mql.addEventListener("change", cb);
      return () => mql.removeEventListener("change", cb);
    },
    [query],
  );
  const read = useCallback(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return true;
    return window.matchMedia(query).matches;
  }, [query]);
  return useSyncExternalStore(subscribe, read, () => true);
}

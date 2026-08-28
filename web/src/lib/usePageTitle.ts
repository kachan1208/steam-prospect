import { useEffect } from "react";

/** The suffix every page carries, and the title a page falls back to. Mirrors the
 * <title> in index.html so a hard load and a client-side navigation agree. */
const SUFFIX = "Prospect";
const DEFAULT_TITLE = "Prospect — Steam Market Intelligence";

/**
 * Sets document.title to "<title> — Prospect" for as long as the calling page is
 * mounted, restoring the default on unmount.
 *
 * An SPA never reloads, so without this every tab, every bookmark and every history
 * entry read "Prospect — Steam Market Intelligence" no matter where you were — which
 * makes a browser-history search useless and a pinned tab ambiguous.
 *
 * Pass a null/empty title while data is still loading (e.g. a game name that hasn't
 * arrived yet) and the default is held rather than writing "undefined — Prospect"; the
 * effect re-runs and fills in the real title the moment it resolves.
 */
export function usePageTitle(title: string | null | undefined): void {
  useEffect(() => {
    document.title = title ? `${title} — ${SUFFIX}` : DEFAULT_TITLE;
    return () => {
      document.title = DEFAULT_TITLE;
    };
  }, [title]);
}

/**
 * Vitest setup: ensure a WORKING localStorage under jsdom.
 *
 * Node >= 22 ships a builtin global `localStorage` that, when the process isn't started
 * with a valid `--localstorage-file`, is a method-less stub — and it shadows jsdom's real
 * Storage implementation in the vitest environment (observed on Node 25:
 * `localStorage.setItem is not a function`). Tests that exercise storage-backed modules
 * (src/lib/compareList.ts) need the real semantics, so when the ambient localStorage is
 * unusable we install a minimal in-memory Storage shim on both globalThis and window.
 * Runs before test modules import, so module-level reads see the shim too.
 */
function makeMemoryStorage(): Storage {
  let store = new Map<string, string>();
  return {
    get length() {
      return store.size;
    },
    clear: () => {
      store = new Map();
    },
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    key: (i: number) => [...store.keys()][i] ?? null,
    removeItem: (k: string) => {
      store.delete(k);
    },
    setItem: (k: string, v: string) => {
      store.set(k, String(v));
    },
  } as Storage;
}

const broken =
  typeof globalThis.localStorage === "undefined" ||
  typeof globalThis.localStorage.setItem !== "function";

if (broken) {
  const shim = makeMemoryStorage();
  Object.defineProperty(globalThis, "localStorage", { value: shim, configurable: true });
  if (typeof window !== "undefined" && window.localStorage !== shim) {
    Object.defineProperty(window, "localStorage", { value: shim, configurable: true });
  }
}

/**
 * matchMedia that actually evaluates (min-width: Npx) against window.innerWidth.
 *
 * jsdom ships a matchMedia whose `matches` is ALWAYS false (it does not evaluate media
 * queries), which would put every responsive component permanently in its narrow mode
 * under test. This shim answers min-width queries from the live window.innerWidth
 * (jsdom default 1024 — desktop for the radar's lg breakpoint) and re-notifies
 * listeners on window resize, so a test can flip modes with
 * `window.innerWidth = 390; window.dispatchEvent(new Event("resize"))`.
 * Non-min-width queries keep jsdom's answer (false).
 */
if (typeof window !== "undefined") {
  window.matchMedia = (query: string): MediaQueryList => {
    const m = /\(min-width:\s*([\d.]+)px\)/.exec(query);
    const evaluate = () => (m ? window.innerWidth >= Number(m[1]) : false);
    const listeners = new Set<(e: MediaQueryListEvent) => void>();
    let last = evaluate();
    window.addEventListener("resize", () => {
      const now = evaluate();
      if (now === last) return;
      last = now;
      const event = { matches: now, media: query } as MediaQueryListEvent;
      for (const cb of listeners) cb(event);
    });
    return {
      media: query,
      get matches() {
        return evaluate();
      },
      onchange: null,
      addEventListener: (_: string, cb: (e: MediaQueryListEvent) => void) => listeners.add(cb),
      removeEventListener: (_: string, cb: (e: MediaQueryListEvent) => void) => listeners.delete(cb),
      addListener: (cb: (e: MediaQueryListEvent) => void) => listeners.add(cb),
      removeListener: (cb: (e: MediaQueryListEvent) => void) => listeners.delete(cb),
      dispatchEvent: () => false,
    } as MediaQueryList;
  };
}

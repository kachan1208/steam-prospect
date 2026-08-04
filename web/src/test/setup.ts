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

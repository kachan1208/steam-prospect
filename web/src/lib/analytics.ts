/**
 * Privacy-first frontend usage analytics.
 *
 * Buffers page views + a small allowlist of interaction events and flushes them to
 * POST /api/analytics/collect, where the backend turns them into bounded Prometheus counters
 * (VictoriaMetrics scrapes them; a Grafana dashboard charts them). No cookies, no durable
 * identifiers, no PII — we only ever send a route path or an event name. Honors the browser's
 * Do-Not-Track signal (fully inert when set) and flushes with sendBeacon so a send never blocks
 * navigation or gets cancelled when the tab closes.
 *
 * Interaction-event names must match the backend allowlist (api/app/analytics_metrics.py:
 * KNOWN_EVENTS) — anything else is silently dropped server-side to keep label cardinality bounded.
 */
import { API_BASE } from "./api";

type Item = { type: "pageview"; path: string } | { type: "event"; name: string };

const COLLECT_URL = `${API_BASE}/analytics/collect`;
const FLUSH_MS = 10_000;
const MAX_BUFFER = 50;

// Respect Do Not Track: when the user has asked not to be tracked, this module is a no-op.
const nav = typeof navigator !== "undefined" ? (navigator as Navigator & { msDoNotTrack?: string }) : undefined;
const DNT =
  !!nav &&
  (nav.doNotTrack === "1" ||
    nav.msDoNotTrack === "1" ||
    (typeof window !== "undefined" && (window as Window & { doNotTrack?: string }).doNotTrack === "1"));

let buffer: Item[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;

function flush(): void {
  if (buffer.length === 0) return;
  const payload = JSON.stringify({ events: buffer });
  buffer = [];
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
  try {
    // sendBeacon survives page unload and never blocks the main thread; fall back to a
    // keepalive fetch where it isn't available.
    if (nav?.sendBeacon) {
      nav.sendBeacon(COLLECT_URL, new Blob([payload], { type: "application/json" }));
    } else {
      void fetch(COLLECT_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: payload,
        keepalive: true,
      });
    }
  } catch {
    // Analytics must never break the app — swallow every error.
  }
}

function scheduleFlush(): void {
  if (buffer.length >= MAX_BUFFER) {
    flush();
    return;
  }
  if (timer === null) timer = setTimeout(flush, FLUSH_MS);
}

let started = false;

/** Wire lifecycle flushes once (called from the app root). Inert under Do Not Track. */
export function initAnalytics(): void {
  if (started || DNT || typeof document === "undefined") return;
  started = true;
  // Flush when the tab is hidden/closed so the session's tail isn't lost.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flush();
  });
  window.addEventListener("pagehide", flush);
}

export function trackPageview(path: string): void {
  if (DNT) return;
  buffer.push({ type: "pageview", path });
  scheduleFlush();
}

export function trackEvent(name: string): void {
  if (DNT) return;
  buffer.push({ type: "event", name });
  scheduleFlush();
}

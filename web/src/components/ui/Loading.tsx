import clsx from "clsx";

/**
 * THE loading placeholder — one spinner + label for every wait in the app, replacing the
 * ad-hoc "Loading…" divs each page hand-rolled. Also the router's Suspense fallback for
 * lazy-loaded routes (App.tsx).
 *
 * The spinner is a hairline arc in currentColor — stroke-only, square-corner-era
 * restraint, no filled chip — so it inherits whatever ink the context sets (default
 * text-ink-muted). `className` carries the CONTAINER sizing (height/padding/text size)
 * so call sites keep their exact reserved space; content is always centered.
 */
export function Loading({ label = "Loading…", className = "py-6 text-sm" }: { label?: string; className?: string }) {
  return (
    <div role="status" className={clsx("flex items-center justify-center gap-2 text-ink-muted", className)}>
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden className="shrink-0 animate-spin">
        <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeOpacity="0.25" strokeWidth="1.5" />
        <path d="M14.5 8a6.5 6.5 0 0 0-6.5-6.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
      <span>{label}</span>
    </div>
  );
}

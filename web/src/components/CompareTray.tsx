import type { CSSProperties } from "react";
import { useNavigate } from "react-router-dom";

import { clearCompare, COMPARE_CAP, removeFromCompare, useCompareList } from "../lib/compareList";

/**
 * The slim compare bar. Rendered inside AppShell (between main and the footer) as a
 * `sticky bottom-0` element, so it pins to the viewport bottom while scrolling but never
 * overlaps the footer at page end (a `fixed` bar would). Only renders when the compare
 * list is non-empty. "Compare (n)" navigates with the ids IN the URL
 * (/compare?ids=1,2,3) so the resulting view is shareable.
 *
 * Blueprint grammar (README §4d): square, hairline, accent-300 primary — same visual
 * language as the Compare page it launches into. Stays `sticky bottom-0`; another agent
 * is restyling the app shell (Header/Footer), so this does not move into it.
 */

// Condensed 600 is automatic on <h1>-<h6> (index.css applies it by element); the tray's
// labels/buttons aren't headings, so it's applied inline instead of a bespoke font stack.
const CONDENSED: CSSProperties = { fontFamily: '"Barlow Condensed", "Barlow", system-ui, sans-serif' };

export function CompareTray() {
  const list = useCompareList();
  const navigate = useNavigate();

  if (list.length === 0) return null;

  return (
    <div className="sticky bottom-0 z-30 border-t border-chartborder bg-page" data-testid="compare-tray">
      <div className="mx-auto flex w-full max-w-[1320px] flex-wrap items-center gap-2 px-6 py-2 lg:px-10">
        <span className="kicker text-[11px] text-ink-muted">Compare</span>
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
          {list.map((e) => (
            <span
              key={e.appid}
              className="inline-flex max-w-[180px] items-center gap-1 border border-chartborder px-2 py-0.5 text-[11px] text-ink-secondary"
            >
              <span className="truncate">{e.name ?? `App ${e.appid}`}</span>
              <button
                type="button"
                onClick={() => removeFromCompare(e.appid)}
                aria-label={`Remove ${e.name ?? e.appid} from compare`}
                className="-my-1 flex h-6 w-6 shrink-0 items-center justify-center text-ink-muted transition-colors hover:bg-ink-primary/[0.08] hover:text-ink-primary"
              >
                ✕
              </button>
            </span>
          ))}
          {list.length < COMPARE_CAP && (
            <span className="text-[10px] text-ink-muted">room for {COMPARE_CAP - list.length} more</span>
          )}
        </div>
        <button
          type="button"
          onClick={() => navigate(`/compare?ids=${list.map((e) => e.appid).join(",")}`)}
          style={CONDENSED}
          className="bg-brand px-3 py-1.5 text-xs font-semibold text-brand-fg transition-colors hover:bg-brand-hover"
        >
          Compare ({list.length})
        </button>
        <button
          type="button"
          onClick={clearCompare}
          style={CONDENSED}
          className="border border-chartborder px-2.5 py-1.5 text-[11px] text-ink-muted transition-colors hover:bg-ink-primary/[0.08] hover:text-ink-primary"
        >
          Clear
        </button>
      </div>
    </div>
  );
}

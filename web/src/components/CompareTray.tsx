import { useNavigate } from "react-router-dom";

import { clearCompare, COMPARE_CAP, removeFromCompare, useCompareList } from "../lib/compareList";

/**
 * The slim compare bar. Rendered inside AppShell (between main and the footer) as a
 * `sticky bottom-0` element, so it pins to the viewport bottom while scrolling but never
 * overlaps the footer at page end (a `fixed` bar would). Only renders when the compare
 * list is non-empty. "Compare (n)" navigates with the ids IN the URL
 * (/compare?ids=1,2,3) so the resulting view is shareable.
 */
export function CompareTray() {
  const list = useCompareList();
  const navigate = useNavigate();

  if (list.length === 0) return null;

  return (
    <div className="sticky bottom-0 z-30 border-t border-chartborder bg-surface shadow-md" data-testid="compare-tray">
      <div className="mx-auto flex w-full max-w-[1320px] flex-wrap items-center gap-2 px-6 py-2 lg:px-10">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-ink-muted">Compare</span>
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
          {list.map((e) => (
            <span
              key={e.appid}
              className="inline-flex max-w-[180px] items-center gap-1 rounded-full border border-chartborder bg-page px-2 py-0.5 text-[11px] text-ink-secondary"
            >
              <span className="truncate">{e.name ?? `App ${e.appid}`}</span>
              <button
                type="button"
                onClick={() => removeFromCompare(e.appid)}
                aria-label={`Remove ${e.name ?? e.appid} from compare`}
                className="-my-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-ink-muted hover:bg-page hover:text-ink-primary"
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
          className="rounded-lg bg-brand px-3 py-1.5 text-xs font-semibold text-brand-fg shadow-xs transition-colors hover:bg-brand-hover"
        >
          Compare ({list.length})
        </button>
        <button
          type="button"
          onClick={clearCompare}
          className="rounded-md border border-chartborder px-2.5 py-1.5 text-[11px] font-medium text-ink-muted hover:text-ink-primary"
        >
          Clear
        </button>
      </div>
    </div>
  );
}

/**
 * The page-level answer to "I can't find a button or a way to deselect this range".
 *
 * Once a drag zooms every chart on the page, the undo cannot live only in the corner of the
 * chart that happened to start it — by the time a reader wants out they have scrolled three
 * panels down, and the per-chart control they left behind is off screen. This is pinned to
 * the viewport, so wherever they are the way back is visible, it names the window that is
 * actually applied, and it says the two keyboard routes out loud instead of leaving them to
 * be discovered.
 *
 * Rendered once, by the shell, and it draws nothing at all when no window is set.
 */
import { formatRange, useZoomRange } from "../../lib/zoomRange";

export function ZoomBanner() {
  const { range, setRange } = useZoomRange();
  if (!range) return null;
  return (
    <div
      role="status"
      className="pointer-events-none fixed inset-x-0 bottom-4 z-40 flex justify-center px-4"
    >
      <div className="pointer-events-auto flex items-center gap-3 rounded-sm border border-borderstrong bg-surface px-3 py-2 text-xs shadow-lg">
        <span className="text-ink-muted">
          Charts zoomed to <span className="font-semibold text-ink-primary">{formatRange(range)}</span>
        </span>
        <button
          type="button"
          onClick={() => setRange(null)}
          className="rounded-sm border border-borderstrong px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-ink-secondary hover:border-brand hover:text-ink-primary focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-brand"
        >
          Clear
        </button>
        <span className="hidden text-[10px] text-ink-muted sm:inline">or press Esc</span>
      </div>
    </div>
  );
}

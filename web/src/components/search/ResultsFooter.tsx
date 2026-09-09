/** Rows per page on both search pages. */
export const PAGE_LIMIT = 25;

// Mirrors api/app/routers/games.py and entities.py: `offset: int = Query(0, ge=0, le=10000)`.
// Paging past it is a 422, and /games used to walk straight off that cliff — at
// ?offset=10000 with 174,265 matches the Next button was still enabled, and one click
// rendered "0 matches" plus the API's raw pydantic error array (measured on production
// 2026-09-01). The cap is deliberate server-side (a large OFFSET must walk every skipped
// row), so the UI's job is to stop at the last reachable page and SAY the deep tail needs a
// narrower query, not to advertise 6,971 pages when 401 exist.
export const MAX_OFFSET = 10000;

/**
 * Where a page sits in its result set, and which way it can still move. `lastOffset` is
 * the last offset the API will actually serve: `total` alone lies about reachability past
 * MAX_OFFSET (it kept Next enabled at offset 10,000 and the click landed on a 422). Deep
 * results are still reachable — by narrowing or re-sorting — which is what the footer's
 * note says instead of leaving the reader to guess.
 */
export function pagingState(total: number, offset: number, limit: number) {
  const rangeStart = total === 0 ? 0 : offset + 1;
  const rangeEnd = Math.min(offset + limit, total);
  const lastOffset = Math.min(MAX_OFFSET, Math.max(0, total - 1));
  const atPagingCap = offset + limit > lastOffset && total > offset + limit;
  return {
    rangeStart,
    rangeEnd,
    lastOffset,
    atPagingCap,
    canPrev: offset !== 0,
    canNext: !(offset + limit >= total || offset + limit > lastOffset),
  };
}

const PAGE_BUTTON =
  "border border-chartborder px-2.5 py-1 font-medium text-ink-secondary transition-colors hover:bg-surface2 hover:text-ink-primary disabled:opacity-45 disabled:hover:bg-transparent";

/**
 * "1–25 of N · Prev / Next" under the rows. `onPage` receives the offset to move to (0 for
 * the first page — the caller decides whether that means deleting ?offset= from the URL).
 */
export function ResultsFooter({
  total,
  offset,
  limit,
  onPage,
}: {
  total: number;
  offset: number;
  limit: number;
  onPage: (offset: number) => void;
}) {
  const { rangeStart, rangeEnd, lastOffset, atPagingCap, canPrev, canNext } = pagingState(total, offset, limit);
  return (
    <div className="flex items-center justify-between border-t border-chartborder pt-3 text-xs text-ink-muted">
      <span>
        {total > 0 ? `${rangeStart.toLocaleString()}–${rangeEnd.toLocaleString()} of ${total.toLocaleString()}` : "0 results"}
        {atPagingCap && (
          <span className="ml-2 text-ink-secondary">
            paging stops at {MAX_OFFSET.toLocaleString()} — narrow the filters or change the sort to reach the rest
          </span>
        )}
      </span>
      <div className="flex items-center gap-2">
        <button type="button" disabled={!canPrev} onClick={() => onPage(Math.max(0, offset - limit))} className={PAGE_BUTTON}>
          Prev
        </button>
        <button
          type="button"
          disabled={!canNext}
          onClick={() => onPage(Math.min(offset + limit, lastOffset))}
          className={PAGE_BUTTON}
        >
          Next
        </button>
      </div>
    </div>
  );
}

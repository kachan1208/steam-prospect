export type SortOrder = "asc" | "desc";

/**
 * The URL patch for picking `picked` while sorted by `sort`/`order` — the toggle-on-reselect
 * contract column-header sorting had, now behind the "sorted by …" control: the SAME key
 * again flips the direction, a NEW key starts highest-first unless it is one of `ascFirst`
 * (names read A→Z). Both search pages route their select and their ▼/▲ through this so
 * the two cannot disagree about what a click means.
 */
export function sortPatch<K extends string>(
  sort: K,
  order: SortOrder,
  picked: K,
  ascFirst: readonly K[],
): Record<string, string> {
  if (picked === sort) return { order: order === "desc" ? "asc" : "desc" };
  return { sort: picked, order: ascFirst.includes(picked) ? "asc" : "desc" };
}

/**
 * The "sorted by …" control (mockup 4e's caption, made interactive): a bare select over
 * the allow-listed keys and a ▼/▲ that flips the direction. `onSort` receives the picked
 * key; the arrow re-picks the CURRENT key, which — through sortPatch — means "flip".
 */
export function SortControl<K extends string>({
  keys,
  labels,
  sort,
  order,
  onSort,
}: {
  keys: readonly K[];
  labels: Record<K, string>;
  sort: K;
  order: SortOrder;
  onSort: (key: K) => void;
}) {
  return (
    <span className="flex items-center gap-1.5 text-ink-muted">
      sorted by
      <select
        value={sort}
        onChange={(e) => onSort(e.target.value as K)}
        aria-label="Sort by"
        className="cursor-pointer bg-transparent text-ink-secondary outline-none hover:text-ink-primary"
      >
        {keys.map((k) => (
          <option key={k} value={k}>
            {labels[k]}
          </option>
        ))}
      </select>
      <button
        type="button"
        onClick={() => onSort(sort)}
        title={`Currently sorted ${order === "desc" ? "highest first" : "lowest first"} — click to flip`}
        className="text-ink-secondary hover:text-ink-primary"
        aria-label="Toggle sort direction"
      >
        {order === "desc" ? "▼" : "▲"}
      </button>
    </span>
  );
}

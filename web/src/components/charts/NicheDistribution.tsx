import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import clsx from "clsx";
import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, XAxis, YAxis } from "recharts";

import { fmtCompact, fmtInt, fmtPct, fmtUsd } from "../../lib/format";
import { CSS_VAR } from "../../lib/palette";
import { TooltipPanel } from "./TooltipPanel";

export type DistributionMetric = "revenue" | "price";

export type DistributionBucket = {
  bucket_index: number;
  x_min: number;
  x_max: number;
  count: number;
};

/**
 * A selected slice of the axis, as VALUES (not bucket indices), so the page can hand it
 * straight to the API's rev_min/rev_max (or price_min/price_max) filters. Edges are the
 * exact bucket edges we were given — half-open [min, max), matching how the marts bucket
 * (x_min inclusive, x_max exclusive) — so the games behind a highlighted bar and the games
 * the API returns are the same set.
 */
export type BucketSelection = { min: number; max: number } | null;

// ---- selection algebra (exported so the exact edge math is unit-testable) ----------------

/** Buckets in axis order. The API returns them ordered, but the edge math must not depend on it. */
export function orderBuckets(buckets: DistributionBucket[]): DistributionBucket[] {
  return [...buckets].sort((a, b) => a.bucket_index - b.bucket_index);
}

/**
 * The selection covering ordered positions a..b inclusive (either order). The emitted
 * bounds are the FIRST bucket's x_min and the LAST bucket's x_max verbatim — never a
 * midpoint, never an off-by-one neighbour edge, because these two numbers become the
 * API filter.
 */
export function rangeSelection(ordered: DistributionBucket[], a: number, b: number): BucketSelection {
  if (ordered.length === 0) return null;
  const lo = Math.max(0, Math.min(a, b));
  const hi = Math.min(ordered.length - 1, Math.max(a, b));
  if (lo > hi) return null;
  return { min: ordered[lo].x_min, max: ordered[hi].x_max };
}

/** Click semantics: select the bucket, or clear if it is already exactly the selection. */
export function toggleSelection(
  ordered: DistributionBucket[],
  current: BucketSelection,
  index: number,
): BucketSelection {
  const next = rangeSelection(ordered, index, index);
  if (!next) return null;
  if (current && current.min === next.min && current.max === next.max) return null;
  return next;
}

/**
 * Containment first — it is exact for the edges we emit, and it is the only rule that
 * handles a POINT bucket (free-to-play, x_min === x_max === 0), which no overlap test can
 * match. Overlap is the fallback for a selection restored from a URL or a hand-typed filter
 * that doesn't land on our edges.
 */
export function isBucketSelected(bucket: DistributionBucket, selection: BucketSelection): boolean {
  if (!selection) return false;
  if (bucket.x_min >= selection.min && bucket.x_max <= selection.max) return true;
  return bucket.x_min < selection.max && bucket.x_max > selection.min;
}

/** The [first, last] ordered positions a selection covers, or null if it covers none. */
export function selectedIndexSpan(
  ordered: DistributionBucket[],
  selection: BucketSelection,
): [number, number] | null {
  if (!selection) return null;
  let lo = -1;
  let hi = -1;
  ordered.forEach((b, i) => {
    if (!isBucketSelected(b, selection)) return;
    if (lo === -1) lo = i;
    hi = i;
  });
  return lo === -1 ? null : [lo, hi];
}

/** Shift+Arrow: grow the current selection so it also covers `index` (union of spans). */
export function extendSelection(
  ordered: DistributionBucket[],
  current: BucketSelection,
  index: number,
): BucketSelection {
  const span = selectedIndexSpan(ordered, current);
  if (!span) return rangeSelection(ordered, index, index);
  return rangeSelection(ordered, Math.min(span[0], index), Math.max(span[1], index));
}

export function selectedCount(ordered: DistributionBucket[], selection: BucketSelection): number {
  if (!selection) return 0;
  return ordered.reduce((sum, b) => (isBucketSelected(b, selection) ? sum + b.count : sum), 0);
}

// ---- labels ------------------------------------------------------------------------------

/** A single axis VALUE. Never fmtPrice() here: it renders 0 as "Free", which is a lie on
 *  the right-hand edge of a range ("Free – $4.99"), and fmtUsd rounds $19.99 to "$20". */
function fmtEdge(metric: DistributionMetric, v: number): string {
  if (v === 0) return "$0";
  if (metric === "price") return Number.isInteger(v) ? `$${v}` : `$${v.toFixed(2)}`;
  return fmtUsd(v);
}

/** True for the degenerate [0, 0] bucket the price mart emits for free-to-play titles. */
function isFreeBucket(metric: DistributionMetric, b: DistributionBucket): boolean {
  return metric === "price" && b.x_min === 0 && b.x_max === 0;
}

/** The tick under a band: its lower edge, except free-to-play, which is named, not numbered. */
function bucketTick(metric: DistributionMetric, b: DistributionBucket): string {
  if (isFreeBucket(metric, b)) return "Free";
  return fmtEdge(metric, b.x_min);
}

/** The full range, for tooltips and accessible names. */
function bucketRange(metric: DistributionMetric, b: DistributionBucket): string {
  if (isFreeBucket(metric, b)) return "Free ($0)";
  if (b.x_min === b.x_max) return fmtEdge(metric, b.x_min);
  return `${fmtEdge(metric, b.x_min)} – ${fmtEdge(metric, b.x_max)}`;
}

function selectionRangeText(metric: DistributionMetric, selection: NonNullable<BucketSelection>): string {
  if (selection.min === 0 && selection.max === 0) return "Free ($0)";
  return `${fmtEdge(metric, selection.min)} – ${fmtEdge(metric, selection.max)}`;
}

const METRIC_META: Record<DistributionMetric, { title: string; short: string; noun: string }> = {
  revenue: { title: "Games by estimated lifetime revenue", short: "Revenue", noun: "revenue" },
  price: { title: "Games by price", short: "Price", noun: "price" },
};

/**
 * The axis caption. Revenue buckets span orders of magnitude, so the marts hand us
 * log-spaced (widening) edges and we draw them as EQUAL-WIDTH bands — the only layout that
 * keeps the long tail readable, and the one Histogram.tsx already established. That trade is
 * only honest if the chart says so out loud, which is what this sentence is for.
 */
function axisNote(metric: DistributionMetric, ordered: DistributionBucket[]): string {
  const widths = ordered.filter((b) => b.x_max > b.x_min).map((b) => b.x_max - b.x_min);
  const parts: string[] = [];

  if (widths.length > 1) {
    const min = Math.min(...widths);
    const max = Math.max(...widths);
    if (max > min * 1.5) {
      parts.push(
        `Equal-width bands, unequal ${metric === "price" ? "price" : "dollar"} ranges — edges widen to the right, so compare heights, not widths.`,
      );
    } else {
      parts.push(`Each band covers an equal ${fmtEdge(metric, min)} range.`);
    }
  }

  if (metric === "price") {
    if (ordered.some((b) => isFreeBucket(metric, b))) {
      parts.push("Free-to-play ($0) gets its own band.");
    } else if (ordered[0]?.x_min === 0) {
      parts.push("Note: free-to-play ($0) is inside the first band, not broken out.");
    }
  }

  if (ordered.some((b) => b.count === 0)) {
    parts.push("Empty bands are kept — a gap in the market, not missing data.");
  }

  return parts.join(" ");
}

// ---- geometry ----------------------------------------------------------------------------

/**
 * Recharts plot-area geometry, pinned rather than defaulted so the HTML interaction overlay
 * lands exactly on the SVG bands. Recharts starts the plot at margin.left + YAxis width and
 * ends the band strip at margin.bottom + XAxis height; fixing all four means the overlay's
 * n equal flex columns coincide with recharts' n equal categorical bands.
 */
const MARGIN = { top: 20, right: 12, left: 4, bottom: 6 } as const;
const Y_AXIS_WIDTH = 44;
const X_AXIS_HEIGHT = 28;
const PLOT_INSET: CSSProperties = {
  position: "absolute",
  left: MARGIN.left + Y_AXIS_WIDTH,
  right: MARGIN.right,
  top: MARGIN.top,
  bottom: MARGIN.bottom + X_AXIS_HEIGHT,
};

// One series (a count of games) on both charts, so both wear categorical slot 1 — the same
// blue the niche revenue histogram already uses. Selection is deliberately NOT a hue change:
// picked bands keep the full-strength fill while the rest drop to 0.35 opacity, sit under a
// brand-tint column wash, and are underlined by an ink rail on the baseline (which is also
// the only marker that can show an EMPTY bucket is selected — it has no bar to restyle).
// aria-pressed + the header chip carry the same state to assistive tech. No new hex values
// are introduced, so the palette validator's existing sign-off in lib/palette.ts still holds.
const BAR_COLOR = CSS_VAR.demand;
const DIM_OPACITY = 0.35;

// ---- component ---------------------------------------------------------------------------

export function NicheDistribution({
  metric,
  buckets,
  selection,
  onSelectionChange,
  loading = false,
  totalGames,
  height = 240,
}: {
  metric: DistributionMetric;
  buckets: DistributionBucket[];
  selection: BucketSelection;
  onSelectionChange: (s: BucketSelection) => void;
  loading?: boolean;
  totalGames?: number;
  /** Beyond the frozen contract: plot height, matching Histogram/TimingBars. Reserved in
   *  every state (loading, empty, loaded) so the page never jumps. */
  height?: number;
}) {
  const ordered = useMemo(() => orderBuckets(buckets), [buckets]);
  const meta = METRIC_META[metric];

  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const [rovingIndex, setRovingIndex] = useState(0);
  const [dragSpan, setDragSpan] = useState<[number, number] | null>(null);

  const dragRef = useRef<{ anchor: number; current: number; moved: boolean } | null>(null);
  const suppressClickRef = useRef(false);
  const btnRefs = useRef<(HTMLButtonElement | null)[]>([]);

  // Kept in a ref so the window listener below can stay mounted once instead of
  // re-subscribing on every render (parents commonly pass an inline onSelectionChange).
  const latest = useRef({ ordered, onSelectionChange });
  latest.current = { ordered, onSelectionChange };

  // Release anywhere finishes the drag — a pointer that leaves the chart mid-drag must not
  // strand the component in a permanent "dragging" state.
  useEffect(() => {
    function onUp() {
      const d = dragRef.current;
      dragRef.current = null;
      setDragSpan(null);
      if (d && d.moved) {
        // A real drag already committed the range; swallow the click that follows mouseup
        // so it doesn't immediately re-toggle the bucket under the cursor.
        suppressClickRef.current = true;
        latest.current.onSelectionChange(rangeSelection(latest.current.ordered, d.anchor, d.current));
      }
    }
    window.addEventListener("mouseup", onUp);
    return () => window.removeEventListener("mouseup", onUp);
  }, []);

  const previewSelection = dragSpan ? rangeSelection(ordered, dragSpan[0], dragSpan[1]) : selection;
  const charted = ordered.reduce((sum, b) => sum + b.count, 0);
  const inRange = selectedCount(ordered, previewSelection);
  const separatorAfter = metric === "price" && ordered.length > 1 && isFreeBucket(metric, ordered[0]) ? 1 : null;

  const summary = previewSelection
    ? `${fmtInt(inRange)} of ${fmtInt(charted)} games in the selected range`
    : totalGames != null && totalGames !== charted
      ? `${fmtInt(charted)} of ${fmtInt(totalGames)} games have a ${meta.noun} to chart`
      : `${fmtInt(charted)} games`;

  function handleMouseDown(i: number) {
    suppressClickRef.current = false;
    dragRef.current = { anchor: i, current: i, moved: false };
    setDragSpan([i, i]);
  }

  // onMouseOver, not onMouseEnter: `mouseover` bubbles and is what React actually delegates,
  // so the drag works under synthetic events in tests as well as in the browser. The buttons
  // have no children, so it fires exactly once per band entered.
  function handleMouseOver(i: number) {
    setActiveIndex(i);
    const d = dragRef.current;
    if (!d) return;
    d.current = i;
    if (i !== d.anchor) d.moved = true;
    setDragSpan([d.anchor, i]);
  }

  function handleClick(i: number) {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    setRovingIndex(i);
    onSelectionChange(toggleSelection(ordered, selection, i));
  }

  function handleKeyDown(e: KeyboardEvent<HTMLButtonElement>, i: number) {
    if (e.key === "Escape") {
      if (selection) {
        e.preventDefault();
        onSelectionChange(null);
      }
      return;
    }
    let next: number | null = null;
    if (e.key === "ArrowLeft") next = Math.max(0, i - 1);
    else if (e.key === "ArrowRight") next = Math.min(ordered.length - 1, i + 1);
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = ordered.length - 1;
    if (next === null) return;
    e.preventDefault();
    setRovingIndex(next);
    btnRefs.current[next]?.focus();
    if (e.shiftKey) onSelectionChange(extendSelection(ordered, selection, next));
  }

  const hasData = ordered.length > 0;
  const chartData = ordered.map((b) => ({ ...b, label: bucketTick(metric, b) }));
  const activeBucket = activeIndex !== null ? ordered[activeIndex] : undefined;

  return (
    <div className="flex select-none flex-col">
      <div className="mb-1.5 flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <div className="min-w-0">
          <div className="text-xs font-medium text-ink-primary">{meta.title}</div>
          <div className="text-[11px] text-ink-muted">{summary}</div>
        </div>
        {previewSelection && (
          <div className="flex shrink-0 items-center gap-2 rounded-lg border border-chartborder bg-surface2 px-2 py-1 text-[11px]">
            <span className="inline-block h-2.5 w-2.5 shrink-0 rounded-sm" style={{ backgroundColor: BAR_COLOR }} />
            <span className="text-ink-secondary">{meta.short}</span>
            <span className="tabular font-medium text-ink-primary">{selectionRangeText(metric, previewSelection)}</span>
            <button
              type="button"
              onClick={() => onSelectionChange(null)}
              aria-label={`Clear ${meta.noun} filter`}
              className="-mr-1 rounded px-1 py-0.5 font-medium text-ink-secondary underline decoration-dotted underline-offset-2 hover:text-ink-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
            >
              Clear
            </button>
          </div>
        )}
      </div>

      <div
        className="relative w-full"
        style={{ height }}
        aria-busy={loading || undefined}
        onMouseLeave={() => setActiveIndex(null)}
      >
        {!hasData ? (
          <div className="flex h-full items-center justify-center text-xs text-ink-muted">
            {loading ? `Loading ${meta.noun} distribution…` : "No data for this slice."}
          </div>
        ) : (
          <>
            {/* Wash layer — under the SVG, so bars paint over it exactly like a Recharts cursor. */}
            <div className="pointer-events-none" style={PLOT_INSET}>
              <div className="flex h-full w-full">
                {ordered.map((b, i) => (
                  <div key={b.bucket_index} className="relative h-full flex-1">
                    {isBucketSelected(b, previewSelection) && (
                      <div className="absolute inset-0" style={{ backgroundColor: "var(--brand-tint)" }} />
                    )}
                    {activeIndex === i && (
                      <div
                        className="absolute inset-0 opacity-60"
                        style={{ backgroundColor: "var(--gridline)" }}
                      />
                    )}
                  </div>
                ))}
              </div>
            </div>

            {/* Refetch holds the frame at reduced opacity rather than flashing a skeleton. */}
            <div className="absolute inset-0" style={{ opacity: loading ? 0.5 : 1 }}>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={chartData} margin={{ ...MARGIN }} barCategoryGap={2}>
                  <CartesianGrid stroke="var(--gridline)" vertical={false} />
                  <XAxis
                    dataKey="label"
                    height={X_AXIS_HEIGHT}
                    tick={{ fontSize: 10 }}
                    interval="preserveStartEnd"
                    minTickGap={12}
                    tickLine={false}
                    axisLine={{ stroke: "var(--baseline)" }}
                  />
                  <YAxis
                    width={Y_AXIS_WIDTH}
                    tick={{ fontSize: 10 }}
                    tickFormatter={(v: number) => fmtCompact(v)}
                    tickLine={false}
                    axisLine={false}
                    allowDecimals={false}
                  />
                  <Bar dataKey="count" radius={[4, 4, 0, 0]} maxBarSize={24} isAnimationActive={false}>
                    {ordered.map((b) => (
                      <Cell
                        key={b.bucket_index}
                        fill={BAR_COLOR}
                        opacity={!previewSelection || isBucketSelected(b, previewSelection) ? 1 : DIM_OPACITY}
                      />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>

            {/* Rails, separator and tooltip — above the SVG, never in the way of the pointer. */}
            <div className="pointer-events-none z-10" style={PLOT_INSET}>
              {separatorAfter !== null && (
                <div
                  className="absolute inset-y-0 w-px"
                  style={{ left: `${(separatorAfter / ordered.length) * 100}%`, backgroundColor: "var(--border-strong)" }}
                  aria-hidden="true"
                />
              )}
              {(() => {
                const span = selectedIndexSpan(ordered, previewSelection);
                if (!span) return null;
                const left = (span[0] / ordered.length) * 100;
                const width = ((span[1] - span[0] + 1) / ordered.length) * 100;
                return (
                  <div
                    className="absolute bottom-0 h-[3px] rounded-full"
                    style={{ left: `${left}%`, width: `${width}%`, backgroundColor: "var(--text-primary)" }}
                    aria-hidden="true"
                  />
                );
              })()}
              {activeBucket && (
                <div
                  className="absolute top-1 z-20 whitespace-nowrap"
                  style={tooltipAnchor(activeIndex as number, ordered.length)}
                >
                  <TooltipPanel
                    title={bucketRange(metric, activeBucket)}
                    rows={[
                      { label: "Games", value: fmtCompact(activeBucket.count), color: BAR_COLOR },
                      { label: "Share", value: charted > 0 ? fmtPct(activeBucket.count / charted, 1) : "—" },
                    ]}
                  />
                </div>
              )}
            </div>

            {/* Interaction layer. Full-height per-band hit targets, so a zero-count bucket is
                just as clickable as a tall one, and the target is far bigger than the mark. */}
            <div
              className="z-30"
              style={PLOT_INSET}
              role="group"
              aria-label={`${meta.title} — select a band to filter this niche by ${meta.noun}`}
            >
              <div className="flex h-full w-full">
                {ordered.map((b, i) => {
                  const isSel = isBucketSelected(b, previewSelection);
                  return (
                    <button
                      key={b.bucket_index}
                      ref={(el) => {
                        btnRefs.current[i] = el;
                      }}
                      type="button"
                      tabIndex={i === Math.min(rovingIndex, ordered.length - 1) ? 0 : -1}
                      aria-pressed={isSel}
                      aria-label={`${bucketRange(metric, b)}: ${fmtInt(b.count)} games`}
                      onMouseDown={() => handleMouseDown(i)}
                      onMouseOver={() => handleMouseOver(i)}
                      onFocus={() => {
                        setActiveIndex(i);
                        setRovingIndex(i);
                      }}
                      onBlur={() => setActiveIndex((cur) => (cur === i ? null : cur))}
                      onClick={() => handleClick(i)}
                      onKeyDown={(e) => handleKeyDown(e, i)}
                      className={clsx(
                        "h-full min-w-0 flex-1 cursor-pointer rounded-sm border-0 bg-transparent p-0",
                        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand",
                      )}
                    />
                  );
                })}
              </div>
            </div>
          </>
        )}
      </div>

      <p className="mt-1.5 text-[11px] leading-relaxed text-ink-muted">
        {hasData && (
          <span className="text-ink-secondary">
            {selection
              ? "Click the highlighted band again, press Esc, or use Clear to drop it. "
              : "Click a band to filter the niche; drag across bands for a range. "}
          </span>
        )}
        {axisNote(metric, ordered)}
      </p>
    </div>
  );
}

/**
 * Keep the tooltip inside the plot: bands in the outer fifths anchor to their own edge
 * instead of centring, so the panel never hangs off the card.
 */
function tooltipAnchor(index: number, n: number): CSSProperties {
  const center = ((index + 0.5) / n) * 100;
  if (center < 20) return { left: `${(index / n) * 100}%`, transform: "translateX(0)" };
  if (center > 80) return { left: `${((index + 1) / n) * 100}%`, transform: "translateX(-100%)" };
  return { left: `${center}%`, transform: "translateX(-50%)" };
}

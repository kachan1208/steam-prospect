/** Which months on a monthly review chart get a PLUMB LINE, WHY, and what the line says —
 * the one shared gate the review chart (ReviewVelocityBars) runs its event/anomaly markers
 * through. Tooltips are NOT gated: every
 * hovered month still lists its events; only the drawn lines are selected here.
 *
 * Why this exists — two failure modes bracket the design:
 *   - "line per event month" picket-fences a patch-heavy game (CS2 ships updates most months)
 *     until the markers explain nothing;
 *   - "line only on huge absolute spikes" (the old MIN_LIFT=15 rule) draws NOTHING for
 *     small/mid games whose whole monthly scale is 3-30 reviews, which is how markers went
 *     invisible on most profiles while the tooltip kept listing events.
 * The fix is an ADAPTIVE change detector plus a sparse-events fallback, capped for readability.
 *
 * 1. Adaptive spike/drop rule (per month, against the trailing WINDOW=6-month median, first
 *    MIN_SKIP=2 months skipped — launch turbulence is the release marker's job):
 *      spike: value >= RATIO x median  AND  value - median >= max(ABS_FLOOR, REL_FLOOR x median)
 *      drop:  value <= median / RATIO  AND  median - value >= the same floor
 *    The relative floor (0.5 x median) carries small games — 20 reviews over a median of 8 is
 *    a real event; the 6-review absolute floor keeps 3-vs-1 micro-noise dark. Drops are
 *    detected symmetrically: a collapse is as notable a change as a surge.
 *    EXCEPT in the current calendar month: the last charted month is half-elapsed for half
 *    the month and always looks like a collapse, so a drop there is never flagged (a spike
 *    still is — a partial month that already beats the median is a real surge).
 *
 * 2. Sparse-events fallback — precedence of what gets a line:
 *      - If the game has <= SPARSE_EVENT_MAX (8) event months ON the charted axis in total,
 *        EVERY one of them gets a line (a sparse feed cannot picket-fence), plus every
 *        detected spike/drop.
 *      - If more, lines go only to detected spikes (event or not — CS2's real inflections
 *        predate our article scrape) and to drops that coincide with an event month; event
 *        months where the curve did not move stay tooltip-only.
 *      - The release month ALWAYS gets a line when it is on the axis, in both modes.
 *
 * 3. Readability cap: at most MAX_LINES (14) lines per chart. When over, the most extreme
 *    months by |value - median| / median survive; the release line is always kept.
 *
 * 4. Every line carries a label (design handoff: "1px dashed paper vertical line + condensed
 *    uppercase annotation"). `markerReasons` is the selection above with the WHY attached;
 *    `plumbLineLabel` turns a reason into <= ~9 characters of uppercase; `layoutPlumbLabels`
 *    spreads the labels over two rows above the plot and degrades/hides the ones that would
 *    collide at the measured plot width. A bare dotted line explained nothing — the report
 *    was "there are lines but they don't show any additional info".
 */
import { fmtCompact } from "./format";

const WINDOW = 6;
const RATIO = 1.75;
const MIN_SKIP = 2;
const ABS_FLOOR = 6;
const REL_FLOOR = 0.5;
const SPARSE_EVENT_MAX = 8;
const MAX_LINES = 14;

/** The detector's thresholds, exported so a legend quotes the rule it actually draws. */
export const MARKER_RATIO = RATIO;
export const MARKER_WINDOW = WINDOW;

export interface SeriesPoint {
  period: string; // 'YYYY-MM'
  value: number;
}

/** Why a month has a plumb line. */
export interface MarkerReason {
  /** The release month — always drawn when on the axis, always labelled RELEASED. */
  release: boolean;
  /** At least one catalog event falls in this month. */
  eventMonth: boolean;
  /** The adaptive detector's verdict, when the curve moved here. */
  change?: "spike" | "drop";
  /** value / max(trailing median, 1) — the multiple the label prints ("▲ 3.0×"). */
  ratio?: number;
  value?: number;
  median?: number;
}

export interface MarkerOptions {
  /** "Today", for the partial-month rule. Injectable so tests can pin the calendar. */
  now?: Date;
}

interface Change {
  change: "spike" | "drop";
  ratio: number;
  value: number;
  median: number;
}

function monthOf(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

/** Trailing-median spike/drop detection over the series, plus an extremity score per month
 * (|value - median| / median, medians clamped to >= 1) used by the readability cap.
 * `partialMonth` is the current calendar month when it is the last charted one: its drop is
 * suppressed and its score zeroed, so an incomplete month never earns a line as a collapse. */
function detectChanges(
  points: SeriesPoint[],
  partialMonth?: string,
): {
  changes: Map<string, Change>;
  score: Map<string, number>;
} {
  const changes = new Map<string, Change>();
  const score = new Map<string, number>();
  for (let i = MIN_SKIP; i < points.length; i++) {
    const prev = points
      .slice(Math.max(0, i - WINDOW), i)
      .map((p) => p.value)
      .sort((a, b) => a - b);
    if (prev.length === 0) continue;
    const median =
      prev.length % 2 === 1
        ? prev[(prev.length - 1) / 2]
        : (prev[prev.length / 2 - 1] + prev[prev.length / 2]) / 2;
    const { period, value: v } = points[i];
    const base = Math.max(median, 1); // a 0-review median must not make every 1-review month a spike
    const floor = Math.max(ABS_FLOOR, REL_FLOOR * median);
    const partialDrop = period === partialMonth && v < median;
    score.set(period, partialDrop ? 0 : Math.abs(v - median) / base);
    if (v >= RATIO * base && v - median >= floor) {
      changes.set(period, { change: "spike", ratio: v / base, value: v, median });
    } else if (!partialDrop && v <= median / RATIO && median - v >= floor) {
      changes.set(period, { change: "drop", ratio: v / base, value: v, median });
    }
  }
  return { changes, score };
}

/**
 * The marker-month selection all three review charts share, with the reason each month
 * earned its line.
 *
 * @param points       The charted monthly series (chronological), value = reviews that month.
 * @param eventMonths  'YYYY-MM' months that have at least one catalog event; months not on the
 *                     charted axis are ignored (a marker must never float off the axis).
 * @param releaseMonth The release 'YYYY-MM', if known — always marked when on the axis.
 * @returns 'YYYY-MM' -> reason, in axis order (all guaranteed on the axis). Precedence and
 *          the cap are documented in the file header above.
 */
export function markerReasons(
  points: SeriesPoint[],
  eventMonths: Iterable<string>,
  releaseMonth?: string,
  opts: MarkerOptions = {},
): Map<string, MarkerReason> {
  const axis = new Set(points.map((p) => p.period));
  const last = points.length > 0 ? points[points.length - 1].period : undefined;
  const partialMonth = last !== undefined && last === monthOf(opts.now ?? new Date()) ? last : undefined;
  const { changes, score } = detectChanges(points, partialMonth);
  const eventsOnAxis = new Set([...eventMonths].filter((m) => axis.has(m)));

  let lines: Set<string>;
  if (eventsOnAxis.size <= SPARSE_EVENT_MAX) {
    // Sparse feed: every event month earns a line, plus every detected change.
    lines = new Set([...eventsOnAxis, ...changes.keys()]);
  } else {
    // Dense feed: only where the curve moved — all spikes, drops only when an event
    // coincides (an unexplained collapse stays tooltip-territory on patch-heavy games).
    lines = new Set(
      [...changes].filter(([m, c]) => c.change === "spike" || eventsOnAxis.has(m)).map(([m]) => m),
    );
  }
  if (releaseMonth !== undefined && axis.has(releaseMonth)) lines.add(releaseMonth);

  if (lines.size > MAX_LINES) {
    const keep = new Set<string>();
    if (releaseMonth !== undefined && lines.has(releaseMonth)) keep.add(releaseMonth);
    const byExtremity = [...lines]
      .filter((m) => m !== releaseMonth)
      .sort((a, b) => (score.get(b) ?? 0) - (score.get(a) ?? 0));
    for (const m of byExtremity) {
      if (keep.size >= MAX_LINES) break;
      keep.add(m);
    }
    lines = keep;
  }

  const reasons = new Map<string, MarkerReason>();
  for (const p of points) {
    if (!lines.has(p.period)) continue;
    const reason: MarkerReason = { release: p.period === releaseMonth, eventMonth: eventsOnAxis.has(p.period) };
    const c = changes.get(p.period);
    if (c) {
      reason.change = c.change;
      reason.ratio = c.ratio;
      reason.value = c.value;
      reason.median = c.median;
    }
    reasons.set(p.period, reason);
  }
  return reasons;
}

/** The set of 'YYYY-MM' periods to draw lines at — `markerReasons` without the why. */
export function markerMonths(
  points: SeriesPoint[],
  eventMonths: Iterable<string>,
  releaseMonth?: string,
  opts?: MarkerOptions,
): Set<string> {
  return new Set(markerReasons(points, eventMonths, releaseMonth, opts).keys());
}

// ---- labels ------------------------------------------------------------------------------

/** A catalog event as the labeller reads it — the kind, and the title when it has one. */
export interface PlumbEvent {
  kind: string;
  title?: string | null;
}

/** Plural nouns for a multi-event month: "2 UPDATES" but "2 PRESS" (a mass noun — "presses"
 * is a different word). Kinds this table does not know just take an S. */
const KIND_PLURAL: Record<string, string> = { update: "UPDATES", press: "PRESS" };

function changeGlyph(reason: MarkerReason): "▲" | "▼" | undefined {
  if (reason.change === "spike") return "▲";
  if (reason.change === "drop") return "▼";
  return undefined;
}

/** "3.0×" below ten, "12×" from there: the label has ~9 characters of room and a decimal on
 * a 12x spike says nothing a reader acts on. A collapse that would round to "0.0×" prints
 * "<0.1×" — a multiple of nothing is not what happened. */
function fmtMultiple(ratio: number): string {
  if (ratio < 0.05) return "<0.1×";
  // Past ~100× the multiple is of a near-empty baseline (a beta month with one review before
  // the real launch read "▲ 1838×"), so the digits say nothing more than ">99×" does.
  if (ratio >= 99.5) return ">99×";
  return `${ratio < 9.95 ? ratio.toFixed(1) : Math.round(ratio)}×`;
}

/**
 * The text on a plumb line — uppercase, <= ~9 characters (the layout below estimates width
 * from character count, so the cap is what keeps the estimate honest):
 *   release                      RELEASED
 *   event month, curve flat      UPDATE / PRESS; several: 2 UPDATES / 3 EVENTS (mixed kinds)
 *   change, no event             ▲ 3.0× / ▼ 0.3× — the multiple of the trailing 6-month median
 *   event + change               UPDATE ▲ (several events: UPDATES ▲ — the count goes, the
 *                                tooltip lists them; "2 UPDATES ▲" would not fit)
 * @param events The month's catalog events; only their `kind` is read.
 */
export function plumbLineLabel(reason: MarkerReason, events: ReadonlyArray<PlumbEvent> = []): string {
  if (reason.release) {
    // An Early Access graduate is dated from its EA start (the rebuilt mart's release event is
    // titled "Early Access launch"), so that line is the EA launch, not a "release".
    const release = events.find((e) => e.kind === "release");
    return release?.title && /^early access/i.test(release.title) ? "EA LAUNCH" : "RELEASED";
  }
  const glyph = changeGlyph(reason);
  // The graduate's 1.0 ships as an 'update' titled "1.0 release" — it is the second-biggest
  // spike on most EA charts, so it says "1.0", not "UPDATE".
  const kinds = events
    .map((e) => (e.kind === "update" && /^1\.0 release/i.test(e.title ?? "") ? "1.0" : e.kind))
    .filter((k) => k !== "release");
  if (kinds.length === 0) {
    if (glyph !== undefined && reason.ratio !== undefined) return `${glyph} ${fmtMultiple(reason.ratio)}`;
    return glyph ?? "•";
  }
  const single = kinds[0].toUpperCase();
  const plural = new Set(kinds).size === 1 ? (KIND_PLURAL[kinds[0]] ?? `${single}S`) : "EVENTS";
  if (glyph !== undefined) return `${kinds.length === 1 ? single : plural} ${glyph}`;
  return kinds.length === 1 ? single : `${kinds.length} ${plural}`;
}

/** The tooltip's one-line account of a detected change: "3.0× the trailing 6-mo median
 * (36 → 107)". Undefined when the month's line is not about a change. */
export function changeSummary(reason: MarkerReason): string | undefined {
  if (reason.change === undefined || reason.ratio === undefined || reason.value === undefined || reason.median === undefined) {
    return undefined;
  }
  return `${fmtMultiple(reason.ratio)} the trailing ${WINDOW}-mo median (${fmtCompact(Math.round(reason.median))} → ${fmtCompact(reason.value)})`;
}

// ---- layout ------------------------------------------------------------------------------

export interface PlumbLabel {
  /** Final text — the full label, or the glyph it was degraded to. */
  text: string;
  /** 1 = the row on the plot's edge (where every label wants to be), 0 = the row above it. */
  row: number;
  /** False when even the glyph would collide: the line is still drawn, unlabelled. */
  show: boolean;
}

/** Estimated ink per character of the 9.5px uppercase labels. Calibrated to the FALLBACK
 * font (measured 6.4-7.1px/char in headless Chromium with Google Fonts unreachable), not to
 * Barlow Condensed's ~5.5: the estimate has to hold when the web font does not load, and
 * over-estimating only degrades a label a little early, while under-estimating overlaps
 * two of them into an unreadable one. */
export const LABEL_CHAR_PX = 6.5;
/** Minimum clear space between two neighbouring labels in one row. */
export const LABEL_GAP_PX = 8;
/** The plot width to assume before ResponsiveContainer has reported one: wide, so the first
 * paint shows every label in full and the measured layout only ever takes labels away. */
export const UNMEASURED_PLOT_PX = 4000;

/**
 * Where each marked month's label goes and what survives at this plot width. Pure: the chart
 * feeds it the visible x categories (in axis order), the reasons, the measured plot width and
 * the events per month; it gets back one entry per marked VISIBLE month, in axis order.
 *
 * Every label prefers the lower row, on the plot's edge; one is lifted to the row above only
 * when it would overlap the label placed before it on the lower row — so a sparse chart reads
 * as one tidy row and a dense one uses both. When it would collide on both rows, the less
 * extreme of it and its lower-row neighbour (release > bigger |ratio - 1| > event-only) is
 * degraded to its glyph alone (▲ / ▼ / •); if that still collides, it is hidden. RELEASED is
 * never degraded or hidden — the one line every chart must explain.
 *
 * x is the category's band centre, (i + 0.5) / n of the plot width — what a bar chart draws;
 * a line chart's point scale differs by at most half a band, well inside the estimate's slack.
 * Width is LABEL_CHAR_PX per character (see its note on calibration) plus LABEL_GAP_PX clear.
 */
export function layoutPlumbLabels(
  visiblePeriods: readonly string[],
  reasonsByMonth: ReadonlyMap<string, MarkerReason>,
  plotWidthPx: number,
  eventsByMonth?: ReadonlyMap<string, ReadonlyArray<PlumbEvent>>,
): Map<string, PlumbLabel> {
  interface Slot extends PlumbLabel {
    period: string;
    x: number;
    release: boolean;
    extremity: number;
    glyph: string;
    degraded: boolean;
  }
  const n = visiblePeriods.length;
  const slots: Slot[] = [];
  visiblePeriods.forEach((period, i) => {
    const reason = reasonsByMonth.get(period);
    if (!reason) return;
    slots.push({
      period,
      x: ((i + 0.5) / n) * plotWidthPx,
      text: plumbLineLabel(reason, eventsByMonth?.get(period)),
      row: 1,
      show: true,
      release: reason.release,
      extremity: reason.release ? Infinity : reason.change !== undefined && reason.ratio !== undefined ? Math.abs(reason.ratio - 1) : 0,
      glyph: changeGlyph(reason) ?? "•",
      degraded: false,
    });
  });

  const width = (s: Slot) => s.text.length * LABEL_CHAR_PX;
  // Where the label is DRAWN: centred on its line, but pinned inside the plot at either edge
  // (the chart anchors an overhanging label to the edge instead of letting it hang over an
  // axis). Measured on the current text, so a degraded glyph re-centres.
  const drawnX = (s: Slot) => {
    const half = width(s) / 2;
    if (plotWidthPx <= 2 * half) return plotWidthPx / 2;
    return Math.min(Math.max(s.x, half), plotWidthPx - half);
  };
  const overlaps = (a: Slot, b: Slot) => Math.abs(drawnX(a) - drawnX(b)) < (width(a) + width(b)) / 2 + LABEL_GAP_PX;

  // The labels placed on each row and still visible, left to right.
  const placed: [Slot[], Slot[]] = [[], []];
  const last = (row: number): Slot | undefined => placed[row][placed[row].length - 1];
  for (const cur of slots) {
    for (;;) {
      // The plot-edge row whenever it is clear; the row above only to clear the label before it.
      const row = [1, 0].find((r) => {
        const prev = last(r);
        return prev === undefined || !overlaps(prev, cur);
      });
      if (row !== undefined) {
        cur.row = row;
        placed[row].push(cur);
        break;
      }
      // Both rows collide: the less extreme of cur and its plot-edge neighbour gives way.
      // Ties go against the later label; the release never yields.
      const prev = last(1)!;
      const loser = prev.release ? cur : cur.release ? prev : prev.extremity < cur.extremity ? prev : cur;
      if (!loser.degraded) {
        loser.text = loser.glyph;
        loser.degraded = true;
        continue; // try both rows again with the shorter text
      }
      loser.show = false;
      if (loser === cur) break;
      placed[1].pop(); // prev is gone; cur now has to clear the label before it
    }
  }
  return new Map(slots.map((s) => [s.period, { text: s.text, row: s.row, show: s.show }]));
}

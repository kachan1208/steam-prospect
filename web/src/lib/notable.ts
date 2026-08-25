/** Which months on a monthly review chart get a PLUMB LINE — the one shared gate all three
 * review charts (ReviewVelocityBars, ReviewsTimelineChart, GameTrendsChart) run their
 * event/anomaly markers through. Tooltips are NOT gated: every hovered month still lists its
 * events; only the drawn lines are selected here.
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
 */
const WINDOW = 6;
const RATIO = 1.75;
const MIN_SKIP = 2;
const ABS_FLOOR = 6;
const REL_FLOOR = 0.5;
const SPARSE_EVENT_MAX = 8;
const MAX_LINES = 14;

export interface SeriesPoint {
  period: string; // 'YYYY-MM'
  value: number;
}

/** Trailing-median spike/drop detection over the series, plus an extremity score per month
 * (|value - median| / median, medians clamped to >= 1) used by the readability cap. */
function detectChanges(points: SeriesPoint[]): {
  spikes: Set<string>;
  drops: Set<string>;
  score: Map<string, number>;
} {
  const spikes = new Set<string>();
  const drops = new Set<string>();
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
    const v = points[i].value;
    const base = Math.max(median, 1); // a 0-review median must not make every 1-review month a spike
    const floor = Math.max(ABS_FLOOR, REL_FLOOR * median);
    score.set(points[i].period, Math.abs(v - median) / base);
    if (v >= RATIO * base && v - median >= floor) {
      spikes.add(points[i].period);
    } else if (v <= median / RATIO && median - v >= floor) {
      drops.add(points[i].period);
    }
  }
  return { spikes, drops, score };
}

/**
 * The marker-month selection all three review charts share: which months get a plumb line.
 *
 * @param points       The charted monthly series (chronological), value = reviews that month.
 * @param eventMonths  'YYYY-MM' months that have at least one catalog event; months not on the
 *                     charted axis are ignored (a marker must never float off the axis).
 * @param releaseMonth The release 'YYYY-MM', if known — always marked when on the axis.
 * @returns The set of 'YYYY-MM' periods to draw lines at (all guaranteed on the axis).
 *          Precedence and the cap are documented in the file header above.
 */
export function markerMonths(
  points: SeriesPoint[],
  eventMonths: Iterable<string>,
  releaseMonth?: string,
): Set<string> {
  const axis = new Set(points.map((p) => p.period));
  const { spikes, drops, score } = detectChanges(points);
  const eventsOnAxis = new Set([...eventMonths].filter((m) => axis.has(m)));

  let lines: Set<string>;
  if (eventsOnAxis.size <= SPARSE_EVENT_MAX) {
    // Sparse feed: every event month earns a line, plus every detected change.
    lines = new Set([...eventsOnAxis, ...spikes, ...drops]);
  } else {
    // Dense feed: only where the curve moved — all spikes, drops only when an event
    // coincides (an unexplained collapse stays tooltip-territory on patch-heavy games).
    lines = new Set([...spikes, ...[...drops].filter((m) => eventsOnAxis.has(m))]);
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
  return lines;
}

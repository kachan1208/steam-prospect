/** Which months on a monthly series are NOTABLE — the anomaly months a chart annotation is
 * allowed to point at.
 *
 * Why this exists: the event feed (mart_game_event) is honest but dense — CS2 ships an update
 * almost every month, so drawing a plumb line per event month turns the lifetime chart into a
 * picket fence where the markers explain nothing. The user's original ask was causal: "mark
 * releases or notable mentions, so it's easier to spot changes and WHY something happened."
 * An explanation attaches to a change; a routine patch in a flat month is noise. So the charts
 * draw event lines only where the curve itself moved, and leave every month's events readable
 * in the tooltip on hover.
 *
 * The rule is deliberately simple and robust: a month is notable when its value is at least
 * RATIO x the median of the trailing WINDOW months AND clears it by MIN_LIFT absolute — the
 * ratio catches small games (12 vs a median of 6 is a real double), the absolute floor stops
 * 3-vs-1 micro-noise from lighting up. The first two months are skipped: launch turbulence is
 * the release marker's job, which callers always draw regardless.
 */
const WINDOW = 6;
const RATIO = 1.75;
const MIN_LIFT = 15;

export function notableMonths(points: { period: string; value: number }[]): Set<string> {
  const out = new Set<string>();
  for (let i = 2; i < points.length; i++) {
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
    if (v >= RATIO * Math.max(median, 1) && v - median >= MIN_LIFT) {
      out.add(points[i].period);
    }
  }
  return out;
}

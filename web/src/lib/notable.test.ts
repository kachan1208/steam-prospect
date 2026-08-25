import { describe, expect, it } from "vitest";

import { markerMonths, type SeriesPoint } from "./notable";

/** Build a monthly series from Jan 2020: values[i] -> { period: '2020-01'+i, value }. */
function series(values: number[]): SeriesPoint[] {
  return values.map((value, i) => {
    const y = 2020 + Math.floor(i / 12);
    const m = (i % 12) + 1;
    return { period: `${y}-${String(m).padStart(2, "0")}`, value };
  });
}

const period = (i: number): string => series(new Array(i + 1).fill(0))[i].period;

describe("markerMonths — adaptive spike rule", () => {
  it("marks a small-game spike the old 15-review absolute floor silently dropped", () => {
    // Median ~8 reviews/mo, spike to 20: 20 >= 1.75*8 and 20-8=12 >= max(6, 4).
    // Under the old rule (lift >= 15 absolute) this game NEVER drew a line.
    const pts = series([8, 8, 8, 8, 8, 8, 20, 8]);
    expect(markerMonths(pts, [])).toEqual(new Set([period(6)]));
  });

  it("keeps 3-vs-1 micro-noise dark via the 6-review absolute floor", () => {
    // 3 over a median of 1 passes the ratio but not the floor: 3-1=2 < 6.
    const pts = series([1, 1, 1, 1, 3, 1, 1]);
    expect(markerMonths(pts, [])).toEqual(new Set());
  });

  it("still marks big-game spikes (the ratio + relative floor path)", () => {
    const pts = series([100, 100, 100, 100, 100, 100, 250, 100]);
    expect(markerMonths(pts, [])).toEqual(new Set([period(6)]));
  });

  it("never marks the first two months (launch turbulence is the release marker's job)", () => {
    // 18 over a 1-month history of 10 would qualify as a spike if month 1 were evaluated
    // (18 >= 17.5, lift 8 >= 6); it must not be, and month 2 is quiet vs its window.
    const pts = series([10, 18, 10, 10, 10, 10]);
    expect(markerMonths(pts, [])).toEqual(new Set());
  });
});

describe("markerMonths — drop detection", () => {
  it("marks a collapse symmetrically (value <= median/RATIO, floor cleared)", () => {
    // Median 100 -> 40: 40 <= 100/1.75 (~57.1) and 100-40=60 >= max(6, 50).
    const pts = series([100, 100, 100, 100, 100, 100, 40, 100]);
    expect(markerMonths(pts, [])).toEqual(new Set([period(6)]));
  });

  it("requires the relative floor for drops — just under median/RATIO is not enough", () => {
    // 57 <= 100/1.75 passes the ratio, but 100-57=43 < 0.5*100 -> no line.
    const pts = series([100, 100, 100, 100, 100, 100, 57, 100]);
    expect(markerMonths(pts, [])).toEqual(new Set());
  });
});

describe("markerMonths — sparse-events fallback", () => {
  it("draws every event month when the feed has <= 8 event months on the axis", () => {
    const pts = series([50, 50, 50, 50, 50, 50, 50, 50, 50, 50, 50, 50]);
    const events = [period(3), period(5), period(9)]; // flat months — no spike anywhere
    expect(markerMonths(pts, events)).toEqual(new Set(events));
  });

  it("ignores event months that are not on the charted axis (nothing floats)", () => {
    const pts = series([50, 50, 50, 50]);
    expect(markerMonths(pts, ["2031-01", period(2)])).toEqual(new Set([period(2)]));
  });

  it("off-axis event months do not count toward the sparse threshold", () => {
    // 9 event months total, but only 2 on the axis -> still sparse -> both drawn.
    const pts = series([50, 50, 50, 50, 50, 50]);
    const offAxis = ["2030-01", "2030-02", "2030-03", "2030-04", "2030-05", "2030-06", "2030-07"];
    const onAxis = [period(2), period(4)];
    expect(markerMonths(pts, [...offAxis, ...onAxis])).toEqual(new Set(onAxis));
  });

  it("sparse mode still adds detected spikes/drops on event-less months", () => {
    const pts = series([50, 50, 50, 50, 200, 50, 50, 50]);
    expect(markerMonths(pts, [period(6)])).toEqual(new Set([period(4), period(6)]));
  });
});

describe("markerMonths — dense-events mode (> 8 event months on the axis)", () => {
  // 12 flat months, spike at i=4, drop at i=8; events on 9 months incl. neither/both cases.
  const values = [50, 50, 50, 50, 200, 50, 50, 50, 10, 50, 50, 50];
  const pts = series(values);
  const nineEvents = [0, 1, 2, 3, 5, 6, 7, 9, 10].map(period);

  it("event-only months on a flat curve get NO line (no picket fence)", () => {
    const got = markerMonths(pts, nineEvents);
    for (const m of [period(5), period(6), period(7), period(9), period(10)]) {
      expect(got.has(m)).toBe(false);
    }
  });

  it("pure spikes without a coinciding event still get a line", () => {
    expect(markerMonths(pts, nineEvents).has(period(4))).toBe(true);
  });

  it("drops get a line only when an event month coincides", () => {
    // No event on the drop month -> tooltip-only.
    expect(markerMonths(pts, nineEvents).has(period(8))).toBe(false);
    // Same series, event ON the drop month -> line.
    const withDropEvent = [...nineEvents.slice(0, 8), period(8)];
    expect(markerMonths(pts, withDropEvent).has(period(8))).toBe(true);
  });
});

describe("markerMonths — release month", () => {
  it("is always drawn when on the axis, flat curve and dense feed included", () => {
    const pts = series(new Array(12).fill(50));
    const nineEvents = [0, 1, 2, 3, 4, 5, 6, 7, 8].map(period);
    expect(markerMonths(pts, nineEvents, period(0)).has(period(0))).toBe(true);
  });

  it("is skipped when it is not a charted month", () => {
    const pts = series([50, 50, 50]);
    expect(markerMonths(pts, [], "2010-01")).toEqual(new Set());
  });
});

describe("markerMonths — readability cap", () => {
  // Baseline 10 with a spike every 3rd month keeps the trailing median at 10 (at most
  // 2 spikes in any 6-month window), so every spike month is detected individually.
  // 16 spikes of strictly increasing magnitude -> 16 candidates + release.
  const values: number[] = new Array(50).fill(10);
  const spikeIdx: number[] = [];
  for (let k = 0; k < 16; k++) {
    const i = 2 + 3 * k;
    values[i] = 100 + 10 * k; // weakest spike first
    spikeIdx.push(i);
  }
  const pts = series(values);
  const release = period(0);

  it("caps at 14 lines, keeps the release, trims the least extreme", () => {
    const got = markerMonths(pts, [], release);
    expect(got.size).toBe(14);
    expect(got.has(release)).toBe(true);
    // 13 non-release slots -> the 3 weakest of the 16 spikes are trimmed.
    for (const i of spikeIdx.slice(0, 3)) expect(got.has(period(i))).toBe(false);
    for (const i of spikeIdx.slice(3)) expect(got.has(period(i))).toBe(true);
  });

  it("does not trim anything when at or under the cap", () => {
    const got = markerMonths(pts.slice(0, 2 + 3 * 12), [], release); // 12 spikes + release
    expect(got.size).toBe(13);
  });
});

describe("markerMonths — CS2 real-data regression (appid 730, prod API 2026-08)", () => {
  // Steam's full monthly review history for CS:GO/CS2 and its real catalog event months.
  // The event feed on the axis is sparse (7 months: release + 2026 updates), so this is
  // the sparse path plus the cap: the two things the picket-fence bug report was about.
  const RAW =
    "2012-05:1|2012-08:1838|2012-09:1091|2012-10:570|2012-11:653|2012-12:960|2013-01:768|2013-02:666|2013" +
    "-03:584|2013-04:548|2013-05:1131|2013-06:867|2013-07:1024|2013-08:825|2013-09:927|2013-10:1031|2013-" +
    "11:3724|2013-12:19991|2014-01:16578|2014-02:11809|2014-03:14815|2014-04:12637|2014-05:13147|2014-06:" +
    "25984|2014-07:21490|2014-08:22816|2014-09:19483|2014-10:18159|2014-11:22598|2014-12:33066|2015-01:37" +
    "377|2015-02:30982|2015-03:39535|2015-04:40159|2015-05:45141|2015-06:56304|2015-07:42677|2015-08:4579" +
    "2|2015-09:42077|2015-10:46783|2015-11:51931|2015-12:71887|2016-01:67196|2016-02:61702|2016-03:56448|" +
    "2016-04:51950|2016-05:47380|2016-06:51822|2016-07:48855|2016-08:41582|2016-09:35642|2016-10:36504|20" +
    "16-11:133179|2016-12:56217|2017-01:56765|2017-02:51455|2017-03:51850|2017-04:51329|2017-05:48318|201" +
    "7-06:59469|2017-07:57752|2017-08:49916|2017-09:46790|2017-10:48964|2017-11:104388|2017-12:53785|2018" +
    "-01:55966|2018-02:46983|2018-03:47350|2018-04:33926|2018-05:32167|2018-06:37921|2018-07:35519|2018-0" +
    "8:36122|2018-09:31190|2018-10:29595|2018-11:77583|2018-12:84928|2019-01:43953|2019-02:40155|2019-03:" +
    "40508|2019-04:34419|2019-05:32597|2019-06:81827|2019-07:100249|2019-08:32560|2019-09:30625|2019-10:5" +
    "8733|2019-11:222997|2019-12:138087|2020-01:119911|2020-02:110775|2020-03:145303|2020-04:173726|2020-" +
    "05:150391|2020-06:118093|2020-07:108033|2020-08:103239|2020-09:88327|2020-10:93671|2020-11:136859|20" +
    "20-12:138407|2021-01:118383|2021-02:97209|2021-03:105257|2021-04:93688|2021-05:87999|2021-06:99606|2" +
    "021-07:87805|2021-08:88635|2021-09:84605|2021-10:79989|2021-11:77666|2021-12:77107|2022-01:88478|202" +
    "2-02:79979|2022-03:76266|2022-04:64635|2022-05:63159|2022-06:64317|2022-07:71631|2022-08:81299|2022-" +
    "09:64558|2022-10:62406|2022-11:62501|2022-12:71092|2023-01:82796|2023-02:75093|2023-03:131295|2023-0" +
    "4:100513|2023-05:82199|2023-06:82351|2023-07:86068|2023-08:82212|2023-09:157668|2023-10:122987|2023-" +
    "11:64289|2023-12:56062|2024-01:59464|2024-02:67969|2024-03:68224|2024-04:59701|2024-05:58125|2024-06" +
    ":64705|2024-07:104880|2024-08:72436|2024-09:54044|2024-10:60013|2024-11:55295|2024-12:58202|2025-01:" +
    "83430|2025-02:84725|2025-03:100684|2025-04:73374|2025-05:74895|2025-06:65662|2025-07:78580|2025-08:7" +
    "8161|2025-09:70576|2025-10:88651|2025-11:82553|2025-12:82138|2026-01:98667|2026-02:87885|2026-03:983" +
    "80|2026-04:81604|2026-05:75504|2026-06:73021|2026-07:60219";
  const pts: SeriesPoint[] = RAW.split("|").map((pair) => {
    const [p, v] = pair.split(":");
    return { period: p, value: Number(v) };
  });
  // Real /api/games/730/events months ('2026-08' is off-axis and must not count).
  const eventMonths = [
    "2012-08", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06", "2026-07", "2026-08",
  ];
  const release = "2012-08";

  it("yields the 2019 Operation and 2023 CS2-announcement spike lines", () => {
    const got = markerMonths(pts, eventMonths, release);
    expect(got.has("2019-11")).toBe(true); // Operation Shattered Web
    expect(got.has("2019-06")).toBe(true);
    expect(got.has("2019-07")).toBe(true);
    expect(got.has("2023-03")).toBe(true); // the CS2 announcement
    expect(got.has(release)).toBe(true);
  });

  it("stays within the cap — no picket fence on 169 charted months", () => {
    const got = markerMonths(pts, eventMonths, release);
    expect(got.size).toBeLessThanOrEqual(14);
  });
});

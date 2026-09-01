// Mutation harness: revert one fix at a time and confirm the tests that claim to cover it
// actually go red. A test that passes either way is worthless.
// Usage: node scripts/audit/mutate.mjs [name...]
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const MUTATIONS = [
  {
    name: "A2-colours",
    why: "COMPARE_SERIES back on the withdrawn mono paper-alpha ramp",
    file: "src/lib/palette.ts",
    from: `  { color: "var(--accent-100)", hex: "#eef6ff", shape: "circle" },`,
    to: `  { color: "var(--accent-300)", hex: "#b5d9fd", shape: "circle" },`,
    extra: [
      [`  { color: "var(--series-2)", hex: "#199e70", dash: "6 3", shape: "square" },`,
       `  { color: "var(--text-primary)", hex: "#bdc1c6", dash: "6 3", shape: "square" },`],
      [`  { color: "var(--text-primary)", hex: "#f2f2f3", dash: "2 3", shape: "triangle" },`,
       `  { color: "var(--text-primary)", hex: "#a7adb3", dash: "2 3", shape: "triangle" },`],
    ],
    tests: ["src/lib/palette.test.ts"],
  },
  {
    name: "A2-dashes",
    why: "every compare series solid again",
    file: "src/lib/palette.ts",
    from: `dash: "6 3", shape: "square"`,
    to: `shape: "square"`,
    extra: [
      [`dash: "2 3", shape: "triangle"`, `shape: "triangle"`],
      [`dash: "10 3 2 3", shape: "diamond"`, `shape: "diamond"`],
      [`dash: "1 4", shape: "plus"`, `shape: "plus"`],
      [`dash: "14 4", shape: "cross"`, `shape: "cross"`],
    ],
    tests: ["src/lib/palette.test.ts", "src/components/charts/CompareTrendsChart.test.tsx"],
  },
  {
    name: "A2-shapes",
    why: "every compare series wearing the same marker",
    file: "src/lib/palette.ts",
    from: `shape: "square" }`,
    to: `shape: "circle" }`,
    extra: [
      [`shape: "triangle" }`, `shape: "circle" }`],
      [`shape: "diamond" }`, `shape: "circle" }`],
      [`shape: "plus" }`, `shape: "circle" }`],
      [`shape: "cross" }`, `shape: "circle" }`],
    ],
    tests: ["src/lib/palette.test.ts", "src/components/charts/CompareTrendsChart.test.tsx"],
  },
  {
    name: "A2-chart-wiring",
    why: "chart drops the dash + marker it is handed (dot={false}, no dasharray)",
    file: "src/components/charts/CompareTrendsChart.tsx",
    from: `                stroke={s.color}
                strokeDasharray={s.dash}`,
    to: `                stroke={s.color}`,
    tests: ["src/components/charts/CompareTrendsChart.test.tsx"],
  },
  {
    name: "A1-paint-order",
    why: "annotation labels back inside xy-decor, i.e. under the dots",
    file: "src/components/RadarBoard.tsx",
    move: {
      startMarker: `          {/* IN-PLOT ANNOTATIONS — LAST, so they paint OVER the dots.`,
      endMarker: `          </g>\n        </svg>`,
      beforeMarker: `          {/* REGION HIT RECTS`,
    },
    tests: ["src/components/RadarBoard.test.tsx"],
  },
  {
    name: "A5-formatter",
    why: "axisFormatter back to the per-value ladder (fmtAxisCompact / fmtAxisUsd)",
    file: "src/lib/format.ts",
    from: `  const prefix = kind === "usd" ? "$" : "";
  const nonZero = finite.map(Math.abs).filter((v) => v > 0);`,
    to: `  const prefix = kind === "usd" ? "$" : "";
  if (true) return (v) => (kind === "usd" ? fmtAxisUsd(v) : fmtAxisCompact(v));
  const nonZero = finite.map(Math.abs).filter((v) => v > 0);`,
    tests: [
      "src/lib/format.test.ts",
      "src/components/charts/Histogram.test.tsx",
      "src/components/charts/axisConsistency.test.tsx",
    ],
  },
  {
    name: "A5-nice-ticks",
    why: "recharts picks the ticks again (the 0/9/18/33 price axis)",
    file: "src/lib/format.ts",
    from: `  if (!Number.isFinite(max) || max <= 0 || count < 2) return [0];
  const target = max / count;`,
    to: `  if (!Number.isFinite(max) || max <= 0 || count < 2) return [0];
  if (true) return [0, max / 3, (max * 2) / 3, max];
  const target = max / count;`,
    tests: ["src/lib/format.test.ts"],
  },
  {
    name: "A5-histogram-axis",
    why: "Histogram's y-axis back on the free-running per-value formatter",
    file: "src/components/charts/Histogram.tsx",
    from: `          ticks={y.ticks}
          interval={0}
          domain={y.domain}
          tickFormatter={(v: number) => y.format(v)}`,
    to: `          tickFormatter={(v: number) => formatCount(v)}`,
    tests: ["src/components/charts/Histogram.test.tsx"],
  },
  {
    name: "A4-group-tints",
    why: "genre chips tinted per name again, collisions and all",
    file: "src/lib/heat.ts",
    from: `  const taken = new Set<number>();
  return names.map((name) => {`,
    to: `  const taken = new Set<number>();
  if (true) return names.map((n) => tintFor(genreSlot(n)));
  return names.map((name) => {`,
    tests: ["src/lib/heat.test.ts"],
  },
  {
    name: "B4-hidden-axes",
    why: "both y-axes hidden again on Demand vs. pipeline",
    file: "src/pages/NicheDetail.tsx",
    from: `                          <YAxis
                            yAxisId="revenue"
                            tick={{ fontSize: 10 }}`,
    to: `                          <YAxis
                            yAxisId="revenue"
                            hide
                            tick={{ fontSize: 10 }}`,
    extra: [
      [`                            yAxisId="releases"
                            orientation="right"
                            tick={{ fontSize: 10 }}`,
       `                            yAxisId="releases"
                            orientation="right"
                            hide
                            tick={{ fontSize: 10 }}`],
    ],
    tests: ["src/pages/NicheDetail.test.tsx"],
  },
  {
    name: "B4-legend-swatch",
    why: "the dashed Releases key back to the swatch that rendered nothing",
    file: "src/pages/NicheDetail.tsx",
    from: `                    <svg width="16" height="6" viewBox="0 0 16 6" aria-hidden className="shrink-0">
                      <line
                        x1="0"
                        y1="3"
                        x2="16"
                        y2="3"
                        stroke={TREND_RELEASES_STROKE}
                        strokeWidth="2"
                        strokeDasharray="4 3"
                      />
                    </svg>`,
    to: `                    <span className="inline-block h-[2px] w-3.5 bg-ink-primary/45" aria-hidden />`,
    tests: ["src/pages/NicheDetail.test.tsx"],
  },
  {
    name: "B4-partial-year",
    why: "partial final year never flagged",
    file: "src/pages/NicheDetail.tsx",
    from: `  const currentYear = now.getFullYear();
  return points.some((p) => p.year === currentYear) ? currentYear : null;`,
    to: `  void now;
  void points;
  return null;`,
    tests: ["src/pages/NicheDetail.test.tsx"],
  },
];

const wanted = process.argv.slice(2);
const selected = wanted.length > 0 ? MUTATIONS.filter((m) => wanted.includes(m.name)) : MUTATIONS;

function runTests(files) {
  try {
    const out = execFileSync("npx", ["vitest", "run", ...files], { encoding: "utf8", stdio: "pipe" });
    return { ok: true, out };
  } catch (e) {
    return { ok: false, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

const ANSI = new RegExp(String.fromCharCode(27) + "\\[[0-9;]*m", "g");

function summarise(out) {
  const clean = out.replace(ANSI, "");
  const m = clean.match(/Tests\s+(\d+) failed\s*\|\s*(\d+) passed/);
  if (m) return `${m[1]} failed / ${m[2]} passed`;
  const p = clean.match(/Tests\s+(\d+) passed/);
  if (p) return `0 failed / ${p[1]} passed`;
  if (/error TS|Failed to load|Transform failed|SyntaxError/.test(clean)) return "BUILD ERROR (not an assertion)";
  return "unparsed";
}

/** The assertion messages a mutation produced — proof it went red on BEHAVIOUR, not on a
 *  compile error. */
function failedTests(out) {
  const clean = out.replace(ANSI, "");
  return [...clean.matchAll(/^\s*x\s+(.+?)(?:\s+\d+ms)?$/gmu)].map((m) => m[1].trim());
}

const results = [];
for (const mut of selected) {
  const original = readFileSync(mut.file, "utf8");
  let mutated = original;
  if (mut.move) {
    const s = mutated.indexOf(mut.move.startMarker);
    const e = mutated.indexOf(mut.move.endMarker, s);
    if (s === -1 || e === -1) throw new Error(`${mut.name}: move markers not found`);
    const block = mutated.slice(s, e + "          </g>\n".length);
    mutated = mutated.slice(0, s) + mutated.slice(s + block.length);
    const at = mutated.indexOf(mut.move.beforeMarker);
    if (at === -1) throw new Error(`${mut.name}: destination marker not found`);
    mutated = mutated.slice(0, at) + block + "\n" + mutated.slice(at);
  } else {
    const pairs = [[mut.from, mut.to], ...(mut.extra ?? [])];
    for (const [from, to] of pairs) {
      if (!mutated.includes(from)) throw new Error(`${mut.name}: pattern not found:\n${from}`);
      mutated = mutated.replace(from, to);
    }
  }
  writeFileSync(mut.file, mutated);
  const res = runTests(mut.tests);
  writeFileSync(mut.file, original);
  const summary = summarise(res.out);
  const named = failedTests(res.out);
  results.push({ name: mut.name, why: mut.why, red: !res.ok && !summary.startsWith("BUILD"), summary, named });
  console.log(`${!res.ok ? "RED  " : "GREEN"}  ${mut.name.padEnd(20)} ${summary.padEnd(26)} ${mut.why}`);
  for (const t of named.slice(0, 4)) console.log(`         - ${t}`);
}

const survived = results.filter((r) => !r.red);
console.log(`\n${results.length - survived.length}/${results.length} mutations killed.`);
if (survived.length > 0) {
  console.log("SURVIVED (the tests do not cover this):");
  for (const s of survived) console.log(`  - ${s.name}: ${s.why}`);
  process.exitCode = 1;
}

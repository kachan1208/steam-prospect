// A2: find an ORDERED compare ramp, drawn only from tokens index.css already declares,
// where (a) every slot clears 3:1 against the chart ground and (b) every CONSECUTIVE pair
// clears 3:1 against each other (WCAG 1.4.11, adjacent graphical objects).
// The theme is pinned to dark (lib/theme.tsx), so #1d2d3d is the only ground to satisfy.
import { parseColor, contrast, relLum } from "./color.mjs";

const BG = parseColor("#1d2d3d").slice(0, 3);
const rgb = (h) => parseColor(h).slice(0, 3);

const TOKENS = {
  paper: "#f2f2f3",
  "accent-100": "#eef6ff",
  "accent-200": "#d6ebff",
  "accent-300": "#b5d9fd",
  "accent-400": "#94bce3",
  "accent-500": "#749dc4",
  "accent-600": "#597ea3",
  "series-1": "#3987e5",
  "series-2": "#199e70",
  "series-3": "#c98500",
  "series-5": "#9085e9",
  "series-6": "#e66767",
  "series-7": "#d55181",
  "series-8": "#d95926",
  "status-warning": "#fab219",
  "status-serious": "#ec835a",
  "verdict-crowded": "#a8742a",
};

const rows = Object.entries(TOKENS)
  .map(([n, h]) => ({ n, h, L: relLum(rgb(h)), c: contrast(rgb(h), BG) }))
  .filter((r) => r.c >= 3)
  .sort((a, b) => b.L - a.L);

console.log("ground #1d2d3d L =", relLum(BG).toFixed(5), " white vs ground =", contrast([255, 255, 255], BG).toFixed(2) + ":1");
console.log("\nCEILING PROOF — N slots each >=3:1 on the ground and >=m:1 from each other:");
for (const N of [2, 3, 4]) {
  // darkest sits at exactly 3:1 (L = 3*(Lbg+.05)-.05); lightest cannot exceed white.
  const floor = 3 * (relLum(BG) + 0.05);
  const m = Math.pow(1.05 / floor, 1 / (N - 1));
  console.log(`  N=${N}: max achievable ALL-PAIRS separation = ${m.toFixed(2)}:1`);
}

const K = Number(process.argv[2] || 6);
let winner = null;
const search = (prefix, used) => {
  if (prefix.length === K) {
    let cons = Infinity;
    for (let i = 0; i + 1 < prefix.length; i++) cons = Math.min(cons, contrast(rgb(prefix[i].h), rgb(prefix[i + 1].h)));
    let all = Infinity;
    for (let i = 0; i < prefix.length; i++)
      for (let j = i + 1; j < prefix.length; j++) all = Math.min(all, contrast(rgb(prefix[i].h), rgb(prefix[j].h)));
    const score = Math.min(cons, 3) * 1000 + all; // consecutive >=3 first, then spread the rest
    if (!winner || score > winner.score) winner = { order: [...prefix], cons, all, score };
    return;
  }
  for (let i = 0; i < rows.length; i++) {
    if (used.has(i)) continue;
    used.add(i);
    search([...prefix, rows[i]], used);
    used.delete(i);
  }
};
search([], new Set());

console.log(`\n=== best ${K}-slot order ===`);
console.log("  " + winner.order.map((o, i) => `${i + 1}:${o.n}(${o.h})`).join("  "));
console.log(`  min consecutive ${winner.cons.toFixed(2)}:1 · min over ALL pairs ${winner.all.toFixed(2)}:1`);
for (let i = 0; i < winner.order.length; i++) {
  for (let j = i + 1; j < winner.order.length; j++) {
    console.log(
      `   ${i + 1}v${j + 1} ${winner.order[i].n}/${winner.order[j].n}: ${contrast(rgb(winner.order[i].h), rgb(winner.order[j].h)).toFixed(2)}:1${j === i + 1 ? "  (adjacent)" : ""}`,
    );
  }
}
for (const o of winner.order) console.log(`   ${o.n} vs ground: ${o.c.toFixed(2)}:1`);

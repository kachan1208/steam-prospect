// Generic probe: dump every SVG mark inside a page's recharts surfaces plus axis tick
// strings, so findings can be re-verified against production before/after a change.
// Usage: node scripts/audit/probe.mjs <url> [viewport] [screenshotPath]
import { chromium } from "playwright";

const URL = process.argv[2];
const VP = (process.argv[3] || "1440x1200").split("x").map(Number);
const SHOT = process.argv[4];

const browser = await chromium.launch();
const ctx = await browser.newContext({
  ignoreHTTPSErrors: true,
  viewport: { width: VP[0], height: VP[1] },
  deviceScaleFactor: 2,
});
const page = await ctx.newPage();
await page.goto(URL, { waitUntil: "networkidle", timeout: 90000 });
await page.waitForTimeout(4000);
// nudge lazy charts into view
await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
await page.waitForTimeout(2500);
await page.evaluate(() => window.scrollTo(0, 0));
await page.waitForTimeout(1500);

const dump = await page.evaluate(() => {
  const charts = [];
  document.querySelectorAll(".recharts-wrapper").forEach((w, idx) => {
    // Nearest heading-ish text above the chart, for identification.
    let title = "";
    let el = w;
    while (el && !title) {
      el = el.parentElement;
      if (!el) break;
      const h = el.querySelector("h1,h2,h3,h4,.text-label,[class*='uppercase']");
      if (h) title = h.textContent.trim().slice(0, 90);
    }
    const marks = [];
    w.querySelectorAll("path.recharts-line-curve, path.recharts-curve, .recharts-bar-rectangle path, .recharts-reference-line line").forEach((p) => {
      const cs = getComputedStyle(p);
      marks.push({ cls: p.getAttribute("class"), stroke: cs.stroke, fill: cs.fill, dash: cs.strokeDasharray, width: cs.strokeWidth });
    });
    const axes = [];
    w.querySelectorAll(".recharts-xAxis, .recharts-yAxis").forEach((ax) => {
      const kind = ax.classList.contains("recharts-xAxis") ? "x" : "y";
      const ticks = [...ax.querySelectorAll(".recharts-cartesian-axis-tick-value")].map((t) => t.textContent.trim());
      const label = ax.parentElement?.querySelector(".recharts-label")?.textContent?.trim() || null;
      axes.push({ kind, ticks, label, orientation: ax.querySelector("line")?.getAttribute("orientation") || null });
    });
    charts.push({ idx, title, marks, axes });
  });
  return { title: document.title, charts };
});

console.log(`# ${URL} @ ${VP[0]}x${VP[1]} — ${dump.title}`);
for (const c of dump.charts) {
  console.log(`\n[chart ${c.idx}] ${c.title}`);
  for (const a of c.axes) console.log(`  ${a.kind}Axis label=${a.label} ticks=${JSON.stringify(a.ticks)}`);
  const seen = new Set();
  for (const m of c.marks) {
    const k = `${m.cls}|${m.stroke}|${m.fill}|${m.dash}`;
    if (seen.has(k)) continue;
    seen.add(k);
    console.log(`  mark ${m.cls} stroke=${m.stroke} fill=${m.fill} dash=${m.dash} w=${m.width}`);
  }
}

if (SHOT) await page.screenshot({ path: SHOT, fullPage: true });
await browser.close();

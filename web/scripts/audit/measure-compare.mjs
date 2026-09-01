// Measures the Compare-page multi-series line chart: resolved stroke colours, dash
// patterns, legend swatches, and adjacent-series contrast ratios (WCAG 1.4.11 wants >=3:1).
// Usage: node scripts/audit/measure-compare.mjs <baseUrl> <outPrefix>
import { chromium } from "playwright";
import { parseColor, composite, contrast, hex } from "./color.mjs";

const BASE = process.argv[2] || "https://142-93-49-69.nip.io";
const PREFIX = process.argv[3] || "/tmp/pw/compare";
const VIEWPORTS = [
  { width: 1440, height: 1100, name: "1440" },
  { width: 1024, height: 1100, name: "1024" },
  { width: 390, height: 1100, name: "390" },
];

const browser = await chromium.launch();
for (const vp of VIEWPORTS) {
  const ctx = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: vp.width, height: vp.height },
    deviceScaleFactor: 2,
  });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/compare?ids=730,1962700,2393160`, { waitUntil: "networkidle", timeout: 90000 });
  await page.waitForTimeout(3500);

  const info = await page.evaluate(() => {
    const out = { lines: [], swatches: [] };
    out.bg = getComputedStyle(document.body).backgroundColor;
    const paths = document.querySelectorAll("path.recharts-line-curve");
    for (const p of paths) {
      const cs = getComputedStyle(p);
      out.lines.push({ stroke: cs.stroke, dash: cs.strokeDasharray, width: cs.strokeWidth });
    }
    const dots = document.querySelectorAll(".recharts-line-dots > *");
    out.dotTags = [...new Set([...dots].map((d) => d.tagName))];
    let chartBg = null;
    const surf = document.querySelector(".recharts-surface");
    let el = surf?.parentElement;
    while (el) {
      const c = getComputedStyle(el).backgroundColor;
      if (c && c !== "rgba(0, 0, 0, 0)") { chartBg = c; break; }
      el = el.parentElement;
    }
    out.chartBg = chartBg;
    // Legend keys: any small empty element carrying a background/border colour next to text.
    document.querySelectorAll("span, svg").forEach((s) => {
      const r = s.getBoundingClientRect();
      if (r.width === 0 || r.width > 34 || r.height > 16) return;
      const cs = getComputedStyle(s);
      const bg = cs.backgroundColor;
      const isSvg = s.tagName.toLowerCase() === "svg";
      if (!isSvg && (bg === "rgba(0, 0, 0, 0)" || s.textContent.trim())) return;
      out.swatches.push({
        tag: s.tagName,
        bg,
        html: isSvg ? s.outerHTML.slice(0, 240) : "",
        w: +r.width.toFixed(1),
        h: +r.height.toFixed(1),
        near: (s.parentElement?.textContent || "").trim().slice(0, 40),
      });
    });
    return out;
  });

  const bg = parseColor(info.chartBg || info.bg);
  console.log(`\n===== ${vp.name}px =====`);
  console.log(`chart bg: ${info.chartBg || info.bg} -> ${hex(bg.slice(0, 3))}`);
  const resolved = [];
  for (const l of info.lines) {
    const c = parseColor(l.stroke);
    if (!c) continue;
    const comp = composite(c, bg);
    resolved.push(comp);
    console.log(
      `line stroke=${l.stroke} dash=${l.dash} width=${l.width} -> composited ${hex(comp)}`,
    );
  }
  console.log(`line dots rendered as: ${JSON.stringify(info.dotTags)}`);
  for (let i = 0; i + 1 < resolved.length; i++) {
    console.log(`  contrast series ${i + 1} vs ${i + 2}: ${contrast(resolved[i], resolved[i + 1]).toFixed(2)}:1`);
  }
  for (let i = 0; i < resolved.length; i++) {
    for (let j = i + 1; j < resolved.length; j++) {
      if (j === i + 1) continue;
      console.log(`  contrast series ${i + 1} vs ${j + 1}: ${contrast(resolved[i], resolved[j]).toFixed(2)}:1`);
    }
  }
  for (let i = 0; i < resolved.length; i++) {
    console.log(`  contrast series ${i + 1} vs bg: ${contrast(resolved[i], bg.slice(0, 3)).toFixed(2)}:1`);
  }
  console.log("legend swatches:");
  for (const s of info.swatches) console.log("  " + JSON.stringify(s));

  const chartCard = page.locator(".recharts-surface").first();
  try {
    await chartCard.scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);
  } catch { /* ignore */ }
  await page.screenshot({ path: `${PREFIX}-${vp.name}.png` });
  await ctx.close();
}
await browser.close();

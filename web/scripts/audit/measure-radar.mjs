// A1: does the radar's FLOOD BAR annotation get painted UNDER the dot cluster?
// Reports the label's bbox, how many dots overlap it, and whether the label's <text>
// precedes those dots in SVG paint order (document order == paint order in SVG 1.1).
// Usage: node scripts/audit/measure-radar.mjs <baseUrl> <outPrefix>
import { chromium } from "playwright";

const BASE = process.argv[2] || "https://142-93-49-69.nip.io";
const PREFIX = process.argv[3] || "/tmp/pw/radar";
const VIEWPORTS = [1440, 1024, 390];

const browser = await chromium.launch();
for (const w of VIEWPORTS) {
  const ctx = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: w, height: 1200 },
    deviceScaleFactor: 2,
  });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/radar`, { waitUntil: "networkidle", timeout: 90000 });
  await page.waitForTimeout(4000);

  const res = await page.evaluate(() => {
    const svg = document.querySelector('svg[role="img"]');
    if (!svg) return { err: "no plate svg" };
    const texts = [...svg.querySelectorAll("text")];
    // The BAR's label specifically — the Y-axis title also contains the word "FLOODING".
    const label = texts.find((t) => /^FLOOD (BAR )?\+\d/.test((t.textContent || "").trim()));
    if (!label) return { err: "no flood label", texts: texts.map((t) => t.textContent) };
    const lb = label.getBoundingClientRect();
    const dots = [...svg.querySelectorAll('circle[data-testid^="radar-blip-"]')];
    const order = [...svg.querySelectorAll("*")];
    const labelIdx = order.indexOf(label);
    let overlapping = 0;
    let overlappingPainted = 0; // dots that overlap AND paint after the label
    const overlapIds = [];
    for (const d of dots) {
      const r = d.getBoundingClientRect();
      const hit = !(r.right < lb.left || r.left > lb.right || r.bottom < lb.top || r.top > lb.bottom);
      if (!hit) continue;
      overlapping++;
      if (order.indexOf(d) > labelIdx) {
        overlappingPainted++;
        overlapIds.push(d.getAttribute("data-testid"));
      }
    }
    return {
      text: label.textContent,
      bbox: { x: +lb.x.toFixed(1), y: +lb.y.toFixed(1), w: +lb.width.toFixed(1), h: +lb.height.toFixed(1) },
      totalDots: dots.length,
      overlapping,
      overlappingPainted,
      overlapIds: overlapIds.slice(0, 12),
      labelPaintIndex: labelIdx,
      labelParentTestId: label.closest("[data-testid]")?.getAttribute("data-testid") ?? null,
      // Anything drawn after the label inside the plate that is not decor:
      dotsGroupIndex: order.indexOf(svg.querySelector('circle[data-testid^="radar-blip-"]')),
    };
  });
  console.log(`\n===== radar @ ${w}px =====`);
  console.log(JSON.stringify(res, null, 2));

  const svg = page.locator('svg[role="img"]').first();
  await svg.screenshot({ path: `${PREFIX}-${w}.png` });
  await ctx.close();
}
await browser.close();

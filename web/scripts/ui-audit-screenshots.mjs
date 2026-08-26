// UI-audit screenshot harness. Loads every app route against a target origin (default:
// production) at desktop + phone widths, saves full-page PNGs, and records whether the
// PAGE scrolls horizontally at 390px (wide tables must scroll inside their own container,
// never the body). Console errors per page are logged too.
//
// Usage: node scripts/ui-audit-screenshots.mjs [outDir] [origin]
// Output PNGs are throwaway audit artifacts — do not commit them.
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const OUT = process.argv[2] ?? "/tmp/prospect-ui-audit";
const ORIGIN = process.argv[3] ?? "https://142-93-49-69.nip.io";

const ROUTES = [
  ["radar", "/radar"],
  ["games-search", "/games?q=roguelike"],
  ["games-search-empty", "/games"],
  ["game-730", "/games/730"],
  ["game-subnautica2", "/games/1962700"],
  ["game-small", "/games/2393160"], // Nice Day for Fishing, ~3.1K reviews
  ["niches", "/niches"],
  ["niche-detail", "/niches/tag/Naval%20Combat"],
  ["niches-combined", "/niches/combined?niches=tag%3ARoguelike&niches=tag%3AFishing"],
  ["studios", "/studios"],
  ["entity-developer", "/entity/developer?name=FromSoftware%2C%20Inc."],
  ["compare", "/compare?ids=730,1962700,2393160"],
  ["compare-empty", "/compare"],
  ["watchlist-empty", "/watchlist"],
  ["timing", "/timing"],
  ["chat", "/chat"],
  ["datalog", "/datalog"],
  ["docs", "/docs"],
];

const WIDTHS = [
  ["1440", { width: 1440, height: 900 }],
  ["390", { width: 390, height: 844 }],
];

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();
let shots = 0;

for (const [wName, viewport] of WIDTHS) {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const errors = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(String(e)));

  for (const [name, path] of ROUTES) {
    errors.length = 0;
    try {
      await page.goto(ORIGIN + path, { waitUntil: "networkidle", timeout: 45000 });
    } catch (e) {
      console.log(`[${wName}] ${name}: goto failed/slow (${String(e).slice(0, 80)}) — shooting anyway`);
    }
    await page.waitForTimeout(2500); // charts animate in after network idle
    const overflow = await page.evaluate(() => {
      const el = document.scrollingElement;
      return { scrollW: el.scrollWidth, clientW: el.clientWidth };
    });
    const file = `${OUT}/${name}-${wName}.png`;
    await page.screenshot({ path: file, fullPage: true });
    shots++;
    const hscroll = overflow.scrollW > overflow.clientW ? ` HSCROLL ${overflow.scrollW}>${overflow.clientW}` : "";
    const errNote = errors.length ? ` console-errors=${errors.length}: ${errors[0].slice(0, 120)}` : "";
    console.log(`[${wName}] ${name}${hscroll}${errNote}`);
  }
  await ctx.close();
}

await browser.close();
console.log(`done: ${shots} screenshots in ${OUT}`);

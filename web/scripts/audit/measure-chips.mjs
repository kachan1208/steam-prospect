// A4: are any two genre chips in ONE row rendered in the same colour?
// Usage: node scripts/audit/measure-chips.mjs <baseUrl> <outPrefix>
import { chromium } from "playwright";

const BASE = process.argv[2] || "https://142-93-49-69.nip.io";
const PREFIX = process.argv[3] || "/tmp/pw/chips";

const browser = await chromium.launch();
const ctx = await browser.newContext({
  ignoreHTTPSErrors: true,
  viewport: { width: 1440, height: 1200 },
  deviceScaleFactor: 2,
});
const page = await ctx.newPage();
await page.goto(`${BASE}/studios`, { waitUntil: "networkidle", timeout: 90000 });
await page.waitForTimeout(4000);

const rows = await page.evaluate(() => {
  const out = [];
  for (const tr of document.querySelectorAll("tbody tr")) {
    const name = tr.querySelector("td")?.textContent?.trim().slice(0, 40) ?? "?";
    const chips = [...tr.querySelectorAll("td:last-child span")].map((s) => ({
      text: s.textContent.trim(),
      bg: getComputedStyle(s).backgroundColor,
      border: getComputedStyle(s).borderColor,
    }));
    if (chips.length > 0) out.push({ name, chips });
  }
  return out;
});

let dupRows = 0;
for (const r of rows) {
  const bgs = r.chips.map((c) => c.bg);
  const dup = new Set(bgs).size !== bgs.length;
  if (dup) dupRows++;
  const flag = dup ? "DUPLICATE" : "ok       ";
  console.log(`${flag} ${r.name.padEnd(34)} ${r.chips.map((c) => `${c.text}=${c.bg}`).join("  ")}`);
}
console.log(`\n${dupRows} of ${rows.length} rows render two chips in the same colour.`);

await page.screenshot({ path: `${PREFIX}-studios.png`, fullPage: false });

await page.goto(`${BASE}/entity/publisher?name=Ubisoft`, { waitUntil: "networkidle", timeout: 90000 });
await page.waitForTimeout(3000);
const ubi = await page.evaluate(() => {
  const spans = [...document.querySelectorAll("span")].filter(
    (s) => s.className.includes("rounded-full") && s.className.includes("border") && s.textContent.trim(),
  );
  return spans.slice(0, 8).map((s) => ({ text: s.textContent.trim(), bg: getComputedStyle(s).backgroundColor }));
});
console.log("\nUbisoft top-genres row:");
for (const c of ubi) console.log(`  ${c.text.padEnd(16)} ${c.bg}`);
const bgs = ubi.map((c) => c.bg);
console.log(`  -> ${new Set(bgs).size} distinct colours across ${bgs.length} chips`);
await page.screenshot({ path: `${PREFIX}-ubisoft.png`, fullPage: false });

await browser.close();

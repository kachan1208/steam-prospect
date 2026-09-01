import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

/**
 * THE guard against B1 coming back (2026-09-01).
 *
 * Nine routes shipped wide tables inside a bare `overflow-x-auto` div, and because macOS
 * and iOS keep overlay scrollbars invisible until touched, the clipped edge read as the
 * end of the data. Measured on production: /studios @390 hid 799px of a 1139px row (70%,
 * i.e. Years / Active / Total est. revenue / P90 / Hit rate / Top genres), /niches @390 hid
 * 520px of 860, /games/:id comparables hid 346px of 640, /studios still hid 197px at 1024.
 *
 * It regresses INVISIBLY — a new table with `overflow-x-auto` looks right at the desk it
 * was written on and silently amputates itself on a phone — so the rule is pinned as
 * source structure: a scrolling data container goes through ui/TableScroll, and the only
 * `overflow-x-auto` left in the app is on <code>/<pre>, where the clipped thing is a code
 * sample and the user has no columns to lose.
 */

const SRC = resolve(__dirname, "..");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return sourceFiles(p);
    if (!/\.tsx?$/.test(name) || /\.test\.tsx?$/.test(name)) return [];
    return [p];
  });
}

/** Lines that mention the class in prose (the component's own docs) aren't markup. */
function usesClassInMarkup(line: string): boolean {
  return /overflow-x-auto/.test(line) && /className=|class=/.test(line);
}

describe("horizontal scrollers all go through TableScroll", () => {
  it("leaves overflow-x-auto only on <code>/<pre>, never on a data container", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      readFileSync(file, "utf8")
        .split("\n")
        .forEach((line, i) => {
          if (!usesClassInMarkup(line)) return;
          if (/<code|<pre/.test(line)) return;
          // Named, not counted: the message has to say which container to convert.
          offenders.push(`${relative(SRC, file)}:${i + 1}`);
        });
    }
    expect(offenders).toEqual([]);
  });

  it("and the tables really are wired to it — every audited route still has one", () => {
    // One entry per route the audit measured as clipped, plus the scrollers that share
    // their shape. If a page drops back to a bare div, its line here goes to 0.
    const expected: Record<string, number> = {
      "pages/Studios.tsx": 1, // @390 hid 799px of 1139
      "pages/NicheFinder.tsx": 2, // /niches @390 hid 520px of 860
      "pages/NicheDetail.tsx": 5, // /niches/tag/* @390 hid 300px
      "pages/NicheCombined.tsx": 1, // @390 hid 380px
      "pages/GameProfile.tsx": 1, // comparables @390 hid 346px
      "pages/EntityProfile.tsx": 1, // /entity/* @390 hid 355px
      "pages/Compare.tsx": 1, // @390 hid 330px
      "pages/Watchlist.tsx": 1,
      "components/charts/SeasonalityHeatmap.tsx": 1, // /timing @390 hid 80px
      "components/chat/ChatMarkdown.tsx": 1,
    };
    const actual: Record<string, number> = {};
    for (const [file] of Object.entries(expected)) {
      const code = readFileSync(join(SRC, file), "utf8");
      actual[file] = code.split("<TableScroll").length - 1;
    }
    expect(actual).toEqual(expected);
  });
});

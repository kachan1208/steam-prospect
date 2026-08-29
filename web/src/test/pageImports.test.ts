import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, relative, resolve } from "node:path";

/**
 * THE guard for route-level code splitting (2026-08-29).
 *
 * Every page except the radar index is React.lazy, but that only buys anything while NO
 * module statically imports a pages/* module: one such import and the whole page — plus
 * everything it imports, which for the niche/game pages means vendor-recharts, 109KB gz —
 * is welded into the importer's chunk. It has regressed twice already (NicheDetail's link
 * builder, then NicheCombined's selection helpers, both fixed by moving the helper into a
 * leaf lib/ module), and it regresses INVISIBLY: nothing fails, the bundle just gets fat.
 *
 * So the rule is pinned as source structure, which is exactly where it's breakable:
 * a shared helper belongs in lib/ or components/, never on a page.
 */

const SRC = resolve(__dirname, "..");

/** The only eager page imports in the app — App.tsx's router needs these three by value:
 * Radar is the index route (hand-rolled SVG, no charts, always the first paint), and
 * Terms/Privacy render outside the shell and are tiny static text. */
const ALLOWED = new Set(["App.tsx -> pages/Radar", "App.tsx -> pages/Terms", "App.tsx -> pages/Privacy"]);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return sourceFiles(p);
    if (!/\.tsx?$/.test(name) || /\.test\.tsx?$/.test(name)) return [];
    return [p];
  });
}

/** Static `import … from "x"` and `export … from "x"` only — a dynamic `import("x")` has
 * no `from` clause and is precisely what we WANT, so it can never match. */
function staticSpecifiers(code: string): string[] {
  const out: string[] = [];
  for (const re of [/^[ \t]*import\s[^;]*?from\s*["']([^"']+)["']/gm, /^[ \t]*export\s[^;]*?from\s*["']([^"']+)["']/gm]) {
    for (const m of code.matchAll(re)) out.push(m[1]);
  }
  return out;
}

describe("code splitting: nobody statically imports a page", () => {
  it("has no static pages/* import outside App.tsx's three documented ones", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const from = relative(SRC, file);
      for (const spec of staticSpecifiers(readFileSync(file, "utf8"))) {
        if (!spec.startsWith(".")) continue;
        const target = relative(SRC, resolve(dirname(file), spec));
        if (!target.startsWith("pages/")) continue;
        const edge = `${from} -> ${target}`;
        if (!ALLOWED.has(edge)) offenders.push(edge);
      }
    }
    // Named, not counted: the message has to say WHICH import to move into lib/.
    expect(offenders).toEqual([]);
  });

  it("the allowlist itself is real — App.tsx still imports those three eagerly", () => {
    const app = readFileSync(join(SRC, "App.tsx"), "utf8");
    const specs = staticSpecifiers(app);
    for (const page of ["./pages/Radar", "./pages/Terms", "./pages/Privacy"]) {
      expect(specs).toContain(page);
    }
    // …and every OTHER page is lazy, i.e. reached through a dynamic import.
    expect(app).toMatch(/lazy\(\(\) => import\("\.\/pages\/NicheDetail"\)\)/);
  });
});

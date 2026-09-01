import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * The three WCAG AA text failures a live audit measured on production 2026-09-01, pinned as
 * arithmetic on the tokens that produced them.
 *
 *   /datalog  SUCCESS badge      #0ca30c on #213141   3.96:1  (11px/600)
 *   /niches   ×0.87 brake note   #889098 on #1d2d3d   4.32:1  (10px/400)
 *   /studios  inactive tab       #989fa6 on #2a3948   4.41:1  (12px/500)
 *
 * All three are small text, so the bar is 4.5:1. A fourth finding — the DISABLED Prev button
 * at 3.78:1 — is deliberately not fixed: WCAG exempts inactive controls, and dimming is how
 * the control says it is unavailable.
 *
 * The ratios are recomputed here from index.css's own declarations rather than hardcoded,
 * so retuning a token re-runs the check instead of silently invalidating a stale comment.
 * jsdom has no layout or color-mix() engine, which is why this is arithmetic on the source
 * and the rendered ratios were verified separately in Chromium.
 */

const SRC = resolve(__dirname, "..");
const CSS = readFileSync(resolve(SRC, "index.css"), "utf8");

/** The `.dark` block only — the app is dark-only (lib/theme.tsx pins THEME = "dark"), and
 * the :root/light values are a different, already-passing set. */
const DARK_BLOCK = (() => {
  const start = CSS.indexOf(".dark {");
  expect(start).toBeGreaterThan(-1);
  return CSS.slice(start, CSS.indexOf("\n}", start));
})();

function darkToken(name: string): string {
  const m = DARK_BLOCK.match(new RegExp(`--${name}:\\s*([^;]+);`));
  if (!m) throw new Error(`--${name} not declared in .dark`);
  return m[1].trim();
}

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
}

/** color-mix(in srgb, X n%, transparent) composited over an opaque backdrop — exactly what
 * the browser does for --text-muted/--text-secondary and NicheFinder's PAPER_nn. */
function mix(fg: [number, number, number], alpha: number, bg: [number, number, number]): [number, number, number] {
  return [0, 1, 2].map((i) => fg[i] * alpha + bg[i] * (1 - alpha)) as [number, number, number];
}

function luminance([r, g, b]: [number, number, number]): number {
  const lin = (c: number) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function ratio(fg: [number, number, number], bg: [number, number, number]): number {
  const [a, b] = [luminance(fg), luminance(bg)].sort((x, y) => y - x);
  return (a + 0.05) / (b + 0.05);
}

// The three dark planes, derived the way index.css derives them: surface-1/-2 are
// color-mix of --text-primary into --page-plane at 2% / 6%.
const PAGE = hexToRgb(darkToken("page-plane"));
const TEXT_PRIMARY = hexToRgb(darkToken("text-primary"));
const SURFACE_1 = mix(TEXT_PRIMARY, 0.02, PAGE);
const SURFACE_2 = mix(TEXT_PRIMARY, 0.06, PAGE);

const AA_SMALL = 4.5;

describe("--page-plane and its surfaces are what the audit measured", () => {
  it("derives #1d2d3d / #213141 / #2a3948", () => {
    const hex = (c: [number, number, number]) =>
      "#" + c.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");
    expect(hex(PAGE)).toBe("#1d2d3d");
    expect(hex(SURFACE_1)).toBe("#213141");
    expect(hex(SURFACE_2)).toBe("#2a3948");
  });
});

describe("/datalog — the SUCCESS badge", () => {
  it("passes AA on every dark surface it can land on", () => {
    // text-verdict-good resolves to --status-good-text. The badge sits on a Card
    // (surface-1); the other two are checked so the token cannot fail by being reused.
    const fg = hexToRgb(darkToken("status-good-text"));
    expect(ratio(fg, SURFACE_1)).toBeGreaterThanOrEqual(AA_SMALL);
    expect(ratio(fg, SURFACE_2)).toBeGreaterThanOrEqual(AA_SMALL);
    expect(ratio(fg, PAGE)).toBeGreaterThanOrEqual(AA_SMALL);
  });

  it("is not simply aliased to the MARK hue, which is the shape of the bug", () => {
    // The .dark block used to set --status-good-text: #0ca30c — the same value as
    // --status-good — under a comment claiming the mark hues "already pass" as text. The
    // orange did (5.04:1); the green did not (3.96:1).
    expect(darkToken("status-good-text")).not.toBe(darkToken("status-good"));
  });

  it("does not regress the FAILED badge beside it", () => {
    // The asymmetry was the harm: the state you see ~always was the illegible one.
    expect(ratio(hexToRgb(darkToken("status-serious-text")), SURFACE_1)).toBeGreaterThanOrEqual(AA_SMALL);
  });
});

describe("/niches — the ×0.87 supply-brake annotation", () => {
  const FINDER = readFileSync(resolve(SRC, "pages/NicheFinder.tsx"), "utf8");

  /** The PAPER_nn constant the brake annotation is styled with, read off the source. */
  function brakeAlpha(): number {
    const m = FINDER.match(/style=\{\{\s*fontSize:\s*10,\s*color:\s*PAPER_(\d+)\s*\}\}/);
    if (!m) throw new Error("could not find the brake annotation's colour");
    return Number(m[1]) / 100;
  }

  it("passes AA at 10px on the page plane", () => {
    expect(ratio(mix(TEXT_PRIMARY, brakeAlpha(), PAGE), PAGE)).toBeGreaterThanOrEqual(AA_SMALL);
  });

  it("is dimmer than the score it annotates — the fix must not flatten the hierarchy", () => {
    const strong = /const PAPER_80 =/.test(FINDER) ? 0.8 : NaN;
    expect(brakeAlpha()).toBeLessThan(strong);
  });

  it("confirms the ORIGINAL alpha really did fail, so this test can fail", () => {
    // PAPER_50 was the shipped value: 4.32:1, measured in Chromium.
    expect(ratio(mix(TEXT_PRIMARY, 0.5, PAGE), PAGE)).toBeLessThan(AA_SMALL);
  });
});

describe("/niches/combined — the funnel tile on its brand-tinted panel", () => {
  const COMBINED = readFileSync(resolve(SRC, "pages/NicheCombined.tsx"), "utf8");

  // bg-brand-tint = color-mix(--brand 14%, transparent) over the card, i.e. #36485b — the
  // lightest text backdrop in the app, and the one that turns the ordinary muted token into
  // a failure. Not in the original audit's list: its probe parsed rgb() only and Chromium
  // emits color(srgb …) for these, so it silently skipped every alpha-composited node.
  const BRAND_TINT_PANEL = mix(hexToRgb(darkToken("brand")), 0.14, SURFACE_1);

  it("is measured on the panel the audit's own probe could not see", () => {
    const hex = "#" + BRAND_TINT_PANEL.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");
    expect(hex).toBe("#36485b");
    // The shipped token was --text-muted: 3.78:1 there.
    const muted = Number(darkToken("text-muted").match(/(\d+)%/)![1]) / 100;
    expect(ratio(mix(TEXT_PRIMARY, muted, BRAND_TINT_PANEL), BRAND_TINT_PANEL)).toBeLessThan(AA_SMALL);
  });

  it("labels the funnel tile with a token that passes AA there", () => {
    const line = COMBINED.match(/^\s*<div className="([^"]*)">\n\s*\{mode === "intersect" \? "In all of them"/m);
    if (!line) throw new Error("could not find the funnel tile's label classes");
    const token = line[1].includes("text-ink-secondary")
      ? "text-secondary"
      : line[1].includes("text-ink-muted")
        ? "text-muted"
        : null;
    expect(token).not.toBeNull();
    const alpha = Number(darkToken(token!).match(/(\d+)%/)![1]) / 100;
    expect(ratio(mix(TEXT_PRIMARY, alpha, BRAND_TINT_PANEL), BRAND_TINT_PANEL)).toBeGreaterThanOrEqual(AA_SMALL);
  });
});

describe("/studios — the inactive role tab", () => {
  const STUDIOS = readFileSync(resolve(SRC, "pages/Studios.tsx"), "utf8");

  /** The tab's RESTING colour token. Variant-prefixed classes (`hover:text-ink-*`) are
   * dropped first — a hover colour is not what the tab is read at, and matching one is how
   * the first draft of this test passed against the unfixed muted resting state. */
  function restingToken(): string {
    const inactive = STUDIOS.match(/role === r\.id \? "[^"]*" : "([^"]*)"/);
    if (!inactive) throw new Error("could not find the role tab's inactive classes");
    const resting = inactive[1]
      .split(/\s+/)
      .filter((c) => !c.includes(":"))
      .find((c) => c.startsWith("text-ink-"));
    if (!resting) throw new Error(`no resting text colour in ${JSON.stringify(inactive[1])}`);
    return resting.replace("text-ink-", "text-");
  }

  it("uses a text token that passes AA on the bg-surface2 pill", () => {
    const token = restingToken();
    // text-primary is opaque; the muted/secondary tokens are color-mix alphas.
    const alpha = token === "text-primary" ? 1 : Number(darkToken(token).match(/(\d+)%/)![1]) / 100;
    expect(ratio(mix(TEXT_PRIMARY, alpha, SURFACE_2), SURFACE_2)).toBeGreaterThanOrEqual(AA_SMALL);
  });

  it("reads the RESTING colour, not a hover variant", () => {
    expect(restingToken()).not.toContain(":");
    expect(["text-secondary", "text-primary"]).toContain(restingToken());
  });

  it("confirms the ORIGINAL token really did fail on that pill", () => {
    // --text-muted is 55%: 4.41:1 on #2a3948, measured in Chromium.
    const muted = Number(darkToken("text-muted").match(/(\d+)%/)![1]) / 100;
    expect(ratio(mix(TEXT_PRIMARY, muted, SURFACE_2), SURFACE_2)).toBeLessThan(AA_SMALL);
  });
});

import { createContext, useContext, useEffect, useMemo, type ReactNode } from "react";

/**
 * The theme context — what is LEFT of it.
 *
 * This module used to carry 7 selectable ACCENTS and 4 structural PRESETS with setters,
 * built for a /settings page that has since been retired (App.tsx redirects /settings).
 * Every accent/preset other than "industry" was unreachable: nothing rendered a picker,
 * and the initial-value functions deliberately stopped reading localStorage (a stored
 * preference from before the redesign was silently outranking the new defaults and
 * getting reported as bugs). That left ~200 lines describing looks the product cannot
 * enter — removed 2026-08-28.
 *
 * What survives is exactly what still has a consumer:
 *   - `theme` ("dark", fixed) — SeasonalityHeatmap reads it to pick the sequential ramp
 *     anchor (lib/palette.ts sequentialScale/tierColor take a Theme).
 *   - the `dark` class on <html> — Tailwind's darkMode: "class" strategy depends on it.
 *   - the runtime write of --radius-card / --radius-control, which tailwind.config.js
 *     maps to borderRadius.card / .lg. index.css declares both as 0px already, so this
 *     is belt-and-braces for the token contract rather than a live switch.
 *
 * The Industry identity is now stated ONCE, here and in index.css, with no alternative
 * to drift from. Everything below reproduces the previous default byte-for-byte: the
 * industry accent + industry preset on dark is what the app rendered before.
 */

export type Theme = "light" | "dark";

/** The designed identity is the product's look, not a preference — see the module doc. */
const THEME: Theme = "dark";

/** Square corners are the blueprint grammar. index.css declares these too; they are
 * written at runtime as well because tailwind.config.js reads them as design tokens and
 * the previous implementation set them here — keeping the write makes the removal a
 * pure deletion of unreachable branches, with no chance of a radius regression. */
const RADIUS_CARD = "0px";
const RADIUS_CONTROL = "0px";

interface ThemeCtx {
  theme: Theme;
}

const Ctx = createContext<ThemeCtx | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  useEffect(() => {
    document.documentElement.classList.toggle("dark", THEME === "dark");
    const s = document.documentElement.style;
    s.setProperty("--radius-card", RADIUS_CARD);
    s.setProperty("--radius-control", RADIUS_CONTROL);
  }, []);

  const value = useMemo<ThemeCtx>(() => ({ theme: THEME }), []);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useTheme(): ThemeCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useTheme must be used within ThemeProvider");
  return ctx;
}

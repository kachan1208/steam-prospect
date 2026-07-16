import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

export type Theme = "light" | "dark";
export type AccentId = "indigo" | "blue" | "slate" | "violet" | "teal" | "emerald";

interface AccentVars {
  brand: string;
  hover: string;
  tint: string;
  fg: string;
}
interface AccentDef {
  id: AccentId;
  name: string;
  swatch: string; // representative dot color in the picker (the light-mode brand)
  light: AccentVars;
  dark: AccentVars;
}

/** The six accents from the color-options board. `swatch` drives the picker dot; `light`/`dark`
 * carry the exact CSS-var set applied per theme (dark uses a lighter brand + translucent tint,
 * and Slate flips to near-white in dark so it stays visible). */
export const ACCENTS: AccentDef[] = [
  {
    id: "blue",
    name: "Blue",
    swatch: "#2563eb",
    light: { brand: "#2563eb", hover: "#1d4ed8", tint: "#eef3ff", fg: "#ffffff" },
    dark: { brand: "#4f83f0", hover: "#6b98f3", tint: "rgba(79,131,240,0.15)", fg: "#ffffff" },
  },
  {
    id: "indigo",
    name: "Indigo",
    swatch: "#4f46e5",
    light: { brand: "#4f46e5", hover: "#4338ca", tint: "#eef2ff", fg: "#ffffff" },
    dark: { brand: "#8b83f5", hover: "#a29bf7", tint: "rgba(139,131,245,0.16)", fg: "#ffffff" },
  },
  {
    id: "violet",
    name: "Violet",
    swatch: "#7c3aed",
    light: { brand: "#7c3aed", hover: "#6d28d9", tint: "#f5f0ff", fg: "#ffffff" },
    dark: { brand: "#a78bfa", hover: "#c4b5fd", tint: "rgba(167,139,250,0.16)", fg: "#ffffff" },
  },
  {
    id: "teal",
    name: "Teal",
    swatch: "#0d9488",
    light: { brand: "#0d9488", hover: "#0f766e", tint: "#e6f7f4", fg: "#ffffff" },
    dark: { brand: "#2dd4bf", hover: "#5eead4", tint: "rgba(45,212,191,0.15)", fg: "#06201d" },
  },
  {
    id: "emerald",
    name: "Emerald",
    swatch: "#059669",
    light: { brand: "#059669", hover: "#047857", tint: "#e7f6ef", fg: "#ffffff" },
    dark: { brand: "#34d399", hover: "#6ee7b7", tint: "rgba(52,211,153,0.15)", fg: "#04231a" },
  },
  {
    id: "slate",
    name: "Slate",
    swatch: "#0f172a",
    light: { brand: "#0f172a", hover: "#020617", tint: "#eef1f5", fg: "#ffffff" },
    dark: { brand: "#e2e8f0", hover: "#f1f5f9", tint: "rgba(226,232,240,0.12)", fg: "#0f172a" },
  },
];

const THEME_KEY = "prospect-theme-2";
const ACCENT_KEY = "prospect-accent";
const DEFAULT_ACCENT: AccentId = "blue";

function initialTheme(): Theme {
  if (typeof window === "undefined") return "light";
  const stored = window.localStorage.getItem(THEME_KEY);
  if (stored === "light" || stored === "dark") return stored;
  // Prospect defaults to the clean light SaaS aesthetic regardless of OS preference.
  return "light";
}

function initialAccent(): AccentId {
  if (typeof window === "undefined") return DEFAULT_ACCENT;
  const stored = window.localStorage.getItem(ACCENT_KEY);
  return ACCENTS.some((a) => a.id === stored) ? (stored as AccentId) : DEFAULT_ACCENT;
}

interface ThemeCtx {
  theme: Theme;
  toggle: () => void;
  setTheme: (t: Theme) => void;
  accent: AccentId;
  setAccent: (a: AccentId) => void;
}

const Ctx = createContext<ThemeCtx | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(initialTheme);
  const [accent, setAccentState] = useState<AccentId>(initialAccent);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
    window.localStorage.setItem(THEME_KEY, theme);
  }, [theme]);

  // Apply the accent's CSS vars for the current mode. Re-runs on theme change so a switch to
  // dark repaints with the accent's dark set. Inline vars on <html> override the stylesheet.
  useEffect(() => {
    const def = ACCENTS.find((a) => a.id === accent) ?? ACCENTS.find((a) => a.id === DEFAULT_ACCENT)!;
    const v = theme === "dark" ? def.dark : def.light;
    const s = document.documentElement.style;
    s.setProperty("--brand", v.brand);
    s.setProperty("--brand-hover", v.hover);
    s.setProperty("--brand-tint", v.tint);
    s.setProperty("--brand-fg", v.fg);
    window.localStorage.setItem(ACCENT_KEY, accent);
  }, [accent, theme]);

  const value = useMemo<ThemeCtx>(
    () => ({
      theme,
      toggle: () => setThemeState((t) => (t === "dark" ? "light" : "dark")),
      setTheme: setThemeState,
      accent,
      setAccent: setAccentState,
    }),
    [theme, accent],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useTheme(): ThemeCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useTheme must be used within ThemeProvider");
  return ctx;
}

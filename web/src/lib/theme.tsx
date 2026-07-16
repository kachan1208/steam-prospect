import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

export type Theme = "light" | "dark";
export type AccentId = "indigo" | "blue" | "slate" | "violet" | "teal" | "emerald";
export type PresetId = "soft" | "flat" | "rounded";

interface AccentVars {
  brand: string;
  hover: string;
  tint: string;
  fg: string;
}
interface AccentDef {
  id: AccentId;
  name: string;
  swatch: string;
  light: AccentVars;
  dark: AccentVars;
}

/** Accent = the color axis (drives --brand*). Each carries an explicit light + dark set. */
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

interface PresetVars {
  page: string;
  surface2: string;
  border: string;
  borderStrong: string;
  radiusCard: string;
  radiusControl: string;
  shadowXs: string;
  shadowSm: string;
  shadowMd: string;
  shadowLg: string;
}
interface PresetDef {
  id: PresetId;
  name: string;
  light: PresetVars;
  dark: PresetVars;
}

// Soft shadow ramps (the current elevation). Flat drops shadows entirely; Rounded diffuses them.
const SOFT_L = {
  xs: "0 1px 2px rgba(16,24,40,0.05)",
  sm: "0 1px 3px rgba(16,24,40,0.08), 0 1px 2px rgba(16,24,40,0.04)",
  md: "0 4px 12px -2px rgba(16,24,40,0.10), 0 2px 6px -2px rgba(16,24,40,0.05)",
  lg: "0 16px 40px -12px rgba(16,24,40,0.18)",
};
const SOFT_D = {
  xs: "0 1px 2px rgba(0,0,0,0.4)",
  sm: "0 1px 3px rgba(0,0,0,0.5)",
  md: "0 6px 16px -4px rgba(0,0,0,0.55)",
  lg: "0 20px 48px -12px rgba(0,0,0,0.6)",
};
const ROUND_L = {
  xs: "0 1px 2px rgba(16,24,40,0.05)",
  sm: "0 2px 6px rgba(16,24,40,0.06), 0 1px 2px rgba(16,24,40,0.04)",
  md: "0 8px 24px -4px rgba(16,24,40,0.12), 0 3px 8px -3px rgba(16,24,40,0.06)",
  lg: "0 24px 56px -16px rgba(16,24,40,0.20)",
};
const NONE = { xs: "none", sm: "none", md: "none", lg: "none" };

/** Theme = the structural axis: corner radius, elevation, page tint, border weight. Composes
 * with any accent. `soft` reproduces the current look, so it's a safe default. */
export const PRESETS: PresetDef[] = [
  {
    id: "soft",
    name: "Soft",
    light: {
      page: "#f6f7f9", surface2: "#f4f6f8", border: "#e6e8ec", borderStrong: "#d7dbe2",
      radiusCard: "12px", radiusControl: "10px",
      shadowXs: SOFT_L.xs, shadowSm: SOFT_L.sm, shadowMd: SOFT_L.md, shadowLg: SOFT_L.lg,
    },
    dark: {
      page: "#0e0f11", surface2: "#202228", border: "#26282e", borderStrong: "#33363e",
      radiusCard: "12px", radiusControl: "10px",
      shadowXs: SOFT_D.xs, shadowSm: SOFT_D.sm, shadowMd: SOFT_D.md, shadowLg: SOFT_D.lg,
    },
  },
  {
    id: "flat",
    name: "Flat",
    light: {
      page: "#f7f8fa", surface2: "#f1f3f6", border: "#dfe1e6", borderStrong: "#cbd0d8",
      radiusCard: "8px", radiusControl: "8px",
      shadowXs: NONE.xs, shadowSm: NONE.sm, shadowMd: NONE.md, shadowLg: SOFT_L.lg,
    },
    dark: {
      page: "#0c0d0f", surface2: "#1a1c20", border: "#2c2e35", borderStrong: "#3a3d45",
      radiusCard: "8px", radiusControl: "8px",
      shadowXs: NONE.xs, shadowSm: NONE.sm, shadowMd: NONE.md, shadowLg: SOFT_D.lg,
    },
  },
  {
    id: "rounded",
    name: "Rounded",
    light: {
      page: "#f5f6f9", surface2: "#f2f4f8", border: "#e7e9ee", borderStrong: "#d9dde4",
      radiusCard: "18px", radiusControl: "12px",
      shadowXs: ROUND_L.xs, shadowSm: ROUND_L.sm, shadowMd: ROUND_L.md, shadowLg: ROUND_L.lg,
    },
    dark: {
      page: "#0f1013", surface2: "#202329", border: "#282b31", borderStrong: "#363942",
      radiusCard: "18px", radiusControl: "12px",
      shadowXs: SOFT_D.xs, shadowSm: SOFT_D.sm, shadowMd: SOFT_D.md, shadowLg: SOFT_D.lg,
    },
  },
];

const THEME_KEY = "prospect-theme-2";
const ACCENT_KEY = "prospect-accent";
const PRESET_KEY = "prospect-preset";
const DEFAULT_ACCENT: AccentId = "blue";
const DEFAULT_PRESET: PresetId = "soft";

function initialTheme(): Theme {
  if (typeof window === "undefined") return "light";
  const stored = window.localStorage.getItem(THEME_KEY);
  if (stored === "light" || stored === "dark") return stored;
  return "light";
}
function initialAccent(): AccentId {
  if (typeof window === "undefined") return DEFAULT_ACCENT;
  const s = window.localStorage.getItem(ACCENT_KEY);
  return ACCENTS.some((a) => a.id === s) ? (s as AccentId) : DEFAULT_ACCENT;
}
function initialPreset(): PresetId {
  if (typeof window === "undefined") return DEFAULT_PRESET;
  const s = window.localStorage.getItem(PRESET_KEY);
  return PRESETS.some((p) => p.id === s) ? (s as PresetId) : DEFAULT_PRESET;
}

interface ThemeCtx {
  theme: Theme;
  toggle: () => void;
  setTheme: (t: Theme) => void;
  accent: AccentId;
  setAccent: (a: AccentId) => void;
  preset: PresetId;
  setPreset: (p: PresetId) => void;
}

const Ctx = createContext<ThemeCtx | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(initialTheme);
  const [accent, setAccentState] = useState<AccentId>(initialAccent);
  const [preset, setPresetState] = useState<PresetId>(initialPreset);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
    window.localStorage.setItem(THEME_KEY, theme);
  }, [theme]);

  // Accent vars (color axis). Re-runs on theme change to repaint with the dark set.
  useEffect(() => {
    const def = ACCENTS.find((a) => a.id === accent) ?? ACCENTS[0];
    const v = theme === "dark" ? def.dark : def.light;
    const s = document.documentElement.style;
    s.setProperty("--brand", v.brand);
    s.setProperty("--brand-hover", v.hover);
    s.setProperty("--brand-tint", v.tint);
    s.setProperty("--brand-fg", v.fg);
    window.localStorage.setItem(ACCENT_KEY, accent);
  }, [accent, theme]);

  // Theme/preset vars (structure axis): surfaces, borders, radius, elevation — per mode.
  useEffect(() => {
    const def = PRESETS.find((p) => p.id === preset) ?? PRESETS[0];
    const v = theme === "dark" ? def.dark : def.light;
    const s = document.documentElement.style;
    s.setProperty("--page-plane", v.page);
    s.setProperty("--surface-2", v.surface2);
    s.setProperty("--border", v.border);
    s.setProperty("--border-strong", v.borderStrong);
    s.setProperty("--radius-card", v.radiusCard);
    s.setProperty("--radius-control", v.radiusControl);
    s.setProperty("--shadow-xs", v.shadowXs);
    s.setProperty("--shadow-sm", v.shadowSm);
    s.setProperty("--shadow-md", v.shadowMd);
    s.setProperty("--shadow-lg", v.shadowLg);
    window.localStorage.setItem(PRESET_KEY, preset);
  }, [preset, theme]);

  const value = useMemo<ThemeCtx>(
    () => ({
      theme,
      toggle: () => setThemeState((t) => (t === "dark" ? "light" : "dark")),
      setTheme: setThemeState,
      accent,
      setAccent: setAccentState,
      preset,
      setPreset: setPresetState,
    }),
    [theme, accent, preset],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useTheme(): ThemeCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useTheme must be used within ThemeProvider");
  return ctx;
}

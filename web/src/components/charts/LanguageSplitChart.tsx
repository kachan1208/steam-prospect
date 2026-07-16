import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

import type { LanguageShare } from "../../lib/api";
import { fmtCompact, fmtPct } from "../../lib/format";
import { CSS_VAR } from "../../lib/palette";
import { TooltipPanel } from "./TooltipPanel";

// Steam's review-language codes -> display names, for the handful that are
// non-obvious. Anything not listed falls back to a title-cased raw code.
const LANGUAGE_LABELS: Record<string, string> = {
  english: "English",
  schinese: "Chinese (Simp.)",
  tchinese: "Chinese (Trad.)",
  russian: "Russian",
  brazilian: "Portuguese (BR)",
  portuguese: "Portuguese",
  spanish: "Spanish",
  latam: "Spanish (LatAm)",
  german: "German",
  french: "French",
  turkish: "Turkish",
  koreana: "Korean",
  japanese: "Japanese",
  polish: "Polish",
  italian: "Italian",
  ukrainian: "Ukrainian",
  thai: "Thai",
  vietnamese: "Vietnamese",
  dutch: "Dutch",
  swedish: "Swedish",
  czech: "Czech",
  hungarian: "Hungarian",
  romanian: "Romanian",
  finnish: "Finnish",
  danish: "Danish",
  norwegian: "Norwegian",
  greek: "Greek",
  bulgarian: "Bulgarian",
  arabic: "Arabic",
};

export function languageLabel(code: string): string {
  return LANGUAGE_LABELS[code] ?? code.charAt(0).toUpperCase() + code.slice(1);
}

/**
 * Top-N review-language share, horizontal bars — the same "magnitude compare
 * across nominal categories, single hue, sorted descending" shape as
 * PriceByGenreChart. Up to ~15 languages is well past the categorical hue
 * ceiling (~8), so this is deliberately one hue, never per-language color.
 */
export function LanguageSplitChart({ data, height }: { data: LanguageShare[]; height?: number }) {
  if (data.length === 0) {
    return <div className="flex h-24 items-center justify-center text-xs text-ink-muted">No language data.</div>;
  }
  const sorted = [...data].sort((a, b) => b.share - a.share);
  const h = height ?? Math.max(120, sorted.length * 24);
  return (
    <ResponsiveContainer width="100%" height={h}>
      <BarChart data={sorted} layout="vertical" margin={{ top: 4, right: 28, left: 8, bottom: 4 }}>
        <CartesianGrid stroke="var(--gridline)" horizontal={false} />
        <XAxis
          type="number"
          tick={{ fontSize: 10 }}
          tickFormatter={(v: number) => fmtPct(v, 0)}
          tickLine={false}
          axisLine={{ stroke: "var(--baseline)" }}
        />
        <YAxis
          type="category"
          dataKey="language"
          tickFormatter={(l: string) => languageLabel(l)}
          tick={{ fontSize: 11 }}
          tickLine={false}
          axisLine={false}
          width={112}
        />
        <Tooltip
          cursor={{ fill: "var(--gridline)", opacity: 0.5 }}
          content={({ active, payload }) => {
            if (!active || !payload || payload.length === 0) return null;
            const p = payload[0].payload as LanguageShare;
            return (
              <TooltipPanel
                title={languageLabel(p.language)}
                rows={[
                  { label: "Share of sampled reviews", value: fmtPct(p.share), color: CSS_VAR.competition },
                  { label: "Reviews", value: fmtCompact(p.n) },
                ]}
              />
            );
          }}
        />
        <Bar dataKey="share" fill={CSS_VAR.competition} radius={[0, 4, 4, 0]} maxBarSize={18} />
      </BarChart>
    </ResponsiveContainer>
  );
}

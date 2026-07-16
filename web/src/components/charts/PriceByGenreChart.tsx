import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

import { fmtPrice } from "../../lib/format";
import { CSS_VAR } from "../../lib/palette";
import { TooltipPanel } from "./TooltipPanel";

export interface GenrePricePoint {
  genre: string;
  median_price: number;
  n_games: number;
}

/**
 * Median list price by genre, derived from the real `/api/niches?dimension=genre`
 * rows. The backend's /market/distribution only serves revenue|reviews|owners
 * (no `price` metric), so this is the honest real-data stand-in for a price
 * distribution: magnitude compare across genres, single hue, sorted descending.
 */
export function PriceByGenreChart({ data, height }: { data: GenrePricePoint[]; height?: number }) {
  const sorted = [...data].sort((a, b) => b.median_price - a.median_price);
  const h = height ?? Math.max(180, sorted.length * 26);
  return (
    <ResponsiveContainer width="100%" height={h}>
      <BarChart data={sorted} layout="vertical" margin={{ top: 4, right: 28, left: 8, bottom: 4 }}>
        <CartesianGrid stroke="var(--gridline)" horizontal={false} />
        <XAxis
          type="number"
          tick={{ fontSize: 10 }}
          tickFormatter={(v: number) => fmtPrice(v)}
          tickLine={false}
          axisLine={{ stroke: "var(--baseline)" }}
        />
        <YAxis type="category" dataKey="genre" tick={{ fontSize: 11 }} tickLine={false} axisLine={false} width={140} />
        <Tooltip
          cursor={{ fill: "var(--gridline)", opacity: 0.5 }}
          content={({ active, payload }) => {
            if (!active || !payload || payload.length === 0) return null;
            const p = payload[0].payload as GenrePricePoint;
            return (
              <TooltipPanel
                title={p.genre}
                rows={[
                  { label: "Median price", value: fmtPrice(p.median_price), color: CSS_VAR.demand },
                  { label: "Games", value: p.n_games.toLocaleString() },
                ]}
              />
            );
          }}
        />
        <Bar dataKey="median_price" fill={CSS_VAR.demand} radius={[0, 4, 4, 0]} maxBarSize={18} />
      </BarChart>
    </ResponsiveContainer>
  );
}

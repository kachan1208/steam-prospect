import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

import { useGamePriceHistory, type PricePoint } from "../../lib/api";
import { axisScale, fmtPrice, fmtUsd, monthName } from "../../lib/format";
import { CSS_VAR } from "../../lib/palette";
import { TooltipPanel, type TooltipRow } from "./TooltipPanel";

/**
 * Daily US price snapshots (GET /api/games/{appid}/price-history ← signals.db).
 * Collection went live 2026-08-24, so a days-deep series is the NORMAL state right now,
 * not an edge case — the render states are designed for it rather than around it:
 *
 *   free  — F2P titles have no price series; say so instead of charting nulls.
 *   empty — no snapshots yet (or the endpoint failed; the hook swallows errors to []).
 *   dots  — 1-2 points: plotted as honest dots, no pretense of a curve.
 *   line  — >= 3 points: a step line (prices hold between snapshots, so stepAfter —
 *           a sloped interpolation would invent gradual price drift that never happened).
 *
 * Single series on the mono language (CSS_VAR.demand), so no legend; discount days get
 * an emphasized dot + a tooltip row ("−N% (was $X)") since a step down alone doesn't say
 * whether it's a sale or a permanent cut.
 */

export type PriceSeriesState = "free" | "empty" | "dots" | "line";

/** Which render state a snapshot series is in. Exported for tests. */
export function priceSeriesState(points: PricePoint[]): PriceSeriesState {
  const latest = points[points.length - 1];
  if (latest?.is_free) return "free";
  const plottable = points.filter((p) => p.final_cents !== null);
  if (plottable.length === 0) return "empty";
  return plottable.length >= 3 ? "line" : "dots";
}

/** Tooltip discount row: "−25% (was $79.99)", or null when the day isn't discounted.
 * Exported for tests. */
export function discountLabel(p: PricePoint): string | null {
  if (p.discount_pct <= 0) return null;
  const was = p.original_cents !== null ? ` (was ${fmtPrice(p.original_cents / 100)})` : "";
  return `−${p.discount_pct}%${was}`;
}

/** 'YYYY-MM-DD' -> "Aug 24" (ticks) / "Aug 24, 2026" (tooltip titles). */
function dayLabel(iso: string, withYear = false): string {
  const m = Number(iso.slice(5, 7));
  const d = Number(iso.slice(8, 10));
  if (!(m >= 1 && m <= 12)) return iso;
  return withYear ? `${monthName(m)} ${d}, ${iso.slice(0, 4)}` : `${monthName(m)} ${d}`;
}

interface ChartPoint extends PricePoint {
  usd: number;
}

const TRACKING_NOTE = "Price tracking started 2026-08-24 — the series builds daily.";
const METHOD_CAPTION = "Daily US snapshots via the Steam catalog diff; history accrues from Aug 24, 2026.";

export function PriceHistoryChart({ appid, priceInitial }: { appid: number; priceInitial: number | null }) {
  const historyQ = useGamePriceHistory(appid);

  if (historyQ.isLoading) {
    return <div className="flex h-[150px] items-center justify-center text-xs text-ink-muted">Loading…</div>;
  }

  const points = historyQ.data ?? [];
  const state = priceSeriesState(points);

  if (state === "free") {
    return (
      <div className="flex h-full min-h-[80px] flex-col items-center justify-center gap-1.5 py-4 text-center text-xs text-ink-muted">
        <span className="font-medium text-ink-secondary">Free to play</span>
        <span>No list price to track for this title.</span>
      </div>
    );
  }

  if (state === "empty") {
    return (
      <div className="flex h-full min-h-[80px] flex-col items-center justify-center gap-1.5 py-4 text-center text-xs text-ink-muted">
        <span className="font-medium text-ink-secondary">No snapshots yet</span>
        <span>
          {TRACKING_NOTE} Launch price was {fmtPrice(priceInitial)}.
        </span>
      </div>
    );
  }

  const data: ChartPoint[] = points
    .filter((p) => p.final_cents !== null)
    .map((p) => ({ ...p, usd: (p.final_cents as number) / 100 }));

  // The price axis is anchored at $0 (a -50% sale only reads honestly against zero) with
  // ticks we compute rather than let recharts derive from a x1.1 headroom domain — that
  // produced literally unevenly-spaced ticks: "$0 / $9 / $18 / $33" on a $29.99 title.
  const y = axisScale(Math.max(0, ...data.map((d) => d.usd)), "usd", 4);

  // dots (1-2 points): every snapshot is a visible dot and the line stroke is hidden —
  // two points joined by a stroke would read as a month of continuous price knowledge
  // we don't have. line (>= 3): the stroke carries the series and only discount days
  // keep a dot, as emphasis.
  const dotsOnly = state === "dots";
  const renderDot = (props: { cx?: number; cy?: number; index?: number; payload?: ChartPoint }) => {
    const { cx, cy, index, payload } = props;
    const discounted = (payload?.discount_pct ?? 0) > 0;
    if (cx == null || cy == null || !payload || (!dotsOnly && !discounted)) return <g key={`pd-${index}`} />;
    return (
      <circle
        key={`pd-${index}`}
        cx={cx}
        cy={cy}
        r={4}
        fill={CSS_VAR.demand}
        stroke="var(--surface-1)"
        strokeWidth={2}
      />
    );
  };

  return (
    <div>
      <ResponsiveContainer width="100%" height={160}>
        <LineChart data={data} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
          <CartesianGrid stroke="var(--gridline)" vertical={false} />
          <XAxis
            dataKey="captured_on"
            tick={{ fontSize: 10 }}
            tickFormatter={(v: string) => dayLabel(v)}
            interval="preserveStartEnd"
            minTickGap={24}
            tickLine={false}
            axisLine={{ stroke: "var(--baseline)" }}
            // With 1-2 category points recharts pins them to the plot edges, shoving the
            // sole dot onto the y-axis; padding recenters the sparse series.
            padding={dotsOnly ? { left: 24, right: 24 } : undefined}
          />
          <YAxis
            // Anchored at $0 — price deltas (a -50% sale) only read honestly against zero.
            ticks={y.ticks}
            interval={0}
            domain={y.domain}
            tick={{ fontSize: 10 }}
            tickFormatter={(v: number) => y.format(v)}
            tickLine={false}
            axisLine={false}
            width={40}
          />
          <Tooltip
            cursor={{ stroke: "var(--baseline)" }}
            content={({ active, payload }) => {
              if (!active || !payload || payload.length === 0) return null;
              const p = payload[0].payload as ChartPoint;
              const rows: TooltipRow[] = [{ label: "Price", value: fmtPrice(p.usd), color: CSS_VAR.demand }];
              const discount = discountLabel(p);
              if (discount) rows.push({ label: "Discount", value: discount });
              return <TooltipPanel title={dayLabel(p.captured_on, true)} rows={rows} />;
            }}
          />
          <Line
            type="stepAfter"
            dataKey="usd"
            stroke={dotsOnly ? "none" : CSS_VAR.demand}
            strokeWidth={2}
            dot={renderDot}
            activeDot={{ r: 4, fill: CSS_VAR.demand, stroke: "var(--surface-1)", strokeWidth: 2 }}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
      {dotsOnly && (
        <p className="mt-2 text-xs text-ink-muted">
          {TRACKING_NOTE} Launch price was {fmtPrice(priceInitial)}.
        </p>
      )}
      <p className="mt-2 text-xs text-ink-muted">{METHOD_CAPTION}</p>
    </div>
  );
}

import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceArea,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { useGamePriceHistory, type PriceHistoryStatus, type PricePoint } from "../../lib/api";
import { useDataAge } from "../../lib/dataAge";
import { fmtDay } from "../../lib/dates";
import { axisScale, fmtPrice, fmtPriceFor, monthName } from "../../lib/format";
import { CSS_VAR } from "../../lib/palette";
import { useDragZoom } from "../../lib/useDragZoom";
import { InfoTip } from "../ui/InfoTip";
import { InlineError } from "../ui/InlineError";
import { SELECTION_AREA_PROPS, ZoomFrame } from "./ZoomFrame";
import { TooltipPanel, type TooltipRow } from "./TooltipPanel";

/**
 * PRICE CHANGES, NOT DAILY SNAPSHOTS (2026-09-23).
 *
 * GET /api/games/{appid}/price-history reads signals.db, where the collector writes a row only
 * when Steam's own price-change counter moves. So Hollow Knight, Stardew Valley and Cyberpunk
 * have ONE row (their price when tracking began on 2026-08-24) and The Witcher 3 has two
 * ($39.99 on Aug 24, $49.99 from Aug 26). The old chart promised "the series builds daily",
 * drew those rows as one or two unconnected dots, and spaced them evenly on a category axis,
 * so Aug 24 → Aug 26 looked as long as a year.
 *
 * Now:
 *   one row    no chart — a sentence: "No price change since tracking began (Aug 24, 2026):
 *              $14.99". A lone dot said the same thing less clearly.
 *   2+ rows    a STEP line on a TIME axis from the first record to the data's as-of date:
 *              a price holds until the next change, and the gaps are as long as they were.
 *   empty      told apart by the API's `status`: "missing" (no price store on this server),
 *              "unavailable" (the store couldn't be read) and "ok" (the collector hasn't
 *              reached this game) are three different sentences, and a failed request is a
 *              fourth — an error with Retry, never "no snapshots yet".
 *   free       the latest record says free: nothing to track.
 */

export type PriceSeriesState = "free" | "empty" | "single" | "line";

/** Which render state a record series is in. Exported for tests. */
export function priceSeriesState(points: PricePoint[]): PriceSeriesState {
  const latest = points[points.length - 1];
  if (latest?.is_free) return "free";
  const plottable = points.filter((p) => p.final_cents !== null);
  if (plottable.length === 0) return "empty";
  return plottable.length === 1 ? "single" : "line";
}

/** Tooltip discount row: "−25% (was $79.99)", or null when the record isn't discounted.
 * Exported for tests. */
export function discountLabel(p: PricePoint): string | null {
  if (p.discount_pct <= 0) return null;
  const was = p.original_cents !== null ? ` (was ${fmtPrice(p.original_cents / 100)})` : "";
  return `−${p.discount_pct}%${was}`;
}

const DAY_MS = 86_400_000;

/** 'YYYY-MM-DD…' -> UTC midnight in ms. */
export function dayMs(iso: string): number {
  return Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)));
}

function isoDay(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

/**
 * Ticks for a time axis from `from` to `to` (UTC ms): weekly under ~10 weeks, then month
 * starts, then year starts — at most ~6, always including both ends' neighbourhood.
 * Exported for tests.
 */
export function timeTicks(from: number, to: number): { ticks: number[]; format: (ms: number) => string } {
  const spanDays = Math.max(1, (to - from) / DAY_MS);
  const dayLabel = (ms: number) => {
    const d = new Date(ms);
    return `${monthName(d.getUTCMonth() + 1)} ${d.getUTCDate()}`;
  };
  if (spanDays <= 70) {
    const step = Math.max(1, Math.ceil(spanDays / 5 / 7)) * 7 * DAY_MS;
    const ticks: number[] = [];
    for (let t = from; t <= to; t += step) ticks.push(t);
    return { ticks, format: dayLabel };
  }
  const monthly = spanDays <= 3 * 365;
  const ticks: number[] = [];
  const start = new Date(from);
  let y = start.getUTCFullYear();
  let m = start.getUTCMonth() + 1; // first boundary strictly after `from`'s month start
  if (!monthly) {
    y += 1;
    m = 0;
  }
  for (;;) {
    const t = Date.UTC(y + Math.floor(m / 12), m % 12, 1);
    if (t > to) break;
    ticks.push(t);
    if (monthly) m += 1;
    else y += 1;
  }
  const keep = Math.max(1, Math.ceil(ticks.length / 6));
  const thinned = ticks.filter((_, i) => i % keep === 0);
  const fmt = (ms: number) => {
    const d = new Date(ms);
    return monthly ? `${monthName(d.getUTCMonth() + 1)} ${d.getUTCFullYear()}` : String(d.getUTCFullYear());
  };
  return { ticks: thinned, format: fmt };
}

export interface PriceStep {
  /** UTC ms of the record day. */
  t: number;
  captured_on: string;
  usd: number;
  discount_pct: number;
  original_cents: number | null;
  /** The as-of endpoint that carries the last price to the right edge — not a record. */
  carried?: boolean;
}

/**
 * The step series: every record with a price, plus — when the data runs past the last
 * record — the last price carried to the as-of day, so the line reaches the right edge
 * instead of stopping at the last change. Exported for tests.
 */
export function priceSteps(points: PricePoint[], asOf: string | null): PriceStep[] {
  const rows: PriceStep[] = points
    .filter((p) => p.final_cents !== null)
    .map((p) => ({
      t: dayMs(p.captured_on),
      captured_on: p.captured_on,
      usd: (p.final_cents as number) / 100,
      discount_pct: p.discount_pct,
      original_cents: p.original_cents,
    }));
  const last = rows[rows.length - 1];
  if (last && asOf && dayMs(asOf) > last.t) {
    rows.push({ ...last, t: dayMs(asOf), captured_on: asOf.slice(0, 10), carried: true });
  }
  return rows;
}

/** One plain sentence over the recorded changes, e.g. "1 change: $39.99 → $49.99 on Aug 26,
 * 2026." Exported for tests. */
export function priceChangeSummary(steps: PriceStep[]): string {
  const records = steps.filter((s) => !s.carried);
  const changes = records.slice(1);
  if (changes.length === 0) return "No change recorded.";
  const describe = (s: PriceStep, prev: PriceStep) => {
    const sale = s.discount_pct > 0 ? ` (−${s.discount_pct}% sale)` : "";
    return `${fmtPrice(prev.usd)} → ${fmtPrice(s.usd)}${sale} on ${fmtDay(s.captured_on)}`;
  };
  if (changes.length <= 3) {
    const parts = changes.map((s, i) => describe(s, records[i]));
    return `${changes.length} change${changes.length === 1 ? "" : "s"}: ${parts.join("; ")}.`;
  }
  const low = records.reduce((a, b) => (b.usd < a.usd ? b : a));
  return `${changes.length} changes; lowest ${fmtPrice(low.usd)}${low.discount_pct > 0 ? ` (−${low.discount_pct}% sale)` : ""} on ${fmtDay(
    low.captured_on,
  )}; latest ${fmtPrice(records[records.length - 1].usd)} since ${fmtDay(records[records.length - 1].captured_on)}.`;
}

const EMPTY_COPY: Record<PriceHistoryStatus, { title: string; body: string }> = {
  ok: {
    title: "No price recorded yet",
    body: "The price collector hasn't reached this game yet.",
  },
  missing: {
    title: "Price tracking isn't running here",
    body: "This server has no price store yet, so there is nothing to chart — not a sign the price never changed.",
  },
  unavailable: {
    title: "Price history unavailable",
    body: "The price store exists but couldn't be read just now — this says nothing about the game's price.",
  },
};

function PriceTip() {
  return (
    <InfoTip
      term="price_history"
      formula="one row per change of Steam's own price-change counter (US store), from Aug 24, 2026; the step line holds each price until the next change"
    />
  );
}

export function PriceHistoryChart({
  appid,
  priceInitial,
  isFree,
}: {
  appid: number;
  priceInitial: number | null;
  /** The catalog's is_free flag, so an empty history can say "Free" vs "Price unknown". */
  isFree?: number | boolean | null;
}) {
  const historyQ = useGamePriceHistory(appid);
  const age = useDataAge();

  // Derived ABOVE the early returns, not beside the chart, because useDragZoom below is a
  // hook and a hook after a conditional return is a different hook order on the loading
  // render. All of this is pure and cheap, and on a loading/empty render it just folds to
  // an empty series.
  const points = historyQ.data?.items ?? [];
  const status: PriceHistoryStatus = historyQ.data?.status ?? "ok";
  const state = priceSeriesState(points);
  const asOfIso = age.asOf ? age.asOf.toISOString().slice(0, 10) : null;
  const steps = priceSteps(points, asOfIso);
  // Rows keep their record DAY for the page-wide zoom window; the axis itself is `t`.
  const zoom = useDragZoom(steps, "t", { dateOf: (s) => s.captured_on });
  const listPrice = fmtPriceFor({ price_initial: priceInitial, is_free: isFree });

  if (historyQ.isLoading) {
    return <div className="flex h-[60px] items-center justify-center text-xs text-ink-muted">Loading…</div>;
  }

  if (historyQ.isError) {
    return <InlineError what="the price history" error={historyQ.error} onRetry={() => void historyQ.refetch()} />;
  }

  if (state === "free") {
    return (
      <p className="text-xs text-ink-secondary">
        <span className="font-medium text-ink-primary">Free to play</span> — no list price to track for this title.
      </p>
    );
  }

  if (state === "empty") {
    const copy = EMPTY_COPY[status];
    return (
      <div className="flex flex-col gap-1 text-xs text-ink-muted" data-price-status={status}>
        <span className="flex items-center gap-1.5 font-medium text-ink-secondary">
          {copy.title}
          <PriceTip />
        </span>
        <span>
          {copy.body} Catalog list price: {listPrice}.
        </span>
      </div>
    );
  }

  const first = steps[0];
  const lastRecord = [...steps].reverse().find((s) => !s.carried) ?? first;

  if (state === "single") {
    // A single record is the whole story: the price hasn't moved since tracking began.
    const sale = first.discount_pct > 0 ? ` (−${first.discount_pct}% sale${first.original_cents !== null ? `, was ${fmtPrice(first.original_cents / 100)}` : ""})` : "";
    return (
      <div className="flex flex-col gap-1 text-xs">
        <p className="flex flex-wrap items-center gap-x-1.5 text-ink-secondary" data-testid="price-single">
          <span>
            No price change since tracking began ({fmtDay(first.captured_on)}):{" "}
            <span className="tabular font-semibold text-ink-primary">{fmtPrice(first.usd)}</span>
            {sale}
          </span>
          <PriceTip />
        </p>
        {asOfIso && <p className="text-[11px] text-ink-muted">Latest data: {fmtDay(asOfIso)}.</p>}
      </div>
    );
  }

  const visible = zoom.data;
  const from = visible[0]?.t ?? first.t;
  const to = visible[visible.length - 1]?.t ?? first.t;
  const x = timeTicks(from, to);
  // The price axis is anchored at $0 (a -50% sale only reads honestly against zero) with
  // ticks we compute rather than let recharts derive from a x1.1 headroom domain.
  const y = axisScale(Math.max(0, ...steps.map((d) => d.usd)), "usd", 4);

  const renderDot = (props: { cx?: number; cy?: number; index?: number; payload?: PriceStep }) => {
    const { cx, cy, index, payload } = props;
    if (cx == null || cy == null || !payload || payload.carried) return <g key={`pd-${index}`} />;
    return (
      <circle
        key={`pd-${index}`}
        cx={cx}
        cy={cy}
        r={payload.discount_pct > 0 ? 4.5 : 3.5}
        fill={CSS_VAR.demand}
        stroke="var(--surface-1)"
        strokeWidth={2}
      />
    );
  };

  return (
    <div>
      <p className="mb-2 flex flex-wrap items-center gap-x-1.5 text-xs text-ink-secondary" data-testid="price-summary">
        <span>
          <span className="font-medium text-ink-primary">Price changes since {fmtDay(first.captured_on)}</span> —{" "}
          {priceChangeSummary(steps)}
          {asOfIso && dayMs(asOfIso) > lastRecord.t ? ` No change since, through ${fmtDay(asOfIso)}.` : ""}
        </span>
        <PriceTip />
      </p>
      <ZoomFrame zoomed={zoom.zoomed} dragging={zoom.dragging} outOfRange={zoom.outOfRange} onReset={zoom.reset}>
        <ResponsiveContainer width="100%" height={150}>
          <LineChart data={visible} margin={{ top: 8, right: 12, left: 0, bottom: 0 }} {...zoom.handlers}>
            <CartesianGrid stroke="var(--gridline)" vertical={false} />
            <XAxis
              dataKey="t"
              type="number"
              scale="time"
              domain={[from, to]}
              ticks={x.ticks}
              tickFormatter={(v: number) => x.format(v)}
              tick={{ fontSize: 10 }}
              interval="preserveStartEnd"
              minTickGap={24}
              tickLine={false}
              axisLine={{ stroke: "var(--baseline)" }}
            />
            <YAxis
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
                const p = payload[0].payload as PriceStep;
                const rows: TooltipRow[] = [{ label: "Price", value: fmtPrice(p.usd), color: CSS_VAR.demand }];
                const discount = p.discount_pct > 0 ? `−${p.discount_pct}%${p.original_cents !== null ? ` (was ${fmtPrice(p.original_cents / 100)})` : ""}` : null;
                if (discount) rows.push({ label: "Discount", value: discount });
                if (p.carried) rows.push({ label: "Status", value: "no change since the last record" });
                return <TooltipPanel title={fmtDay(isoDay(p.t)) ?? undefined} rows={rows} />;
              }}
            />
            <Line
              type="stepAfter"
              dataKey="usd"
              stroke={CSS_VAR.demand}
              strokeWidth={2}
              dot={renderDot}
              activeDot={{ r: 4, fill: CSS_VAR.demand, stroke: "var(--surface-1)", strokeWidth: 2 }}
              isAnimationActive={false}
            />
            {zoom.selection && <ReferenceArea x1={zoom.selection.x1} x2={zoom.selection.x2} {...SELECTION_AREA_PROPS} />}
          </LineChart>
        </ResponsiveContainer>
      </ZoomFrame>
      <p className="mt-1.5 text-[11px] text-ink-muted">
        US store price. A dot is a recorded change; the line holds each price until the next one
        {asOfIso ? `, and runs to the latest data (${fmtDay(asOfIso)})` : ""}.
      </p>
    </div>
  );
}

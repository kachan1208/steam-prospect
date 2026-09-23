import type { ReactNode } from "react";

import { fmtPercentile, isFiniteNumber } from "../../lib/format";
import { glossary, type GlossaryKey } from "../../lib/glossary";
import { MetricTip, type MetricExplainProps } from "./InfoTip";
import { SentinelTag, sentinelTag, type Sentinel } from "./SentinelTag";

/** A single-value meter: filled track (0-100 scale) against a neutral, recessive rail.
 * 4px, square-cornered — the D/C/Q bars from the Niche Finder table and "Why 87.4" panel. */
export function Meter({ value, max = 100, color }: { value: number | null; max?: number; color: string }) {
  const pct = value === null ? 0 : Math.max(0, Math.min(100, (value / max) * 100));
  return (
    <span className="block h-1 w-full overflow-hidden bg-line-grid">
      <span className="block h-full" style={{ width: `${pct}%`, backgroundColor: color }} />
    </span>
  );
}

/**
 * A bullet-style meter: filled bar to `value` (fraction 0-1) plus an optional reference tick.
 *
 * EXPLAINS ITSELF (2026-09-22): `term` / `info` / `help` / `worked` / `sentinel` add the
 * accessible ⓘ beside the label (components/ui/InfoTip), and the benchmark tick's label —
 * which used to live only in a hover `title` on a 2px sliver — is part of the bar's
 * accessible description and of the ⓘ. A value that is null or not finite draws a DASHED
 * empty rail instead of a solid one: an empty solid rail reads as 0%, which is a claim, not
 * an absence.
 */
export function BulletMeter({
  label,
  value,
  benchmark,
  benchmarkLabel,
  color,
  valueLabel,
  term,
  info,
  help,
  worked,
  sentinel,
}: {
  /** Visible label. Optional when `term` is given (the glossary label is used). */
  label?: string;
  value: number | null;
  benchmark?: number;
  benchmarkLabel?: string;
  color: string;
  valueLabel: string;
} & MetricExplainProps) {
  const shown = label ?? (term ? glossary(term).label : "");
  const known = isFiniteNumber(value);
  const pct = known ? Math.max(0, Math.min(100, value * 100)) : 0;
  const benchPct = benchmark === undefined ? undefined : Math.max(0, Math.min(100, benchmark * 100));
  const description = [`${shown}: ${known ? valueLabel : "no data"}`, benchmarkLabel ? `tick: ${benchmarkLabel}` : null]
    .filter(Boolean)
    .join("; ");
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between gap-2 text-xs">
        <span className="flex min-w-0 items-center gap-1 text-ink-secondary">
          <span className="min-w-0">{shown}</span>
          <MetricTip
            label={shown}
            term={term}
            info={
              benchmarkLabel && !info?.notes
                ? { ...info, notes: joinNotes(term ? glossary(term).notes : undefined, `The tick marks ${benchmarkLabel}.`) }
                : info
            }
            help={help}
            worked={worked}
            sentinel={sentinel}
          />
        </span>
        <span className="flex shrink-0 items-center gap-1.5">
          {sentinel != null && <SentinelTag>{sentinelTag(sentinel)}</SentinelTag>}
          <span className="tabular font-medium text-ink-primary">{valueLabel}</span>
        </span>
      </div>
      <div
        role="img"
        aria-label={description}
        className={known ? "relative h-1.5 bg-line-grid" : "relative h-1.5 border border-dashed border-chartborder"}
        data-empty={known ? undefined : ""}
      >
        {known && <div className="h-full" style={{ width: `${pct}%`, backgroundColor: color }} />}
        {benchPct !== undefined && (
          <div
            className="absolute -top-[3px] h-[12px] w-[2px] bg-ink-primary"
            style={{ left: `calc(${benchPct}% - 1px)` }}
            title={benchmarkLabel}
          />
        )}
      </div>
    </div>
  );
}

function joinNotes(a: ReactNode | undefined, b: string): ReactNode {
  return a ? (
    <>
      {a} {b}
    </>
  ) : (
    b
  );
}

/**
 * A percentile-RANK meter (0–100 input, e.g. mart_game.rev_pct_in_genre) — BulletMeter with
 * the rank's own rules built in, so no page re-derives them:
 *   - the value label goes through fmtPercentile(): floored, never "P100" for a 99.6, and the
 *     ends worded ("top 1%", "bottom 1%");
 *   - the median tick at 50 is labelled with the peer group;
 *   - the ⓘ defaults to the glossary's `percentile_vs_genre` entry and works the row's own
 *     rank through it ("beats 73.4% of Action games with 50+ reviews → P73");
 *   - a missing rank is flagged ("not ranked"), never drawn as an empty bar.
 */
export function PercentileMeter({
  label,
  percentile,
  peers = "its genre peers",
  color,
  term = "percentile_vs_genre",
  worked,
  sentinel,
  info,
}: {
  label: string;
  /** Percentile rank on a 0–100 scale. */
  percentile: number | null | undefined;
  /** Who the rank is against, for the tick label and the worked line, e.g. "Action games
   * with 50+ reviews". */
  peers?: string;
  color: string;
  term?: GlossaryKey;
  worked?: ReactNode;
  sentinel?: Sentinel;
  info?: MetricExplainProps["info"];
}) {
  const known = isFiniteNumber(percentile);
  const p = known ? Math.min(100, Math.max(0, percentile)) : null;
  return (
    <BulletMeter
      label={label}
      value={p === null ? null : p / 100}
      benchmark={0.5}
      benchmarkLabel={`the median of ${peers} (P50)`}
      color={color}
      valueLabel={fmtPercentile(percentile)}
      term={term}
      info={{ label: `${label} — rank vs ${peers}`, ...info }}
      worked={worked ?? (p === null ? undefined : `beats ${p.toFixed(1)}% of ${peers} → ${fmtPercentile(p)}`)}
      sentinel={sentinel ?? (p === null ? "not ranked" : undefined)}
    />
  );
}

import { useId } from "react";
import clsx from "clsx";

import { CSS_VAR } from "../lib/palette";
import { fmtMultiplier, opportunityBreakdown, PART_NEUTRAL, type OpportunityInputs, type OpportunityPart } from "../lib/opportunity";
import { InfoTip } from "./ui/InfoTip";
import { SentinelTag } from "./ui/SentinelTag";
import { TableScroll } from "./ui/TableScroll";

/**
 * THE OPPORTUNITY SCORE WITH ITS PARTS (2026-09-22) — replaces the dead OpportunityBars,
 * which drew the retired v1 demand / competition / quality trio.
 *
 * The owner's rules, in the order the component applies them:
 *   1. bearish reading first — the headline names what holds the score back (the supply
 *      brake and why, or the parts below neutral) before anything else is shown;
 *   2. never a lone score — each part's value, its weight, the points it adds, the
 *      multiplier, then the score, as the sum the mart actually computes;
 *   3. every number explains itself — an ⓘ per part with the glossary definition and this
 *      row's own numbers worked through the formula (shown only when they reproduce the
 *      served value — see lib/opportunity.ts), and sentinels ("not scored", "capped at
 *      100", "unknown → ×1.00") flagged in place, never bare.
 *
 * Takes any /api/niches row (NicheRow) or niche-detail variant as-is:
 *
 *   <OpportunityBreakdown row={activeVariant} />                  // niche page
 *   <OpportunityBreakdown row={row} variant="compact" />          // a Finder row
 */
export function OpportunityBreakdown({
  row,
  variant = "full",
  title = "Opportunity breakdown",
  className,
}: {
  row: OpportunityInputs;
  variant?: "full" | "compact";
  title?: string;
  className?: string;
}) {
  const m = opportunityBreakdown(row);
  return variant === "compact" ? (
    <CompactBreakdown m={m} title={title} className={className} />
  ) : (
    <FullBreakdown m={m} title={title} className={className} />
  );
}

type Model = ReturnType<typeof opportunityBreakdown>;

const f1 = (v: number | null) => (v === null ? "—" : v.toFixed(1));

function mismatchNote(m: Model): string | undefined {
  if (m.reproduces !== false || m.score === null || m.recomputed === null) return undefined;
  return `These parts give ${m.recomputed.toFixed(2)}, but the served score is ${m.score.toFixed(2)} — a weight or constant here no longer matches the data build. Trust neither number until it's checked.`;
}

/** A 0–100 part on a small rail with the neutral 50 marked; a missing part is a dashed rail. */
function PartBar({ value }: { value: number | null }) {
  const known = value !== null;
  return (
    <span
      aria-hidden
      className={clsx("relative inline-block h-1.5 w-16 align-middle", known ? "bg-line-grid" : "border border-dashed border-chartborder")}
    >
      {known && (
        <span className="absolute inset-y-0 left-0" style={{ width: `${Math.max(0, Math.min(100, value))}%`, backgroundColor: CSS_VAR.demand }} />
      )}
      <span className="absolute -top-[2px] h-[10px] w-px bg-ink-primary/60" style={{ left: `${PART_NEUTRAL}%` }} />
    </span>
  );
}

function roomsDetail(m: Model): string | null {
  const reads = [
    m.floodRoom !== null ? `Flood room ${m.floodRoom.toFixed(1)} (releases vs demand)` : null,
    m.entrantRoom !== null ? `Entrant room ${m.entrantRoom.toFixed(1)} (newcomer earnings)` : null,
  ].filter((s): s is string => s !== null);
  if (m.supplyRoom === null || reads.length === 0) return null;
  return `${reads.join(" · ")} → Supply room = the weaker, ${m.supplyRoom.toFixed(1)}`;
}

function FullBreakdown({ m, title, className }: { m: Model; title: string; className?: string }) {
  const titleId = useId();
  const mismatch = mismatchNote(m);
  const missing = m.parts.filter((p) => p.value === null);
  return (
    <section aria-labelledby={titleId} className={clsx("flex flex-col gap-2.5", className)} data-testid="opportunity-breakdown">
      <div className="flex items-center gap-1.5">
        <h3 id={titleId} className="kicker text-[12px] text-ink-primary">
          {title}
        </h3>
        <InfoTip term="opportunity_v2" worked={m.scoreWorked ?? undefined} sentinel={mismatch} />
      </div>
      {/* Bearish reading first: the drag, before the table that adds it up. */}
      <p className="text-[13px] leading-relaxed text-ink-primary" data-testid="opportunity-headline">
        {m.headline}
      </p>
      {m.available && (
        <TableScroll>
          <table className="w-full min-w-[320px] border-collapse text-[12px]">
            <caption className="sr-only">How this niche's Opportunity score adds up</caption>
            <thead>
              <tr className="border-b border-chartborder text-ink-muted">
                <th scope="col" className="kicker py-1 pr-3 text-left text-[10px] font-semibold">
                  Part
                </th>
                <th scope="col" className="kicker py-1 pr-3 text-left text-[10px] font-semibold">
                  Score (0–100, 50 = neutral)
                </th>
                <th scope="col" className="kicker py-1 pr-3 text-right text-[10px] font-semibold">
                  Weight
                </th>
                <th scope="col" className="kicker py-1 text-right text-[10px] font-semibold">
                  Points
                </th>
              </tr>
            </thead>
            <tbody>
              {m.parts.map((p) => (
                <PartRow key={p.key} p={p} />
              ))}
            </tbody>
            <tfoot className="text-ink-primary">
              <tr className="border-t border-chartborder">
                <th scope="row" className="py-1.5 pr-3 text-left font-normal text-ink-secondary">
                  Core — weighted mean of the parts
                </th>
                <td className="py-1.5 pr-3" />
                <td className="py-1.5 pr-3" />
                <td className="tabular py-1.5 text-right">{f1(m.core)}</td>
              </tr>
              <tr>
                <th scope="row" className="py-1.5 pr-3 text-left font-normal text-ink-secondary">
                  <span className="inline-flex items-center gap-1">
                    × Supply brake
                    <InfoTip term="supply_brake" worked={m.brakeWorked ?? undefined} sentinel={m.brakeSentinel?.detail}>
                      {roomsDetail(m) && <div className="tabular text-ink-primary">{roomsDetail(m)}</div>}
                    </InfoTip>
                  </span>
                </th>
                <td className="py-1.5 pr-3" colSpan={2}>
                  {m.brakeSentinel ? (
                    <SentinelTag>{m.brakeSentinel.tag}</SentinelTag>
                  ) : m.binding ? (
                    <span className="text-[11px] text-ink-muted">
                      set by {m.binding === "flood" ? "releases vs demand" : "newcomer earnings"}
                    </span>
                  ) : null}
                </td>
                <td className="tabular py-1.5 text-right" style={{ color: m.brake !== null && m.brake < 1 ? CSS_VAR.textPrimary : undefined }}>
                  {m.brake === null ? "—" : `×${m.brake.toFixed(2)}`}
                </td>
              </tr>
              <tr className="border-t border-chartborder">
                <th scope="row" className="py-1.5 pr-3 text-left font-semibold">
                  <span className="inline-flex items-center gap-1">
                    = Opportunity score
                    <InfoTip term="opportunity_v2" ariaLabel="About the Opportunity score total" worked={m.scoreWorked ?? undefined} sentinel={mismatch} />
                  </span>
                </th>
                <td className="py-1.5 pr-3" colSpan={2}>
                  {mismatch && <SentinelTag>doesn't add up</SentinelTag>}
                </td>
                <td className="tabular py-1.5 text-right text-[14px] font-semibold">{f1(m.score)}</td>
              </tr>
            </tfoot>
          </table>
        </TableScroll>
      )}
      {m.renormalised && (
        <p className="text-[11px] text-ink-muted">
          {missing.map((p) => p.label).join(" and ")} {missing.length === 1 ? "wasn't" : "weren't"} scored, so the other
          weights are rescaled to sum to 1 (each ÷ {m.weightTotal.toFixed(2)}) — a missing part never counts as 0.
        </p>
      )}
    </section>
  );
}

function PartRow({ p }: { p: OpportunityPart }) {
  return (
    <tr className="border-b border-chartborder/50 last:border-b-0">
      <th scope="row" className="py-1.5 pr-3 text-left font-normal text-ink-secondary">
        <span className="inline-flex items-center gap-1">
          {p.label}
          <InfoTip term={p.key} worked={p.worked ?? undefined} sentinel={p.sentinel?.detail} />
        </span>
      </th>
      <td className="py-1.5 pr-3">
        <span className="inline-flex items-center gap-2">
          <span className="tabular w-10 text-ink-primary">{f1(p.value)}</span>
          <PartBar value={p.value} />
          {p.sentinel && <SentinelTag>{p.sentinel.tag}</SentinelTag>}
        </span>
      </td>
      <td className="tabular py-1.5 pr-3 text-right text-ink-secondary">
        {p.effectiveWeight === null ? "—" : `× ${p.effectiveWeight.toFixed(2)}`}
      </td>
      <td className="tabular py-1.5 text-right text-ink-primary">{f1(p.contribution)}</td>
    </tr>
  );
}

function CompactBreakdown({ m, title, className }: { m: Model; title: string; className?: string }) {
  const mismatch = mismatchNote(m);
  if (!m.available) {
    return (
      <span className={clsx("inline-flex items-center gap-1.5 text-ink-secondary", className)} data-testid="opportunity-breakdown-compact">
        <span className="tabular">{f1(m.score)}</span>
        <SentinelTag>no parts</SentinelTag>
      </span>
    );
  }
  const summary = [
    `Opportunity score ${f1(m.score)}`,
    ...m.parts.map((p) => `${p.label} ${p.value === null ? "not scored" : p.value.toFixed(1)}`),
    `supply brake ×${m.brake === null ? "—" : m.brake.toFixed(2)}`,
  ].join(", ");
  return (
    <span className={clsx("inline-flex items-center gap-2", className)} data-testid="opportunity-breakdown-compact">
      <span className="sr-only">{summary}</span>
      <span aria-hidden className="flex h-3.5 items-end gap-[3px]">
        {m.parts.map((p) => (
          <span
            key={p.key}
            className={clsx("relative block h-full w-[5px]", p.value === null ? "border border-dashed border-chartborder" : "bg-line-grid")}
          >
            {p.value !== null && (
              <span className="absolute inset-x-0 bottom-0" style={{ height: `${Math.max(0, Math.min(100, p.value))}%`, backgroundColor: CSS_VAR.demand }} />
            )}
          </span>
        ))}
      </span>
      <span aria-hidden className="tabular text-[11px] text-ink-muted">
        ×{m.brake === null ? "—" : m.brake.toFixed(2)}
      </span>
      <span aria-hidden className="tabular text-ink-primary">
        {f1(m.score)}
      </span>
      <InfoTip label={title} meaning={m.headline} worked={m.scoreWorked ?? undefined} sentinel={mismatch}>
        <div className="tabular flex flex-col text-ink-primary">
          {m.parts.map((p) => (
            <span key={p.key}>
              {p.label}{" "}
              {p.value === null
                ? `— ${p.sentinel?.tag ?? "not scored"}`
                : `${p.value.toFixed(1)} × ${(p.effectiveWeight ?? 0).toFixed(2)} = ${(p.contribution ?? 0).toFixed(1)}`}
            </span>
          ))}
          <span>
            × Supply brake {m.brake === null ? "—" : fmtMultiplier(m.brake)}
            {m.brakeSentinel ? ` (${m.brakeSentinel.tag})` : ""}
          </span>
        </div>
      </InfoTip>
    </span>
  );
}

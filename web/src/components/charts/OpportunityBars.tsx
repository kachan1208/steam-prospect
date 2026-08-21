import { CSS_VAR } from "../../lib/palette";

// Fixed order used everywhere in the app — mono steel, not hue (design_handoff
// README, 4a/4b: demand and quality_gap fill accent-300, competition fills paper 50%,
// because both demand and quality_gap read as "good for the opportunity score" while
// competition is the downside/crowding term). Never reassigned or cycled per-row.
const METERS: { key: "demand" | "competition" | "quality_gap"; label: string; short: string; color: string }[] = [
  { key: "demand", label: "Demand", short: "D", color: CSS_VAR.demand },
  { key: "competition", label: "Competition", short: "C", color: CSS_VAR.competition },
  { key: "quality_gap", label: "Quality gap", short: "Q", color: CSS_VAR.qualityGap },
];

/** Inline 0-100 meter trio for a niche row: demand / competition / quality_gap. */
export function OpportunityBars({
  demand,
  competition,
  quality_gap,
}: {
  demand: number | null;
  competition: number | null;
  quality_gap: number | null;
}) {
  const values: Record<string, number | null> = { demand, competition, quality_gap };
  return (
    <div className="flex w-28 flex-col gap-1">
      {METERS.map((m) => {
        const raw = values[m.key];
        const pct = raw === null ? 0 : Math.max(0, Math.min(100, raw));
        return (
          <div
            key={m.key}
            className="flex items-center gap-1.5"
            title={`${m.label}: ${raw !== null ? raw.toFixed(1) : "no data"}`}
          >
            <span className="w-2.5 shrink-0 text-[9px] font-semibold text-ink-muted">{m.short}</span>
            <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-line-grid">
              <span className="block h-full rounded-full" style={{ width: `${pct}%`, backgroundColor: m.color }} />
            </span>
          </div>
        );
      })}
    </div>
  );
}

export const OPPORTUNITY_LEGEND = METERS.map((m) => ({ label: m.label, color: m.color }));

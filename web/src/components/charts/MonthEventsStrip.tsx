import { monthName } from "../../lib/format";

/**
 * Steam's recurring storefront events, as a strip under a Jan..Dec month axis (2026-09-23).
 *
 * The timing charts showed November and December as the best months to launch without a
 * word about WHY players buy then: those are Steam's Autumn and Winter Sale months, when the
 * storefront is flooded with discounted back-catalog hits. A launch there competes with every
 * sale at once, and shoppers expect a discount. The strip puts those windows on the same
 * axis as the bars, so the demand spike and the sale that drives it are read together.
 *
 * STATIC AND APPROXIMATE, and it says so: Valve sets the dates each year and has moved them,
 * so these are the months the events have usually fallen in, at month resolution — a
 * reason to check the Steamworks calendar, not a substitute for it.
 */

export interface SteamEvent {
  key: string;
  label: string;
  /** Calendar months (1..12) the event usually touches. */
  months: readonly number[];
  /** When it usually runs, in words. */
  when: string;
  kind: "fest" | "sale";
}

export const STEAM_EVENTS: readonly SteamEvent[] = [
  { key: "nextfest", label: "Steam Next Fest", months: [2, 6, 10], when: "a week each in Feb, Jun and Oct", kind: "fest" },
  { key: "spring", label: "Spring Sale", months: [3], when: "mid-to-late March", kind: "sale" },
  { key: "summer", label: "Summer Sale", months: [6, 7], when: "late June into early July", kind: "sale" },
  { key: "autumn", label: "Autumn Sale", months: [11], when: "late November in most years", kind: "sale" },
  { key: "winter", label: "Winter Sale", months: [12, 1], when: "late December into early January", kind: "sale" },
];

/** The events touching a month (1..12). */
export function eventsIn(month: number): SteamEvent[] {
  return STEAM_EVENTS.filter((e) => e.months.includes(month));
}

/** The sale events among the given months, for a caveat line. */
export function salesIn(months: readonly number[]): SteamEvent[] {
  return STEAM_EVENTS.filter((e) => e.kind === "sale" && e.months.some((m) => months.includes(m)));
}

const MONTHS = Array.from({ length: 12 }, (_, i) => i + 1);

/**
 * Two rows under the chart — "Next Fest" markers and "Sale" bands — in twelve columns that
 * share the plot's gutters (`left` = the y-axis width, `right` = the chart's right margin),
 * so each mark sits under its month's bar. A legend line names every event and when it
 * usually runs; the words carry the meaning, the marks only place it.
 */
export function MonthEventsStrip({
  left,
  right,
  legend = "full",
}: {
  left: number;
  right: number;
  /** "full" names every event and when it runs; "compact" (for a page's second and later
   * month charts) just keys the marks — the full key is already on the page once. */
  legend?: "full" | "compact";
}) {
  const rows: { kind: SteamEvent["kind"]; label: string }[] = [
    { kind: "fest", label: "Fest" },
    { kind: "sale", label: "Sale" },
  ];
  return (
    <div className="mt-1.5" data-testid="steam-events">
      {rows.map((row) => (
        <div key={row.kind} className="flex items-center" style={{ height: 14 }}>
          <span
            className="shrink-0 pr-1.5 text-right text-[9px] uppercase tracking-[0.06em] text-ink-muted"
            style={{ width: left }}
          >
            {row.label}
          </span>
          <div className="grid flex-1 grid-cols-12" style={{ marginRight: right }}>
            {MONTHS.map((m) => {
              const hit = eventsIn(m).filter((e) => e.kind === row.kind);
              const title = hit.length > 0 ? `${monthName(m)}: ${hit.map((e) => e.label).join(", ")} (approximate)` : undefined;
              return (
                <span key={m} className="flex h-full items-center justify-center" title={title}>
                  {hit.length > 0 &&
                    (row.kind === "fest" ? (
                      <span
                        aria-hidden
                        className="block h-2 w-2 rotate-45 border border-ink-secondary"
                        data-event={`fest-${m}`}
                      />
                    ) : (
                      <span
                        aria-hidden
                        className="block h-1.5 w-full"
                        style={{ backgroundColor: "var(--text-muted)", opacity: 0.55 }}
                        data-event={`sale-${m}`}
                      />
                    ))}
                </span>
              );
            })}
          </div>
        </div>
      ))}
      {legend === "full" ? (
        <p className="mt-1 text-[10px] leading-snug text-ink-muted" style={{ paddingLeft: left }}>
          <span className="text-ink-secondary">Steam events, approximate:</span>{" "}
          {STEAM_EVENTS.map((e, i) => (
            <span key={e.key}>
              {i > 0 && " · "}
              {e.label} ({e.when})
            </span>
          ))}
          . Valve sets the dates each year and has moved them — check the Steamworks calendar before you pick a day.
        </p>
      ) : (
        <p className="mt-1 text-[10px] leading-snug text-ink-muted" style={{ paddingLeft: left }}>
          Steam events, approximate: ◇ Next Fest · ▬ seasonal sale (Spring, Summer, Autumn, Winter).
        </p>
      )}
    </div>
  );
}

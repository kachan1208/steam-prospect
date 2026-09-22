import { useState } from "react";
import clsx from "clsx";

import { useDataAge, STALE_AFTER_HOURS, type DataAgeInfo } from "../lib/dataAge";
// The glossary-free core: this component lives in the app shell (the entry chunk), and the
// glossary it doesn't use would otherwise ride along on every first paint.
import { InfoTipBase as InfoTip } from "./ui/InfoTipBase";
import { SentinelTag } from "./ui/SentinelTag";

/**
 * The shell's data-freshness readout and stale-data warning (2026-09-22) — see
 * lib/dataAge.ts for how the age is derived from /api/health.
 *
 *   <DataAge />        footer line: "API connected · Data as of Sep 21, 2026 · 1 day old" + ⓘ
 *   <DataAgeBanner />  a dismissible warning once the data is older than STALE_AFTER_HOURS
 *
 * Neither states a refresh SCHEDULE: a clock time in the copy is only true for one
 * deployment, and the age is what a reader actually needs to know.
 */

const API_LABEL: Record<DataAgeInfo["apiState"], string> = {
  checking: "Checking API…",
  unreachable: "API unreachable",
  ok: "API connected",
  degraded: "API degraded",
};

function dotColor(age: DataAgeInfo): string {
  if (age.apiState === "checking") return "var(--text-muted)";
  if (age.apiState !== "ok") return "var(--status-critical)";
  return age.stale ? "var(--status-warning)" : "var(--status-good)";
}

export function DataAge({ className }: { className?: string }) {
  const age = useDataAge();
  const live = age.apiState === "ok" || age.apiState === "degraded";
  const details = [
    age.asOfLabel ? `Data as of ${age.asOfLabel}${age.ageLabel ? ` — ${age.ageLabel}` : ""}` : null,
    age.builtAt ? `Built ${age.builtAt}` : null,
    age.martVersion ? `Data build (mart) ${age.martVersion}` : null,
    age.martBehind ? `A newer build (${age.targetMartVersion}) is ready but not loaded yet` : null,
    age.ownersAsOfLabel ? `Owners figures: SteamSpy snapshot of ${age.ownersAsOfLabel}` : null,
  ].filter((l): l is string => l !== null);

  return (
    <div className={clsx("flex min-w-0 items-center gap-2 text-[11px] text-ink-muted", className)} data-testid="data-age">
      <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: dotColor(age) }} />
      <span className="min-w-0">
        {API_LABEL[age.apiState]}
        {live &&
          (age.asOfLabel ? (
            <>
              {" · "}Data as of {age.asOfLabel}
              {age.ageLabel && (
                <>
                  {" · "}
                  <span className={age.stale ? "text-ink-primary" : undefined}>{age.ageLabel}</span>
                </>
              )}
            </>
          ) : (
            <>
              {" · "}
              <SentinelTag>data date unknown</SentinelTag>
            </>
          ))}
      </span>
      {live && (
        <InfoTip
          label="Data freshness"
          meaning="How old the numbers on every page are: when the data now being served was built, and how long ago that was. A scheduled refresh rebuilds it; if refreshes stop, this age keeps growing, and past three days every page shows a warning."
          workedLabel="This build"
          worked={
            details.length > 0 ? (
              <span className="flex flex-col">
                {details.map((d) => (
                  <span key={d}>{d}</span>
                ))}
              </span>
            ) : undefined
          }
          sentinel={age.asOfLabel ? undefined : "The API didn't report when its data was built."}
          source="/api/health"
        />
      )}
    </div>
  );
}

const DISMISS_KEY = "prospect.dataAgeBanner.dismissedFor";

function readSession(key: string): string | null {
  try {
    return window.sessionStorage.getItem(key);
  } catch {
    return null; // storage blocked (private mode, sandboxed frame): just don't remember
  }
}

function writeSession(key: string, value: string): void {
  try {
    window.sessionStorage.setItem(key, value);
  } catch {
    // Same: the in-memory state below still hides the banner for this page's life.
  }
}

/**
 * The stale-data warning. Renders nothing while the data is fresh (or its age unknown).
 * Dismissal lasts for the browser SESSION and is keyed to the build it was dismissed for,
 * so a later build that goes stale in turn warns again.
 */
export function DataAgeBanner({ className }: { className?: string }) {
  const age = useDataAge();
  const token = age.asOf?.toISOString() ?? (age.martVersion ? `mart:${age.martVersion}` : "unknown");
  const [dismissedFor, setDismissedFor] = useState<string | null>(() => readSession(DISMISS_KEY));

  if (!age.stale || dismissedFor === token) return null;
  const days = age.ageDays ?? Math.floor(STALE_AFTER_HOURS / 24);

  return (
    <div
      role="status"
      data-testid="data-age-banner"
      className={clsx(
        "flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border px-3 py-2 text-[12px] text-ink-primary",
        className,
      )}
      style={{ borderColor: "var(--status-warning)" }}
    >
      <p className="min-w-0">
        <span className="kicker mr-2 text-[11px]" style={{ color: "var(--status-warning)" }}>
          Stale data
        </span>{" "}
        Data hasn't refreshed in {days} days
        {age.asOfLabel ? <> — numbers are as of {age.asOfLabel}.</> : "."}
      </p>
      <button
        type="button"
        onClick={() => {
          writeSession(DISMISS_KEY, token);
          setDismissedFor(token);
        }}
        className="shrink-0 border border-borderstrong px-2.5 py-1 text-[11px] font-medium text-ink-primary transition-colors hover:bg-surface2"
      >
        Dismiss
      </button>
    </div>
  );
}

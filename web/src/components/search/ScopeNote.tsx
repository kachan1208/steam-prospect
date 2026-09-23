import type { ReactNode } from "react";

import type { Scope } from "../../lib/api";
import { fmtInt } from "../../lib/format";
import { InfoTip } from "../ui/InfoTip";
import { SentinelTag } from "../ui/SentinelTag";

/**
 * The one line under a search page's filter row that says WHICH population the results are
 * drawn from (2026-09-23).
 *
 * /games opened on Counter-Strike and Dota 2 and /studios on EA, Bandai Namco and Ubisoft —
 * useless comparables for a solo developer — so both pages now default to the indie scope.
 * A default that narrows the data has to say so where the results are, and has to COUNT
 * what it leaves out: under scope=indie the API excludes every row whose indie flag is
 * unknown (unknown is not indie) and returns how many that was (`n_scope_unknown`), which
 * is printed here rather than silently dropped.
 *
 * `applied` is the scope the API ECHOED, not the one the page asked for: an API that
 * predates scopes ignores the parameter and serves everything, and the note must not claim
 * a filter that wasn't applied.
 */
export function ScopeNote({
  requested,
  applied,
  unknown,
  noun,
  definition,
  formula,
}: {
  /** What the page asked for. */
  requested: Scope;
  /** What the API says it applied (undefined = an API without scopes: everything). */
  applied: Scope | undefined;
  /** Rows left out because their indie flag is unknown (scope=indie only). */
  unknown: number | null | undefined;
  /** Plural noun: "games", "publishers", "developers". */
  noun: string;
  /** What "indie" means for this noun — the ⓘ's meaning. */
  definition: ReactNode;
  /** The exact rule the API applies. */
  formula: ReactNode;
}) {
  const effective: Scope = applied ?? "all";
  const tip = (
    <InfoTip
      label="Indie scope"
      meaning={definition}
      formula={formula}
      notes={`“All ${noun}” removes the filter — big studios and publishers included.`}
      source="Steam's own Indie genre flag, set by the developer on the store page"
    />
  );

  if (requested === "indie" && applied === undefined) {
    return (
      <p className="flex flex-wrap items-center gap-1.5 text-xs text-ink-muted" data-testid="scope-note">
        <SentinelTag>indie filter unavailable</SentinelTag>
        This API version doesn&apos;t filter by the indie flag — showing all {noun}.
      </p>
    );
  }

  if (effective === "all") {
    return (
      <p className="flex flex-wrap items-center gap-1.5 text-xs text-ink-muted" data-testid="scope-note">
        Showing <span className="text-ink-secondary">all {noun}</span> — the biggest studios and publishers
        included. {tip}
      </p>
    );
  }

  return (
    <p className="flex flex-wrap items-center gap-1.5 text-xs text-ink-muted" data-testid="scope-note">
      Showing <span className="text-ink-secondary">indie {noun} only</span>
      {tip}
      {unknown != null && unknown > 0 && (
        <>
          <span aria-hidden>·</span>
          <span>
            {unknown === 1
              ? `1 ${noun.replace(/s$/, "")} with no indie flag yet isn't counted`
              : `${fmtInt(unknown)} ${noun} with no indie flag yet aren't counted`}
          </span>
        </>
      )}
    </p>
  );
}

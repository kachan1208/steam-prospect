import type { ReactNode } from "react";

import type { GlossaryKey } from "../lib/glossary";
import type { OpportunityInputs } from "../lib/opportunity";
import { OpportunityBreakdown } from "./OpportunityBreakdown";
import { InfoTip } from "./ui/InfoTip";

/**
 * The Radar's glossary-backed explanations, in their OWN chunk (2026-09-23).
 *
 * The Radar is the eagerly loaded index route, and the ⓘ that explains a metric in place
 * reads lib/glossary.ts — ~25KB of definitions that the entry chunk deliberately does not
 * carry (see components/ui/InfoTipBase). RadarBoard loads this module with React.lazy, so the
 * glossary arrives right after first paint instead of with it; the board renders a same-size
 * placeholder until then, so nothing shifts when the ⓘ appears.
 */

/** A glossary ⓘ with the row's own worked numbers. */
export function TermInfo({
  term,
  worked,
  sentinel,
  label,
  ariaLabel,
  notes,
}: {
  term: GlossaryKey;
  worked?: ReactNode;
  sentinel?: ReactNode;
  label?: string;
  ariaLabel?: string;
  notes?: ReactNode;
}) {
  return (
    <InfoTip
      term={term}
      label={label}
      worked={worked ?? undefined}
      sentinel={sentinel ?? undefined}
      ariaLabel={ariaLabel}
      notes={notes}
    />
  );
}

/** The Opportunity score with its parts — the dossier's footer, compact. */
export function RadarOpportunity({ row }: { row: OpportunityInputs }) {
  return <OpportunityBreakdown row={row} variant="compact" title="Opportunity score" />;
}

export default TermInfo;

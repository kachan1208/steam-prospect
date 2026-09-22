import type { ReactNode } from "react";

import { glossary, type GlossaryKey } from "../../lib/glossary";
import { InfoTipBase, type InfoTipBaseProps, type InfoTipContent } from "./InfoTipBase";
import { sentinelDetail, type Sentinel } from "./SentinelTag";

/**
 * <InfoTip> — the accessible ⓘ (see ./InfoTipBase for the interaction and placement
 * contract) plus the glossary: pass `term` and the label, meaning, formula, notes and
 * source come from lib/glossary.ts; explicit props override them field by field; the page
 * adds only what it alone knows — the row's `worked` numbers and a `sentinel`.
 *
 *   <InfoTip term="saturation_yoy" worked="(176 − 190) ÷ 190 = −7.4%" />
 *
 * The shared metric primitives (KpiCell, StatTile, BulletMeter, PercentileMeter,
 * HeaderLabel) take the same explanation through MetricExplainProps below.
 */

export {
  INFOTIP_CLOSE_DELAY,
  INFOTIP_OPEN_DELAY,
  InfoTipBase,
  InfoTipBody,
  TIP_GAP,
  TIP_MARGIN,
  computeTipPosition,
} from "./InfoTipBase";
export type { InfoTipBaseProps, InfoTipContent, TipPosition, TipRect, TipSize } from "./InfoTipBase";

export interface InfoTipProps extends InfoTipBaseProps {
  /** Glossary key: fills label / meaning / formula / notes / source. Explicit props win. */
  term?: GlossaryKey;
  /** Drop the glossary's notes paragraph (tight contexts). */
  hideNotes?: boolean;
}

/** Resolve the panel content from a glossary term plus explicit overrides; null when there
 * is no label or no meaning to show. */
export function resolveInfoTip(
  props: Pick<InfoTipProps, keyof InfoTipContent | "term" | "hideNotes">,
): InfoTipContent | null {
  const entry = props.term ? glossary(props.term) : undefined;
  const label = props.label ?? entry?.label;
  const meaning = props.meaning ?? entry?.meaning;
  if (!label || meaning == null) return null;
  return {
    label,
    meaning,
    formula: props.formula ?? entry?.formula,
    worked: props.worked,
    sentinel: props.sentinel,
    source: props.source ?? entry?.source,
    notes: props.hideNotes ? undefined : props.notes ?? entry?.notes,
  };
}

export function InfoTip({ term, hideNotes, ...rest }: InfoTipProps) {
  const content = resolveInfoTip({ ...rest, term, hideNotes });
  if (!content) return null;
  return <InfoTipBase {...rest} {...content} />;
}

/**
 * The explanation props every shared metric primitive takes (KpiCell, StatTile, BulletMeter,
 * PercentileMeter, HeaderLabel) — so a page adopts the ⓘ by passing a glossary key and,
 * where it has them, the row's worked numbers and a sentinel:
 *
 *   <KpiCell term="saturation_yoy" value="−7.4%" worked="(176 − 190) ÷ 190 = −7.4%" />
 */
export interface MetricExplainProps {
  /** Glossary key — the explanation (and, when no `label` is given, the label) comes from
   * lib/glossary. */
  term?: GlossaryKey;
  /** Field-by-field overrides of the explanation. */
  info?: Partial<InfoTipContent>;
  /** Plain-language help string (the pre-glossary API) — becomes the explanation's meaning. */
  help?: string;
  /** This row's real numbers substituted into the formula. Needs a meaning to hang on
   * (`term`, `help` or `info.meaning`). */
  worked?: ReactNode;
  /** Marks the value as a sentinel: a tag beside it, the detail inside the ⓘ. */
  sentinel?: Sentinel;
}

/** True when a primitive was given anything to explain. */
export function hasExplanation(p: MetricExplainProps): boolean {
  return p.term !== undefined || p.info !== undefined || p.help !== undefined || p.worked != null || p.sentinel != null;
}

/** The ⓘ for a shared primitive. Heading: the explicit `info.label`, else the glossary's
 * canonical label, else the label the primitive shows. Renders nothing when there is
 * nothing to explain. */
export function MetricTip({
  label,
  term,
  info,
  help,
  worked,
  sentinel,
  className,
}: MetricExplainProps & { label?: string; className?: string }) {
  if (!hasExplanation({ term, info, help, worked, sentinel })) return null;
  const entry = term ? glossary(term) : undefined;
  const heading = info?.label ?? entry?.label ?? label;
  const meaning = info?.meaning ?? help ?? entry?.meaning ?? (sentinel != null ? "" : undefined);
  return (
    <InfoTip
      term={term}
      label={heading}
      meaning={meaning}
      formula={info?.formula}
      notes={info?.notes}
      source={info?.source}
      worked={worked ?? info?.worked}
      sentinel={sentinel != null ? sentinelDetail(sentinel) : info?.sentinel}
      className={className}
    />
  );
}

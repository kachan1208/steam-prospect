import clsx from "clsx";
import type { ReactNode } from "react";

const CONDENSED = '"Barlow Condensed", "Barlow", system-ui, sans-serif';

/**
 * One cell of a KPI strip: condensed uppercase label -> 38px condensed value -> footnote,
 * matching design_handoff §4b exactly. Not StatTile — that component's rounded tile
 * doesn't carry this grid's "gap colour IS the rule" layout or the 38px numeral.
 *
 * Lives here, not on the page that draws the most of them (2026-08-29): NicheDetail owned
 * it and NicheCombined imported it from there, which is a static page -> page import —
 * it pulled the whole 80K NicheDetail page, and through its charts all of recharts, into
 * the /niches/combined chunk for the sake of one 25-line presentational component.
 */
export function KpiCell({
  label,
  value,
  footnote,
  footnoteWrap,
  valueClassName,
}: {
  label: string;
  value: ReactNode;
  footnote?: ReactNode;
  /** Let the footnote wrap onto more lines instead of ellipsising at one. For footnotes that
   * carry a CAVEAT rather than a restatement — a truncated caveat is worse than none, because
   * the reader sees a confident half-sentence and never learns it was qualified. */
  footnoteWrap?: boolean;
  valueClassName?: string;
}) {
  return (
    <div className="bg-page px-5 py-4">
      <div className="kicker text-[11px] text-ink-primary/55">{label}</div>
      {/* Only one text-color utility ever applies: two same-specificity color classes race on
          Tailwind's generated-CSS order, not className string order, so the default has to be
          the FALLBACK (via ??), not a base class the override tries to beat. */}
      <div
        className={clsx("mt-1 truncate leading-none", valueClassName ?? "text-ink-primary")}
        style={{ fontFamily: CONDENSED, fontWeight: 600, fontSize: 38 }}
      >
        {value}
      </div>
      {footnote && (
        <div className={clsx("mt-1.5 text-[11px] text-ink-primary/55", footnoteWrap ? "text-balance" : "truncate")}>
          {footnote}
        </div>
      )}
    </div>
  );
}

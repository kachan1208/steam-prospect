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
      {/* NOT a clipping bug, though it measures like one: `truncate leading-none` reports
          scrollHeight 41 against clientHeight 38 here, and that 3px is the FONT METRIC box
          (Barlow Condensed at 38px declares ascent 37 + descent 8 = 45, so line-height:1
          leaves -3.5px half-leading), not ink. Canvas ink extents at this exact size, both
          in Barlow Condensed and in the fallback stack: `$` descends 2.69px below a baseline
          that sits 33.50px down, so it ends at 36.19 of 38 — 1.8px INSIDE the box. `87`
          reports the identical 41/38 with a 0.46px descent. Forcing the block axis visible
          changes zero pixels (verified by a 4x screenshot diff of a `$3.1K` tile: 0 of
          216,320 pixels differ), so leave it alone. Only a true lowercase descender would
          clip (inkBot 40.39 for "gjpqy") and no KPI formatter can emit one — every value
          here comes from fmtUsd/fmtInt/fmtPrice/fmtCompact/fmtPct/fmtSigned. */}
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

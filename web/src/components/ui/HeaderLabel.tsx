import type { CSSProperties } from "react";
import clsx from "clsx";

import { glossary } from "../../lib/glossary";
import { MetricTip, type MetricExplainProps } from "./InfoTip";

const CONDENSED = '"Barlow Condensed", "Barlow", system-ui, sans-serif';

/** The Niche Finder's column-header type: condensed, uppercase, 12px, wide-tracked. */
export const HEADER_LABEL_STYLE: CSSProperties = {
  fontFamily: CONDENSED,
  fontSize: 12,
  letterSpacing: ".08em",
  fontWeight: 600,
};

export interface HeaderSort<K extends string> {
  col: K;
  active: boolean;
  order: "asc" | "desc";
  onSort: (col: K) => void;
}

/**
 * A table column header that explains itself: the (optionally sortable) label plus the
 * accessible ⓘ from components/ui/InfoTip.
 *
 * Replaces the pattern NicheFinder's SortLabel carried — a sort button whose `title=`
 * held the column's whole explanation, readable only by hovering a mouse and never on
 * focus or on a phone. The sort control and the ⓘ are SIBLING buttons (a button inside a
 * button is invalid HTML and unreachable by keyboard), and the ⓘ swallows its own clicks,
 * so opening an explanation never re-sorts the table.
 *
 *   <HeaderLabel term="p90_rev" sort={{ col: "p90_rev", active, order, onSort }} />
 *
 * Label: `label`, else the glossary's column-header form (`short`). Style: the Finder's
 * header type by default; pass `style` / `className` to match another table's ramp.
 */
export function HeaderLabel<K extends string>({
  label,
  sort,
  className,
  style = HEADER_LABEL_STYLE,
  term,
  info,
  help,
  worked,
  sentinel,
}: {
  label?: string;
  sort?: HeaderSort<K>;
  className?: string;
  style?: CSSProperties;
} & MetricExplainProps) {
  const shown = label ?? (term ? glossary(term).short : "");
  const arrow = sort ? (sort.active ? (sort.order === "desc" ? "↓" : "↑") : "↕") : null;
  return (
    <span className={clsx("inline-flex items-center gap-1 whitespace-nowrap uppercase text-ink-muted", className)} style={style}>
      {sort ? (
        <button
          type="button"
          onClick={() => sort.onSort(sort.col)}
          title={`Sort by ${shown}`}
          className="group inline-flex items-center gap-1 uppercase transition-colors hover:text-ink-secondary"
        >
          {shown}
          <span
            aria-hidden
            className={clsx("text-[10px] leading-none", sort.active ? "opacity-100" : "opacity-0 group-hover:opacity-50")}
          >
            {arrow}
          </span>
        </button>
      ) : (
        <span>{shown}</span>
      )}
      <MetricTip label={shown} term={term} info={info} help={help} worked={worked} sentinel={sentinel} />
    </span>
  );
}

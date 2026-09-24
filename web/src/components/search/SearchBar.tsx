import type { ReactNode } from "react";
import { useRecordRecentSearch, type RecentScope } from "../../lib/recentSearches";
import { useRecentCombobox } from "./RecentSearches";

type SearchBarProps = {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  ariaLabel: string;
  /** Matches for the committed query — shown as "1,234 matches" once `loading` clears. */
  total: number;
  loading: boolean;
  /** Keep a per-browser list of this surface's recent searches and offer it when the box is
   * focused and empty (lib/recentSearches.ts). A query is recorded once it has been left
   * alone for a moment AND returned matches. */
  recentScope?: RecentScope;
};

/**
 * The large blueprint search field (mockup 4e): Lucide search glyph, accent caret, and the
 * match count right-aligned in muted ink. /games hand-rolled it and /studios had a small
 * boxed input in a Card; the two pages now open on the SAME control, so the count wording,
 * the glyph and the frame cannot drift. Native `type="search"` supplies the clear
 * affordance; "Clear all" in the chip row below it is the other route to an empty box.
 */
export function SearchBar(props: SearchBarProps) {
  // recentScope is fixed for a mounted bar, so this branch never flips a hook order.
  return props.recentScope ? <RecentSearchBar {...props} recentScope={props.recentScope} /> : <SearchFrame {...props} />;
}

function RecentSearchBar(props: SearchBarProps & { recentScope: RecentScope }) {
  const { recentScope, value, onChange, total, loading } = props;
  useRecordRecentSearch(recentScope, value, !loading && total > 0);
  const rc = useRecentCombobox({ scope: recentScope, value, onPick: onChange });
  return <SearchFrame {...props} wrapperProps={rc.wrapperProps} inputProps={rc.inputProps} dropdown={rc.dropdown} />;
}

function SearchFrame({
  value,
  onChange,
  placeholder,
  ariaLabel,
  total,
  loading,
  wrapperProps,
  inputProps,
  dropdown,
}: SearchBarProps & {
  wrapperProps?: ReturnType<typeof useRecentCombobox>["wrapperProps"];
  inputProps?: ReturnType<typeof useRecentCombobox>["inputProps"];
  dropdown?: ReactNode;
}) {
  return (
    <div className="relative" {...wrapperProps}>
      <div className="blueprint flex items-center gap-3 px-[18px] py-3" style={{ borderColor: "var(--border-strong)" }}>
        <i className="bp-corner" />
        <SearchIcon className="shrink-0 text-brand" />
        <input
          type="search"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          aria-label={ariaLabel}
          autoComplete="off"
          className="min-w-0 flex-1 bg-transparent text-[15px] text-ink-primary outline-none caret-brand placeholder:text-ink-muted"
          {...inputProps}
        />
        <span className="shrink-0 whitespace-nowrap text-xs text-ink-muted">
          {loading ? "…" : `${total.toLocaleString()} match${total === 1 ? "" : "es"}`}
        </span>
      </div>
      {dropdown}
    </div>
  );
}

/** Lucide "search" glyph (hand-inlined — the codebase doesn't depend on lucide-react), 1.5
 * stroke per the design system's icon rule. */
export function SearchIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <circle cx="11" cy="11" r="8" />
      <path d="m21 21-4.3-4.3" />
    </svg>
  );
}

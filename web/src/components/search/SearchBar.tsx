/**
 * The large blueprint search field (mockup 4e): Lucide search glyph, accent caret, and the
 * match count right-aligned in muted ink. /games hand-rolled it and /studios had a small
 * boxed input in a Card; the two pages now open on the SAME control, so the count wording,
 * the glyph and the frame cannot drift. Native `type="search"` supplies the clear
 * affordance; "Clear all" in the chip row below it is the other route to an empty box.
 */
export function SearchBar({
  value,
  onChange,
  placeholder,
  ariaLabel,
  total,
  loading,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  ariaLabel: string;
  /** Matches for the committed query — shown as "1,234 matches" once `loading` clears. */
  total: number;
  loading: boolean;
}) {
  return (
    <div className="blueprint flex items-center gap-3 px-[18px] py-3" style={{ borderColor: "var(--border-strong)" }}>
      <i className="bp-corner" />
      <SearchIcon className="shrink-0 text-brand" />
      <input
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={ariaLabel}
        className="min-w-0 flex-1 bg-transparent text-[15px] text-ink-primary outline-none caret-brand placeholder:text-ink-muted"
      />
      <span className="shrink-0 whitespace-nowrap text-xs text-ink-muted">
        {loading ? "…" : `${total.toLocaleString()} match${total === 1 ? "" : "es"}`}
      </span>
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

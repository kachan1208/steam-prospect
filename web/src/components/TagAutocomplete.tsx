import { useEffect, useRef, useState } from "react";
import clsx from "clsx";

import { useTagSuggest } from "../lib/api";
import { fmtInt } from "../lib/format";
import { useDebounced } from "../lib/useDebounced";

/**
 * Tag filter input with autocomplete over the real catalog tag universe
 * (GET /api/games/tags/suggest). Steam's tag taxonomy is case/hyphenation-sensitive
 * ("Rogue-like" vs "Roguelike" are different tags), so free-typing an exact string was a
 * guess-into-empty-results trap — this keeps the EXACT-match filter semantics but lets the
 * user pick the exact string from a ranked list. Selecting a suggestion (click or Enter)
 * commits it via onSelect and clears the draft; the committed tag lives in the page's
 * active-filter chips, not in this input. Enter with no highlighted suggestion commits the
 * raw trimmed text (escape hatch for tags the suggest list may miss).
 *
 * Keyboard: ArrowUp/Down move the highlight, Enter selects, Escape closes. Opens on focus
 * (empty query = the catalog's top tags, a discovery affordance).
 */
export function TagAutocomplete({ onSelect }: { onSelect: (tag: string) => void }) {
  const [draft, setDraft] = useState("");
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(-1);
  const rootRef = useRef<HTMLDivElement>(null);

  const debounced = useDebounced(draft.trim(), 250);
  const suggestQ = useTagSuggest(debounced, open);
  const items = suggestQ.data?.items ?? [];

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  // Keep the highlight inside the current suggestion list.
  useEffect(() => {
    setHighlight((h) => (h >= items.length ? items.length - 1 : h));
  }, [items.length]);

  function commit(tag: string) {
    const t = tag.trim();
    if (!t) return;
    onSelect(t);
    setDraft("");
    setOpen(false);
    setHighlight(-1);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setOpen(true);
      setHighlight((h) => Math.min(h + 1, items.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((h) => Math.max(h - 1, -1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (highlight >= 0 && highlight < items.length) commit(items[highlight].tag);
      else commit(draft);
    } else if (e.key === "Escape") {
      setOpen(false);
      setHighlight(-1);
    }
  }

  return (
    <div ref={rootRef} className="relative">
      <input
        type="text"
        role="combobox"
        aria-expanded={open}
        aria-controls="tag-suggest-listbox"
        aria-autocomplete="list"
        aria-activedescendant={highlight >= 0 ? `tag-suggest-opt-${highlight}` : undefined}
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value);
          setOpen(true);
          setHighlight(-1);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
        placeholder="Add tag filter…"
        className="w-44 rounded-md border border-chartborder bg-page px-2.5 py-1.5 text-xs text-ink-primary outline-none placeholder:text-ink-muted focus:border-series-1"
      />
      {open && items.length > 0 && (
        <ul
          id="tag-suggest-listbox"
          role="listbox"
          className="absolute left-0 top-full z-40 mt-1 max-h-64 w-64 overflow-y-auto rounded-md border border-chartborder bg-surface py-1 shadow-md"
        >
          {items.map((s, i) => (
            <li
              key={s.tag}
              id={`tag-suggest-opt-${i}`}
              role="option"
              aria-selected={i === highlight}
              // onMouseDown (not onClick) so selection wins over the input's blur/outside-close.
              onMouseDown={(e) => {
                e.preventDefault();
                commit(s.tag);
              }}
              onMouseEnter={() => setHighlight(i)}
              className={clsx(
                "flex cursor-pointer items-center justify-between gap-3 px-2.5 py-1.5 text-xs",
                i === highlight ? "bg-page text-ink-primary" : "text-ink-secondary",
              )}
            >
              <span className="truncate font-medium">{s.tag}</span>
              <span className="tabular shrink-0 text-[10px] text-ink-muted">{fmtInt(s.n_games)} games</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

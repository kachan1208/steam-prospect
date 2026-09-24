/**
 * Recent searches UI, two shapes over one store (lib/recentSearches.ts):
 *
 *  - useRecentCombobox: a dropdown under a search input, opened when the input (or anything
 *    inside its wrapper, e.g. the "Clear" button) has focus and the box is EMPTY. Keyboard
 *    follows the same combobox contract as TagAutocomplete: the input keeps focus, ↑/↓ move
 *    the highlight (aria-activedescendant), Enter runs the highlighted search, Delete removes
 *    it, Esc closes. Mouse picks on mousedown so the pick wins over the input's blur.
 *  - RecentSearchChips: an inline row for inputs whose arrow keys already belong to a result
 *    list (the Radar rail), where a dropdown would cover the list it navigates.
 */
import { useId, useState, type FocusEvent, type KeyboardEvent, type ReactNode } from "react";
import clsx from "clsx";
import { normalizeQuery, useRecentSearches, type RecentScope } from "../../lib/recentSearches";

function ClockIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="13"
      height="13"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="shrink-0 text-ink-muted"
      aria-hidden
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </svg>
  );
}

export function useRecentCombobox({
  scope,
  value,
  onPick,
}: {
  scope: RecentScope;
  value: string;
  /** Run the chosen search — usually the input's own onChange. */
  onPick: (q: string) => void;
}): {
  wrapperProps: { onFocus: (e: FocusEvent<HTMLElement>) => void; onBlur: (e: FocusEvent<HTMLElement>) => void };
  inputProps: {
    role: "combobox";
    "aria-expanded": boolean;
    "aria-controls": string;
    "aria-autocomplete": "list";
    "aria-activedescendant": string | undefined;
    onKeyDown: (e: KeyboardEvent<HTMLInputElement>) => void;
  };
  dropdown: ReactNode;
  open: boolean;
} {
  const { items, add, remove, clear } = useRecentSearches(scope);
  const [focused, setFocused] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [highlight, setHighlight] = useState(-1);
  const listId = useId();
  const optId = (i: number) => `${listId}-opt-${i}`;

  const open = focused && !dismissed && normalizeQuery(value) === "" && items.length > 0;
  const hi = Math.min(highlight, items.length - 1);

  const pick = (q: string) => {
    add(q);
    onPick(q);
    setHighlight(-1);
  };

  const wrapperProps = {
    onFocus: () => {
      setFocused(true);
      setDismissed(false);
    },
    onBlur: (e: FocusEvent<HTMLElement>) => {
      // Focus moving to another element INSIDE the wrapper (the Clear button) keeps it open.
      if (e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget)) return;
      setFocused(false);
      setHighlight(-1);
    },
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (!open) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const step = e.key === "ArrowDown" ? 1 : -1;
      setHighlight((h) => Math.max(-1, Math.min(items.length - 1, h + step)));
    } else if (e.key === "Enter" && hi >= 0) {
      e.preventDefault();
      pick(items[hi].q);
    } else if (e.key === "Delete" && hi >= 0) {
      e.preventDefault();
      remove(items[hi].q);
      setHighlight((h) => Math.min(h, items.length - 2));
    } else if (e.key === "Escape") {
      e.preventDefault();
      setDismissed(true);
      setHighlight(-1);
    }
  };

  const dropdown = open ? (
    <div
      className="absolute left-0 right-0 top-full z-40 mt-1 border border-chartborder bg-surface shadow-md"
      data-testid="recent-searches"
    >
      <div className="flex items-center justify-between px-2.5 pb-1 pt-1.5">
        <span className="kicker text-[10px] tracking-[.08em] text-ink-muted">Recent searches</span>
        <button
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            clear();
            setHighlight(-1);
          }}
          className="text-[11px] text-ink-muted underline-offset-2 hover:text-ink-primary hover:underline"
        >
          Clear
        </button>
      </div>
      <ul id={listId} role="listbox" aria-label="Recent searches" className="max-h-64 overflow-y-auto pb-1">
        {items.map((it, i) => (
          <li
            key={it.q}
            id={optId(i)}
            role="option"
            aria-selected={i === hi}
            onMouseDown={(e) => {
              e.preventDefault();
              pick(it.q);
            }}
            onMouseEnter={() => setHighlight(i)}
            className={clsx(
              "flex cursor-pointer items-center gap-2 px-2.5 py-1.5 text-[13px]",
              i === hi ? "bg-page text-ink-primary" : "text-ink-secondary",
            )}
          >
            <ClockIcon />
            <span className="min-w-0 flex-1 truncate">{it.q}</span>
            {/* Mouse affordance only — keyboard users remove with Delete (hint below). */}
            <span
              aria-hidden="true"
              title={`Remove “${it.q}” from recent searches`}
              data-testid="recent-remove"
              onMouseDown={(e) => {
                e.preventDefault();
                e.stopPropagation();
                remove(it.q);
              }}
              className="shrink-0 px-1 text-ink-muted hover:text-ink-primary"
            >
              ×
            </span>
          </li>
        ))}
      </ul>
      <div className="border-t border-chartborder px-2.5 py-1 text-[10px] text-ink-muted">
        ↑↓ choose · Enter search · Del remove · Esc close
      </div>
    </div>
  ) : null;

  return {
    wrapperProps,
    inputProps: {
      role: "combobox",
      "aria-expanded": open,
      "aria-controls": listId,
      "aria-autocomplete": "list",
      "aria-activedescendant": open && hi >= 0 ? optId(hi) : undefined,
      onKeyDown,
    },
    dropdown,
    open,
  };
}

/** Inline "Recent: [Roguelike ×] [Souls-like ×] Clear" row. Renders nothing without history. */
export function RecentSearchChips({
  scope,
  onPick,
  className,
}: {
  scope: RecentScope;
  onPick: (q: string) => void;
  className?: string;
}) {
  const { items, add, remove, clear } = useRecentSearches(scope);
  if (items.length === 0) return null;
  return (
    <div
      className={clsx("flex flex-wrap items-center gap-1.5 text-[11px] text-ink-muted", className)}
      data-testid="recent-search-chips"
    >
      <span>Recent:</span>
      {items.map((it) => (
        <span key={it.q} className="inline-flex items-center border border-chartborder">
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              add(it.q);
              onPick(it.q);
            }}
            className="px-1.5 py-[2px] text-ink-secondary hover:text-ink-primary"
          >
            {it.q}
          </button>
          <button
            type="button"
            aria-label={`Remove “${it.q}” from recent searches`}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => remove(it.q)}
            className="px-1 text-ink-muted hover:text-ink-primary"
          >
            ×
          </button>
        </span>
      ))}
      <button
        type="button"
        onMouseDown={(e) => e.preventDefault()}
        onClick={clear}
        className="underline-offset-2 hover:text-ink-primary hover:underline"
      >
        Clear
      </button>
    </div>
  );
}

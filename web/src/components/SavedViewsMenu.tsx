import { useEffect, useRef, useState } from "react";

import { useCreateSavedView, useDeleteSavedView, useSavedViews, type SavedView } from "../lib/api";
import type { Dimension, SortKey, Window } from "../lib/api";

export interface NicheViewConfig {
  dimension: Dimension;
  window: Window;
  min_reviews: number;
  sort: SortKey;
  order: "asc" | "desc";
  q?: string;
}

const SORT_KEYS: SortKey[] = [
  "key", "opportunity", "demand", "competition", "quality_gap",
  "median_rev", "median_reviews", "median_price", "median_owners",
  "median_positive_ratio", "recent_velocity", "n_games", "n_recent",
  "hit_rate_200k", "hit_rate_500k", "beatable_share", "saturation_yoy",
  "self_pub_share", "winner_concentration",
];

function parseViewConfig(raw: Record<string, unknown>): NicheViewConfig {
  const dimension: Dimension = raw.dimension === "genre" ? "genre" : "tag";
  const windowVal: Window = raw.window === "24m" ? "24m" : "all";
  const min_reviews = typeof raw.min_reviews === "number" ? raw.min_reviews : 10;
  const sortRaw = typeof raw.sort === "string" ? raw.sort : "opportunity";
  const sort: SortKey = (SORT_KEYS as string[]).includes(sortRaw) ? (sortRaw as SortKey) : "opportunity";
  const order: "asc" | "desc" = raw.order === "asc" ? "asc" : "desc";
  const q = typeof raw.q === "string" && raw.q.length > 0 ? raw.q : undefined;
  return { dimension, window: windowVal, min_reviews, sort, order, q };
}

function useOutsideClick(ref: React.RefObject<HTMLDivElement | null>, onOutside: () => void) {
  useEffect(() => {
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onOutside();
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [ref, onOutside]);
}

/** Saved-views affordance for the Niche Finder filter rail, backed by /api/views. */
export function SavedViewsMenu({
  current,
  onApply,
}: {
  current: NicheViewConfig;
  onApply: (config: NicheViewConfig) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const { data: views, isLoading } = useSavedViews();
  const createView = useCreateSavedView();
  const deleteView = useDeleteSavedView();
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");

  useOutsideClick(ref, () => setOpen(false));

  function submitSave() {
    const trimmed = name.trim();
    if (!trimmed) return;
    createView.mutate(
      { name: trimmed, surface: "niches", config: current },
      { onSuccess: () => { setNaming(false); setName(""); } },
    );
  }

  function handleApply(v: SavedView) {
    onApply(parseViewConfig(v.config));
    setOpen(false);
  }

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="rounded-md border border-chartborder px-3 py-1.5 text-xs font-medium text-ink-secondary hover:text-ink-primary"
      >
        Saved views{views && views.length > 0 ? ` (${views.length})` : ""}
      </button>
      {open && (
        <div className="absolute right-0 z-20 mt-1 w-72 rounded-card border border-chartborder bg-surface p-2 shadow-xl">
          {isLoading && <div className="px-2 py-1.5 text-xs text-ink-muted">Loading…</div>}
          {views && views.length === 0 && <div className="px-2 py-1.5 text-xs text-ink-muted">No saved views yet.</div>}
          <div className="max-h-64 overflow-y-auto">
            {views?.map((v) => (
              <div key={v.id} className="group flex items-center gap-1 rounded-md px-1 py-0.5 hover:bg-page">
                <button
                  type="button"
                  onClick={() => handleApply(v)}
                  className="flex-1 truncate rounded px-1.5 py-1 text-left text-xs text-ink-primary"
                  title={`dimension=${String(v.config.dimension)} window=${String(v.config.window)} sort=${String(v.config.sort)}`}
                >
                  {v.name}
                </button>
                <button
                  type="button"
                  onClick={() => deleteView.mutate(v.id)}
                  aria-label={`Delete ${v.name}`}
                  className="hidden shrink-0 px-1.5 text-ink-muted hover:text-status-critical group-hover:block"
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
          <div className="mt-1 border-t border-chartborder pt-1">
            {naming ? (
              <div className="flex items-center gap-1 px-1 py-0.5">
                <input
                  autoFocus
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") submitSave();
                    if (e.key === "Escape") {
                      setNaming(false);
                      setName("");
                    }
                  }}
                  placeholder="View name…"
                  className="min-w-0 flex-1 rounded-md border border-chartborder bg-page px-2 py-1 text-xs text-ink-primary outline-none focus:border-series-1"
                />
                <button
                  type="button"
                  onClick={submitSave}
                  disabled={!name.trim() || createView.isPending}
                  className="rounded-md border border-series-1 px-2 py-1 text-xs font-medium text-series-1 hover:bg-page disabled:opacity-50"
                >
                  Save
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setNaming(false);
                    setName("");
                  }}
                  aria-label="Cancel"
                  className="rounded-md px-1.5 py-1 text-xs text-ink-muted hover:text-ink-primary"
                >
                  ✕
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setNaming(true)}
                className="w-full rounded-md px-2 py-1.5 text-left text-xs font-medium text-series-1 hover:bg-page"
              >
                + Save current filters
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

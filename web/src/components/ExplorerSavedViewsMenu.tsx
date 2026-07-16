import { useEffect, useRef, useState } from "react";

import { useCreateSavedView, useDeleteSavedView, useSavedViews, type ExploreFilterOp, type SavedView } from "../lib/api";

const SURFACE = "explorer";

export type ExplorerMode = "rows" | "grouped";
export type ExplorerChartChoice = "auto" | "bar" | "line" | "scatter" | "table";

export interface ExplorerFilterConfig {
  col: string;
  op: ExploreFilterOp;
  val: string;
}

/** The Explorer's full query-builder UI state — richer than the raw ExploreQuery sent to
 * the API (it also remembers mode/chart-choice/scatter axes) so loading a saved view
 * restores the whole builder, not just a one-shot query result. Mirrors the shape/defensive-
 * parse pattern of components/SavedViewsMenu.tsx's NicheViewConfig, specialized for
 * Explorer — kept as a separate component (not an edit to that file) since it's a new,
 * Explorer-only surface. */
export interface ExplorerViewConfig {
  mode: ExplorerMode;
  filters: ExplorerFilterConfig[];
  rowColumns: string[];
  groupBy: string;
  metrics: string[];
  sort: string;
  order: "asc" | "desc";
  limit: number;
  chart: ExplorerChartChoice;
  scatterX: string;
  scatterY: string;
}

const OPS: ExploreFilterOp[] = ["eq", "neq", "gt", "gte", "lt", "lte", "in", "like", "contains", "is_null", "not_null"];
const CHART_CHOICES: ExplorerChartChoice[] = ["auto", "bar", "line", "scatter", "table"];

function parseViewConfig(raw: Record<string, unknown>): ExplorerViewConfig {
  const mode: ExplorerMode = raw.mode === "grouped" ? "grouped" : "rows";
  const filters: ExplorerFilterConfig[] = Array.isArray(raw.filters)
    ? (raw.filters as Record<string, unknown>[])
        .filter((f) => typeof f.col === "string" && OPS.includes(f.op as ExploreFilterOp))
        .map((f) => ({ col: String(f.col), op: f.op as ExploreFilterOp, val: f.val === undefined ? "" : String(f.val) }))
    : [];
  const rowColumns = Array.isArray(raw.rowColumns) ? (raw.rowColumns as unknown[]).map(String) : [];
  const groupBy = typeof raw.groupBy === "string" ? raw.groupBy : "";
  const metrics = Array.isArray(raw.metrics) ? (raw.metrics as unknown[]).map(String) : [];
  const sort = typeof raw.sort === "string" ? raw.sort : "";
  const order: "asc" | "desc" = raw.order === "asc" ? "asc" : "desc";
  const limit = typeof raw.limit === "number" && raw.limit > 0 ? raw.limit : 200;
  const chart: ExplorerChartChoice = CHART_CHOICES.includes(raw.chart as ExplorerChartChoice)
    ? (raw.chart as ExplorerChartChoice)
    : "auto";
  const scatterX = typeof raw.scatterX === "string" ? raw.scatterX : "";
  const scatterY = typeof raw.scatterY === "string" ? raw.scatterY : "";
  return { mode, filters, rowColumns, groupBy, metrics, sort, order, limit, chart, scatterX, scatterY };
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

/** Saved-views affordance for the Explorer, backed by the same /api/views CRUD as the
 * Niche Finder's SavedViewsMenu — just scoped to surface="explorer" and filtered
 * client-side to that surface (list_views itself returns all of an org's views
 * regardless of surface, same as the Niche Finder menu). */
export function ExplorerSavedViewsMenu({
  current,
  onApply,
}: {
  current: ExplorerViewConfig;
  onApply: (config: ExplorerViewConfig) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const { data: allViews, isLoading } = useSavedViews();
  const views = (allViews ?? []).filter((v) => v.surface === SURFACE);
  const createView = useCreateSavedView();
  const deleteView = useDeleteSavedView();
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");

  useOutsideClick(ref, () => setOpen(false));

  function submitSave() {
    const trimmed = name.trim();
    if (!trimmed) return;
    createView.mutate(
      { name: trimmed, surface: SURFACE, config: current },
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
        Saved views{views.length > 0 ? ` (${views.length})` : ""}
      </button>
      {open && (
        <div className="absolute right-0 z-20 mt-1 w-72 rounded-card border border-chartborder bg-surface p-2 shadow-xl">
          {isLoading && <div className="px-2 py-1.5 text-xs text-ink-muted">Loading…</div>}
          {!isLoading && views.length === 0 && <div className="px-2 py-1.5 text-xs text-ink-muted">No saved views yet.</div>}
          <div className="max-h-64 overflow-y-auto">
            {views.map((v) => (
              <div key={v.id} className="group flex items-center gap-1 rounded-md px-1 py-0.5 hover:bg-page">
                <button
                  type="button"
                  onClick={() => handleApply(v)}
                  className="flex-1 truncate rounded px-1.5 py-1 text-left text-xs text-ink-primary"
                  title={`mode=${String(v.config.mode)} sort=${String(v.config.sort)}`}
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
                + Save current query
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

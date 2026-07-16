import { useEffect, useMemo, useRef, useState } from "react";
import { createColumnHelper, flexRender, getCoreRowModel, useReactTable } from "@tanstack/react-table";
import clsx from "clsx";

import { ExplorerBarChart, ExplorerLineChart, ExplorerScatterChart, formatExploreValue } from "../components/charts/ExplorerChart";
import { ExplorerSavedViewsMenu, type ExplorerChartChoice, type ExplorerFilterConfig, type ExplorerMode, type ExplorerViewConfig } from "../components/ExplorerSavedViewsMenu";
import { Card } from "../components/ui/Card";
import {
  exploreExportCsvUrl,
  useExploreSchema,
  useRunExplore,
  type ExploreColumnMeta,
  type ExploreFilter,
  type ExploreFilterOp,
  type ExploreQuery,
} from "../lib/api";

const OP_LABELS: Record<ExploreFilterOp, string> = {
  eq: "=",
  neq: "≠",
  gt: ">",
  gte: "≥",
  lt: "<",
  lte: "≤",
  in: "in (comma list)",
  like: "contains text",
  contains: "has tag",
  is_null: "is empty",
  not_null: "is not empty",
};

const TEMPORAL_GROUP_COLS = new Set(["release_year"]);

interface BuilderState {
  mode: ExplorerMode;
  filters: ExplorerFilterConfig[];
  rowColumns: string[];
  groupBy: string;
  metrics: string[];
  sort: string;
  order: "asc" | "desc";
  limit: number;
}

const DEFAULT_ROW_COLUMNS = ["name", "primary_genre", "release_year", "price_initial", "total_reviews", "positive_ratio", "est_rev_reviews"];

function isNumericKind(kind: string | undefined): boolean {
  return kind === "number" || kind === "integer";
}

function coerceFilterVal(f: ExplorerFilterConfig, dims: ExploreColumnMeta[]): ExploreFilter["val"] {
  if (f.op === "is_null" || f.op === "not_null") return null;
  const kind = dims.find((d) => d.name === f.col)?.kind ?? "string";
  if (f.op === "in") {
    const parts = f.val
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    return isNumericKind(kind) ? parts.map(Number) : parts;
  }
  if (kind === "boolean") return f.val === "true";
  if (isNumericKind(kind)) return Number(f.val);
  return f.val;
}

function buildQuery(state: BuilderState, dims: ExploreColumnMeta[]): ExploreQuery {
  const cleanFilters: ExploreFilter[] = state.filters
    .filter((f) => f.col && f.op && (f.op === "is_null" || f.op === "not_null" || f.val.trim() !== ""))
    .map((f) => ({ col: f.col, op: f.op, val: coerceFilterVal(f, dims) }));

  if (state.mode === "grouped") {
    if (state.groupBy) {
      const select = [state.groupBy, ...state.metrics.filter((m) => m !== state.groupBy)];
      const sort = select.includes(state.sort) ? state.sort : select[0];
      return { select, filters: cleanFilters, group_by: [state.groupBy], sort, order: state.order, limit: state.limit };
    }
    // No group-by picked: an ungrouped aggregate summary over the filtered set (one row).
    const select = state.metrics.length > 0 ? state.metrics : ["n_games"];
    const sort = select.includes(state.sort) ? state.sort : select[0];
    return { select, filters: cleanFilters, group_by: [], sort, order: state.order, limit: state.limit };
  }
  const select = state.rowColumns.length > 0 ? state.rowColumns : ["appid", "name"];
  const sort = select.includes(state.sort) ? state.sort : select[0];
  return { select, filters: cleanFilters, group_by: [], sort, order: state.order, limit: state.limit };
}

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={clsx(
        "rounded-full border px-2 py-0.5 text-[10px] font-medium transition-colors",
        active ? "border-series-1 bg-page text-ink-primary" : "border-chartborder text-ink-muted hover:text-ink-secondary",
      )}
    >
      {children}
    </button>
  );
}

function SegButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={clsx(
        "rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
        active ? "bg-page text-ink-primary" : "text-ink-muted hover:text-ink-secondary",
      )}
    >
      {children}
    </button>
  );
}

function FilterRowEditor({
  filter,
  dims,
  onChange,
  onRemove,
}: {
  filter: ExplorerFilterConfig;
  dims: ExploreColumnMeta[];
  onChange: (next: ExplorerFilterConfig) => void;
  onRemove: () => void;
}) {
  const dim = dims.find((d) => d.name === filter.col);
  const kind = dim?.kind ?? "string";
  const opsForCol = dim?.ops ?? Object.keys(OP_LABELS);
  const needsVal = filter.op !== "is_null" && filter.op !== "not_null";

  return (
    <div className="flex flex-wrap items-center gap-1.5 rounded-md border border-chartborder bg-page px-2 py-1.5">
      <select
        value={filter.col}
        onChange={(e) => onChange({ ...filter, col: e.target.value, op: "eq", val: "" })}
        className="rounded-md border border-chartborder bg-surface px-1.5 py-1 text-[11px] text-ink-primary outline-none focus:border-series-1"
      >
        <option value="">Column…</option>
        {dims.map((d) => (
          <option key={d.name} value={d.name}>
            {d.label}
          </option>
        ))}
      </select>
      <select
        value={filter.op}
        onChange={(e) => onChange({ ...filter, op: e.target.value as ExploreFilterOp, val: "" })}
        className="rounded-md border border-chartborder bg-surface px-1.5 py-1 text-[11px] text-ink-primary outline-none focus:border-series-1"
      >
        {opsForCol.map((op) => (
          <option key={op} value={op}>
            {OP_LABELS[op as ExploreFilterOp] ?? op}
          </option>
        ))}
      </select>
      {needsVal &&
        (kind === "boolean" ? (
          <select
            value={filter.val || "true"}
            onChange={(e) => onChange({ ...filter, val: e.target.value })}
            className="rounded-md border border-chartborder bg-surface px-1.5 py-1 text-[11px] text-ink-primary outline-none focus:border-series-1"
          >
            <option value="true">true</option>
            <option value="false">false</option>
          </select>
        ) : (
          <input
            type="text"
            value={filter.val}
            onChange={(e) => onChange({ ...filter, val: e.target.value })}
            placeholder={filter.op === "in" ? "a, b, c" : kind === "list" ? "exact tag, e.g. Roguelike" : "value"}
            className="w-32 min-w-0 rounded-md border border-chartborder bg-surface px-2 py-1 text-[11px] text-ink-primary outline-none placeholder:text-ink-muted focus:border-series-1"
          />
        ))}
      <button type="button" onClick={onRemove} aria-label="Remove filter" className="ml-auto px-1 text-ink-muted hover:text-status-critical">
        ✕
      </button>
    </div>
  );
}

export default function Explorer() {
  const schemaQ = useExploreSchema();
  const dims = useMemo(() => schemaQ.data?.dimensions ?? [], [schemaQ.data]);
  const metricsAvail = useMemo(() => schemaQ.data?.metrics ?? [], [schemaQ.data]);
  const groupableDims = useMemo(() => dims.filter((d) => d.groupable), [dims]);

  const [mode, setMode] = useState<ExplorerMode>("grouped");
  const [filters, setFilters] = useState<ExplorerFilterConfig[]>([]);
  const [rowColumns, setRowColumns] = useState<string[]>(DEFAULT_ROW_COLUMNS);
  const [groupBy, setGroupBy] = useState<string>("primary_genre");
  const [metrics, setMetrics] = useState<string[]>(["n_games", "median_est_rev"]);
  const [sort, setSort] = useState<string>("median_est_rev");
  const [order, setOrder] = useState<"asc" | "desc">("desc");
  const [limit, setLimit] = useState<number>(200);
  const [chart, setChart] = useState<ExplorerChartChoice>("auto");
  const [scatterX, setScatterX] = useState<string>("");
  const [scatterY, setScatterY] = useState<string>("");
  const [lastQuery, setLastQuery] = useState<ExploreQuery | null>(null);

  const runQuery = useRunExplore();
  const result = runQuery.data;
  const maxLimit = schemaQ.data?.max_limit ?? 1000;
  const maxSelect = schemaQ.data?.max_select ?? 8;

  function currentState(): BuilderState {
    return { mode, filters, rowColumns, groupBy, metrics, sort, order, limit };
  }

  function runState(state: BuilderState) {
    const q = buildQuery(state, dims);
    setLastQuery(q);
    runQuery.mutate(q);
  }

  function runNow() {
    runState(currentState());
  }

  const didAutoRun = useRef(false);
  useEffect(() => {
    if (schemaQ.data && !didAutoRun.current) {
      didAutoRun.current = true;
      runNow();
    }
    // Intentionally only re-checks when the schema finishes loading — this fires the
    // one-time default query, not a refetch-on-every-keystroke loop (this page is a
    // deliberate "build then Run" query builder, not an auto-fetching filter bar).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schemaQ.data]);

  function toggleSort(col: string) {
    const nextOrder = sort === col ? (order === "desc" ? "asc" : "desc") : "desc";
    setSort(col);
    setOrder(nextOrder);
    runState({ ...currentState(), sort: col, order: nextOrder });
  }

  function applyView(config: ExplorerViewConfig) {
    setMode(config.mode);
    setFilters(config.filters);
    setRowColumns(config.rowColumns);
    setGroupBy(config.groupBy);
    setMetrics(config.metrics);
    setSort(config.sort);
    setOrder(config.order);
    setLimit(config.limit);
    setChart(config.chart);
    setScatterX(config.scatterX);
    setScatterY(config.scatterY);
    runState({
      mode: config.mode,
      filters: config.filters,
      rowColumns: config.rowColumns,
      groupBy: config.groupBy,
      metrics: config.metrics,
      sort: config.sort,
      order: config.order,
      limit: config.limit,
    });
  }

  function addFilter() {
    if (filters.length >= (schemaQ.data?.max_filters ?? 8)) return;
    setFilters((fs) => [...fs, { col: dims[0]?.name ?? "", op: "eq", val: "" }]);
  }

  function toggleRowColumn(name: string) {
    setRowColumns((cols) => {
      if (cols.includes(name)) return cols.filter((c) => c !== name);
      if (cols.length >= maxSelect) return cols;
      return [...cols, name];
    });
  }

  function toggleMetric(name: string) {
    setMetrics((ms) => {
      if (ms.includes(name)) return ms.filter((m) => m !== name);
      if (ms.length >= maxSelect - 1) return ms;
      return [...ms, name];
    });
  }

  const selectableSortCols = mode === "grouped" ? [groupBy, ...metrics].filter(Boolean) : rowColumns;

  function labelFor(col: string): string {
    return dims.find((d) => d.name === col)?.label ?? metricsAvail.find((m) => m.name === col)?.label ?? col;
  }

  // ---- auto-chart: decide what (if anything) to render above the table ------------------
  const numericRowCols = rowColumns.filter((c) => isNumericKind(dims.find((d) => d.name === c)?.kind));
  const scatterXCol = scatterX && numericRowCols.includes(scatterX) ? scatterX : numericRowCols[0];
  const scatterYCol =
    scatterY && numericRowCols.includes(scatterY) && scatterY !== scatterXCol
      ? scatterY
      : numericRowCols.find((c) => c !== scatterXCol);

  function renderChart(): React.ReactNode {
    if (!result || chart === "table" || result.rows.length === 0) return null;

    if (result.grouped) {
      if (chart === "scatter") return null; // scatter isn't meaningful once rows are aggregated
      const metricCol = metrics[0];
      if (!metricCol || !result.columns.includes(metricCol)) return null;
      const useLine = chart === "line" || (chart === "auto" && TEMPORAL_GROUP_COLS.has(groupBy));
      if (useLine) {
        return (
          <ExplorerLineChart
            rows={result.rows}
            groupCol={groupBy}
            groupLabel={labelFor(groupBy)}
            metricCol={metricCol}
            metricLabel={labelFor(metricCol)}
          />
        );
      }
      return <ExplorerBarChart rows={result.rows} groupCol={groupBy} metricCol={metricCol} metricLabel={labelFor(metricCol)} />;
    }

    // Row-level result.
    if (chart === "bar" || chart === "line") return null; // not meaningful without a group_by
    if (!scatterXCol || !scatterYCol) return null;
    return (
      <ExplorerScatterChart
        rows={result.rows}
        xCol={scatterXCol}
        xLabel={labelFor(scatterXCol)}
        yCol={scatterYCol}
        yLabel={labelFor(scatterYCol)}
      />
    );
  }
  const chartNode = renderChart();

  const columnHelper = useMemo(() => createColumnHelper<Record<string, unknown>>(), []);
  const tableColumns = useMemo(
    () =>
      (result?.columns ?? []).map((col) =>
        columnHelper.accessor(col, {
          id: col,
          header: () => (
            <button
              type="button"
              onClick={() => toggleSort(col)}
              title={`Sort by ${labelFor(col)}`}
              className={clsx(
                "group inline-flex items-center gap-1 font-medium",
                sort === col ? "text-ink-primary" : "text-ink-muted hover:text-ink-secondary",
              )}
            >
              {labelFor(col)}
              <span aria-hidden className={clsx("text-[10px] leading-none", sort === col ? "opacity-100" : "opacity-0 group-hover:opacity-40")}>
                {sort === col ? (order === "desc" ? "↓" : "↑") : "↕"}
              </span>
            </button>
          ),
          cell: (info) => <span className="tabular">{formatExploreValue(col, info.getValue())}</span>,
        }),
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [result?.columns, sort, order],
  );
  const table = useReactTable({ data: result?.rows ?? [], columns: tableColumns, getCoreRowModel: getCoreRowModel() });

  const currentViewConfig: ExplorerViewConfig = { mode, filters, rowColumns, groupBy, metrics, sort, order, limit, chart, scatterX, scatterY };

  if (schemaQ.isLoading) {
    return <div className="p-6 text-sm text-ink-muted">Loading query builder…</div>;
  }
  if (schemaQ.isError || !schemaQ.data) {
    return (
      <div className="p-6 text-sm text-status-serious">
        Failed to load the Explorer schema{schemaQ.error instanceof Error ? `: ${schemaQ.error.message}` : "."}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-lg font-semibold text-ink-primary">Data Explorer</h1>
        <p className="mt-0.5 text-sm text-ink-muted">
          Build an open-ended query over the catalog — filter, group, chart, save the view, export the rows. Every
          query compiles server-side against a fixed column whitelist; nothing here runs raw SQL.
        </p>
      </div>

      <Card className="!p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-0.5 rounded-md border border-chartborder p-0.5">
            <SegButton active={mode === "grouped"} onClick={() => setMode("grouped")}>
              Group &amp; aggregate
            </SegButton>
            <SegButton active={mode === "rows"} onClick={() => setMode("rows")}>
              Browse rows
            </SegButton>
          </div>
          <div className="flex items-center gap-2">
            <ExplorerSavedViewsMenu current={currentViewConfig} onApply={applyView} />
            {lastQuery && (
              <a
                href={exploreExportCsvUrl(lastQuery)}
                className="rounded-md border border-chartborder px-3 py-1.5 text-xs font-medium text-ink-secondary hover:text-ink-primary"
              >
                Export CSV
              </a>
            )}
          </div>
        </div>

        {/* Filters */}
        <div className="mt-3 flex flex-col gap-1.5 border-t border-chartborder pt-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-ink-primary">Filters</span>
            <button
              type="button"
              onClick={addFilter}
              disabled={filters.length >= schemaQ.data.max_filters}
              className="rounded-md border border-chartborder px-2 py-1 text-[11px] font-medium text-ink-secondary hover:text-ink-primary disabled:opacity-40"
            >
              + Add filter
            </button>
          </div>
          {filters.length === 0 && <div className="text-[11px] text-ink-muted">No filters — showing the whole catalog.</div>}
          <div className="flex flex-col gap-1.5">
            {filters.map((f, i) => (
              <FilterRowEditor
                key={i}
                filter={f}
                dims={dims}
                onChange={(next) => setFilters((fs) => fs.map((x, xi) => (xi === i ? next : x)))}
                onRemove={() => setFilters((fs) => fs.filter((_, xi) => xi !== i))}
              />
            ))}
          </div>
        </div>

        {/* Mode-specific column pickers */}
        {mode === "grouped" ? (
          <div className="mt-3 flex flex-col gap-2 border-t border-chartborder pt-3">
            <div className="flex flex-wrap items-center gap-2">
              <label className="flex items-center gap-1.5 text-xs text-ink-secondary">
                Group by
                <select
                  value={groupBy}
                  onChange={(e) => setGroupBy(e.target.value)}
                  className="rounded-md border border-chartborder bg-page px-2 py-1.5 text-xs text-ink-primary outline-none focus:border-series-1"
                >
                  <option value="">(none — whole-catalog summary)</option>
                  {groupableDims.map((d) => (
                    <option key={d.name} value={d.name}>
                      {d.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div>
              <div className="mb-1 text-[11px] text-ink-muted">Metrics (pick 1-4)</div>
              <div className="flex flex-wrap gap-1">
                {metricsAvail.map((m) => (
                  <Chip key={m.name} active={metrics.includes(m.name)} onClick={() => toggleMetric(m.name)}>
                    {m.label}
                  </Chip>
                ))}
              </div>
            </div>
          </div>
        ) : (
          <div className="mt-3 border-t border-chartborder pt-3">
            <div className="mb-1 text-[11px] text-ink-muted">Columns to show (pick up to {maxSelect})</div>
            <div className="flex flex-wrap gap-1">
              {dims.map((d) => (
                <Chip key={d.name} active={rowColumns.includes(d.name)} onClick={() => toggleRowColumn(d.name)}>
                  {d.label}
                </Chip>
              ))}
            </div>
          </div>
        )}

        {/* Sort / limit / chart / run */}
        <div className="mt-3 flex flex-wrap items-end gap-2 border-t border-chartborder pt-3">
          <label className="flex items-center gap-1.5 text-xs text-ink-secondary">
            Sort
            <select
              value={selectableSortCols.includes(sort) ? sort : ""}
              onChange={(e) => setSort(e.target.value)}
              className="rounded-md border border-chartborder bg-page px-2 py-1.5 text-xs text-ink-primary outline-none focus:border-series-1"
            >
              {selectableSortCols.map((c) => (
                <option key={c} value={c}>
                  {labelFor(c)}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            onClick={() => setOrder((o) => (o === "desc" ? "asc" : "desc"))}
            className="rounded-md border border-chartborder px-2 py-1.5 text-xs text-ink-secondary hover:text-ink-primary"
            title="Toggle sort direction"
          >
            {order === "desc" ? "↓ desc" : "↑ asc"}
          </button>
          <label className="flex items-center gap-1.5 text-xs text-ink-secondary">
            Limit
            <input
              type="number"
              min={1}
              max={maxLimit}
              value={limit}
              onChange={(e) => setLimit(Math.min(maxLimit, Math.max(1, Number(e.target.value) || 1)))}
              className="w-20 rounded-md border border-chartborder bg-page px-2 py-1.5 text-xs text-ink-primary outline-none focus:border-series-1"
            />
          </label>
          <label className="flex items-center gap-1.5 text-xs text-ink-secondary">
            Chart
            <select
              value={chart}
              onChange={(e) => setChart(e.target.value as ExplorerChartChoice)}
              className="rounded-md border border-chartborder bg-page px-2 py-1.5 text-xs text-ink-primary outline-none focus:border-series-1"
            >
              <option value="auto">Auto</option>
              {mode === "grouped" ? (
                <>
                  <option value="bar">Bar</option>
                  <option value="line">Line</option>
                </>
              ) : (
                <option value="scatter">Scatter</option>
              )}
              <option value="table">Table only</option>
            </select>
          </label>
          {mode === "rows" && (chart === "scatter" || chart === "auto") && numericRowCols.length >= 2 && (
            <>
              <label className="flex items-center gap-1.5 text-xs text-ink-secondary">
                Scatter X
                <select
                  value={scatterXCol ?? ""}
                  onChange={(e) => setScatterX(e.target.value)}
                  className="rounded-md border border-chartborder bg-page px-2 py-1.5 text-xs text-ink-primary outline-none focus:border-series-1"
                >
                  {numericRowCols.map((c) => (
                    <option key={c} value={c}>
                      {labelFor(c)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex items-center gap-1.5 text-xs text-ink-secondary">
                Scatter Y
                <select
                  value={scatterYCol ?? ""}
                  onChange={(e) => setScatterY(e.target.value)}
                  className="rounded-md border border-chartborder bg-page px-2 py-1.5 text-xs text-ink-primary outline-none focus:border-series-1"
                >
                  {numericRowCols.map((c) => (
                    <option key={c} value={c}>
                      {labelFor(c)}
                    </option>
                  ))}
                </select>
              </label>
            </>
          )}
          <button
            type="button"
            onClick={runNow}
            disabled={runQuery.isPending}
            className="ml-auto rounded-md border border-series-1 bg-page px-4 py-1.5 text-xs font-semibold text-series-1 hover:bg-series-1 hover:text-white disabled:opacity-50"
          >
            {runQuery.isPending ? "Running…" : "Run query"}
          </button>
        </div>
      </Card>

      <Card className={clsx(runQuery.isPending && "opacity-90 transition-opacity")}>
        {runQuery.isError && (
          <div className="rounded-md border border-status-serious/40 bg-page p-3 text-xs text-status-serious">
            {runQuery.error instanceof Error ? runQuery.error.message : "Query failed."}
          </div>
        )}
        {!runQuery.isError && !result && !runQuery.isPending && (
          <div className="p-6 text-center text-sm text-ink-muted">Build a query above and click "Run query."</div>
        )}
        {result && (
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-ink-muted">
              <span>
                {result.row_count.toLocaleString()} row{result.row_count === 1 ? "" : "s"}
                {result.truncated ? ` (truncated at ${(lastQuery?.limit ?? result.row_count).toLocaleString()} — narrow your filters for the full set)` : ""}
                {" · "}
                {result.elapsed_ms.toFixed(1)}ms
                {" · "}
                {result.grouped ? "grouped" : "row-level"}
              </span>
              <details className="text-[11px]">
                <summary className="cursor-pointer text-ink-muted hover:text-ink-secondary">View compiled SQL</summary>
                <pre className="mt-1 max-w-[640px] overflow-x-auto rounded-md border border-chartborder bg-page p-2 text-[10px] text-ink-secondary">
                  {result.sql_preview}
                </pre>
              </details>
            </div>

            {chartNode ? (
              <div className="rounded-card border border-chartborder p-3">{chartNode}</div>
            ) : chart !== "table" ? (
              <div className="rounded-card border border-chartborder p-3 text-center text-xs text-ink-muted">
                Not enough shape to auto-chart this result — showing the table only.
              </div>
            ) : null}

            {result.rows.length === 0 ? (
              <div className="p-6 text-center text-sm text-ink-muted">No rows match this query.</div>
            ) : (
              <div className="overflow-x-auto rounded-card border border-chartborder">
                <table className="w-full min-w-[720px] border-collapse text-sm">
                  <thead>
                    {table.getHeaderGroups().map((hg) => (
                      <tr key={hg.id} className="border-b border-chartborder text-left text-xs text-ink-muted">
                        {hg.headers.map((h) => (
                          <th key={h.id} className="whitespace-nowrap px-3 py-2 font-medium">
                            {flexRender(h.column.columnDef.header, h.getContext())}
                          </th>
                        ))}
                      </tr>
                    ))}
                  </thead>
                  <tbody>
                    {table.getRowModel().rows.map((row) => (
                      <tr key={row.id} className="border-b border-chartborder/60 hover:bg-page">
                        {row.getVisibleCells().map((cell) => (
                          <td key={cell.id} className="whitespace-nowrap px-3 py-2 align-middle">
                            {flexRender(cell.column.columnDef.cell, cell.getContext())}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </Card>
    </div>
  );
}

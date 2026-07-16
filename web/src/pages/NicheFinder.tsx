import { useCallback, useEffect, useMemo, useState } from "react";
import { createColumnHelper, flexRender, getCoreRowModel, useReactTable } from "@tanstack/react-table";
import clsx from "clsx";

import { OpportunityBars, OPPORTUNITY_LEGEND } from "../components/charts/OpportunityBars";
import { NicheDetailDrawer } from "../components/NicheDetailDrawer";
import { SavedViewsMenu, type NicheViewConfig } from "../components/SavedViewsMenu";
import { Card } from "../components/ui/Card";
import {
  nicheExportCsvUrl,
  useNiches,
  type Dimension,
  type NicheRow,
  type SortKey,
  type Window,
} from "../lib/api";
import { fmtInt, fmtPct, fmtSigned, fmtUsd } from "../lib/format";
import { sequentialColorAt } from "../lib/palette";
import { useDebounced } from "../lib/useDebounced";
import { useTheme } from "../lib/theme";

const LIMIT = 50;

const INPUT_CLS =
  "rounded-lg border border-chartborder bg-surface text-xs text-ink-primary outline-none transition-colors placeholder:text-ink-muted focus:border-brand focus:shadow-[0_0_0_3px_var(--brand-tint)]";

const legColor = (needle: string) =>
  OPPORTUNITY_LEGEND.find((l) => l.label.toLowerCase().includes(needle))?.color;

/** A clickable column header that drives the server-side sort, with a direction arrow. */
function SortLabel({
  label,
  col,
  active,
  order,
  onSort,
  color,
}: {
  label: string;
  col: SortKey;
  active: boolean;
  order: "asc" | "desc";
  onSort: (col: SortKey) => void;
  color?: string;
}) {
  return (
    <button
      type="button"
      onClick={() => onSort(col)}
      title={`Sort by ${label}`}
      className={clsx(
        "group inline-flex items-center gap-1 font-semibold uppercase tracking-wide transition-colors",
        active ? "text-ink-primary" : "text-ink-muted hover:text-ink-secondary",
      )}
    >
      {color && <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: color }} />}
      {label}
      <span
        aria-hidden
        className={clsx("text-[10px] leading-none", active ? "opacity-100" : "opacity-0 group-hover:opacity-40")}
      >
        {active ? (order === "desc" ? "↓" : "↑") : "↕"}
      </span>
    </button>
  );
}

function Segmented({ children }: { children: React.ReactNode }) {
  return <div className="flex items-center gap-0.5 rounded-lg bg-surface2 p-0.5">{children}</div>;
}

function SegButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={clsx(
        "rounded-md px-3 py-1.5 text-xs font-medium transition-all",
        active ? "bg-surface text-ink-primary shadow-xs" : "text-ink-muted hover:text-ink-secondary",
      )}
    >
      {children}
    </button>
  );
}

export default function NicheFinder() {
  const { theme } = useTheme();
  const [dimension, setDimension] = useState<Dimension>("tag");
  const [windowParam, setWindowParam] = useState<Window>("all");
  const [minReviews, setMinReviews] = useState(10);
  const [q, setQ] = useState("");
  const debouncedQ = useDebounced(q, 300);
  const [sort, setSort] = useState<SortKey>("opportunity");
  const [order, setOrder] = useState<"asc" | "desc">("desc");

  const toggleSort = useCallback(
    (col: SortKey) => {
      if (sort === col) setOrder((o) => (o === "desc" ? "asc" : "desc"));
      else {
        setSort(col);
        setOrder(col === "key" ? "asc" : "desc");
      }
    },
    [sort],
  );
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState<NicheRow | null>(null);

  // Any filter change re-pages to the top so offset never points past the new result set.
  useEffect(() => {
    setOffset(0);
  }, [dimension, windowParam, minReviews, debouncedQ, sort, order]);

  const { data, isLoading, isFetching, isError, error } = useNiches({
    dimension,
    window: windowParam,
    min_reviews: minReviews,
    sort,
    order,
    q: debouncedQ || undefined,
    limit: LIMIT,
    offset,
  });

  const columnHelper = useMemo(() => createColumnHelper<NicheRow>(), []);
  const columns = useMemo(
    () => [
      columnHelper.accessor("key", {
        header: () => (
          <SortLabel label="Niche" col="key" active={sort === "key"} order={order} onSort={toggleSort} />
        ),
        cell: (info) => (
          <button
            type="button"
            onClick={() => setSelected(info.row.original)}
            className="text-left font-medium text-ink-primary transition-colors hover:text-brand"
          >
            {info.getValue()}
          </button>
        ),
      }),
      columnHelper.accessor("n_games", {
        header: () => (
          <SortLabel label="Games" col="n_games" active={sort === "n_games"} order={order} onSort={toggleSort} />
        ),
        cell: (info) => <span className="tabular text-ink-secondary">{fmtInt(info.getValue())}</span>,
      }),
      columnHelper.accessor("n_recent", {
        header: () => (
          <SortLabel label="Recent 24m" col="n_recent" active={sort === "n_recent"} order={order} onSort={toggleSort} />
        ),
        cell: (info) => <span className="tabular text-ink-secondary">{fmtInt(info.getValue())}</span>,
      }),
      columnHelper.accessor("median_rev", {
        header: () => (
          <SortLabel label="Median rev" col="median_rev" active={sort === "median_rev"} order={order} onSort={toggleSort} />
        ),
        cell: (info) => <span className="tabular text-ink-secondary">{fmtUsd(info.getValue())}</span>,
      }),
      columnHelper.accessor("median_price", {
        header: () => (
          <SortLabel label="Median price" col="median_price" active={sort === "median_price"} order={order} onSort={toggleSort} />
        ),
        cell: (info) => <span className="tabular text-ink-secondary">{fmtUsd(info.getValue())}</span>,
      }),
      columnHelper.display({
        id: "opportunity_bars",
        header: () => (
          <span className="flex items-center gap-1.5 whitespace-nowrap">
            <SortLabel label="Demand" col="demand" color={legColor("demand")} active={sort === "demand"} order={order} onSort={toggleSort} />
            <span className="text-ink-muted/40">/</span>
            <SortLabel label="Comp." col="competition" color={legColor("competition")} active={sort === "competition"} order={order} onSort={toggleSort} />
            <span className="text-ink-muted/40">/</span>
            <SortLabel label="Quality gap" col="quality_gap" color={legColor("quality")} active={sort === "quality_gap"} order={order} onSort={toggleSort} />
          </span>
        ),
        cell: (info) => (
          <OpportunityBars
            demand={info.row.original.demand}
            competition={info.row.original.competition}
            quality_gap={info.row.original.quality_gap}
          />
        ),
      }),
      columnHelper.accessor("opportunity", {
        header: () => (
          <SortLabel label="Opportunity" col="opportunity" active={sort === "opportunity"} order={order} onSort={toggleSort} />
        ),
        cell: (info) => {
          const v = info.getValue();
          const dotColor = v === null ? "var(--gridline)" : sequentialColorAt(v / 100, theme);
          return (
            <div className="flex items-center gap-2">
              <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: dotColor }} />
              <span className="tabular font-semibold text-ink-primary">{v !== null ? v.toFixed(1) : "—"}</span>
            </div>
          );
        },
      }),
      columnHelper.accessor("hit_rate_200k", {
        header: () => (
          <SortLabel label="Hit ≥$200K" col="hit_rate_200k" active={sort === "hit_rate_200k"} order={order} onSort={toggleSort} />
        ),
        cell: (info) => <span className="tabular text-ink-secondary">{fmtPct(info.getValue())}</span>,
      }),
      columnHelper.accessor("saturation_yoy", {
        header: () => (
          <SortLabel label="Saturation YoY" col="saturation_yoy" active={sort === "saturation_yoy"} order={order} onSort={toggleSort} />
        ),
        cell: (info) => <span className="tabular text-ink-secondary">{fmtSigned(info.getValue())}</span>,
      }),
    ],
    [columnHelper, theme, sort, order, toggleSort],
  );

  const table = useReactTable({
    data: data?.items ?? [],
    columns,
    getCoreRowModel: getCoreRowModel(),
  });

  const currentConfig: NicheViewConfig = {
    dimension,
    window: windowParam,
    min_reviews: minReviews,
    sort,
    order,
    q: debouncedQ || undefined,
  };

  function applyView(config: NicheViewConfig) {
    setDimension(config.dimension);
    setWindowParam(config.window);
    setMinReviews(config.min_reviews);
    setSort(config.sort);
    setOrder(config.order);
    setQ(config.q ?? "");
  }

  const total = data?.total ?? 0;
  const rangeStart = total === 0 ? 0 : offset + 1;
  const rangeEnd = Math.min(offset + LIMIT, total);
  const csvUrl = nicheExportCsvUrl({
    dimension,
    window: windowParam,
    min_reviews: minReviews,
    sort,
    order,
    q: debouncedQ || undefined,
    limit: 1000,
  });

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-ink-primary">Niche Finder</h1>
          <p className="mt-1 max-w-2xl text-sm text-ink-secondary">
            Rank tags and genres by opportunity — demand vs. competition vs. quality gap across the catalog.
          </p>
        </div>
        {total > 0 && (
          <span className="shrink-0 rounded-full border border-chartborder bg-surface px-3 py-1 text-xs font-medium text-ink-secondary shadow-xs">
            {total.toLocaleString()} niches
          </span>
        )}
      </div>

      <Card className="!p-3.5">
        <div className="flex flex-wrap items-center gap-2.5">
          <Segmented>
            <SegButton active={dimension === "tag"} onClick={() => setDimension("tag")}>
              Tags
            </SegButton>
            <SegButton active={dimension === "genre"} onClick={() => setDimension("genre")}>
              Genres
            </SegButton>
          </Segmented>
          <Segmented>
            <SegButton active={windowParam === "all"} onClick={() => setWindowParam("all")}>
              All-time
            </SegButton>
            <SegButton active={windowParam === "24m"} onClick={() => setWindowParam("24m")}>
              Last 24 months
            </SegButton>
          </Segmented>
          <label className="flex items-center gap-1.5 text-xs font-medium text-ink-secondary">
            Min reviews
            <input
              type="number"
              min={0}
              step={10}
              value={minReviews}
              onChange={(e) => setMinReviews(Math.max(0, Number(e.target.value) || 0))}
              className={clsx(INPUT_CLS, "w-16 px-2 py-1.5")}
            />
          </label>
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search niches…"
            className={clsx(INPUT_CLS, "w-44 px-3 py-1.5")}
          />
          <div className="ml-auto flex items-center gap-2">
            <SavedViewsMenu current={currentConfig} onApply={applyView} />
            <a
              href={csvUrl}
              className="rounded-lg border border-chartborder bg-surface px-3 py-1.5 text-xs font-medium text-ink-secondary shadow-xs transition-colors hover:bg-surface2 hover:text-ink-primary"
            >
              Export CSV
            </a>
          </div>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-chartborder pt-2.5 text-[11px] text-ink-muted">
          <span className="font-medium">Color key</span>
          {OPPORTUNITY_LEGEND.map((l) => (
            <span key={l.label} className="flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full" style={{ backgroundColor: l.color }} />
              {l.label}
            </span>
          ))}
          <span className="ml-auto hidden sm:inline">Click a column header to sort</span>
        </div>
      </Card>

      <Card className={clsx("overflow-hidden !p-0", isFetching && "opacity-90 transition-opacity")}>
        {isLoading && <div className="p-8 text-center text-sm text-ink-muted">Loading niches…</div>}
        {isError && (
          <div className="p-8 text-center text-sm text-status-serious">
            Failed to load niches{error instanceof Error ? `: ${error.message}` : "."}
          </div>
        )}
        {data && data.items.length === 0 && (
          <div className="p-8 text-center text-sm text-ink-muted">No niches match these filters.</div>
        )}
        {data && data.items.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[880px] border-collapse text-sm">
              <thead>
                {table.getHeaderGroups().map((hg) => (
                  <tr key={hg.id} className="border-b border-chartborder bg-surface2/50 text-left text-[11px]">
                    {hg.headers.map((h) => (
                      <th key={h.id} className="whitespace-nowrap px-4 py-2.5">
                        {flexRender(h.column.columnDef.header, h.getContext())}
                      </th>
                    ))}
                  </tr>
                ))}
              </thead>
              <tbody>
                {table.getRowModel().rows.map((row) => (
                  <tr
                    key={row.id}
                    className="border-b border-chartborder/70 transition-colors last:border-0 hover:bg-surface2/60"
                  >
                    {row.getVisibleCells().map((cell) => (
                      <td key={cell.id} className="whitespace-nowrap px-4 py-2.5 align-middle">
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {data && (
          <div className="flex items-center justify-between border-t border-chartborder px-4 py-2.5 text-xs text-ink-muted">
            <span>
              {total > 0
                ? `${rangeStart.toLocaleString()}–${rangeEnd.toLocaleString()} of ${total.toLocaleString()}`
                : "0 results"}
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={offset === 0}
                onClick={() => setOffset((o) => Math.max(0, o - LIMIT))}
                className="rounded-lg border border-chartborder bg-surface px-3 py-1 font-medium text-ink-secondary shadow-xs transition-colors hover:text-ink-primary disabled:pointer-events-none disabled:opacity-40"
              >
                Prev
              </button>
              <button
                type="button"
                disabled={offset + LIMIT >= total}
                onClick={() => setOffset((o) => o + LIMIT)}
                className="rounded-lg border border-chartborder bg-surface px-3 py-1 font-medium text-ink-secondary shadow-xs transition-colors hover:text-ink-primary disabled:pointer-events-none disabled:opacity-40"
              >
                Next
              </button>
            </div>
          </div>
        )}
      </Card>

      {selected && <NicheDetailDrawer dimension={dimension} row={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}

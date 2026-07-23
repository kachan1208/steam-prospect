import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { createColumnHelper, flexRender, getCoreRowModel, useReactTable } from "@tanstack/react-table";
import clsx from "clsx";

import { Card } from "../components/ui/Card";
import { useGameSearch, useGenres, type GameSearchRow, type GameSortKey } from "../lib/api";
import { fmtCompact, fmtInt, fmtPct, fmtPrice, fmtUsd } from "../lib/format";
import { useDebounced } from "../lib/useDebounced";

const LIMIT = 25;

function SortLabel({
  label,
  col,
  active,
  order,
  onSort,
}: {
  label: string;
  col: GameSortKey;
  active: boolean;
  order: "asc" | "desc";
  onSort: (col: GameSortKey) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onSort(col)}
      title={`Sort by ${label}`}
      className={clsx(
        "group inline-flex items-center gap-1 font-medium",
        active ? "text-ink-primary" : "text-ink-muted hover:text-ink-secondary",
      )}
    >
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

export default function GameSearch() {
  const navigate = useNavigate();
  const genres = useGenres();

  const [q, setQ] = useState("");
  const debouncedQ = useDebounced(q, 300);
  const [genre, setGenre] = useState("__all__");
  const [tag, setTag] = useState("");
  const debouncedTag = useDebounced(tag, 300);
  const [minReviews, setMinReviews] = useState(10);
  const [sort, setSort] = useState<GameSortKey>("total_reviews");
  const [order, setOrder] = useState<"asc" | "desc">("desc");
  const [offset, setOffset] = useState(0);

  const toggleSort = (col: GameSortKey) => {
    if (sort === col) setOrder((o) => (o === "desc" ? "asc" : "desc"));
    else {
      setSort(col);
      setOrder(col === "name" ? "asc" : "desc");
    }
  };

  useEffect(() => {
    setOffset(0);
  }, [debouncedQ, genre, debouncedTag, minReviews, sort, order]);

  const { data, isLoading, isFetching, isError, error } = useGameSearch({
    q: debouncedQ || undefined,
    tag: debouncedTag || undefined,
    genre: genre === "__all__" ? undefined : genre,
    min_reviews: minReviews,
    sort,
    order,
    limit: LIMIT,
    offset,
  });

  // Tag chips sourced from the current page's own top_tags, so users discover exact
  // tag strings (Steam's taxonomy is case/hyphenation-sensitive, e.g. "Rogue-like" vs
  // "Roguelike" are different tags) instead of guessing into an empty result set.
  const tagChips = useMemo(() => {
    const counts = new Map<string, number>();
    for (const g of data?.items ?? []) {
      for (const t of g.top_tags.slice(0, 5)) counts.set(t, (counts.get(t) ?? 0) + 1);
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12)
      .map(([t]) => t);
  }, [data?.items]);

  const columnHelper = useMemo(() => createColumnHelper<GameSearchRow>(), []);
  const columns = useMemo(
    () => [
      columnHelper.accessor("name", {
        header: () => <SortLabel label="Game" col="name" active={sort === "name"} order={order} onSort={toggleSort} />,
        cell: (info) => {
          const g = info.row.original;
          return (
            <button
              type="button"
              onClick={() => navigate(`/games/${g.appid}`)}
              className="flex items-center gap-2 text-left"
            >
              {g.header_image && (
                <img
                  src={g.header_image}
                  alt=""
                  loading="lazy"
                  className="h-9 w-16 shrink-0 rounded-sm object-cover"
                />
              )}
              <span className="min-w-0">
                <span className="block truncate font-medium text-ink-primary hover:text-series-1 hover:underline">
                  {g.name ?? `App ${g.appid}`}
                </span>
                <span className="block truncate text-[11px] text-ink-muted">
                  {g.primary_genre ?? "—"} · {g.release_year ?? "—"}
                </span>
              </span>
            </button>
          );
        },
      }),
      columnHelper.accessor("price_initial", {
        header: () => (
          <SortLabel label="Price" col="price_initial" active={sort === "price_initial"} order={order} onSort={toggleSort} />
        ),
        cell: (info) => <span className="tabular">{fmtPrice(info.getValue())}</span>,
      }),
      columnHelper.accessor("owners_mid", {
        header: () => (
          <SortLabel label="Owners" col="owners_mid" active={sort === "owners_mid"} order={order} onSort={toggleSort} />
        ),
        cell: (info) => <span className="tabular">{fmtCompact(info.getValue())}</span>,
      }),
      columnHelper.accessor("live_players", {
        header: () => (
          <SortLabel label="Live" col="live_players" active={sort === "live_players"} order={order} onSort={toggleSort} />
        ),
        cell: (info) => {
          const v = info.getValue();
          return <span className="tabular">{v != null ? fmtCompact(v) : "—"}</span>;
        },
      }),
      columnHelper.accessor("total_reviews", {
        header: () => (
          <SortLabel label="Reviews" col="total_reviews" active={sort === "total_reviews"} order={order} onSort={toggleSort} />
        ),
        cell: (info) => <span className="tabular">{fmtInt(info.getValue())}</span>,
      }),
      columnHelper.accessor("positive_ratio", {
        header: () => (
          <SortLabel label="Positive" col="positive_ratio" active={sort === "positive_ratio"} order={order} onSort={toggleSort} />
        ),
        cell: (info) => <span className="tabular">{fmtPct(info.getValue())}</span>,
      }),
      columnHelper.accessor("est_rev_reviews", {
        header: () => (
          <SortLabel
            label="Est. revenue"
            col="est_rev_reviews"
            active={sort === "est_rev_reviews"}
            order={order}
            onSort={toggleSort}
          />
        ),
        cell: (info) => <span className="tabular font-medium text-ink-primary">{fmtUsd(info.getValue())}</span>,
      }),
      columnHelper.display({
        id: "tags",
        header: "Top tags",
        cell: (info) => (
          <div className="flex max-w-[260px] flex-wrap gap-1">
            {info.row.original.top_tags.slice(0, 3).map((t) => (
              <span key={t} className="rounded-full border border-chartborder px-1.5 py-0.5 text-[10px] text-ink-secondary">
                {t}
              </span>
            ))}
          </div>
        ),
      }),
    ],
    [columnHelper, sort, order, navigate],
  );

  const table = useReactTable({ data: data?.items ?? [], columns, getCoreRowModel: getCoreRowModel() });

  const total = data?.total ?? 0;
  const rangeStart = total === 0 ? 0 : offset + 1;
  const rangeEnd = Math.min(offset + LIMIT, total);

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-lg font-semibold text-ink-primary">Games</h1>
        <p className="mt-0.5 text-sm text-ink-muted">
          Search the catalog to profile a specific title or competitor — owners, revenue, rating, and review velocity.
        </p>
      </div>

      <Card className="!p-3">
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search by name…"
            className="w-56 rounded-md border border-chartborder bg-page px-2.5 py-1.5 text-xs text-ink-primary outline-none placeholder:text-ink-muted focus:border-series-1"
          />
          <select
            value={genre}
            onChange={(e) => setGenre(e.target.value)}
            className="rounded-md border border-chartborder bg-page px-2 py-1.5 text-xs text-ink-primary outline-none focus:border-series-1"
          >
            {genres.map((g) => (
              <option key={g.value} value={g.value}>
                {g.label}
              </option>
            ))}
          </select>
          <input
            type="text"
            value={tag}
            onChange={(e) => setTag(e.target.value)}
            placeholder="Tag (exact, e.g. Rogue-like)"
            className="w-48 rounded-md border border-chartborder bg-page px-2.5 py-1.5 text-xs text-ink-primary outline-none placeholder:text-ink-muted focus:border-series-1"
          />
          <label className="flex items-center gap-1.5 text-xs text-ink-secondary">
            Min reviews
            <input
              type="number"
              min={0}
              step={10}
              value={minReviews}
              onChange={(e) => setMinReviews(Math.max(0, Number(e.target.value) || 0))}
              className="w-16 rounded-md border border-chartborder bg-page px-2 py-1 text-xs text-ink-primary outline-none focus:border-series-1"
            />
          </label>
          {tag && (
            <button
              type="button"
              onClick={() => setTag("")}
              className="rounded-md border border-chartborder px-2 py-1 text-[11px] text-ink-muted hover:text-ink-primary"
            >
              Clear tag ✕
            </button>
          )}
        </div>
        {tagChips.length > 0 && (
          <div className="mt-2 flex flex-wrap items-center gap-1.5 border-t border-chartborder pt-2">
            <span className="text-[11px] text-ink-muted">Tags in these results:</span>
            {tagChips.map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setTag(t)}
                className={clsx(
                  "rounded-full border px-2 py-0.5 text-[10px] font-medium transition-colors",
                  tag === t
                    ? "border-series-1 bg-page text-ink-primary"
                    : "border-chartborder text-ink-muted hover:text-ink-secondary",
                )}
              >
                {t}
              </button>
            ))}
          </div>
        )}
      </Card>

      <Card className={clsx("!p-0", isFetching && "opacity-90 transition-opacity")}>
        {isLoading && <div className="p-6 text-sm text-ink-muted">Loading games…</div>}
        {isError && (
          <div className="p-6 text-sm text-status-serious">
            Failed to load games{error instanceof Error ? `: ${error.message}` : "."}
          </div>
        )}
        {data && data.items.length === 0 && (
          <div className="p-6 text-sm text-ink-muted">No games match these filters.</div>
        )}
        {data && data.items.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[860px] border-collapse text-sm">
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
                  <tr
                    key={row.id}
                    className="cursor-pointer border-b border-chartborder/60 hover:bg-page"
                    onClick={() => navigate(`/games/${row.original.appid}`)}
                  >
                    {row.getVisibleCells().map((cell) => (
                      <td key={cell.id} className="px-3 py-2 align-middle">
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
          <div className="flex items-center justify-between border-t border-chartborder px-3 py-2 text-xs text-ink-muted">
            <span>
              {total > 0 ? `${rangeStart.toLocaleString()}–${rangeEnd.toLocaleString()} of ${total.toLocaleString()}` : "0 results"}
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={offset === 0}
                onClick={() => setOffset((o) => Math.max(0, o - LIMIT))}
                className="rounded-md border border-chartborder px-2.5 py-1 font-medium text-ink-secondary disabled:opacity-40"
              >
                Prev
              </button>
              <button
                type="button"
                disabled={offset + LIMIT >= total}
                onClick={() => setOffset((o) => o + LIMIT)}
                className="rounded-md border border-chartborder px-2.5 py-1 font-medium text-ink-secondary disabled:opacity-40"
              >
                Next
              </button>
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}

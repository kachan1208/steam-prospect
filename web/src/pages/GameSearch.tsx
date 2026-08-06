import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { createColumnHelper, flexRender, getCoreRowModel, useReactTable } from "@tanstack/react-table";
import clsx from "clsx";

import { Card } from "../components/ui/Card";
import { TagAutocomplete } from "../components/TagAutocomplete";
import { useGameSearch, useGenres, type GameSearchRow, type GameSortKey } from "../lib/api";
import { COMPARE_CAP, toggleCompare, useCompareList } from "../lib/compareList";
import { fmtCompact, fmtInt, fmtPct, fmtPrice, fmtRevenue, fmtUsd } from "../lib/format";
import { genreTintStyle, heatDomain, heatStyle, positiveRatioClass } from "../lib/heat";
import { useDebounced } from "../lib/useDebounced";

const LIMIT = 25;

// "New releases" windows for the release-date filter. `days` is sent as released_within_days;
// the API bounds the match to <= today, so upcoming / placeholder-dated titles are excluded.
const RELEASE_WINDOWS: { label: string; days: number | undefined }[] = [
  { label: "Any release date", days: undefined },
  { label: "New · last 30 days", days: 30 },
  { label: "New · last 90 days", days: 90 },
  { label: "New · last 6 months", days: 182 },
  { label: "New · last 12 months", days: 365 },
];

const SORT_KEYS: readonly GameSortKey[] = [
  "name", "release_year", "release_date", "price_initial", "owners_mid", "total_reviews",
  "positive_ratio", "est_rev_reviews", "rev_pct_in_genre", "reviews_pct_in_genre",
  "owners_pct_in_genre", "n_reviews_trailing_30d", "live_players",
] as const;

// ---- URL-backed filter state ---------------------------------------------------------------
// The URL is the single source of truth for every committed filter, so a research view is
// shareable and the back button walks filter history. Text/number inputs keep a local
// draft (typing shouldn't fire a request or a history write per keystroke) committed via a
// debounce with replace:true; discrete controls (selects, toggles, chips, sort, paging)
// write straight to the URL as history entries.

interface Filters {
  q: string;
  genre: string; // "__all__" = no filter
  tag: string;
  minReviews: number;
  window: number | undefined; // released_within_days
  priceMin: number | undefined;
  priceMax: number | undefined;
  minPositive: number | undefined; // 0-1
  minRevenue: number | undefined;
  after: number | undefined; // release_year >=
  before: number | undefined; // release_year <=
  selfPub: boolean | undefined;
  indie: boolean | undefined;
  sort: GameSortKey;
  order: "asc" | "desc";
  offset: number;
}

function num(sp: URLSearchParams, key: string): number | undefined {
  const raw = sp.get(key);
  if (raw === null || raw === "") return undefined;
  const v = Number(raw);
  return Number.isFinite(v) ? v : undefined;
}

function bool(sp: URLSearchParams, key: string): boolean | undefined {
  const raw = sp.get(key);
  if (raw === "1") return true;
  if (raw === "0") return false;
  return undefined;
}

function readFilters(sp: URLSearchParams): Filters {
  const sortRaw = sp.get("sort") as GameSortKey | null;
  return {
    q: sp.get("q") ?? "",
    genre: sp.get("genre") ?? "__all__",
    tag: sp.get("tag") ?? "",
    minReviews: Math.max(0, num(sp, "min_reviews") ?? 0),
    window: num(sp, "window"),
    priceMin: num(sp, "price_min"),
    priceMax: num(sp, "price_max"),
    minPositive: num(sp, "min_positive"),
    minRevenue: num(sp, "min_revenue"),
    after: num(sp, "after"),
    before: num(sp, "before"),
    selfPub: bool(sp, "self_pub"),
    indie: bool(sp, "indie"),
    sort: sortRaw && SORT_KEYS.includes(sortRaw) ? sortRaw : "total_reviews",
    order: sp.get("order") === "asc" ? "asc" : "desc",
    offset: Math.max(0, num(sp, "offset") ?? 0),
  };
}

/** The draft (text-input) slice of the filters, as canonical strings ("" = unset). */
interface Drafts {
  q: string;
  minReviews: string;
  priceMin: string;
  priceMax: string;
  minRating: string; // PERCENT in the UI (80), stored as min_positive=0.8 in the URL
  minRevenue: string;
  after: string;
  before: string;
}

function draftsFromFilters(f: Filters): Drafts {
  return {
    q: f.q,
    minReviews: f.minReviews > 0 ? String(f.minReviews) : "",
    priceMin: f.priceMin !== undefined ? String(f.priceMin) : "",
    priceMax: f.priceMax !== undefined ? String(f.priceMax) : "",
    minRating: f.minPositive !== undefined ? String(Math.round(f.minPositive * 100)) : "",
    minRevenue: f.minRevenue !== undefined ? String(f.minRevenue) : "",
    after: f.after !== undefined ? String(f.after) : "",
    before: f.before !== undefined ? String(f.before) : "",
  };
}

/** Re-parse each draft so "0080" and "80" serialize identically (echo detection relies on it). */
function canonicalizeDrafts(d: Drafts): Drafts {
  const n = (s: string, int = false): string => {
    const v = Number(s);
    if (s.trim() === "" || !Number.isFinite(v) || v < 0) return "";
    return String(int ? Math.round(v) : v);
  };
  return {
    q: d.q.trim(),
    minReviews: n(d.minReviews, true) === "0" ? "" : n(d.minReviews, true),
    priceMin: n(d.priceMin),
    priceMax: n(d.priceMax),
    minRating: (() => {
      const v = Number(d.minRating);
      if (d.minRating.trim() === "" || !Number.isFinite(v) || v <= 0) return "";
      return String(Math.min(100, Math.round(v)));
    })(),
    minRevenue: n(d.minRevenue, true),
    after: n(d.after, true),
    before: n(d.before, true),
  };
}

function urlPatchFromDrafts(d: Drafts): Record<string, string | null> {
  return {
    q: d.q || null,
    min_reviews: d.minReviews || null,
    price_min: d.priceMin || null,
    price_max: d.priceMax || null,
    min_positive: d.minRating ? String(Number(d.minRating) / 100) : null,
    min_revenue: d.minRevenue || null,
    after: d.after || null,
    before: d.before || null,
  };
}

function hasAdvanced(f: Filters): boolean {
  return (
    f.priceMin !== undefined || f.priceMax !== undefined || f.minPositive !== undefined ||
    f.minRevenue !== undefined || f.after !== undefined || f.before !== undefined ||
    f.selfPub !== undefined || f.indie !== undefined
  );
}

// ---- small UI pieces -----------------------------------------------------------------------

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

/** Format an ISO YYYY-MM-DD (fall back to the year, then em dash) without a UTC→local off-by-one. */
function fmtReleaseDate(iso: string | null, year: number | null): string {
  if (iso) {
    const d = new Date(`${iso}T00:00:00`);
    if (!Number.isNaN(d.getTime())) {
      return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
    }
  }
  return year != null ? String(year) : "—";
}

const inputCls =
  "rounded-md border border-chartborder bg-page px-2.5 py-1.5 text-xs text-ink-primary outline-none placeholder:text-ink-muted focus:border-brand";

/** Any / yes / no segmented control for the boolean-ish mart flags. */
function TriToggle({
  label,
  value,
  yesLabel,
  noLabel,
  onChange,
}: {
  label: string;
  value: boolean | undefined;
  yesLabel: string;
  noLabel: string;
  onChange: (v: boolean | undefined) => void;
}) {
  const opts: { v: boolean | undefined; label: string }[] = [
    { v: undefined, label: "Any" },
    { v: true, label: yesLabel },
    { v: false, label: noLabel },
  ];
  return (
    <label className="flex items-center gap-1.5 text-xs text-ink-secondary">
      {label}
      <span className="flex items-center gap-0.5 rounded-md bg-surface2 p-0.5">
        {opts.map((o) => (
          <button
            key={o.label}
            type="button"
            onClick={() => onChange(o.v)}
            aria-pressed={value === o.v}
            className={clsx(
              "rounded px-1.5 py-0.5 text-[11px] font-medium transition-all",
              value === o.v ? "bg-surface text-ink-primary shadow-xs" : "text-ink-muted hover:text-ink-secondary",
            )}
          >
            {o.label}
          </button>
        ))}
      </span>
    </label>
  );
}

function FilterChip({ label, onClear }: { label: string; onClear: () => void }) {
  return (
    <button
      type="button"
      onClick={onClear}
      title="Remove filter"
      className="group inline-flex items-center gap-1 rounded-full border border-brand/50 bg-page px-2 py-0.5 text-[11px] font-medium text-ink-primary hover:border-brand"
    >
      {label}
      <span aria-hidden className="text-ink-muted group-hover:text-ink-primary">✕</span>
    </button>
  );
}

/** Per-row add/remove-from-compare icon button. Stops row-click navigation. */
function CompareCell({ g }: { g: GameSearchRow }) {
  const list = useCompareList();
  const inList = list.some((e) => e.appid === g.appid);
  const full = !inList && list.length >= COMPARE_CAP;
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        toggleCompare(g.appid, g.name);
      }}
      disabled={full}
      aria-pressed={inList}
      aria-label={inList ? "Remove from compare" : "Add to compare"}
      title={
        inList
          ? "Remove from compare list"
          : full
            ? `Compare list is full (max ${COMPARE_CAP})`
            : "Add to compare list"
      }
      className={clsx(
        "flex h-6 w-6 items-center justify-center rounded-md border transition-colors",
        inList
          ? "border-brand bg-brand-tint text-brand"
          : "border-chartborder text-ink-muted hover:border-brand hover:text-brand",
        full && "cursor-not-allowed opacity-40",
      )}
    >
      {inList ? (
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
          <path d="M5 13l4 4L19 7" />
        </svg>
      ) : (
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
          <path d="M12 5v14M5 12h14" />
        </svg>
      )}
    </button>
  );
}

// ---- the page ------------------------------------------------------------------------------

export default function GameSearch() {
  const navigate = useNavigate();
  const genres = useGenres();
  const [searchParams, setSearchParams] = useSearchParams();

  const filters = useMemo(() => readFilters(searchParams), [searchParams]);

  const [drafts, setDrafts] = useState<Drafts>(() => draftsFromFilters(filters));
  const [moreOpen, setMoreOpen] = useState<boolean>(() => hasAdvanced(filters));
  // Serialized canonical drafts we last wrote to (or read from) the URL — used to tell our
  // own commit's echo apart from an external navigation (back/forward/shared link).
  const lastCommitted = useRef<string>(JSON.stringify(canonicalizeDrafts(drafts)));

  function patchParams(patch: Record<string, string | null>, opts?: { replace?: boolean; keepOffset?: boolean }) {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        for (const [k, v] of Object.entries(patch)) {
          if (v === null || v === "") next.delete(k);
          else next.set(k, v);
        }
        if (!opts?.keepOffset) next.delete("offset"); // filter/sort change restarts paging
        return next;
      },
      { replace: opts?.replace },
    );
  }

  // Commit debounced drafts -> URL (replace: typing shouldn't spam history).
  const debouncedDrafts = useDebounced(drafts, 400);
  useEffect(() => {
    const ser = JSON.stringify(canonicalizeDrafts(debouncedDrafts));
    if (ser === lastCommitted.current) return;
    lastCommitted.current = ser;
    patchParams(urlPatchFromDrafts(canonicalizeDrafts(debouncedDrafts)), { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedDrafts]);

  // External URL change (back/forward, chip removal, shared link) -> resync drafts.
  const canonicalFromUrl = useMemo(() => JSON.stringify(draftsFromFilters(filters)), [filters]);
  useEffect(() => {
    if (canonicalFromUrl === lastCommitted.current) return;
    lastCommitted.current = canonicalFromUrl;
    setDrafts(JSON.parse(canonicalFromUrl) as Drafts);
  }, [canonicalFromUrl]);

  const setDraft = (key: keyof Drafts) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setDrafts((d) => ({ ...d, [key]: e.target.value }));

  const toggleSort = (col: GameSortKey) => {
    if (filters.sort === col) {
      patchParams({ order: filters.order === "desc" ? "asc" : "desc" });
    } else {
      patchParams({ sort: col, order: col === "name" ? "asc" : "desc" });
    }
  };

  const { data, isLoading, isFetching, isError, error } = useGameSearch({
    q: filters.q || undefined,
    tag: filters.tag || undefined,
    genre: filters.genre === "__all__" ? undefined : filters.genre,
    min_reviews: filters.minReviews,
    released_within_days: filters.window,
    price_min: filters.priceMin,
    price_max: filters.priceMax,
    min_positive: filters.minPositive,
    min_revenue: filters.minRevenue,
    released_after: filters.after,
    released_before: filters.before,
    self_published: filters.selfPub,
    indie: filters.indie,
    sort: filters.sort,
    order: filters.order,
    limit: LIMIT,
    offset: filters.offset,
  });

  // Tag chips sourced from the current page's own top_tags — quick pivots into the exact
  // tag strings present in these results (complements the autocomplete).
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

  // Active non-default filters as removable chips. Chip removal writes the URL; the draft
  // resync effect above then clears the matching inputs.
  const chips = useMemo(() => {
    const out: { key: string; label: string; clear: Record<string, string | null> }[] = [];
    const f = filters;
    if (f.q) out.push({ key: "q", label: `“${f.q}”`, clear: { q: null } });
    if (f.genre !== "__all__") out.push({ key: "genre", label: f.genre, clear: { genre: null } });
    if (f.tag) out.push({ key: "tag", label: `Tag: ${f.tag}`, clear: { tag: null } });
    if (f.minReviews > 0)
      out.push({ key: "min_reviews", label: `≥ ${fmtInt(f.minReviews)} reviews`, clear: { min_reviews: null } });
    if (f.window !== undefined) {
      const w = RELEASE_WINDOWS.find((x) => x.days === f.window);
      out.push({ key: "window", label: w?.label ?? `Last ${f.window} days`, clear: { window: null } });
    }
    if (f.priceMin !== undefined || f.priceMax !== undefined) {
      const label =
        f.priceMin !== undefined && f.priceMax !== undefined
          ? `$${f.priceMin}–$${f.priceMax}`
          : f.priceMin !== undefined
            ? `≥ $${f.priceMin}`
            : `≤ $${f.priceMax}`;
      out.push({ key: "price", label, clear: { price_min: null, price_max: null } });
    }
    if (f.minPositive !== undefined)
      out.push({ key: "min_positive", label: `≥ ${Math.round(f.minPositive * 100)}% positive`, clear: { min_positive: null } });
    if (f.minRevenue !== undefined)
      out.push({ key: "min_revenue", label: `≥ ${fmtUsd(f.minRevenue)} est. rev`, clear: { min_revenue: null } });
    if (f.after !== undefined || f.before !== undefined) {
      const label =
        f.after !== undefined && f.before !== undefined
          ? `${f.after}–${f.before}`
          : f.after !== undefined
            ? `From ${f.after}`
            : `Until ${f.before}`;
      out.push({ key: "years", label, clear: { after: null, before: null } });
    }
    if (f.selfPub !== undefined)
      out.push({ key: "self_pub", label: f.selfPub ? "Self-published" : "Publisher-backed", clear: { self_pub: null } });
    if (f.indie !== undefined)
      out.push({ key: "indie", label: f.indie ? "Indie" : "Non-indie", clear: { indie: null } });
    return out;
  }, [filters]);

  const advancedCount = chips.filter((c) =>
    ["price", "min_positive", "min_revenue", "years", "self_pub", "indie"].includes(c.key),
  ).length;

  // Per-column log-scale domains over the loaded page — the heat tints are relative to
  // what's on screen (this result set), which is the comparison the researcher is making.
  const heat = useMemo(() => {
    const rows = data?.items ?? [];
    return {
      rev: heatDomain(rows, (g) => g.est_rev_reviews),
      reviews: heatDomain(rows, (g) => g.total_reviews),
      owners: heatDomain(rows, (g) => g.owners_mid),
    };
  }, [data]);

  const columnHelper = useMemo(() => createColumnHelper<GameSearchRow>(), []);
  const columns = useMemo(
    () => [
      columnHelper.accessor("name", {
        header: () => (
          <SortLabel label="Game" col="name" active={filters.sort === "name"} order={filters.order} onSort={toggleSort} />
        ),
        cell: (info) => {
          const g = info.row.original;
          return (
            // A real link (not a navigate() button) so middle-click / cmd-click "open in
            // new tab" works — opening several candidates in tabs IS the research workflow.
            <Link
              to={`/games/${g.appid}`}
              onClick={(e) => e.stopPropagation()}
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
                <span className="block truncate font-medium text-ink-primary hover:text-brand hover:underline">
                  {g.name ?? `App ${g.appid}`}
                </span>
                <span className="block truncate text-[11px] text-ink-muted">
                  {g.primary_genre ?? "—"} · {g.release_year ?? "—"}
                </span>
              </span>
            </Link>
          );
        },
      }),
      columnHelper.accessor("release_date", {
        header: () => (
          <SortLabel
            label="Released"
            col="release_date"
            active={filters.sort === "release_date"}
            order={filters.order}
            onSort={toggleSort}
          />
        ),
        cell: (info) => (
          <span className="tabular whitespace-nowrap text-ink-secondary">
            {fmtReleaseDate(info.getValue(), info.row.original.release_year)}
          </span>
        ),
      }),
      columnHelper.accessor("price_initial", {
        header: () => (
          <SortLabel
            label="Price"
            col="price_initial"
            active={filters.sort === "price_initial"}
            order={filters.order}
            onSort={toggleSort}
          />
        ),
        cell: (info) => <span className="tabular">{fmtPrice(info.getValue())}</span>,
      }),
      columnHelper.accessor("owners_mid", {
        header: () => (
          <SortLabel
            label="Owners"
            col="owners_mid"
            active={filters.sort === "owners_mid"}
            order={filters.order}
            onSort={toggleSort}
          />
        ),
        cell: (info) => (
          <span className="tabular rounded px-1.5 py-0.5" style={heatStyle(info.getValue(), ...heat.owners)}>
            {fmtCompact(info.getValue())}
          </span>
        ),
      }),
      columnHelper.accessor("live_players", {
        header: () => (
          <SortLabel
            label="Live"
            col="live_players"
            active={filters.sort === "live_players"}
            order={filters.order}
            onSort={toggleSort}
          />
        ),
        cell: (info) => {
          const v = info.getValue();
          return <span className="tabular">{v != null ? fmtCompact(v) : "—"}</span>;
        },
      }),
      columnHelper.accessor("total_reviews", {
        header: () => (
          <SortLabel
            label="Reviews"
            col="total_reviews"
            active={filters.sort === "total_reviews"}
            order={filters.order}
            onSort={toggleSort}
          />
        ),
        cell: (info) => (
          <span className="tabular rounded px-1.5 py-0.5" style={heatStyle(info.getValue(), ...heat.reviews)}>
            {fmtInt(info.getValue())}
          </span>
        ),
      }),
      columnHelper.accessor("positive_ratio", {
        header: () => (
          <SortLabel
            label="Positive"
            col="positive_ratio"
            active={filters.sort === "positive_ratio"}
            order={filters.order}
            onSort={toggleSort}
          />
        ),
        cell: (info) => (
          <span className={clsx("tabular", positiveRatioClass(info.getValue()))}>{fmtPct(info.getValue())}</span>
        ),
      }),
      columnHelper.accessor("est_rev_reviews", {
        header: () => (
          <SortLabel
            label="Est. revenue"
            col="est_rev_reviews"
            active={filters.sort === "est_rev_reviews"}
            order={filters.order}
            onSort={toggleSort}
          />
        ),
        cell: (info) => (
          <span
            className="tabular rounded px-1.5 py-0.5 font-medium text-ink-primary"
            style={heatStyle(info.getValue(), ...heat.rev)}
          >
            {fmtRevenue(info.getValue(), info.row.original.price_initial === 0)}
          </span>
        ),
      }),
      columnHelper.display({
        id: "tags",
        header: "Top tags",
        cell: (info) => (
          <div className="flex max-w-[260px] flex-wrap gap-1">
            {info.row.original.top_tags.slice(0, 3).map((t) => (
              <span
                key={t}
                className="rounded-full border px-1.5 py-0.5 text-[10px] text-ink-secondary"
                style={genreTintStyle(t)}
              >
                {t}
              </span>
            ))}
          </div>
        ),
      }),
      columnHelper.display({
        id: "compare",
        header: () => <span title="Add games to the compare list">vs</span>,
        cell: (info) => <CompareCell g={info.row.original} />,
      }),
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [columnHelper, filters.sort, filters.order, navigate, heat],
  );

  const table = useReactTable({ data: data?.items ?? [], columns, getCoreRowModel: getCoreRowModel() });

  const total = data?.total ?? 0;
  const rangeStart = total === 0 ? 0 : filters.offset + 1;
  const rangeEnd = Math.min(filters.offset + LIMIT, total);

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
            value={drafts.q}
            onChange={setDraft("q")}
            placeholder="Search by name…"
            className={clsx(inputCls, "w-56")}
          />
          <select
            value={filters.genre}
            onChange={(e) => patchParams({ genre: e.target.value === "__all__" ? null : e.target.value })}
            className="rounded-md border border-chartborder bg-page px-2 py-1.5 text-xs text-ink-primary outline-none focus:border-brand"
          >
            {genres.map((g) => (
              <option key={g.value} value={g.value}>
                {g.label}
              </option>
            ))}
          </select>
          <TagAutocomplete onSelect={(tag) => patchParams({ tag })} />
          <label className="flex items-center gap-1.5 text-xs text-ink-secondary">
            Min reviews
            <input
              type="number"
              min={0}
              step={10}
              value={drafts.minReviews}
              onChange={setDraft("minReviews")}
              placeholder="0"
              className={clsx(inputCls, "w-16 !px-2 !py-1")}
            />
          </label>
          <select
            value={filters.window ?? ""}
            onChange={(e) => {
              const v = e.target.value === "" ? null : e.target.value;
              // Narrowing to new releases → default to newest-first so the filter's intent is visible.
              patchParams(v !== null ? { window: v, sort: "release_date", order: "desc" } : { window: null });
            }}
            title="Show only recently released games (by Steam release date)"
            className="rounded-md border border-chartborder bg-page px-2 py-1.5 text-xs text-ink-primary outline-none focus:border-brand"
          >
            {RELEASE_WINDOWS.map((w) => (
              <option key={w.label} value={w.days ?? ""}>
                {w.label}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => setMoreOpen((o) => !o)}
            aria-expanded={moreOpen}
            className={clsx(
              "ml-auto inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium transition-colors",
              moreOpen || advancedCount > 0
                ? "border-brand text-ink-primary"
                : "border-chartborder text-ink-muted hover:text-ink-secondary",
            )}
          >
            More filters
            {advancedCount > 0 && (
              <span className="rounded-full bg-brand-tint px-1.5 text-[10px] font-semibold text-brand">{advancedCount}</span>
            )}
            <span aria-hidden className="text-[10px]">{moreOpen ? "▲" : "▼"}</span>
          </button>
        </div>

        {moreOpen && (
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-chartborder pt-2">
            <label className="flex items-center gap-1.5 text-xs text-ink-secondary">
              Price $
              <input type="number" min={0} value={drafts.priceMin} onChange={setDraft("priceMin")} placeholder="min" className={clsx(inputCls, "w-16 !px-2 !py-1")} />
              –
              <input type="number" min={0} value={drafts.priceMax} onChange={setDraft("priceMax")} placeholder="max" className={clsx(inputCls, "w-16 !px-2 !py-1")} />
            </label>
            <label className="flex items-center gap-1.5 text-xs text-ink-secondary" title="Floor on positive review share">
              Min rating
              <input type="number" min={0} max={100} step={5} value={drafts.minRating} onChange={setDraft("minRating")} placeholder="%" className={clsx(inputCls, "w-14 !px-2 !py-1")} />
              %
            </label>
            <label className="flex items-center gap-1.5 text-xs text-ink-secondary" title="Floor on estimated revenue (review-based)">
              Min revenue $
              <input type="number" min={0} step={10000} value={drafts.minRevenue} onChange={setDraft("minRevenue")} placeholder="e.g. 100000" className={clsx(inputCls, "w-24 !px-2 !py-1")} />
            </label>
            <label className="flex items-center gap-1.5 text-xs text-ink-secondary" title="Release year range (inclusive)">
              Year
              <input type="number" min={1997} max={2100} value={drafts.after} onChange={setDraft("after")} placeholder="from" className={clsx(inputCls, "w-16 !px-2 !py-1")} />
              –
              <input type="number" min={1997} max={2100} value={drafts.before} onChange={setDraft("before")} placeholder="to" className={clsx(inputCls, "w-16 !px-2 !py-1")} />
            </label>
            <TriToggle
              label="Publishing"
              value={filters.selfPub}
              yesLabel="Self-pub"
              noLabel="Publisher"
              onChange={(v) => patchParams({ self_pub: v === undefined ? null : v ? "1" : "0" })}
            />
            <TriToggle
              label="Indie"
              value={filters.indie}
              yesLabel="Indie"
              noLabel="Non-indie"
              onChange={(v) => patchParams({ indie: v === undefined ? null : v ? "1" : "0" })}
            />
          </div>
        )}

        {chips.length > 0 && (
          <div className="mt-2 flex flex-wrap items-center gap-1.5 border-t border-chartborder pt-2">
            <span className="text-[11px] text-ink-muted">Active filters:</span>
            {chips.map((c) => (
              <FilterChip key={c.key} label={c.label} onClear={() => patchParams(c.clear)} />
            ))}
            <button
              type="button"
              onClick={() =>
                patchParams({
                  q: null, genre: null, tag: null, min_reviews: null, window: null,
                  price_min: null, price_max: null, min_positive: null, min_revenue: null,
                  after: null, before: null, self_pub: null, indie: null,
                })
              }
              className="ml-1 text-[11px] text-ink-muted underline decoration-dotted hover:text-ink-primary"
            >
              Clear all
            </button>
          </div>
        )}

        {tagChips.length > 0 && (
          <div className="mt-2 flex flex-wrap items-center gap-1.5 border-t border-chartborder pt-2">
            <span className="text-[11px] text-ink-muted">Tags in these results:</span>
            {tagChips.map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => patchParams({ tag: t })}
                className={clsx(
                  "rounded-full border px-2 py-0.5 text-[10px] font-medium transition-colors",
                  filters.tag === t
                    ? "border-brand bg-page text-ink-primary"
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
          <div className="p-6 text-sm text-verdict-serious">
            Failed to load games{error instanceof Error ? `: ${error.message}` : "."}
          </div>
        )}
        {data && data.items.length === 0 && (
          <div className="p-6 text-sm text-ink-muted">No games match these filters.</div>
        )}
        {data && data.items.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[900px] border-collapse text-sm">
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
                disabled={filters.offset === 0}
                onClick={() =>
                  patchParams(
                    { offset: filters.offset - LIMIT > 0 ? String(filters.offset - LIMIT) : null },
                    { keepOffset: true },
                  )
                }
                className="rounded-md border border-chartborder px-2.5 py-1 font-medium text-ink-secondary transition-colors hover:bg-page hover:text-ink-primary disabled:opacity-40 disabled:hover:bg-transparent"
              >
                Prev
              </button>
              <button
                type="button"
                disabled={filters.offset + LIMIT >= total}
                onClick={() => patchParams({ offset: String(filters.offset + LIMIT) }, { keepOffset: true })}
                className="rounded-md border border-chartborder px-2.5 py-1 font-medium text-ink-secondary transition-colors hover:bg-page hover:text-ink-primary disabled:opacity-40 disabled:hover:bg-transparent"
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

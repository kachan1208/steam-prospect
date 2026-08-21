import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import clsx from "clsx";

import { TagAutocomplete } from "../components/TagAutocomplete";
import { useGameSearch, useGenres, type GameSearchRow, type GameSortKey } from "../lib/api";
import { COMPARE_CAP, toggleCompare, useCompareList } from "../lib/compareList";
import { fmtCompact, fmtInt, fmtPct, fmtRevenue, fmtUsd } from "../lib/format";
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
  "owners_pct_in_genre", "n_reviews_trailing_30d", "live_players", "metacritic_score",
] as const;

// Friendly labels for the "sorted by …" control (mockup 4e's caption, made interactive).
const SORT_LABELS: Record<GameSortKey, string> = {
  name: "name",
  release_year: "release year",
  release_date: "release date",
  price_initial: "price",
  owners_mid: "owners",
  total_reviews: "review count",
  positive_ratio: "rating",
  est_rev_reviews: "est. revenue",
  rev_pct_in_genre: "revenue percentile",
  reviews_pct_in_genre: "review percentile",
  owners_pct_in_genre: "owner percentile",
  n_reviews_trailing_30d: "review velocity (30d)",
  live_players: "live players",
  lifetime_months: "lifetime",
  metacritic_score: "metacritic",
};

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
  minMetacritic: number | undefined; // critic score floor (only ~2.6% of games have one)
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
    minMetacritic: num(sp, "min_metacritic"),
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
  minMetacritic: string;
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
    minMetacritic: f.minMetacritic !== undefined ? String(f.minMetacritic) : "",
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
    minMetacritic: (() => {
      const v = Number(d.minMetacritic);
      if (d.minMetacritic.trim() === "" || !Number.isFinite(v) || v <= 0) return "";
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
    min_metacritic: d.minMetacritic || null,
    min_revenue: d.minRevenue || null,
    after: d.after || null,
    before: d.before || null,
  };
}

function hasAdvanced(f: Filters): boolean {
  return (
    f.priceMin !== undefined || f.priceMax !== undefined || f.minPositive !== undefined ||
    f.minMetacritic !== undefined || f.minRevenue !== undefined || f.after !== undefined || f.before !== undefined ||
    f.selfPub !== undefined || f.indie !== undefined
  );
}

/** Everything that lives behind the "More filters" control (4e pictures only the search
 * field, the chip row and the result rows — every other control, quick or advanced, is
 * folded into one collapsible panel so it doesn't sit between the mockup's pictured
 * elements). True if the panel should start open, e.g. a shared/back-navigated URL already
 * has one of these set — the researcher shouldn't have to know to click a button to see
 * why their results are narrowed. */
function hasAnyFilterPanelValue(f: Filters): boolean {
  return (
    hasAdvanced(f) || f.genre !== "__all__" || f.tag !== "" || f.minReviews > 0 || f.window !== undefined
  );
}

// ---- small UI pieces -----------------------------------------------------------------------

// Condensed heading stack, matching the global h1–h6 / .kicker rule in index.css — applied
// inline here because these are <span>s inside a result row, not heading elements.
const HEADING_FONT = '"Barlow Condensed", "Barlow", system-ui, sans-serif';

// Capsule placeholder: 45°-diagonal paper-12% stripes (mockup 4e), for games with no
// header_image on this mart.
const placeholderStripeStyle: React.CSSProperties = {
  backgroundImage:
    "repeating-linear-gradient(45deg, color-mix(in srgb, var(--text-primary) 12%, transparent) 0 4px, transparent 4px 8px)",
};

/** Format an ISO YYYY-MM-DD (fall back to the year, then em dash) without a UTC→local off-by-one.
 * Month+year only — the row caption has room for a short date, not the full one. */
function fmtReleaseMonthYear(iso: string | null, year: number | null): string {
  if (iso) {
    const d = new Date(`${iso}T00:00:00`);
    if (!Number.isNaN(d.getTime())) {
      return d.toLocaleDateString(undefined, { year: "numeric", month: "short" });
    }
  }
  return year != null ? String(year) : "—";
}

const inputCls =
  "border border-chartborder bg-page px-2.5 py-1.5 text-xs text-ink-primary outline-none placeholder:text-ink-muted focus:border-brand";
const selectCls =
  "border border-chartborder bg-page px-2 py-1.5 text-xs text-ink-primary outline-none focus:border-brand";

/** Any / yes / no segmented control for the boolean-ish mart flags — square-cornered, selected
 * cell = accent fill + accent-fg text (the same segmented-control grammar as the Niche Finder). */
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
      <span className="inline-flex border border-chartborder">
        {opts.map((o, i) => (
          <button
            key={o.label}
            type="button"
            onClick={() => onChange(o.v)}
            aria-pressed={value === o.v}
            className={clsx(
              "px-2 py-1 text-[11px] font-medium transition-colors",
              i > 0 && "border-l border-chartborder",
              value === o.v ? "bg-brand text-brand-fg" : "text-ink-muted hover:text-ink-secondary",
            )}
          >
            {o.label}
          </button>
        ))}
      </span>
    </label>
  );
}

/** Active-filter chip — outline accent, accent TEXT (mockup 4e's "released 24m" chip: both
 * the border and the label itself carry accent-300, not paper). Every chip rendered here
 * represents a filter that IS applied, so it always wears the "active" state; the mockup's
 * "inactive" paper-30% chips describe categories with nothing set, which this page already
 * represents by omitting the chip entirely — an empty row is a more honest read than a row
 * of chips reading "any". The ✕ (remove) isn't pictured but keeps the chip functional. */
function FilterChip({ label, onClear }: { label: string; onClear: () => void }) {
  return (
    <button
      type="button"
      onClick={onClear}
      title="Remove filter"
      className="group inline-flex items-center gap-1 border border-brand px-2 py-0.5 text-[11px] font-medium text-brand transition-colors hover:bg-brand-tint"
    >
      {label}
      <span aria-hidden className="text-ink-muted group-hover:text-brand">✕</span>
    </button>
  );
}

/** Lucide "search" glyph (hand-inlined — the codebase doesn't depend on lucide-react), 1.5
 * stroke per the design system's icon rule. */
function SearchIcon({ className }: { className?: string }) {
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
        "flex h-6 w-6 shrink-0 items-center justify-center border transition-colors",
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
  const [moreOpen, setMoreOpen] = useState<boolean>(() => hasAnyFilterPanelValue(filters));
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

  // Column-header sorting became a compact "sorted by …" control (mockup 4e has no header
  // row) — same URL-backed sort/order state and the same toggle-on-reselect behavior.
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
    min_metacritic: filters.minMetacritic,
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
    if (f.minMetacritic !== undefined)
      out.push({ key: "min_metacritic", label: `≥ ${f.minMetacritic} Metacritic`, clear: { min_metacritic: null } });
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

  // Badge on "More filters" — every chip except the search box itself, since q has its own
  // field and everything else now lives behind this one control.
  const advancedCount = chips.filter((c) => c.key !== "q").length;

  const total = data?.total ?? 0;
  const rangeStart = total === 0 ? 0 : filters.offset + 1;
  const rangeEnd = Math.min(filters.offset + LIMIT, total);

  return (
    <div className="flex flex-col gap-4">
      {/* Visually hidden — the nav's "Games" link already orients the page; the mockup goes
          straight from nav to the search field with no title block. */}
      <h1 className="sr-only">Games</h1>

      {/* Large blueprint search field (4e): Lucide search glyph, accent caret, result count
          right in paper 55%. */}
      <div className="blueprint flex items-center gap-3 px-[18px] py-3" style={{ borderColor: "var(--border-strong)" }}>
        <i className="bp-corner" />
        <SearchIcon className="shrink-0 text-brand" />
        <input
          type="search"
          value={drafts.q}
          onChange={setDraft("q")}
          placeholder="Search by name…"
          aria-label="Search games by name"
          className="min-w-0 flex-1 bg-transparent text-[15px] text-ink-primary outline-none caret-brand placeholder:text-ink-muted"
        />
        <span className="shrink-0 whitespace-nowrap text-xs text-ink-muted">
          {isLoading ? "…" : `${total.toLocaleString()} match${total === 1 ? "" : "es"}`}
        </span>
      </div>

      {/* Filter chip row (4e): active filters as accent chips + "sorted by …" caption right —
          exactly what's pictured, plus one addition the mock doesn't draw: "More filters",
          the explicit control every OTHER filter (genre, tag, min reviews, release window,
          price, rating, Metacritic, revenue, year range, publishing, indie) now lives behind.
          Rather than sit those controls in an unpictured row between the search field and this
          one, they're collapsed into the panel directly below, off by default. */}
      <div className="flex flex-wrap items-center gap-2 text-xs">
        {chips.length > 0 && (
          <>
            <span className="text-ink-muted">Filter:</span>
            {chips.map((c) => (
              <FilterChip key={c.key} label={c.label} onClear={() => patchParams(c.clear)} />
            ))}
            <button
              type="button"
              onClick={() =>
                patchParams({
                  q: null, genre: null, tag: null, min_reviews: null, window: null,
                  price_min: null, price_max: null, min_positive: null, min_revenue: null,
                  min_metacritic: null,
                  after: null, before: null, self_pub: null, indie: null,
                })
              }
              className="text-ink-muted underline decoration-dotted hover:text-ink-primary"
            >
              Clear all
            </button>
          </>
        )}
        <span className="ml-auto flex items-center gap-3">
          <button
            type="button"
            onClick={() => setMoreOpen((o) => !o)}
            aria-expanded={moreOpen}
            className={clsx(
              "inline-flex items-center gap-1.5 border px-2.5 py-1 text-[11px] font-medium transition-colors",
              moreOpen || advancedCount > 0
                ? "border-brand text-brand"
                : "border-chartborder text-ink-muted hover:text-ink-secondary",
            )}
          >
            More filters
            {advancedCount > 0 && (
              <span className="bg-brand-tint px-1.5 text-[10px] font-semibold text-brand">{advancedCount}</span>
            )}
            <span aria-hidden className="text-[10px]">{moreOpen ? "▲" : "▼"}</span>
          </button>
          <span className="flex items-center gap-1.5 text-ink-muted">
            sorted by
            <select
              value={filters.sort}
              onChange={(e) => toggleSort(e.target.value as GameSortKey)}
              aria-label="Sort by"
              className="cursor-pointer bg-transparent text-ink-secondary outline-none hover:text-ink-primary"
            >
              {SORT_KEYS.map((k) => (
                <option key={k} value={k}>
                  {SORT_LABELS[k]}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => toggleSort(filters.sort)}
              title={`Currently sorted ${filters.order === "desc" ? "highest first" : "lowest first"} — click to flip`}
              className="text-ink-secondary hover:text-ink-primary"
              aria-label="Toggle sort direction"
            >
              {filters.order === "desc" ? "▼" : "▲"}
            </button>
          </span>
        </span>
      </div>

      {/* Every filter not pictured in 4e, quick or advanced, behind the one explicit control
          above — off by default so the page opens on exactly what the mock draws. */}
      {moreOpen && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-chartborder pt-3">
          <select
            value={filters.genre}
            onChange={(e) => patchParams({ genre: e.target.value === "__all__" ? null : e.target.value })}
            className={selectCls}
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
            className={selectCls}
          >
            {RELEASE_WINDOWS.map((w) => (
              <option key={w.label} value={w.days ?? ""}>
                {w.label}
              </option>
            ))}
          </select>
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
          <label
            className="flex items-center gap-1.5 text-xs text-ink-secondary"
            title="Floor on the Metacritic critic score. Only ~2.6% of games have one (Steam links a Metacritic page for few titles), so this narrows results to critically-covered games — it is a benchmarking lens, not a way to size a niche."
          >
            Metacritic ≥
            <input type="number" min={0} max={100} step={5} value={drafts.minMetacritic} onChange={setDraft("minMetacritic")} placeholder="e.g. 75" className={clsx(inputCls, "w-16 !px-2 !py-1")} />
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

      {/* Result rows — hairline top rules, not cards (4e). */}
      <div className={clsx(isFetching && "opacity-90 transition-opacity")}>
        {isLoading && <div className="py-6 text-sm text-ink-muted">Loading games…</div>}
        {isError && (
          <div className="py-6 text-sm text-verdict-serious">
            Failed to load games{error instanceof Error ? `: ${error.message}` : "."}
          </div>
        )}
        {data && data.items.length === 0 && (
          <div className="py-6 text-sm text-ink-muted">No games match these filters.</div>
        )}
        {data && data.items.length > 0 && (
          <div className="border-b border-line-grid">
            {data.items.map((g, i) => {
              const isTop = i === 0 && filters.offset === 0;
              const metaParts = [
                ...(g.top_tags.length > 0 ? g.top_tags.slice(0, 2) : g.primary_genre ? [g.primary_genre] : []),
                fmtReleaseMonthYear(g.release_date, g.release_year),
              ].filter((p) => p && p !== "—");
              return (
                <div
                  key={g.appid}
                  onClick={() => navigate(`/games/${g.appid}`)}
                  // Capsule+name and the metric group stack on narrow viewports (below `sm`)
                  // instead of clipping — the 4e mock (an 880px desktop canvas) doesn't specify
                  // mobile behavior, so this is an extrapolation, not a pictured requirement.
                  className="flex cursor-pointer flex-col gap-2 border-t border-line-grid px-1 py-3.5 transition-colors hover:bg-surface2 sm:flex-row sm:items-center sm:gap-4"
                >
                  <div className="flex min-w-0 items-center gap-4 sm:flex-1">
                    {g.header_image ? (
                      <img
                        src={g.header_image}
                        alt=""
                        loading="lazy"
                        className="h-[45px] w-24 shrink-0 object-cover"
                      />
                    ) : (
                      <span aria-hidden className="h-[45px] w-24 shrink-0" style={placeholderStripeStyle} />
                    )}
                    {/* A real link (not a navigate() button) so middle-click / cmd-click
                        "open in new tab" works — opening several candidates in tabs IS the
                        research workflow. */}
                    <Link
                      to={`/games/${g.appid}`}
                      onClick={(e) => e.stopPropagation()}
                      className="min-w-0 flex-1"
                    >
                      <span
                        className="block truncate text-[17px] font-semibold text-ink-primary hover:text-brand hover:underline"
                        style={{ fontFamily: HEADING_FONT }}
                      >
                        {g.name ?? `App ${g.appid}`}
                      </span>
                      <span className="block truncate text-xs text-ink-secondary">
                        {metaParts.length > 0 ? metaParts.join(" · ") : "—"}
                      </span>
                    </Link>
                  </div>
                  <div className="flex items-center justify-between gap-4 sm:ml-auto sm:w-auto sm:shrink-0 sm:justify-end">
                    <span className="w-[90px] shrink-0 text-[13px] text-ink-primary">
                      {fmtPct(g.positive_ratio, 0)} · {fmtCompact(g.total_reviews)}
                    </span>
                    <span
                      className={clsx("w-20 shrink-0 truncate text-[16px] font-semibold", isTop ? "text-brand" : "text-ink-primary")}
                      style={{ fontFamily: HEADING_FONT }}
                    >
                      {fmtRevenue(g.est_rev_reviews, g.price_initial === 0)}
                    </span>
                    {/* The 4e mock shows a "players 7d ▲/▼" verdict; the search API doesn't
                        expose a 7-day trend (only a point-in-time live count), so this shows
                        the real current count instead of fabricating a change figure. */}
                    <span
                      className="w-[70px] shrink-0 text-[13px] text-ink-muted"
                      title="Live players right now — a 7-day trend isn't available from this endpoint."
                    >
                      {g.live_players != null ? `${fmtCompact(g.live_players)} live` : "—"}
                    </span>
                    <CompareCell g={g} />
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Quick tag pivots sourced from this page's own results — not pictured in 4e (which
          ends at the result rows), so this sits below them rather than between the chip row
          and the list. */}
      {tagChips.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          <span className="text-ink-muted">Tags in these results:</span>
          {tagChips.map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => patchParams({ tag: t })}
              className={clsx(
                "border px-2 py-0.5 text-[10px] font-medium transition-colors",
                filters.tag === t
                  ? "border-brand text-brand"
                  : "border-chartborder text-ink-muted hover:border-borderstrong hover:text-ink-secondary",
              )}
            >
              {t}
            </button>
          ))}
        </div>
      )}

      {data && (
        <div className="flex items-center justify-between border-t border-chartborder pt-3 text-xs text-ink-muted">
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
              className="border border-chartborder px-2.5 py-1 font-medium text-ink-secondary transition-colors hover:bg-surface2 hover:text-ink-primary disabled:opacity-45 disabled:hover:bg-transparent"
            >
              Prev
            </button>
            <button
              type="button"
              disabled={filters.offset + LIMIT >= total}
              onClick={() => patchParams({ offset: String(filters.offset + LIMIT) }, { keepOffset: true })}
              className="border border-chartborder px-2.5 py-1 font-medium text-ink-secondary transition-colors hover:bg-surface2 hover:text-ink-primary disabled:opacity-45 disabled:hover:bg-transparent"
            >
              Next
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import clsx from "clsx";

import { TagAutocomplete } from "../components/TagAutocomplete";
import { FilterBar } from "../components/search/FilterChip";
import {
  MetricCell,
  ResultHeader,
  ResultList,
  ResultRow,
  ResultTitle,
  RevenueCell,
} from "../components/search/ResultList";
import { ResultChipRow, topValues } from "../components/search/ResultChipRow";
import { MAX_OFFSET, PAGE_LIMIT, ResultsFooter } from "../components/search/ResultsFooter";
import { ScopeNote } from "../components/search/ScopeNote";
import { SearchBar } from "../components/search/SearchBar";
import { Segmented } from "../components/search/Segmented";
import { SortControl, sortPatch } from "../components/search/SortControl";
import { EmptyState } from "../components/ui/EmptyState";
import { ErrorState } from "../components/ui/ErrorState";
import { HeaderLabel } from "../components/ui/HeaderLabel";
import { Loading } from "../components/ui/Loading";
import { SentinelTag } from "../components/ui/SentinelTag";
import { useGameSearch, useGenres, type GameSearchRow, type GameSortKey, type Scope } from "../lib/api";
import { COMPARE_CAP, toggleCompare, useCompareList } from "../lib/compareList";
import {
  fmtCompact,
  fmtInt,
  fmtIsoDate,
  fmtPct,
  fmtRevenueFor,
  fmtUsd,
  PRICE_UNKNOWN,
  PRICE_UNKNOWN_NOTE,
  priceKind,
} from "../lib/format";
import { glossary } from "../lib/glossary";
import { releaseCaption } from "../lib/lifecycle";
import { useDebounced } from "../lib/useDebounced";
import { usePageTitle } from "../lib/usePageTitle";

const LIMIT = PAGE_LIMIT;

/** The glossary's Est. revenue caveats plus the "Price unknown" sentinel this page prints. */
const EST_REVENUE_NOTES = `${glossary("est_revenue").notes ?? ""} ${PRICE_UNKNOWN_NOTE}`;

// The paging cliff (MAX_OFFSET) and the footer that stops at it live in
// components/search/ResultsFooter — shared with /studios, whose API caps offset the same way.
// api/app/routers/games.py: `released_after` / `released_before` are Query(None, ge=1970, le=2100). These
// two were the only filters on the page that passed a raw draft through — every sibling
// already clamped (min_metacritic and min_positive to their maxima, price_min/min_reviews
// at 0), so typing "2020" one digit at a time fired `after=2` and `after=202`, each a 422.
const MIN_YEAR = 1970;
const MAX_YEAR = 2100;

// Which games the page shows (2026-09-23). The API default is every game, which opened this
// page on Counter-Strike and Dota 2 — nothing a solo developer can benchmark against — so the
// PAGE defaults to Steam's Indie flag and says so (ScopeNote). "All games" is one click and
// rides the URL as ?scope=all; the default is omitted, like every other default here.
const SCOPES: readonly { value: Scope; label: string; title: string }[] = [
  { value: "indie", label: "Indie", title: "Games Steam flags Indie — the default" },
  { value: "all", label: "All games", title: "Every game, big studios included" },
];

// "New releases" windows for the release-date filter. `days` is sent as released_within_days;
// the API anchors the window on the data's own as-of date (not today's) and bounds it there,
// so upcoming / placeholder-dated titles are excluded — the response echoes that date.
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
// The metric names are the glossary's (lib/glossary.ts) — "Est. revenue", "Positive
// reviews", "Players now", "rank vs genre" — so the sort control and the columns agree.
const SORT_LABELS: Record<GameSortKey, string> = {
  name: "name",
  release_year: "release year",
  release_date: "release date",
  price_initial: "launch price",
  owners_mid: "owners (SteamSpy)",
  total_reviews: "reviews",
  positive_ratio: "positive reviews",
  est_rev_reviews: "est. revenue",
  rev_pct_in_genre: "revenue rank vs genre",
  reviews_pct_in_genre: "reviews rank vs genre",
  owners_pct_in_genre: "owners rank vs genre",
  n_reviews_trailing_30d: "reviews, last 30 days",
  live_players: "players now",
  lifetime_months: "lifetime",
  metacritic_score: "Metacritic score",
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
  /** Which population: Steam's Indie-flagged games (the default) or all of them. */
  scope: Scope;
  /** Legacy ?indie=0 ("non-indie only") — kept working for old links; forces scope=all,
   * since the API rejects scope=indie together with indie=false. */
  nonIndie: boolean;
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
  // The old Any/Indie/Non-indie toggle wrote ?indie=1|0. Its "Indie" is now the page's
  // default scope; its "Non-indie" still works, as an explicit filter on the all-games scope.
  const legacyIndie = bool(sp, "indie");
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
    // The URL is the funnel every request goes through, so the API's bounds are enforced
    // HERE, not only on the draft inputs — otherwise a shared/back-navigated
    // /games?after=202 or /games?offset=10025 sails straight into a 422 that no keystroke
    // can undo. Both were reproduced on production 2026-09-01.
    after: yearOrUndefined(num(sp, "after")),
    before: yearOrUndefined(num(sp, "before")),
    selfPub: bool(sp, "self_pub"),
    scope: legacyIndie === true ? "indie" : legacyIndie === false || sp.get("scope") === "all" ? "all" : "indie",
    nonIndie: legacyIndie === false,
    sort: sortRaw && SORT_KEYS.includes(sortRaw) ? sortRaw : "total_reviews",
    order: sp.get("order") === "asc" ? "asc" : "desc",
    offset: Math.min(MAX_OFFSET, Math.max(0, num(sp, "offset") ?? 0)),
  };
}

/** Undefined (no filter) unless the value is a usable year — see canonicalYear. */
function yearOrUndefined(v: number | undefined): number | undefined {
  if (v === undefined || v < 1000) return undefined;
  return Math.min(MAX_YEAR, Math.max(MIN_YEAR, Math.round(v)));
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
    after: canonicalYear(n(d.after, true)),
    before: canonicalYear(n(d.before, true)),
  };
}

/**
 * A year draft, canonicalized the way every other numeric filter on this page already is.
 *
 * Years are the one filter whose PREFIXES are all invalid: typing 2020 passes through "2",
 * "20" and "202", and each of those was committed and rejected (422) on its own — verified
 * against production 2026-09-01. Under four digits the value is still being typed, so it is
 * DROPPED rather than clamped: unfiltered results while you type beat results that swing to
 * "everything since 1970" and back. Dropping an unusable bound is the same call this page
 * already makes for a negative price_min. A complete year is then clamped into the API's
 * own 1970-2100 band, exactly as minRating/minMetacritic clamp to 0-100 above.
 */
function canonicalYear(s: string): string {
  if (s === "") return "";
  const v = Number(s);
  if (!Number.isFinite(v) || v < 1000) return "";
  return String(Math.min(MAX_YEAR, Math.max(MIN_YEAR, Math.round(v))));
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
    f.selfPub !== undefined || f.nonIndie
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
// The search field, filter chips, "sorted by" control, result rows, "in these results" chips
// and the paging footer are shared with /studios (components/search/*) — this page owns only
// what /studios has no counterpart for: the filter panel and the compare button.

// Capsule placeholder: 45°-diagonal paper-12% stripes (mockup 4e), for games with no
// header_image on this mart.
const placeholderStripeStyle: React.CSSProperties = {
  backgroundImage:
    "repeating-linear-gradient(45deg, color-mix(in srgb, var(--text-primary) 12%, transparent) 0 4px, transparent 4px 8px)",
};


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
  usePageTitle("Games");
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
  const toggleSort = (col: GameSortKey) => patchParams(sortPatch(filters.sort, filters.order, col, ["name"]));

  const { data, isLoading, isFetching, isError, error, refetch } = useGameSearch({
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
    // Only the legacy "non-indie" link sends the flag; the scope carries "indie" itself.
    indie: filters.nonIndie ? false : undefined,
    scope: filters.scope,
    sort: filters.sort,
    order: filters.order,
    limit: LIMIT,
    offset: filters.offset,
  });

  // The scope is a VIEW of the catalog, like /studios' role — not a filter chip, and not
  // something "Clear all" resets. Switching it drops the legacy ?indie= so the two can't
  // contradict each other (the API 422s scope=indie with indie=false).
  const setScope = (next: Scope) => patchParams({ scope: next === "all" ? "all" : null, indie: null });

  // Tag chips sourced from the current page's own top_tags — quick pivots into the exact
  // tag strings present in these results (complements the autocomplete).
  const tagChips = useMemo(() => topValues(data?.items ?? [], (g) => g.top_tags, 5, 12), [data?.items]);

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
      // The API anchors the window on the data's as-of date and echoes it: say which days
      // "the last 30" are, since the data can be a few days behind the calendar.
      const asOf = data?.data_as_of ? ` to ${fmtIsoDate(data.data_as_of)}` : "";
      out.push({ key: "window", label: `${w?.label ?? `Last ${f.window} days`}${asOf}`, clear: { window: null } });
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
    // Removing it stays on "All games" — the view it was taken from.
    if (f.nonIndie) out.push({ key: "indie", label: "Non-indie only", clear: { indie: null, scope: "all" } });
    return out;
  }, [filters, data?.data_as_of]);

  // Badge on "More filters" — every chip except the search box itself, since q has its own
  // field and everything else now lives behind this one control.
  const advancedCount = chips.filter((c) => c.key !== "q").length;

  const total = data?.total ?? 0;

  return (
    <div className="flex flex-col gap-4">
      {/* Visually hidden — the nav's "Games" link already orients the page; the mockup goes
          straight from nav to the search field with no title block. */}
      <h1 className="sr-only">Games</h1>

      {/* Large blueprint search field (4e): Lucide search glyph, accent caret, result count
          right in paper 55%. */}
      <SearchBar
        value={drafts.q}
        onChange={(q) => setDrafts((d) => ({ ...d, q }))}
        placeholder="Search by name…"
        ariaLabel="Search games by name"
        total={total}
        loading={isLoading}
      />

      {/* Filter chip row (4e): active filters as accent chips + "sorted by …" caption right —
          exactly what's pictured, plus one addition the mock doesn't draw: "More filters",
          the explicit control every OTHER filter (genre, tag, min reviews, release window,
          price, rating, Metacritic, revenue, year range, publishing, indie) now lives behind.
          Rather than sit those controls in an unpictured row between the search field and this
          one, they're collapsed into the panel directly below, off by default. */}
      <FilterBar
        leading={<Segmented options={SCOPES} value={filters.scope} onChange={setScope} ariaLabel="Which games" />}
        chips={chips.map((c) => ({ key: c.key, label: c.label, onClear: () => patchParams(c.clear) }))}
        onClearAll={() =>
          patchParams({
            q: null, genre: null, tag: null, min_reviews: null, window: null,
            price_min: null, price_max: null, min_positive: null, min_revenue: null,
            min_metacritic: null,
            after: null, before: null, self_pub: null, indie: null,
            // Clearing filters keeps the view the reader is on.
            scope: filters.scope === "all" ? "all" : null,
          })
        }
        trailing={
          <>
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
            <SortControl keys={SORT_KEYS} labels={SORT_LABELS} sort={filters.sort} order={filters.order} onSort={toggleSort} />
          </>
        }
      />

      {/* Which population these results are, and what the default leaves out — stated where
          the results are, from the scope the API actually APPLIED. The line's height is held
          while the first page loads, so the rows don't jump down when it appears. */}
      <div className="min-h-[18px]">
        {data && (
          <ScopeNote
            requested={filters.scope}
            applied={data.scope}
            unknown={data.n_scope_unknown}
            noun="games"
            definition="Games the developer flagged Indie on their Steam store page (Steam's own Indie genre). Games whose flag we haven't read yet — mostly very recent releases — are left out rather than guessed, and counted here."
            formula="is_indie = 1 on the game's Steam record; unknown flags excluded and counted"
          />
        )}
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
          {/* The old Any / Indie / Non-indie toggle is gone: "Indie" is the page's scope now
              (the Indie | All games control above), and a second indie control beside it
              could only contradict it. A shared ?indie=0 link still works — as the removable
              "Non-indie only" chip on the All games view. */}
        </div>
      )}

      {/* Result rows — hairline top rules, not cards (4e). */}
      <div className={clsx(isFetching && "opacity-90 transition-opacity")}>
        {isLoading && <Loading label="Loading games…" className="py-6 text-sm" />}
        {/* Was `error.message` in raw, which printed the API's whole pydantic 422 array on
            /games?offset=10025 and /games?after=202 (both measured on production
            2026-09-01) and a bare "Failed to fetch" with the API unreachable. */}
        {isError && (
          <ErrorState title="Couldn't load games" error={error} onRetry={() => void refetch()} className="py-6" />
        )}
        {data && data.items.length === 0 && (
          <EmptyState
            title="No games match these filters"
            description="Loosen a filter, widen the release window, or clear the search to see more of the catalog."
          />
        )}
        {data && data.items.length > 0 && (
          <ResultList>
            {/* Column headers (see ResultHeader for why 4e's header-less rows grew them).
                Widths/gaps mirror the metric group below EXACTLY — change one, change both.
                Each explains itself with the glossary's ⓘ — which is also what fixed the
                revenue header contradicting every other page: it said the owners-per-review
                ratio was "genre-fitted"; the estimate every page prints uses a flat 30. */}
            <ResultHeader lead="Game" stackBelow="md">
              <span className="w-[72px] shrink-0">
                <HeaderLabel term="positive_ratio" label="Positive" style={{}} />
              </span>
              <span className="w-16 shrink-0">
                <HeaderLabel term="reviews" style={{}} />
              </span>
              <span className="w-24 shrink-0">
                <HeaderLabel term="est_revenue" info={{ notes: EST_REVENUE_NOTES }} style={{}} />
              </span>
              <span className="w-[84px] shrink-0">
                <HeaderLabel term="players_now" style={{}} />
              </span>
              <span className="w-6 shrink-0 text-center">
                <span className="sr-only">Add to compare</span>
                <span aria-hidden>+</span>
              </span>
            </ResultHeader>
            {data.items.map((g, i) => {
              const isTop = i === 0 && filters.offset === 0;
              const metaParts = [
                ...(g.top_tags.length > 0 ? g.top_tags.slice(0, 2) : g.primary_genre ? [g.primary_genre] : []),
                releaseCaption(g),
              ].filter((p): p is string => !!p);
              const kind = priceKind(g);
              return (
                <ResultRow
                  key={g.appid}
                  stackBelow="md"
                  onOpen={() => navigate(`/games/${g.appid}`)}
                  lead={
                    <>
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
                      <ResultTitle
                        to={`/games/${g.appid}`}
                        name={g.name ?? `App ${g.appid}`}
                        meta={metaParts.length > 0 ? metaParts.join(" · ") : "no tags or release date yet"}
                      />
                    </>
                  }
                  metrics={
                    <>
                      <MetricCell label="Positive" width="w-[72px]" stackBelow="md" className="text-ink-primary">
                        {g.positive_ratio != null ? fmtPct(g.positive_ratio, 0) : <SentinelTag>no reviews</SentinelTag>}
                      </MetricCell>
                      <MetricCell label="Reviews" width="w-16" stackBelow="md" className="text-ink-primary">
                        {g.total_reviews != null ? fmtCompact(g.total_reviews) : <SentinelTag>no data</SentinelTag>}
                      </MetricCell>
                      <RevenueCell top={isTop} stackBelow="md">
                        {kind === "unknown" ? (
                          <SentinelTag>{PRICE_UNKNOWN}</SentinelTag>
                        ) : kind === "free" || g.est_rev_reviews != null ? (
                          fmtRevenueFor(g, g.est_rev_reviews)
                        ) : (
                          <SentinelTag>no estimate</SentinelTag>
                        )}
                      </RevenueCell>
                      {/* The 4e mock shows a "players 7d ▲/▼" verdict; the search API doesn't
                          expose a 7-day trend (only a point-in-time count), so this shows the
                          real current count instead of fabricating a change figure. A game
                          outside the nightly capture says so rather than printing a dash. */}
                      <MetricCell label="Players now" width="w-[84px]" stackBelow="md" className="text-ink-secondary">
                        {g.live_players != null ? fmtCompact(g.live_players) : <SentinelTag>not measured</SentinelTag>}
                      </MetricCell>
                      <CompareCell g={g} />
                    </>
                  }
                />
              );
            })}
          </ResultList>
        )}
      </div>

      {/* Quick tag pivots sourced from this page's own results — not pictured in 4e (which
          ends at the result rows), so this sits below them rather than between the chip row
          and the list. */}
      <ResultChipRow
        label="Tags in these results:"
        items={tagChips}
        active={filters.tag}
        onPick={(t) => patchParams({ tag: t })}
      />

      {data && (
        <ResultsFooter
          total={total}
          offset={filters.offset}
          limit={LIMIT}
          // Page 1 has no ?offset= — the URL stays clean and identical to a fresh /games.
          onPage={(offset) => patchParams({ offset: offset > 0 ? String(offset) : null }, { keepOffset: true })}
        />
      )}
    </div>
  );
}

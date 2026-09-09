import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import clsx from "clsx";

import { FilterBar } from "../components/search/FilterChip";
import { ResultChipRow, topValues } from "../components/search/ResultChipRow";
import { ResultHeader, ResultList, ResultRow, ResultTitle, RevenueCell } from "../components/search/ResultList";
import { MAX_OFFSET, PAGE_LIMIT, ResultsFooter } from "../components/search/ResultsFooter";
import { SearchBar } from "../components/search/SearchBar";
import { Segmented } from "../components/search/Segmented";
import { SortControl, sortPatch } from "../components/search/SortControl";
import { EmptyState } from "../components/ui/EmptyState";
import { ErrorState } from "../components/ui/ErrorState";
import { Loading } from "../components/ui/Loading";
import { ApiError, useEntitySearch, type EntityRole, type EntitySortKey } from "../lib/api";
import { fmtInt, fmtPct, fmtUsd } from "../lib/format";
import { genreTintStyles } from "../lib/heat";
import { useDebounced } from "../lib/useDebounced";
import { usePageTitle } from "../lib/usePageTitle";

const LIMIT = PAGE_LIMIT;

// Browse floor: without a search term, only studios with 3+ scored games rank — a lone
// hit (or a lone flop) isn't a track record. Searching drops the floor to 1 so any credit
// in the catalog is findable. The Games column's tooltip and the empty state say so.
const BROWSE_MIN_GAMES = 3;
// Below this many games a hit rate is a coin toss, not a rate: the cell prints "—".
const HIT_RATE_MIN_GAMES = 3;

// Publishers first — publisher scouting (who ships games like mine, and how do those
// releases do?) is the page's reason to exist.
const ROLES: readonly { value: EntityRole; label: string; title: string }[] = [
  { value: "publisher", label: "Publishers", title: "Who published — the scouting view" },
  { value: "developer", label: "Developers", title: "Who built the games" },
];

// Mirrors the allow-list in api/app/routers/entities.py; anything else falls back to the
// default in readFilters rather than reaching the API as a 422.
const SORT_KEYS: readonly EntitySortKey[] = [
  "total_rev", "median_rev", "p90_rev", "n_games", "n_recent_24m", "hit_rate_200k", "last_release_year", "name",
] as const;

// Friendly labels for the "sorted by …" control — the same control /games renders.
const SORT_LABELS: Record<EntitySortKey, string> = {
  total_rev: "total est. revenue",
  median_rev: "median est. revenue",
  p90_rev: "P90 est. revenue",
  n_games: "games",
  n_recent_24m: "recent releases (24m)",
  hit_rate_200k: "hit rate",
  last_release_year: "last release year",
  name: "name",
};

// ---- URL-backed state ---------------------------------------------------------------------
// Same contract as /games: the URL is the single source of truth, so a research view is
// shareable and the back button walks it. DEFAULTS ARE OMITTED (a pristine /studios stays a
// clean URL), unknown values fall back to the default, discrete controls (role, sort, paging)
// PUSH so back undoes them, and the debounced search box writes with `replace` so typing
// doesn't spam history. ?role= and ?q= predate sort/order/offset and keep their exact
// spelling — Studios.test.tsx pins the reload/back behaviour.

interface Filters {
  role: EntityRole;
  q: string;
  sort: EntitySortKey;
  order: "asc" | "desc";
  offset: number;
}

function num(sp: URLSearchParams, key: string): number | undefined {
  const raw = sp.get(key);
  if (raw === null || raw === "") return undefined;
  const v = Number(raw);
  return Number.isFinite(v) ? v : undefined;
}

function readFilters(sp: URLSearchParams): Filters {
  const sortRaw = sp.get("sort") as EntitySortKey | null;
  return {
    role: sp.get("role") === "developer" ? "developer" : "publisher",
    q: sp.get("q") ?? "",
    sort: sortRaw && SORT_KEYS.includes(sortRaw) ? sortRaw : "total_rev",
    order: sp.get("order") === "asc" ? "asc" : "desc",
    // Clamped HERE, where every request funnels through, so a shared or back-navigated
    // /studios?offset=10025 never reaches the API's `le=10000` as a 422 (the /games bug,
    // reproduced on production 2026-09-01).
    offset: Math.min(MAX_OFFSET, Math.max(0, num(sp, "offset") ?? 0)),
  };
}

function entityHref(role: EntityRole, name: string): string {
  // Names carry slashes/commas/unicode, so they ride the query string, never the path.
  return `/entity/${role}?name=${encodeURIComponent(name)}`;
}

function fmtYears(first: number | null, last: number | null): string {
  if (first == null && last == null) return "—";
  if (first != null && last != null) return first === last ? String(first) : `${first}–${last}`;
  return String(first ?? last);
}

/**
 * Browse + search developer/publisher track records. Rows open the full career profile at
 * /entity/:role?name=. The search field, the chip row, the "sorted by" control, the result
 * rows, the "in these results" chips and the paging footer are the SAME components /games
 * renders (components/search/*), so the two pages cannot drift; this page owns only the
 * role choice and its own columns.
 */
export default function Studios() {
  usePageTitle("Studios");
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const filters = useMemo(() => readFilters(searchParams), [searchParams]);
  const { role } = filters;

  // The box keeps a local draft (a request/history entry per keystroke would be absurd);
  // the debounce below commits it to the URL.
  const [q, setQ] = useState(filters.q);
  const debouncedQ = useDebounced(q, 300);

  function patchParams(patch: Record<string, string | null>, opts?: { replace?: boolean; keepOffset?: boolean }) {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        for (const [k, v] of Object.entries(patch)) {
          if (v === null || v === "") next.delete(k);
          else next.set(k, v);
        }
        if (!opts?.keepOffset) next.delete("offset"); // a role/search/sort change restarts paging
        return next;
      },
      { replace: opts?.replace },
    );
  }

  // The last query string we and the URL agreed on — it tells our own commit's echo apart
  // from an external navigation (back/forward, a shared link).
  const lastCommitted = useRef(filters.q);
  useEffect(() => {
    const committed = debouncedQ.trim();
    if (committed === lastCommitted.current) return;
    lastCommitted.current = committed;
    patchParams({ q: committed || null }, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedQ]);
  useEffect(() => {
    if (filters.q === lastCommitted.current) return;
    lastCommitted.current = filters.q;
    setQ(filters.q);
  }, [filters.q]);

  const setRole = (next: EntityRole) => patchParams({ role: next === "publisher" ? null : next });
  // Same toggle-on-reselect contract as /games: the same key again flips the direction.
  const toggleSort = (key: EntitySortKey) => patchParams(sortPatch(filters.sort, filters.order, key, ["name"]));

  const committedQ = filters.q.trim();
  const browsing = committedQ.length === 0;
  const { data, isLoading, isFetching, isError, error, refetch } = useEntitySearch({
    q: committedQ || undefined,
    role,
    min_games: browsing ? BROWSE_MIN_GAMES : 1,
    sort: filters.sort,
    order: filters.order,
    limit: LIMIT,
    offset: filters.offset,
  });

  const is503 = error instanceof ApiError && error.status === 503;
  const total = data?.total ?? 0;
  const roleNoun = role === "publisher" ? "publishers" : "developers";

  // Genre chips sourced from the current page's own top_genres — the exact strings present
  // in these results. The entity search has no genre filter, so each one pivots to /games.
  const genreChips = useMemo(() => topValues(data?.items ?? [], (e) => e.top_genres, 3, 12), [data?.items]);

  // Active non-default filters as removable chips. The role is a view, not a filter — it
  // has its own segmented control in the same row — so the search term is the only chip.
  const chips = useMemo(
    () => (filters.q ? [{ key: "q", label: `“${filters.q}”`, clear: { q: null } }] : []),
    [filters.q],
  );

  return (
    <div className="flex flex-col gap-4">
      {/* Visually hidden — the nav's "Studios" link already orients the page, as on /games. */}
      <h1 className="sr-only">Studios</h1>

      <SearchBar
        value={q}
        onChange={setQ}
        placeholder={`Search ${roleNoun} by name…`}
        ariaLabel={`Search ${roleNoun} by name`}
        total={total}
        loading={isLoading}
      />

      {/* Filter chip row: the role choice leads, the search-term chip (+ Clear all) follows,
          "sorted by …" is right-aligned — /games' row with a Segmented in its leading slot. */}
      <FilterBar
        leading={<Segmented options={ROLES} value={role} onChange={setRole} ariaLabel="Role" />}
        chips={chips.map((c) => ({ key: c.key, label: c.label, onClear: () => patchParams(c.clear) }))}
        onClearAll={() => patchParams({ q: null })}
        trailing={
          <SortControl keys={SORT_KEYS} labels={SORT_LABELS} sort={filters.sort} order={filters.order} onSort={toggleSort} />
        }
      />

      {/* Result rows — hairline top rules, not a table. */}
      <div className={clsx(isFetching && "opacity-90 transition-opacity")}>
        {isLoading && <Loading label="Loading studios…" className="py-6 text-sm" />}
        {is503 && (
          <EmptyState
            title="Studio data is refreshing"
            description="Developer/publisher track records are built by the nightly data refresh and aren't available yet. Check back shortly — the rest of the app keeps working meanwhile."
            action={
              <Link to="/games" className="text-xs text-series-1 hover:underline">
                Back to games
              </Link>
            }
          />
        )}
        {/* Was `error.message` in raw — "Failed to load studios: Failed to fetch" with the
            API unreachable (measured on production 2026-09-01), and no retry. */}
        {isError && !is503 && (
          <ErrorState title="Couldn't load studios" error={error} onRetry={() => void refetch()} className="py-6" />
        )}
        {data && data.items.length === 0 && (
          <EmptyState
            title={
              browsing
                ? `No ${roleNoun} with ${BROWSE_MIN_GAMES}+ scored games yet`
                : `No ${roleNoun} match “${committedQ}”`
            }
            description={
              browsing
                ? `Browsing lists ${roleNoun} with ${BROWSE_MIN_GAMES}+ scored games. Search by name to find anyone with a credit in the catalog.`
                : "Try a shorter spelling — names are self-reported Steam credit strings, so the same studio can appear under several."
            }
          />
        )}
        {data && data.items.length > 0 && (
          <ResultList>
            {/* Widths/gaps mirror the metric group below EXACTLY — change one, change both.
                Seven cells don't fit beside the title until `lg`, so the row stacks below it. */}
            <ResultHeader
              stackBelow="lg"
              lead={
                <span title="Self-reported Steam credit strings — the same studio may appear under several spellings.">
                  Studio
                </span>
              }
            >
              <span
                className="w-14 shrink-0"
                title={`Released games credited to this studio in the catalog. Browsing lists studios with ${BROWSE_MIN_GAMES}+; searching by name finds anyone.`}
              >
                Games
              </span>
              <span className="w-[84px] shrink-0" title="First to latest release year — the career span.">
                Years
              </span>
              <span className="w-14 shrink-0" title="Released something in the last 24 months.">
                Active
              </span>
              {/* Same base as the hit rate — SUM and quantile both ignore NULL estimates, so
                  neither covers "all releases" when the Games column is larger. */}
              <span
                className="w-28 shrink-0"
                title="Summed estimated lifetime gross over the releases we could estimate (Boxleiter-style estimate, not reported sales) — releases with no estimate contribute nothing."
              >
                Total est. revenue
              </span>
              <span
                className="w-16 shrink-0"
                title="90th-percentile est. lifetime revenue over the releases with an estimate — what the studio's successful titles earn."
              >
                P90
              </span>
              {/* NOT "share of releases": the Games column counts every release, this
                  percentage's denominator is only the ones carrying a revenue estimate
                  (mart_entity.hit_rate_200k excludes NULL-estimate games). 41.9% of prod
                  entities differ on the two, up to 4x — Hooded Horse lists 50 and scores
                  91% off 33. The profile page prints the exact base per entity. */}
              <span
                className="w-14 shrink-0"
                title={`Share of the studio's releases WITH a revenue estimate that clear $200K est. revenue — not of the Games count beside it, which includes releases we could not estimate. Withheld under ${HIT_RATE_MIN_GAMES} games; open the profile for the exact base.`}
              >
                Hit rate
              </span>
              <span className="w-[220px] shrink-0" title="The genres this studio ships most.">
                Top genres
              </span>
            </ResultHeader>
            {data.items.map((e, i) => {
              const isTop = i === 0 && filters.offset === 0;
              const href = entityHref(e.role, e.name);
              const active = (e.n_recent_24m ?? 0) > 0;
              const thinRecord = e.n_games < HIT_RATE_MIN_GAMES;
              const genres = e.top_genres.slice(0, 3);
              const tints = genreTintStyles(genres);
              const meta = [
                `${fmtInt(e.n_games)} ${e.n_games === 1 ? "game" : "games"}`,
                fmtYears(e.first_release_year, e.last_release_year),
                e.top_genres[0],
              ]
                .filter((p): p is string => !!p && p !== "—")
                .join(" · ");
              return (
                <ResultRow
                  key={`${e.role}:${e.name}`}
                  stackBelow="lg"
                  onOpen={() => navigate(href)}
                  lead={<ResultTitle to={href} name={e.name} meta={meta} />}
                  metrics={
                    // Cell titles repeat the column names: below `lg` the header is hidden
                    // and the group stacks under the title, so hover is the only label.
                    <>
                      <span className="w-14 shrink-0 text-[13px] text-ink-primary" title="Games">
                        {fmtInt(e.n_games)}
                      </span>
                      <span
                        className="w-[84px] shrink-0 whitespace-nowrap text-[13px] text-ink-secondary"
                        title="Years — first to latest release"
                      >
                        {fmtYears(e.first_release_year, e.last_release_year)}
                      </span>
                      <span
                        className={clsx("w-14 shrink-0 text-[13px]", active ? "text-ink-primary" : "text-ink-muted")}
                        title={
                          active
                            ? `${fmtInt(e.n_recent_24m)} release${e.n_recent_24m === 1 ? "" : "s"} in the last 24 months`
                            : "No release in the last 24 months"
                        }
                      >
                        {active ? "Active" : "—"}
                      </span>
                      <RevenueCell top={isTop} width="w-28" title="Total est. revenue — an estimate, not reported sales">
                        {fmtUsd(e.total_rev)}
                      </RevenueCell>
                      <span className="w-16 shrink-0 text-[13px] text-ink-primary" title="P90 est. revenue">
                        {fmtUsd(e.p90_rev)}
                      </span>
                      {/* Under HIT_RATE_MIN_GAMES games the "rate" is one or two coin tosses,
                          so it is withheld rather than printed as a confident 0% or 100%. */}
                      <span
                        className={clsx("w-14 shrink-0 text-[13px]", thinRecord ? "text-ink-muted" : "text-ink-primary")}
                        title={thinRecord ? `needs ${HIT_RATE_MIN_GAMES}+ games` : undefined}
                      >
                        {thinRecord ? "—" : fmtPct(e.hit_rate_200k, 0)}
                      </span>
                      {/* genreTintStyles (plural) tints the row as a GROUP: the hash alone put
                          Action and Racing, and RPG and Simulation, on the same slot, so rows
                          like "Action · Simulation · RPG" printed two identical chips. See
                          lib/heat.ts. Clipped, not wrapped: a wrapped chip group would drag the
                          whole row taller; the full list is on hover. */}
                      <span className="flex w-[220px] shrink-0 gap-1 overflow-hidden" title={e.top_genres.join(" · ")}>
                        {genres.map((g, gi) => (
                          <span
                            key={g}
                            className="whitespace-nowrap border px-1.5 py-0.5 text-[10px] text-ink-secondary"
                            style={tints[gi]}
                          >
                            {g}
                          </span>
                        ))}
                      </span>
                    </>
                  }
                />
              );
            })}
          </ResultList>
        )}
      </div>

      {/* Quick genre pivots sourced from this page's own results — below the rows, as on
          /games. Real links: the pivot leaves the page. */}
      <ResultChipRow
        label="Genres in these results:"
        items={genreChips}
        href={(g) => `/games?genre=${encodeURIComponent(g)}`}
      />

      {data && (
        <ResultsFooter
          total={total}
          offset={filters.offset}
          limit={LIMIT}
          // Page 1 has no ?offset= — the URL stays clean and identical to a fresh /studios.
          onPage={(offset) => patchParams({ offset: offset > 0 ? String(offset) : null }, { keepOffset: true })}
        />
      )}
    </div>
  );
}

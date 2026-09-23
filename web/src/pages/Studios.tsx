import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import clsx from "clsx";

import { FilterBar } from "../components/search/FilterChip";
import { ResultChipRow, topValues } from "../components/search/ResultChipRow";
import {
  MetricCell,
  ResultHeader,
  ResultList,
  ResultRow,
  ResultTitle,
  RevenueCell,
  type StackBelow,
} from "../components/search/ResultList";
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
import { ApiError, useEntitySearch, type EntityRole, type EntitySortKey, type Scope } from "../lib/api";
import { ENTITY_MIN_FOR_ANY_RATE } from "../lib/entities";
import { fmtInt, fmtPct, fmtUsd } from "../lib/format";
import { genreTintStyles } from "../lib/heat";
import { useDebounced } from "../lib/useDebounced";
import { usePageTitle } from "../lib/usePageTitle";

const LIMIT = PAGE_LIMIT;

// Seven columns, each with its ⓘ, leave a studio name room to read only from `xl`: at 1024px
// "Facepunch Studios" truncated to "Facepunch…". Below it the rows stack, labelled per cell.
const STACK: StackBelow = "xl";

// Browse floor: without a search term, only studios with 3+ scored games rank — a lone
// hit (or a lone flop) isn't a track record. Searching drops the floor to 1 so any credit
// in the catalog is findable. The Games column's ⓘ and the empty state say so.
const BROWSE_MIN_GAMES = 3;
// Below this many games a hit rate — or a top-10% line — is a coin toss, not a rate: the
// cell is withheld and TAGGED with why (lib/entities.ts ENTITY_MIN_FOR_ANY_RATE).
const THIN_RECORD_GAMES = ENTITY_MIN_FOR_ANY_RATE;

// Publishers first — publisher scouting (who ships games like mine, and how do those
// releases do?) is the page's reason to exist.
const ROLES: readonly { value: EntityRole; label: string; title: string }[] = [
  { value: "publisher", label: "Publishers", title: "Who published — the scouting view" },
  { value: "developer", label: "Developers", title: "Who built the games" },
];

// Which studios (2026-09-23): the API's default is every studio, which opened this page on
// Electronic Arts, Bandai Namco and Ubisoft — not a solo developer's peers or pitch list. The
// PAGE defaults to the indie scope (studios at least half of whose flagged games are Steam
// Indie) and says so; "All studios" rides the URL as ?scope=all.
const SCOPES: readonly { value: Scope; label: string; title: string }[] = [
  { value: "indie", label: "Indie", title: "Studios whose games are mostly Indie-flagged — the default" },
  { value: "all", label: "All studios", title: "Every studio, the biggest publishers included" },
];

// Mirrors the allow-list in api/app/routers/entities.py; anything else falls back to the
// default in readFilters rather than reaching the API as a 422.
const SORT_KEYS: readonly EntitySortKey[] = [
  "total_rev", "median_rev", "p90_rev", "n_games", "n_recent_24m", "hit_rate_200k", "last_release_year", "name",
] as const;

// Friendly labels for the "sorted by …" control — the same control /games renders, in the
// glossary's names (lib/glossary.ts): one revenue name, no "P90".
const SORT_LABELS: Record<EntitySortKey, string> = {
  total_rev: "est. revenue, all games",
  median_rev: "median revenue",
  p90_rev: "top-10% revenue",
  n_games: "games",
  n_recent_24m: "releases, last 24 months",
  hit_rate_200k: "games earning $200K+",
  last_release_year: "last release year",
  name: "name",
};

// ---- URL-backed state ---------------------------------------------------------------------
// Same contract as /games: the URL is the single source of truth, so a research view is
// shareable and the back button walks it. DEFAULTS ARE OMITTED (a pristine /studios stays a
// clean URL), unknown values fall back to the default, discrete controls (role, scope, sort,
// paging) PUSH so back undoes them, and the debounced search box writes with `replace` so
// typing doesn't spam history. ?role= and ?q= predate sort/order/offset and keep their exact
// spelling — Studios.test.tsx pins the reload/back behaviour.

interface Filters {
  role: EntityRole;
  scope: Scope;
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
    scope: sp.get("scope") === "all" ? "all" : "indie",
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

function fmtYears(first: number | null, last: number | null): string | null {
  if (first == null && last == null) return null;
  if (first != null && last != null) return first === last ? String(first) : `${first}–${last}`;
  return String(first ?? last);
}

/**
 * Browse + search developer/publisher track records. Rows open the full career profile at
 * /entity/:role?name=. The search field, the chip row, the "sorted by" control, the result
 * rows, the "in these results" chips and the paging footer are the SAME components /games
 * renders (components/search/*), so the two pages cannot drift; this page owns only the
 * role and scope choices and its own columns.
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
  const setScope = (next: Scope) => patchParams({ scope: next === "all" ? "all" : null });
  // Same toggle-on-reselect contract as /games: the same key again flips the direction.
  const toggleSort = (key: EntitySortKey) => patchParams(sortPatch(filters.sort, filters.order, key, ["name"]));

  const committedQ = filters.q.trim();
  const browsing = committedQ.length === 0;
  const { data, isLoading, isFetching, isError, error, refetch } = useEntitySearch({
    q: committedQ || undefined,
    role,
    min_games: browsing ? BROWSE_MIN_GAMES : 1,
    scope: filters.scope,
    sort: filters.sort,
    order: filters.order,
    limit: LIMIT,
    offset: filters.offset,
  });

  const is503 = error instanceof ApiError && error.status === 503;
  const total = data?.total ?? 0;
  const roleNoun = role === "publisher" ? "publishers" : "developers";
  const scopeNoun = filters.scope === "indie" ? `indie ${roleNoun}` : roleNoun;

  // Genre chips sourced from the current page's own top_genres — the exact strings present
  // in these results. The entity search has no genre filter, so each one pivots to /games.
  const genreChips = useMemo(() => topValues(data?.items ?? [], (e) => e.top_genres, 3, 12), [data?.items]);

  // Active non-default filters as removable chips. The role and the scope are views, not
  // filters — each has its own segmented control in the same row — so the search term is
  // the only chip.
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

      {/* Filter chip row: the role and scope choices lead, the search-term chip (+ Clear all)
          follows, "sorted by …" is right-aligned — /games' row with Segmenteds in its
          leading slot. */}
      <FilterBar
        leading={
          <>
            <Segmented options={ROLES} value={role} onChange={setRole} ariaLabel="Role" />
            <Segmented options={SCOPES} value={filters.scope} onChange={setScope} ariaLabel="Which studios" />
          </>
        }
        chips={chips.map((c) => ({ key: c.key, label: c.label, onClear: () => patchParams(c.clear) }))}
        onClearAll={() => patchParams({ q: null })}
        trailing={
          <SortControl keys={SORT_KEYS} labels={SORT_LABELS} sort={filters.sort} order={filters.order} onSort={toggleSort} />
        }
      />

      {/* Height held while the first page loads, so the rows don't jump when it appears. */}
      <div className="min-h-[18px]">
        {data && (
          <ScopeNote
            requested={filters.scope}
            applied={data.scope}
            unknown={data.n_scope_unknown}
            noun={roleNoun}
            definition={`${role === "publisher" ? "Publishers" : "Developers"} at least half of whose games — among those with a known flag — carry Steam's Indie flag. It keeps Devolver, Team17, Klei and Supergiant; it drops EA, Bandai Namco, Ubisoft and Capcom. A studio none of whose games has a flag yet is left out rather than guessed, and counted here.`}
            formula="average of is_indie over the studio's flagged games ≥ 0.5; studios with no flagged game excluded and counted"
          />
        )}
      </div>

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
                ? `No ${scopeNoun} with ${BROWSE_MIN_GAMES}+ scored games yet`
                : `No ${scopeNoun} match “${committedQ}”`
            }
            description={
              browsing
                ? `Browsing lists ${roleNoun} with ${BROWSE_MIN_GAMES}+ scored games. Search by name to find anyone with a credit in the catalog.`
                : filters.scope === "indie"
                  ? `Only indie ${roleNoun} are searched — try “All studios”, or a shorter spelling (names are self-reported Steam credit strings).`
                  : "Try a shorter spelling — names are self-reported Steam credit strings, so the same studio can appear under several."
            }
          />
        )}
        {data && data.items.length > 0 && (
          <ResultList>
            {/* Widths/gaps mirror the metric group below EXACTLY — change one, change both.
                Seven cells don't fit beside the title until `xl`, so the row stacks below it,
                where each cell prints its own label. Every header explains itself with an ⓘ
                (P90 and Hit rate used to be explained only by a hover-only `title`). */}
            <ResultHeader
              stackBelow={STACK}
              lead={
                <HeaderLabel
                  label="Studio"
                  style={{}}
                  help="The credit string on the games' Steam pages, as the studio typed it — the same company can appear under several spellings."
                />
              }
            >
              <span className="w-14 shrink-0">
                <HeaderLabel
                  term="n_games"
                  style={{}}
                  info={{
                    meaning: `Released games credited to this studio in the catalog. Browsing lists studios with ${BROWSE_MIN_GAMES}+; searching by name finds anyone.`,
                    formula: `count of the studio's catalog releases (browse floor: ${BROWSE_MIN_GAMES}+)`,
                    notes: "Counts every release — including ones with no revenue estimate, which the revenue columns leave out.",
                  }}
                />
              </span>
              <span className="w-[84px] shrink-0">
                <HeaderLabel label="Years" style={{}} help="First to latest release year in the catalog — the career span." />
              </span>
              <span className="w-20 shrink-0">
                <HeaderLabel
                  label="Last 24 mo"
                  style={{}}
                  info={{
                    label: "Releases, last 24 months",
                    meaning:
                      "How many games the studio released in the 24 months to the data's date — whether it is still shipping. “None” means no release in that window.",
                    formula: "releases dated within 24 months of the data's as-of date",
                  }}
                />
              </span>
              <span className="w-28 shrink-0">
                <HeaderLabel
                  term="total_rev"
                  style={{}}
                  info={{
                    meaning:
                      "The studio's releases' Est. revenue added up — the size of its catalog in dollars, dominated by its hits. An estimate, not reported sales.",
                    formula: "sum of Est. revenue (reviews × 30 × launch price) over the studio's releases that have an estimate",
                    notes: "Releases with no estimate — free, or with no known price — add nothing.",
                  }}
                />
              </span>
              <span className="w-24 shrink-0">
                <HeaderLabel
                  term="p90_rev"
                  style={{}}
                  info={{
                    meaning:
                      "What the studio's successful titles earn: only 1 of its releases in 10 earns more. Not what a typical release makes — read the median on its profile for that.",
                    formula: "90th percentile of Est. revenue over the studio's releases with an estimate",
                    notes: `Over fewer than 10 releases it sits close to the studio's single best game; withheld (and tagged) under ${THIN_RECORD_GAMES} games.`,
                  }}
                />
              </span>
              {/* NOT "share of releases": the Games column counts every release, this
                  percentage's denominator is only the ones carrying a revenue estimate
                  (mart_entity.hit_rate_200k excludes NULL-estimate games). 41.9% of prod
                  entities differ on the two, up to 4x — Hooded Horse lists 50 and scores
                  91% off 33. The profile page prints the exact base per entity. */}
              <span className="w-24 shrink-0">
                <HeaderLabel
                  term="hit_rate_200k"
                  style={{}}
                  info={{
                    meaning:
                      "The odds a release of this studio “works”: the share of its releases WITH a revenue estimate that clear $200K — not a share of the Games count beside it, which includes releases with no estimate.",
                    formula: "releases with Est. revenue > $200K ÷ releases with an Est. revenue",
                    notes: `Withheld (and tagged) under ${THIN_RECORD_GAMES} games — a rate over one or two releases can only read 0%, 50% or 100%. Open the profile for the exact base.`,
                  }}
                />
              </span>
              <span className="w-[220px] shrink-0">
                <HeaderLabel label="Top genres" style={{}} help="The genres this studio ships most, most frequent first." />
              </span>
            </ResultHeader>
            {data.items.map((e, i) => {
              const isTop = i === 0 && filters.offset === 0;
              const href = entityHref(e.role, e.name);
              const recent = e.n_recent_24m ?? 0;
              const thinRecord = e.n_games < THIN_RECORD_GAMES;
              const genres = e.top_genres.slice(0, 3);
              const tints = genreTintStyles(genres);
              const meta = [
                `${fmtInt(e.n_games)} ${e.n_games === 1 ? "game" : "games"}`,
                fmtYears(e.first_release_year, e.last_release_year),
                e.top_genres[0],
              ]
                .filter((p): p is string => !!p)
                .join(" · ");
              const thinTag = <SentinelTag>under {THIN_RECORD_GAMES} games</SentinelTag>;
              return (
                <ResultRow
                  key={`${e.role}:${e.name}`}
                  stackBelow={STACK}
                  onOpen={() => navigate(href)}
                  lead={<ResultTitle to={href} name={e.name} meta={meta} />}
                  metrics={
                    // Below `xl` the header is hidden and the group stacks under the title,
                    // so each MetricCell prints its column name above its value.
                    <>
                      <MetricCell label="Games" width="w-14" stackBelow={STACK} className="text-ink-primary">
                        {fmtInt(e.n_games)}
                      </MetricCell>
                      <MetricCell label="Years" width="w-[84px]" stackBelow={STACK} className="whitespace-nowrap text-ink-secondary">
                        {fmtYears(e.first_release_year, e.last_release_year) ?? <SentinelTag>no dates</SentinelTag>}
                      </MetricCell>
                      {/* Was "Active" or a bare "—": the dash now says what it meant. */}
                      <MetricCell
                        label="Last 24 mo"
                        width="w-20"
                        stackBelow={STACK}
                        className={recent > 0 ? "text-ink-primary" : "text-ink-muted"}
                      >
                        {recent > 0 ? `${fmtInt(recent)} ${recent === 1 ? "release" : "releases"}` : "none"}
                      </MetricCell>
                      <RevenueCell top={isTop} width="w-28" stackBelow={STACK} label="Est. revenue, all games">
                        {e.total_rev != null ? fmtUsd(e.total_rev) : <SentinelTag>no estimate</SentinelTag>}
                      </RevenueCell>
                      <MetricCell label="Top-10% revenue" width="w-24" stackBelow={STACK} className="text-ink-primary">
                        {thinRecord ? thinTag : e.p90_rev != null ? fmtUsd(e.p90_rev) : <SentinelTag>no estimate</SentinelTag>}
                      </MetricCell>
                      {/* Under THIN_RECORD_GAMES games the "rate" is one or two coin tosses, so
                          it is withheld — and tagged with why — rather than printed as a
                          confident 0% or 100%. */}
                      <MetricCell label="Earning $200K+" width="w-24" stackBelow={STACK} className="text-ink-primary">
                        {thinRecord ? thinTag : e.hit_rate_200k != null ? fmtPct(e.hit_rate_200k, 0) : <SentinelTag>no estimate</SentinelTag>}
                      </MetricCell>
                      {/* genreTintStyles (plural) tints the row as a GROUP: the hash alone put
                          Action and Racing, and RPG and Simulation, on the same slot, so rows
                          like "Action · Simulation · RPG" printed two identical chips. See
                          lib/heat.ts. Clipped, not wrapped: a wrapped chip group would drag the
                          whole row taller; the full list is on hover. */}
                      <span className="flex w-full shrink-0 gap-1 overflow-hidden xl:w-[220px]" title={e.top_genres.join(" · ")}>
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
        // The pivot keeps the scope the reader is on: /games defaults to indie too, so only
        // "All studios" has anything to carry over.
        href={(g) => `/games?genre=${encodeURIComponent(g)}${filters.scope === "all" ? "&scope=all" : ""}`}
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

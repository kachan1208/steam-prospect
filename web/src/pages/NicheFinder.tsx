import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { createColumnHelper, flexRender, getCoreRowModel, useReactTable } from "@tanstack/react-table";
import clsx from "clsx";

import { OpportunityBreakdown } from "../components/OpportunityBreakdown";
import { EmptyState } from "../components/ui/EmptyState";
import { ErrorState } from "../components/ui/ErrorState";
import { HeaderLabel, HEADER_LABEL_STYLE } from "../components/ui/HeaderLabel";
import { InfoTip } from "../components/ui/InfoTip";
import { Loading } from "../components/ui/Loading";
import { SentinelTag } from "../components/ui/SentinelTag";
import { TableScroll } from "../components/ui/TableScroll";
import { trackEvent } from "../lib/analytics";
import {
  nicheExportCsvUrl,
  useNiches,
  NICHE_TIERS,
  type Dimension,
  type NicheRow,
  type NicheTier,
  type SortKey,
  type Window,
} from "../lib/api";
import { useDataAge } from "../lib/dataAge";
import { fmtCompact, fmtInt, fmtMonths, fmtPct, fmtUsd } from "../lib/format";
import type { GlossaryKey } from "../lib/glossary";
import { paidStatSentinel } from "../lib/nichePaid";
import { medianNicheTrend, noMarketNote, readPlayersTrend } from "../lib/playersTrend";
// The verdict, its inputs and the score are the Radar's own strings — one builder
// (radarDossier), so the table, the deep dive and the board cannot disagree in wording.
import {
  EMERGING_DEMAND_LABEL,
  cutPopulationLabel,
  demandTrendWorked,
  failedCheckClause,
  failedChecks,
  radarDossier,
  releasesYoyWorked,
} from "../lib/radarVerdict";
import { useDebounced } from "../lib/useDebounced";
import { useMinWidth } from "../lib/useMediaQuery";
import { usePageTitle } from "../lib/usePageTitle";
// From the leaf module, NEVER from pages/NicheCombined (which is where these lived until
// 2026-08-29): a static import of a page module drags that page — and NicheDetail, and
// vendor-recharts with it — into this route's chunk, defeating the code splitting.
import {
  DEFAULT_NICHE_CUT,
  formatNicheRef,
  nicheCombinedPath,
  parseNicheSelection,
  NICHE_COMBINE_CAP,
  type NicheSelection,
} from "../lib/nicheSelection";
import { nicheDetailPath } from "../lib/nichePath";

const LIMIT = 50;

/** The Radar's population limit — the pinned-cut verdict query asks for the same rows the
 * board does (and so shares its cache entry). */
const PINNED_LIMIT = 500;

// ---------------------------------------------------------------------------------------
// Industry blueprint grammar (design_handoff_prospect_dark_ui §4a). Most chrome maps onto
// the shared semantic tokens (text-ink-muted, border-line-grid, bg-surface2…), but a
// handful of alphas the mockup calls out precisely — segmented-control borders, bar
// tracks — don't have an existing utility at that exact opacity. These mix off
// --text-primary exactly the way index.css derives --text-muted/--text-secondary, so they
// stay theme-correct in both light and dark rather than pinning a raw hex.
// ---------------------------------------------------------------------------------------
const PAPER_30 = "color-mix(in srgb, var(--text-primary) 30%, transparent)";
const PAPER_35 = "color-mix(in srgb, var(--text-primary) 35%, transparent)";
const PAPER_45 = "color-mix(in srgb, var(--text-primary) 45%, transparent)";

// Umbrella/meta tags are containers/reception labels, not buildable niches — excluded by
// default, same reasoning (and default) as the MCP find_niches tool.
const DEFAULT_TIERS: NicheTier[] = ["micro", "theme"];

const DEFAULT_SORT: SortKey = "opportunity_v2";

/** The sortable columns THIS page offers — the seven server-sortable ones in the grid (the
 * Verdict column is the board's call, computed client-side per row, so it has no server
 * sort — order by its inputs instead) plus the four in the "More metrics" panel. The URL's
 * `sort` is validated against it (an unknown key falls back to the default) so a
 * hand-edited link can't ask the API to order by a column the table can't even draw an
 * arrow on — which since 2026-09-09 includes the retired `demand` / `competition` /
 * `quality_gap` percentile meters. */
const FINDER_SORT_KEYS: readonly SortKey[] = [
  "key", "n_games", "p90_rev", "demand_trend_24m_pct", "saturation_yoy", "opportunity_v2",
  "players_trend_7d_pct",
  "lifetime_survival_12m", "total_owners", "hit_rate_200k", "total_players_now",
] as const;

/** The review floors the mart materializes — 0 (no floor), 50 and 100. Anything else in
 * the URL is a population that does not exist, so it reads as the default. */
const MIN_REVIEW_OPTIONS = [0, 50, 100];

/** Tiers as a canonical, comma-joined string: NICHE_TIERS order, deduped, so ticking the
 * same set two different ways serializes identically (and so "the default set" is one
 * exact string we can omit from the URL). */
function serializeTiers(tiers: NicheTier[]): string {
  return NICHE_TIERS.filter((t) => tiers.includes(t)).join(",");
}

function parseTiers(raw: string | null): NicheTier[] {
  if (raw === null) return DEFAULT_TIERS;
  const wanted = new Set(raw.split(","));
  const picked = NICHE_TIERS.filter((t) => wanted.has(t));
  // An empty/garbage list would ask the API for nothing at all — the UI itself refuses
  // to reach that state (toggleTier keeps one tier lit), so the URL must too.
  return picked.length > 0 ? picked : DEFAULT_TIERS;
}

/** Tier chips in plain words (2026-09-23: "micro" / "umbrella" were jargon on the chip). */
const TIER_LABEL: Record<NicheTier, string> = {
  micro: "Game types",
  theme: "Themes",
  umbrella: "Broad genres",
  meta: "Review tags",
};

const TIER_TITLE: Record<NicheTier, string> = {
  micro: "Buildable game concepts (Colony Sim, Souls-like…)",
  theme: "Settings/aesthetics you attach to a game (Vikings, Pixel Graphics…)",
  umbrella: "Genre/mechanic containers (Open World, Sandbox…) — not buildable on their own",
  meta: "Reception tags (Great Soundtrack…) — never buildable",
};

// Mockup 4a draws exactly 8 columns at an fr-weighted grid. The Opportunity track is wider
// since 2026-09-23: the score never stands alone, so it carries its four part bars and the
// supply brake beside it (OpportunityBreakdown, compact).
const GRID_TEMPLATE = "2fr .6fr .9fr 1fr .9fr 1.25fr 1.35fr 1fr";
const TABLE_MIN_WIDTH = 980;

const ROW_GRID: CSSProperties = {
  display: "grid",
  gridTemplateColumns: GRID_TEMPLATE,
  gap: 14,
  alignItems: "center",
};

// The second panel's grid — same grammar (14px gap, fr-weighted tracks), its own column
// set: Niche (for correlation with the row above) + the four metrics the grid doesn't draw.
const MORE_METRICS_GRID_TEMPLATE = "2fr .9fr 1fr .9fr 1fr";
const MORE_METRICS_MIN_WIDTH = 640;

const MORE_METRICS_ROW_GRID: CSSProperties = {
  display: "grid",
  gridTemplateColumns: MORE_METRICS_GRID_TEMPLATE,
  gap: 14,
  alignItems: "center",
};

function ColHead({
  active,
  order,
  children,
}: {
  active: boolean;
  order: "asc" | "desc";
  children: ReactNode;
}) {
  return (
    <div role="columnheader" aria-sort={active ? (order === "desc" ? "descending" : "ascending") : "none"}>
      {children}
    </div>
  );
}

function Segmented({ children }: { children: ReactNode }) {
  return (
    <div className="inline-flex" style={{ border: `1px solid ${PAPER_30}` }}>
      {children}
    </div>
  );
}

function SegButton({
  active,
  onClick,
  children,
  title,
  first,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
  title?: string;
  first?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={clsx("transition-colors", active ? "text-brand-fg" : "text-ink-primary hover:bg-surface2")}
      style={{
        padding: "6px 14px",
        fontSize: 13,
        fontWeight: active ? 600 : 400,
        backgroundColor: active ? "var(--brand)" : undefined,
        borderLeft: first ? "none" : `1px solid ${PAPER_30}`,
      }}
    >
      {children}
    </button>
  );
}

/**
 * The Radar verdict for one row, ALWAYS at the board's pinned cut (2026-09-23). A verdict
 * that flips when a display chip is clicked is not a verdict — Roguelike Deckbuilder read
 * "Watch" here on the All-time chip while the Radar said otherwise. So the verdict cell reads
 * the row's own 24m × ≥50 twin: the row itself when the table IS that cut, else the same
 * niche from the pinned-cut list (the Radar's own query). A niche with no row at that cut
 * (too few qualifying games) gets a sentinel, never a verdict computed on another population.
 */
function VerdictCell({ pinned, loading }: { pinned: NicheRow | null | undefined; loading: boolean }) {
  if (!pinned) {
    return loading ? (
      <span className="text-ink-muted">…</span>
    ) : (
      <SentinelTag>not scored at the Radar&rsquo;s cut</SentinelTag>
    );
  }
  const d = radarDossier(pinned);
  const failed = failedChecks(d.verdict.checks);
  return (
    <span className="inline-flex items-center gap-1.5 text-ink-primary" data-verdict={d.verdict.ring}>
      <span className="inline-block h-2 w-2 shrink-0" style={{ backgroundColor: d.color }} aria-hidden />
      {d.verdictLabel}
      <InfoTip
        label={`${pinned.key}: ${d.verdictLabel}`}
        ariaLabel={`Why ${pinned.key} is ${d.verdictLabel}`}
        meaning={d.verdict.reason}
        workedLabel={failed.length > 0 ? "Checks it fails" : "Checks"}
        worked={
          failed.length > 0 ? (
            <span className="flex flex-col">
              {failed.map((c) => (
                <span key={c.id}>
                  {c.decides ? "✕ " : "⚠ "}
                  {failedCheckClause(c)}
                </span>
              ))}
            </span>
          ) : (
            "every check passes"
          )
        }
        notes="Judged at the Radar's cut — last 24 months, games with 50+ reviews — whatever cut this table shows."
      />
    </span>
  );
}

export default function NicheFinder() {
  usePageTitle("Niche Finder");
  const wide = useMinWidth(640);
  const dataAge = useDataAge();
  // ---- URL-backed view state --------------------------------------------------------
  // THE WHOLE VIEW RIDES THE URL — dimension, cut (window × review floor), tiers, search,
  // sort/order, paging and the More-metrics disclosure, alongside the multi-select that
  // already did.
  //
  // Until 2026-09-01 only the selection was routed, on the argument that "filters stay in
  // component state: they're a browsing pose, the selection is the artifact worth sending
  // someone". Three things retired that argument:
  //
  //  1. THESE FILTERS ARE NOT A POSE, THEY ARE THE POPULATION. mart_niche precomputes its
  //     aggregates per (window, min_reviews) population, so the cut chips don't narrow a
  //     list — they swap in different medians and a different opportunity_v2 for the same
  //     niche. A URL that omits them doesn't describe what the sender was looking at.
  //  2. THIS PAGE ALREADY TREATED THE CUT AS PART OF THE ARTIFACT. "Analyse combined"
  //     hands win/min_reviews to nicheCombinedPath, and Export CSV builds its href from
  //     every filter.
  //  3. THE APP PROMISES THIS BEHAVIOUR OUT LOUD on /niches/:dim/:key ("This filter lives
  //     in the URL — copy the address bar to share exactly this slice").
  //
  // Contract, matching NicheDetail (the page these rows link into): DEFAULTS ARE OMITTED,
  // so a pristine /niches stays a clean URL and only a non-default reading writes a param;
  // unknown/garbage values fall back to the default instead of throwing; and every write
  // `replace`s — ticking a checkbox, flipping a chip or a sort arrow has no claim on the
  // back button.
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();

  /** One writer for every param: null/"" clears the key. Any filter/sort change re-pages
   * to the top (offset never points past a new result set) unless the caller is the pager
   * itself — the same keepOffset idiom /games uses. */
  const patchParams = useCallback(
    (patch: Record<string, string | null>, opts?: { keepOffset?: boolean }) => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          for (const [k, v] of Object.entries(patch)) {
            if (v === null || v === "") next.delete(k);
            else next.set(k, v);
          }
          if (!opts?.keepOffset) next.delete("offset");
          return next;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );

  const dimension: Dimension = searchParams.get("dim") === "genre" ? "genre" : "tag";
  const setDimension = useCallback((d: Dimension) => patchParams({ dim: d === "tag" ? null : d }), [patchParams]);
  // 24m is the market a new entrant actually faces — the all-time cut is context, not an
  // entry decision, so it is NOT the default (same default as the MCP tool).
  const windowParam: Window = searchParams.get("win") === "all" ? "all" : DEFAULT_NICHE_CUT.win;
  const setWindowParam = useCallback(
    (w: Window) => patchParams({ win: w === DEFAULT_NICHE_CUT.win ? null : w }),
    [patchParams],
  );
  // mart materializes exactly 0 (no floor), 50 & 100. Read as a STRING first: 0 is a real
  // floor here, and Number(null) is also 0 — so a plain Number() would turn "no param" into
  // the All-games cut and quietly serve a different population than the default.
  const rawMinReviews = searchParams.get("min_reviews");
  const minReviews =
    rawMinReviews !== null && MIN_REVIEW_OPTIONS.includes(Number(rawMinReviews))
      ? Number(rawMinReviews)
      : DEFAULT_NICHE_CUT.min_reviews;
  const setMinReviews = useCallback(
    (n: number) => patchParams({ min_reviews: n === DEFAULT_NICHE_CUT.min_reviews ? null : String(n) }),
    [patchParams],
  );
  const tiers = useMemo(() => parseTiers(searchParams.get("tiers")), [searchParams]);
  const rawSort = searchParams.get("sort") as SortKey | null;
  const sort: SortKey = rawSort && FINDER_SORT_KEYS.includes(rawSort) ? rawSort : DEFAULT_SORT;
  const order: "asc" | "desc" = searchParams.get("order") === "asc" ? "asc" : "desc";
  const offset = Math.max(0, Number(searchParams.get("offset")) || 0);
  const cutLabel = cutPopulationLabel(windowParam, minReviews);
  const atPinnedCut = windowParam === DEFAULT_NICHE_CUT.win && minReviews === DEFAULT_NICHE_CUT.min_reviews;

  // The search box keeps a local DRAFT — a request (and a URL write) per keystroke would
  // be absurd — committed to the URL on the same 300ms debounce it always fetched on.
  const urlQ = searchParams.get("q") ?? "";
  const [q, setQ] = useState(urlQ);
  const debouncedQ = useDebounced(q, 300);
  // The last query string the box and the URL agreed on: it tells our own commit's echo
  // apart from an external navigation (back/forward, a shared link).
  const lastCommittedQ = useRef(urlQ);
  useEffect(() => {
    const committed = debouncedQ.trim();
    if (committed === lastCommittedQ.current) return;
    lastCommittedQ.current = committed;
    patchParams({ q: committed || null });
  }, [debouncedQ, patchParams]);
  useEffect(() => {
    if (urlQ === lastCommittedQ.current) return;
    lastCommittedQ.current = urlQ;
    setQ(urlQ);
  }, [urlQ]);

  const toggleSort = useCallback(
    (col: SortKey) => {
      if (sort === col) {
        patchParams({ sort: col === DEFAULT_SORT ? null : col, order: order === "desc" ? "asc" : "desc" });
      } else {
        const nextOrder = col === "key" ? "asc" : "desc";
        patchParams({ sort: col === DEFAULT_SORT ? null : col, order: nextOrder === "desc" ? null : nextOrder });
      }
    },
    [sort, order, patchParams],
  );
  const toggleTier = useCallback(
    (t: NicheTier) => {
      const next = tiers.includes(t) ? tiers.filter((x) => x !== t) : [...tiers, t];
      if (next.length === 0) return; // never allow an empty selection
      const serialized = serializeTiers(next);
      patchParams({ tiers: serialized === serializeTiers(DEFAULT_TIERS) ? null : serialized });
    },
    [tiers, patchParams],
  );
  const setOffset = useCallback(
    (next: number) => patchParams({ offset: next <= 0 ? null : String(next) }, { keepOffset: true }),
    [patchParams],
  );

  // ---- multi-select ---------------------------------------------------------------
  // A game carries many tags, so it lives in many niches — selecting 2..N and analysing
  // the overlap is a first-class question. The selection rides the URL (repeated
  // `niches=<dimension>:<key>`) so a half-built combination is shareable, exactly like
  // /compare?ids=. It writes through its OWN writer rather than patchParams: ticking a
  // checkbox is not a filter change, so it must not re-page the table under the user.
  const selection = useMemo(() => parseNicheSelection(searchParams), [searchParams]);
  const selectedRefs = useMemo(() => new Set(selection.map(formatNicheRef)), [selection]);

  const writeSelection = useCallback(
    (next: NicheSelection[]) => {
      const sp = new URLSearchParams(searchParams);
      sp.delete("niches");
      for (const s of next) sp.append("niches", formatNicheRef(s));
      // replace: ticking checkboxes shouldn't bury the previous page in history.
      setSearchParams(sp, { replace: true });
    },
    [searchParams, setSearchParams],
  );

  const toggleSelected = useCallback(
    (sel: NicheSelection) => {
      const ref = formatNicheRef(sel);
      const present = selection.some((s) => formatNicheRef(s) === ref);
      if (present) writeSelection(selection.filter((s) => formatNicheRef(s) !== ref));
      else if (selection.length < NICHE_COMBINE_CAP) writeSelection([...selection, sel]);
    },
    [selection, writeSelection],
  );

  const tiersParam = dimension === "tag" ? tiers.join(",") : undefined;
  const { data, isLoading, isFetching, isError, error, refetch } = useNiches({
    dimension,
    window: windowParam,
    min_reviews: minReviews,
    sort,
    order,
    q: debouncedQ || undefined,
    tiers: tiersParam,
    limit: LIMIT,
    offset,
  });

  // The verdicts' own population — the board's pinned cut — fetched only when the table
  // shows another cut (see VerdictCell). Same params as the Radar's query for the default
  // tiers, so a visit from the Radar costs nothing.
  const pinnedQ = useNiches(
    {
      dimension,
      window: DEFAULT_NICHE_CUT.win,
      min_reviews: DEFAULT_NICHE_CUT.min_reviews,
      sort: "opportunity_v2",
      order: "desc",
      tiers: tiersParam,
      limit: PINNED_LIMIT,
      offset: 0,
    },
    { enabled: !atPinnedCut },
  );
  const pinnedByKey = useMemo(() => {
    const m = new Map<string, NicheRow>();
    for (const r of pinnedQ.data?.items ?? []) m.set(r.key, r);
    return m;
  }, [pinnedQ.data]);
  const pinnedRow = useCallback(
    (row: NicheRow): NicheRow | null | undefined => (atPinnedCut ? row : pinnedByKey.get(row.key)),
    [atPinnedCut, pinnedByKey],
  );

  // How the typical niche moved this week — the "is it the market?" read for the players
  // column when the data has no market-relative figure.
  const weekMedian = useMemo(() => medianNicheTrend(data?.items ?? []), [data]);
  const hasMarketTrend = (data?.items ?? []).some((r) => r.players_trend_7d_rel_pct != null);

  const header = useCallback(
    (col: SortKey, term: GlossaryKey, extra?: { label?: string; worked?: ReactNode; notes?: ReactNode }) => (
      <HeaderLabel
        term={term}
        label={extra?.label}
        worked={extra?.worked}
        info={extra?.notes ? { notes: extra.notes } : undefined}
        sort={{ col, active: sort === col, order, onSort: toggleSort }}
      />
    ),
    [sort, order, toggleSort],
  );

  const columnHelper = useMemo(() => createColumnHelper<NicheRow>(), []);
  const columns = useMemo(
    () => [
      // The multi-select checkbox rides inside the Niche cell (rather than owning a grid
      // track the mockup never draws).
      columnHelper.accessor("key", {
        header: () => (
          <HeaderLabel
            label="Niche"
            info={{
              label: "Niche",
              meaning:
                "A Steam community tag or Steam genre. The small badge marks what kind of tag it is: a theme is a setting you attach to a game; a broad genre is a container; a review tag is a reception label — only game types are buildable niches on their own.",
            }}
            sort={{ col: "key", active: sort === "key", order, onSort: toggleSort }}
          />
        ),
        cell: (info) => (
          <NicheNameCell
            row={info.row.original}
            dimension={dimension}
            selected={selectedRefs.has(`${dimension}:${info.getValue()}`)}
            full={!selectedRefs.has(`${dimension}:${info.getValue()}`) && selectedRefs.size >= NICHE_COMBINE_CAP}
            onToggle={toggleSelected}
          />
        ),
      }),
      columnHelper.accessor("n_games", {
        header: () => header("n_games", "n_games", { worked: `Counts games in this cut: ${cutLabel}.` }),
        cell: (info) => (
          <span className="tabular text-ink-secondary" title={`${fmtInt(info.getValue())} games · ${cutLabel}`}>
            {fmtInt(info.getValue())}
          </span>
        ),
      }),
      columnHelper.accessor((row) => row.p90_rev ?? null, {
        id: "p90_rev",
        header: () => header("p90_rev", "p90_rev"),
        cell: (info) => <RevenueValue row={info.row.original} value={info.getValue()} />,
      }),
      // THE RADAR VERDICT'S INPUTS AND ITS CALL (2026-09-09): demand, releases and the
      // verdict, through the SAME radarDossier() strings the deep dive's headline and the
      // board's tooltip print. (The board is a ring dial since 2026-09-10 — these are the
      // verdict's checks, not "the Radar's X/Y axes", which this header used to call them.)
      columnHelper.accessor((row) => row.demand_trend_24m_pct ?? null, {
        id: "demand_trend_24m_pct",
        header: () => header("demand_trend_24m_pct", "demand_trend_24m_pct"),
        cell: (info) => <DemandValue row={info.row.original} />,
      }),
      columnHelper.accessor((row) => row.saturation_yoy ?? null, {
        id: "saturation_yoy",
        header: () => header("saturation_yoy", "saturation_yoy"),
        cell: (info) => <ReleasesValue row={info.row.original} />,
      }),
      columnHelper.display({
        id: "verdict",
        header: () => (
          // Not sortable: the verdict is computed client-side per row, so there is no server
          // order to ask for — a sort arrow here would 422. Order by its inputs instead.
          <HeaderLabel
            term="radar_verdict"
            info={{ notes: "Always judged at the Radar's cut — last 24 months, games with 50+ reviews — so switching the cut above never flips a verdict. Not sortable: order by its inputs instead." }}
          />
        ),
        cell: (info) => (
          <VerdictCell pinned={pinnedRow(info.row.original)} loading={!atPinnedCut && pinnedQ.isLoading} />
        ),
      }),
      columnHelper.accessor("opportunity_v2", {
        header: () => header("opportunity_v2", "opportunity_v2"),
        // Never a lone score (2026-09-23): the four part bars and the supply brake ride
        // beside it, and its ⓘ adds them up with this row's numbers.
        cell: (info) => <OpportunityBreakdown row={info.row.original} variant="compact" title={`${info.row.original.key}: Opportunity score`} />,
      }),
      columnHelper.accessor("players_trend_7d_pct", {
        header: () =>
          header("players_trend_7d_pct", hasMarketTrend ? "players_trend_7d_vs_market" : "players_trend_7d_pct", {
            label: "Players 7d",
            notes: hasMarketTrend ? undefined : noMarketNote(weekMedian),
          }),
        cell: (info) => <PlayersValue row={info.row.original} />,
      }),
    ],
    [columnHelper, sort, order, toggleSort, dimension, selectedRefs, toggleSelected, header, cutLabel, pinnedRow, atPinnedCut, pinnedQ.isLoading, hasMarketTrend, weekMedian],
  );

  const table = useReactTable({
    data: data?.items ?? [],
    columns,
    getCoreRowModel: getCoreRowModel(),
  });

  // ---- "more metrics" panel --------------------------------------------------------
  // Everything the app tracks that the grid above does NOT draw — longevity, total owners,
  // hit rate, and the raw "playing now" count. Behind an explicit toggle, sharing the exact
  // same sort/order state (and so the exact same row order) as the primary table above it.
  // Routed too (?more=1) precisely BECAUSE it shares that sort state.
  const showMoreMetrics = searchParams.get("more") === "1";
  const setShowMoreMetrics = useCallback(
    (v: boolean) => patchParams({ more: v ? "1" : null }, { keepOffset: true }),
    [patchParams],
  );
  const moreMetricsColumns = useMemo(
    () => [
      {
        col: "lifetime_survival_12m" as SortKey,
        term: "lifetime_survival_12m" as GlossaryKey,
        render: (row: NicheRow) => {
          const v = row.lifetime_survival_12m ?? null;
          if (v == null) return <SentinelTag>no data</SentinelTag>;
          const m = row.lifetime_median_dead_months;
          const title =
            `${fmtPct(v)} of its 100+ games still alive after a year` + (m != null ? ` · dead ones lasted ~${fmtMonths(m)}` : "");
          return (
            <span className="tabular text-ink-secondary" title={title}>
              {fmtPct(v)}
            </span>
          );
        },
      },
      {
        col: "total_owners" as SortKey,
        term: "total_owners" as GlossaryKey,
        render: (row: NicheRow) => <span className="tabular text-ink-secondary">{fmtCompact(row.total_owners)}</span>,
      },
      {
        col: "hit_rate_200k" as SortKey,
        term: "hit_rate_200k" as GlossaryKey,
        render: (row: NicheRow) => {
          const v = row.hit_rate_200k;
          const sentinel = paidStatSentinel(row, v);
          if (sentinel) return <SentinelTag>{typeof sentinel === "string" ? sentinel : sentinel.tag}</SentinelTag>;
          const n = row.n_paid ?? row.n_games;
          return (
            <span
              className="tabular text-ink-secondary"
              title={v != null && n ? `≈ ${Math.round(v * n)} of ${fmtInt(n)} games clear $200K est. lifetime revenue` : undefined}
            >
              {fmtPct(v)}
            </span>
          );
        },
      },
      {
        col: "total_players_now" as SortKey,
        term: "niche_players_now" as GlossaryKey,
        render: (row: NicheRow) => (
          <span className="tabular text-ink-secondary">
            {row.total_players_now != null ? fmtCompact(row.total_players_now) : "—"}
          </span>
        ),
      },
    ],
    [],
  );

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
    tiers: tiersParam,
    limit: 1000,
  });

  return (
    <div className="flex flex-col" style={{ gap: 18 }}>
      <div className="flex flex-wrap items-baseline gap-3.5">
        <h1 className="text-ink-primary" style={{ fontSize: 25 }}>
          Niche Finder
        </h1>
        {/* Every count says what it counts (2026-09-23): the niche count is THIS cut's; the
            verdicts are always the Radar's cut, and the sentence says so whichever chip is
            lit — a verdict never follows the chips. */}
        <span className="text-[13px] text-ink-secondary" data-testid="finder-summary">
          {total > 0 ? `${total.toLocaleString()} niches · ` : ""}numbers for {cutLabel} · ranked by Opportunity score ·
          verdicts judged at the Radar&rsquo;s cut (last 24 months · ≥50 reviews)
          {!atPinnedCut ? " — not this table's" : ""}
        </span>
        <a
          href={csvUrl}
          onClick={() => trackEvent("niche_export_csv")}
          className="ml-auto shrink-0 text-[13px] text-brand transition-colors hover:text-brand-hover"
        >
          Export CSV
        </a>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Segmented>
          <SegButton first active={dimension === "tag"} onClick={() => setDimension("tag")}>
            Tags
          </SegButton>
          <SegButton active={dimension === "genre"} onClick={() => setDimension("genre")}>
            Genres
          </SegButton>
        </Segmented>
        <Segmented>
          <SegButton
            first
            active={windowParam === "24m"}
            onClick={() => setWindowParam("24m")}
            title="Games released in the last 24 months — the market a new entrant faces"
          >
            Last 24 months
          </SegButton>
          <SegButton
            active={windowParam === "all"}
            onClick={() => setWindowParam("all")}
            title="Full history — context, not an entry decision"
          >
            All-time
          </SegButton>
        </Segmented>
        <Segmented>
          <SegButton
            first
            active={minReviews === 0}
            onClick={() => setMinReviews(0)}
            title="No review floor — the whole tag, unreviewed releases included. Game counts are the honest tag size; revenue stats still count only the paid games."
          >
            All games
          </SegButton>
          <SegButton active={minReviews === 50} onClick={() => setMinReviews(50)} title="Games with 50+ reviews — broader population, noisier stats">
            ≥50 reviews
          </SegButton>
          <SegButton active={minReviews === 100} onClick={() => setMinReviews(100)} title="Games with 100+ reviews — stricter population, cleaner stats">
            ≥100
          </SegButton>
        </Segmented>
        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search niches…"
          aria-label="Search niches"
          className="bg-transparent text-[13px] text-ink-primary outline-none placeholder:text-ink-muted"
          style={{ width: 220, maxWidth: "100%", border: `1px solid ${PAPER_30}`, padding: "6px 12px" }}
        />
        {dimension === "tag" && (
          <span className="flex flex-wrap items-center gap-1.5 text-[11px] text-ink-muted">
            Show:
            {NICHE_TIERS.map((t) => {
              const active = tiers.includes(t);
              return (
                <button
                  key={t}
                  type="button"
                  aria-pressed={active}
                  onClick={() => toggleTier(t)}
                  title={TIER_TITLE[t]}
                  className={clsx(
                    "px-2.5 py-[3px] text-[11px] font-medium transition-colors",
                    active ? "text-brand" : "text-ink-muted hover:bg-surface2",
                  )}
                  style={{ border: `1px solid ${active ? "var(--brand)" : PAPER_30}` }}
                >
                  {TIER_LABEL[t]}
                </button>
              );
            })}
          </span>
        )}
      </div>

      <NicheCombineBar
        selection={selection}
        onRemove={(sel) => toggleSelected(sel)}
        onClear={() => writeSelection([])}
        onAnalyse={() => {
          trackEvent("niche_filter_apply");
          navigate(nicheCombinedPath(selection, "intersect", { win: windowParam, min_reviews: minReviews }));
        }}
      />

      <div className={clsx("blueprint", isFetching && "opacity-90 transition-opacity")}>
        <i className="bp-corner" />
        {isLoading && <Loading label="Loading niches…" className="p-8 text-sm" />}
        {/* Was `error.message` in raw — "Failed to load niches: Failed to fetch" with the
            API unreachable (measured on production 2026-09-01), and no way to try again. */}
        {isError && <ErrorState title="Couldn't load niches" error={error} onRetry={() => void refetch()} className="p-8" />}
        {data && data.items.length === 0 && (
          <EmptyState
            title="No niches match these filters"
            description="Try a broader tier selection, a lower review floor, or clear the search."
          />
        )}
        {data && data.items.length > 0 && wide && (
          <TableScroll>
            <div role="table" style={{ minWidth: TABLE_MIN_WIDTH }}>
              {table.getHeaderGroups().map((hg) => (
                <div key={hg.id} role="row" className="border-b border-chartborder" style={{ ...ROW_GRID, padding: "12px 20px" }}>
                  {hg.headers.map((h) => (
                    <ColHead key={h.id} active={sort === h.column.id} order={order}>
                      {flexRender(h.column.columnDef.header, h.getContext())}
                    </ColHead>
                  ))}
                </div>
              ))}
              {table.getRowModel().rows.map((row) => (
                <div
                  key={row.id}
                  role="row"
                  className="border-b border-line-grid transition-colors last:border-0 hover:bg-surface2/60"
                  style={{ ...ROW_GRID, padding: "13px 20px", fontSize: 14 }}
                >
                  {row.getVisibleCells().map((cell) => (
                    <div key={cell.id} role="cell" className="min-w-0">
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </div>
                  ))}
                </div>
              ))}
            </div>
          </TableScroll>
        )}
        {/* BELOW 640px, CARDS (2026-09-23): the 8-column grid at 390px was a 980px table in a
            340px scroller showing Niche, Games and one money column — the verdict, demand and
            score were all off-screen. A card leads with what decides: the verdict, demand,
            the score with its parts; the rest follows in plain words. */}
        {data && data.items.length > 0 && !wide && (
          <div data-testid="finder-cards">
            <MobileSort sort={sort} order={order} onSort={(col, ord) => patchParams({ sort: col === DEFAULT_SORT ? null : col, order: ord === "desc" ? null : ord })} />
            <ul className="flex flex-col">
              {data.items.map((row) => (
                <li key={row.key} className="border-t border-line-grid px-4 py-3" data-testid={`finder-card-${row.key}`}>
                  <NicheNameCell
                    row={row}
                    dimension={dimension}
                    selected={selectedRefs.has(`${dimension}:${row.key}`)}
                    full={!selectedRefs.has(`${dimension}:${row.key}`) && selectedRefs.size >= NICHE_COMBINE_CAP}
                    onToggle={toggleSelected}
                  />
                  <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[13px]">
                    <VerdictCell pinned={pinnedRow(row)} loading={!atPinnedCut && pinnedQ.isLoading} />
                    <span className="inline-flex items-center gap-1 text-ink-muted">
                      Demand <DemandValue row={row} />
                    </span>
                  </div>
                  <div className="mt-1.5 flex flex-wrap items-center gap-x-2 text-[13px] text-ink-muted">
                    Opportunity <OpportunityBreakdown row={row} variant="compact" title={`${row.key}: Opportunity score`} />
                  </div>
                  <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[12px] text-ink-muted">
                    <span>
                      {fmtInt(row.n_games)} games · {cutLabel}
                    </span>
                    <span>
                      top-10% revenue <RevenueValue row={row} value={row.p90_rev ?? null} />
                    </span>
                    <span>
                      releases <ReleasesValue row={row} />
                    </span>
                    <span>
                      players 7d <PlayersValue row={row} />
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      {data && (
        <div className="flex items-center justify-between text-[12px] text-ink-muted">
          <span>
            {total > 0 ? `${rangeStart.toLocaleString()}–${rangeEnd.toLocaleString()} of ${total.toLocaleString()} niches` : "0 results"}
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={offset === 0}
              onClick={() => setOffset(Math.max(0, offset - LIMIT))}
              className={clsx("px-3 py-1 text-ink-primary transition-colors", offset === 0 ? "pointer-events-none" : "hover:bg-surface2")}
              style={{ border: `1px solid ${PAPER_35}`, color: offset === 0 ? PAPER_45 : undefined }}
            >
              Prev
            </button>
            <button
              type="button"
              disabled={offset + LIMIT >= total}
              onClick={() => setOffset(offset + LIMIT)}
              className={clsx("px-3 py-1 text-ink-primary transition-colors", offset + LIMIT >= total ? "pointer-events-none" : "hover:bg-surface2")}
              style={{ border: `1px solid ${PAPER_35}`, color: offset + LIMIT >= total ? PAPER_45 : undefined }}
            >
              Next
            </button>
          </div>
        </div>
      )}

      {/* More metrics — kept, not deleted, but below the table and behind an explicit
          toggle; shares the same sort/order state, so its row order matches the table. */}
      {data && data.items.length > 0 && (
        <div className="flex flex-col" style={{ gap: 10 }}>
          <button
            type="button"
            onClick={() => setShowMoreMetrics(!showMoreMetrics)}
            aria-expanded={showMoreMetrics}
            className="kicker inline-flex w-fit items-center gap-2 text-ink-muted transition-colors hover:text-ink-secondary"
            style={{ fontSize: 11, border: `1px solid ${PAPER_30}`, padding: "6px 12px" }}
          >
            <span aria-hidden>{showMoreMetrics ? "−" : "+"}</span>
            More metrics — longevity, owners, hit rate, live players
          </button>
          {showMoreMetrics && (
            <div className="blueprint">
              <i className="bp-corner" />
              <p className="px-5 pt-3 text-[11px] text-ink-muted">
                {cutLabel}. Live players are each game&rsquo;s latest nightly sample
                {dataAge.asOfLabel ? ` (data as of ${dataAge.asOfLabel})` : ""}, not a daily peak.
              </p>
              <TableScroll>
                <div role="table" style={{ minWidth: MORE_METRICS_MIN_WIDTH }}>
                  <div role="row" className="border-b border-chartborder" style={{ ...MORE_METRICS_ROW_GRID, padding: "12px 20px" }}>
                    <ColHead active={false} order="desc">
                      <span className="uppercase text-ink-muted" style={HEADER_LABEL_STYLE}>
                        Niche
                      </span>
                    </ColHead>
                    {moreMetricsColumns.map((c) => (
                      <ColHead key={c.col} active={sort === c.col} order={order}>
                        <HeaderLabel term={c.term} sort={{ col: c.col, active: sort === c.col, order, onSort: toggleSort }} />
                      </ColHead>
                    ))}
                  </div>
                  {(data?.items ?? []).map((row) => (
                    <div
                      key={row.key}
                      role="row"
                      className="border-b border-line-grid transition-colors last:border-0 hover:bg-surface2/60"
                      style={{ ...MORE_METRICS_ROW_GRID, padding: "13px 20px", fontSize: 14 }}
                    >
                      <div role="cell" className="min-w-0 truncate text-ink-secondary">
                        {row.key}
                      </div>
                      {moreMetricsColumns.map((c) => (
                        <div key={c.col} role="cell" className="min-w-0">
                          {c.render(row)}
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              </TableScroll>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function NicheNameCell({
  row,
  dimension,
  selected,
  full,
  onToggle,
}: {
  row: NicheRow;
  dimension: Dimension;
  selected: boolean;
  full: boolean;
  onToggle: (sel: NicheSelection) => void;
}) {
  const key = row.key;
  const tier = row.tier;
  return (
    <div className="flex min-w-0 items-center gap-2">
      <input
        type="checkbox"
        checked={selected}
        disabled={full}
        onChange={() => onToggle({ dimension, key })}
        aria-label={`${selected ? "Remove" : "Add"} ${key} ${selected ? "from" : "to"} the combined analysis`}
        title={
          full
            ? `You can combine up to ${NICHE_COMBINE_CAP} niches at once`
            : selected
              ? "Selected — in the combination bar above the table"
              : "Select this niche to combine it with others"
        }
        className="h-3.5 w-3.5 shrink-0 cursor-pointer accent-[var(--brand)] disabled:cursor-not-allowed disabled:opacity-40"
      />
      <Link
        to={nicheDetailPath(dimension, key)}
        onClick={() => trackEvent("niche_open")}
        title={`Open the ${key} deep dive`}
        className="group/nk inline-flex min-w-0 items-center gap-2"
      >
        <span className="truncate font-medium text-ink-primary transition-colors group-hover/nk:text-brand">{key}</span>
        {tier && tier !== "micro" && tier !== "genre" && (
          <span
            className="shrink-0 px-[7px] py-px text-[10px] text-ink-muted"
            style={{ border: `1px solid ${PAPER_30}` }}
            title={TIER_TITLE[tier as NicheTier] ?? tier}
          >
            {TIER_LABEL[tier as NicheTier]?.toLowerCase().replace(/s$/, "") ?? tier}
          </span>
        )}
      </Link>
    </div>
  );
}

function DemandValue({ row }: { row: NicheRow }) {
  const d = radarDossier(row);
  if (d.emerging) {
    return (
      <span className="text-ink-muted" title={`${EMERGING_DEMAND_LABEL}${d.reviews24m ? ` · ${d.reviews24m} reviews in the last 24 months` : ""}`}>
        emerging
      </span>
    );
  }
  const v = row.demand_trend_24m_pct ?? null;
  if (v == null) return <SentinelTag>no data</SentinelTag>;
  // Same up/flat steel as the players column: direction reads from the glyph and the sign,
  // hue only reinforces.
  return (
    <span
      className="tabular font-medium"
      style={{ color: v >= 0 ? "var(--verdict-up)" : "var(--verdict-flat)" }}
      title={demandTrendWorked(row.reviews_24m, row.reviews_prev_24m, v) ?? "last 24 complete months vs the 24 before"}
    >
      {d.demand24m}
    </span>
  );
}

function ReleasesValue({ row }: { row: NicheRow }) {
  const v = row.saturation_yoy;
  if (v == null) return <SentinelTag>no data</SentinelTag>;
  const worked = releasesYoyWorked(row.n_recent_year, row.n_prior_year, v);
  return (
    <span title={worked ? `${worked}${v < -0.05 ? " — the pipeline is shrinking" : ""}` : undefined} className="tabular text-ink-secondary">
      {radarDossier(row).releasesYoy}
    </span>
  );
}

function RevenueValue({ row, value }: { row: NicheRow; value: number | null }) {
  const sentinel = paidStatSentinel(row, value);
  if (sentinel) {
    return <SentinelTag>{typeof sentinel === "string" ? sentinel : sentinel.tag}</SentinelTag>;
  }
  return (
    <span className="tabular text-ink-secondary" title="Only 1 game in 10 earns more (median in the deep dive)">
      {fmtUsd(value)}
    </span>
  );
}

function PlayersValue({ row }: { row: NicheRow }) {
  const t = readPlayersTrend(row);
  if (t.value === null) return <SentinelTag>no data</SentinelTag>;
  // Trend verdicts are mono steel — never red/green. Up carries the accent, down recedes.
  return (
    <span className="inline-flex flex-col leading-tight">
      <span className="tabular font-medium" style={{ color: t.up ? "var(--verdict-up)" : "var(--verdict-flat)" }}>
        {t.value}
      </span>
      {t.relative && (
        <span className="tabular text-[11px] text-ink-muted" title={t.worked ?? undefined}>
          {t.relative} vs market
        </span>
      )}
    </span>
  );
}

/** Below 640px there are no column headers to click, so the sort is a plain control. */
const MOBILE_SORTS: { col: SortKey; label: string }[] = [
  { col: "opportunity_v2", label: "Opportunity score" },
  { col: "demand_trend_24m_pct", label: "Demand trend, 24 months" },
  { col: "saturation_yoy", label: "Releases, year over year" },
  { col: "p90_rev", label: "Top-10% revenue" },
  { col: "n_games", label: "Games" },
  { col: "players_trend_7d_pct", label: "7-day players trend" },
  { col: "key", label: "Name" },
];

function MobileSort({
  sort,
  order,
  onSort,
}: {
  sort: SortKey;
  order: "asc" | "desc";
  onSort: (col: SortKey, order: "asc" | "desc") => void;
}) {
  return (
    <div className="flex items-center gap-2 px-4 py-2.5 text-[12px] text-ink-muted">
      <label htmlFor="finder-mobile-sort">Sort by</label>
      <select
        id="finder-mobile-sort"
        value={MOBILE_SORTS.some((s) => s.col === sort) ? sort : "opportunity_v2"}
        onChange={(e) => onSort(e.target.value as SortKey, e.target.value === "key" ? "asc" : "desc")}
        className="border bg-transparent px-1.5 py-1 text-ink-primary"
        style={{ borderColor: PAPER_30 }}
      >
        {MOBILE_SORTS.map((s) => (
          <option key={s.col} value={s.col}>
            {s.label}
          </option>
        ))}
      </select>
      <button
        type="button"
        onClick={() => onSort(sort, order === "desc" ? "asc" : "desc")}
        className="border px-2 py-1 text-ink-primary"
        style={{ borderColor: PAPER_30 }}
        aria-label={order === "desc" ? "Sorted high to low — switch to low to high" : "Sorted low to high — switch to high to low"}
      >
        {order === "desc" ? "↓ high first" : "↑ low first"}
      </button>
    </div>
  );
}

/**
 * The niche selection bar — the CompareTray idiom (chips with a ✕, a primary "(n)" action,
 * a Clear) applied to niches, so the app's two multi-selects behave the same way.
 *
 * It is NOT CompareTray itself: that component is hard-wired to the localStorage-backed
 * games compare list (appid/name entries, a global sticky footer rendered by AppShell), and
 * generalising it would mean rewriting a file this change doesn't own. The differences are
 * real, not cosmetic — niche selection lives in the URL, not localStorage, and is scoped to
 * this page. It pins under the header (top-14) rather than to the bottom edge, which the
 * global CompareTray already occupies: two sticky bars at bottom-0 would overlap.
 */
function NicheCombineBar({
  selection,
  onRemove,
  onClear,
  onAnalyse,
}: {
  selection: NicheSelection[];
  onRemove: (sel: NicheSelection) => void;
  onClear: () => void;
  onAnalyse: () => void;
}) {
  if (selection.length === 0) return null;
  const ready = selection.length >= 2;
  return (
    <div
      data-testid="niche-combine-bar"
      className="sticky top-14 z-20 -mt-2 flex flex-wrap items-center gap-2 border border-brand bg-surface px-3 py-2"
    >
      <span className="text-[11px] font-semibold uppercase tracking-wider text-ink-muted">Combine</span>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
        {selection.map((s) => (
          <span
            key={formatNicheRef(s)}
            className="inline-flex max-w-[200px] items-center gap-1 border border-chartborder bg-page px-2 py-0.5 text-[11px] text-ink-secondary"
          >
            <span className="truncate" title={`${s.dimension}: ${s.key}`}>
              {s.key}
            </span>
            <button
              type="button"
              onClick={() => onRemove(s)}
              aria-label={`Remove ${s.key} from the combination`}
              className="-my-1 flex h-6 w-6 shrink-0 items-center justify-center text-ink-muted hover:bg-surface2 hover:text-ink-primary"
            >
              ✕
            </button>
          </span>
        ))}
        <span className="text-[10px] text-ink-muted">
          {ready
            ? selection.length < NICHE_COMBINE_CAP
              ? `room for ${NICHE_COMBINE_CAP - selection.length} more`
              : `max ${NICHE_COMBINE_CAP} niches`
            : "pick one more — a combination needs at least two"}
        </span>
      </div>
      <button
        type="button"
        onClick={onAnalyse}
        disabled={!ready}
        title={ready ? "See the games that carry all of these niches at once" : "Select at least two niches to combine them"}
        className="bg-brand px-3 py-1.5 text-xs font-semibold text-brand-fg transition-colors hover:bg-brand-hover disabled:pointer-events-none disabled:opacity-40"
      >
        Analyse combined ({selection.length})
      </button>
      <button
        type="button"
        onClick={onClear}
        className="border border-chartborder px-2.5 py-1.5 text-[11px] font-medium text-ink-muted hover:text-ink-primary"
      >
        Clear
      </button>
    </div>
  );
}

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { createColumnHelper, flexRender, getCoreRowModel, useReactTable } from "@tanstack/react-table";
import clsx from "clsx";

import { EmptyState } from "../components/ui/EmptyState";
import { ErrorState } from "../components/ui/ErrorState";
import { Loading } from "../components/ui/Loading";
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
import { fmtCompact, fmtInt, fmtMonths, fmtPct, fmtUsd } from "../lib/format";
// The verdict, its two axes and the small score are the Radar's own strings — one builder
// (radarDossier), so the table, the deep dive and the board cannot disagree in wording.
import { EMERGING_DEMAND_LABEL, radarDossier } from "../lib/radarVerdict";
import { useDebounced } from "../lib/useDebounced";
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

// ---------------------------------------------------------------------------------------
// Industry blueprint grammar (design_handoff_prospect_dark_ui §4a). Most chrome maps onto
// the shared semantic tokens (text-ink-muted, border-line-grid, bg-surface2…), but a
// handful of alphas the mockup calls out precisely — segmented-control borders, bar
// tracks, the decline-gate suffix — don't have an existing utility at that exact opacity.
// These mix off --text-primary exactly the way index.css derives --text-muted/--text-secondary,
// so they stay theme-correct in both light and dark rather than pinning a raw hex.
// ---------------------------------------------------------------------------------------
const PAPER_30 = "color-mix(in srgb, var(--text-primary) 30%, transparent)";
const PAPER_35 = "color-mix(in srgb, var(--text-primary) 35%, transparent)";
const PAPER_45 = "color-mix(in srgb, var(--text-primary) 45%, transparent)";
const CONDENSED = '"Barlow Condensed", "Barlow", system-ui, sans-serif';

// Umbrella/meta tags are containers/reception labels, not buildable niches — excluded by
// default, same reasoning (and default) as the MCP find_niches tool.
const DEFAULT_TIERS: NicheTier[] = ["micro", "theme"];

const DEFAULT_SORT: SortKey = "opportunity_v2";

/** The sortable columns THIS page offers — the seven server-sortable ones in the grid (the
 * Verdict column is the board's call, computed client-side per row, so it has no server
 * sort — order by its two axes instead) plus the four in the "More metrics" panel. The
 * URL's `sort` is validated against it (an unknown key falls back to the default) so a
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

const TIER_TITLE: Record<NicheTier, string> = {
  micro: "Buildable game concepts (Colony Sim, Souls-like…)",
  theme: "Settings/aesthetics you attach to a game (Vikings, Pixel Graphics…)",
  umbrella: "Genre/mechanic containers (Open World, Sandbox…) — not buildable on their own",
  meta: "Reception tags (Great Soundtrack…) — never buildable",
};

// Mockup 4a draws exactly 8 columns at an fr-weighted grid; the three middle ones changed
// vocabulary on 2026-09-09 (user: "use radar numbers in niches") — Niche | Games | P90 rev
// | Demand 24m | Releases YoY | Verdict | Opp v2 ↓ | Players 7d. The Demand / Competition
// / Quality gap percentile meters were the retired v1 grammar drawn beside the v2 score;
// what the Radar draws is its two axes and a verdict, so that is what the grid carries now.
// The real table still tracks more sortable metrics than eight (longevity, total owners,
// hit rate, live players) plus a multi-select checkbox; nothing is dropped: the checkbox
// rides inside the (2fr-wide) Niche cell instead of owning its own track, and the extra
// metrics live in a second, explicitly-toggled panel below (MORE_METRICS_GRID / "More
// metrics"). The verdict track is the widest of the middle five: "Crowded · caution" has
// to fit on one line at the table's minimum width.
const GRID_TEMPLATE = "2fr .7fr 1fr 1fr 1fr 1.25fr .7fr 1fr";
const TABLE_MIN_WIDTH = 920;

const ROW_GRID: CSSProperties = {
  display: "grid",
  gridTemplateColumns: GRID_TEMPLATE,
  gap: 14,
  alignItems: "center",
};

// The second panel's grid — same grammar (14px gap, fr-weighted tracks), its own column
// set: Niche (for correlation with the row above) + the four metrics the mockup doesn't
// draw, plus the live player count (mockup 4a only draws the 7d *trend*, not the raw
// "Playing now" total this page already had).
const MORE_METRICS_GRID_TEMPLATE = "2fr .9fr 1fr .9fr 1fr .9fr";
const MORE_METRICS_MIN_WIDTH = 640;

const MORE_METRICS_ROW_GRID: CSSProperties = {
  display: "grid",
  gridTemplateColumns: MORE_METRICS_GRID_TEMPLATE,
  gap: 14,
  alignItems: "center",
};

/** A clickable column header that drives the server-side sort, with a direction arrow.
 * `help` is the column's plain-language "how to read this" — it becomes the hover tooltip
 * (with the sort hint appended) so every metric column explains itself in place, even
 * though the visible affordance is now just the label + arrow (mockup 4a shows no icon). */
function SortLabel({
  label,
  col,
  active,
  order,
  onSort,
  help,
}: {
  label: string;
  col: SortKey;
  active: boolean;
  order: "asc" | "desc";
  onSort: (col: SortKey) => void;
  help?: string;
}) {
  return (
    <button
      type="button"
      onClick={() => onSort(col)}
      title={help ? `${help}\n\nClick to sort by ${label}.` : `Sort by ${label}`}
      className="group inline-flex items-center gap-1 whitespace-nowrap uppercase text-ink-muted transition-colors hover:text-ink-secondary"
      style={{ fontFamily: CONDENSED, fontSize: 12, letterSpacing: ".08em", fontWeight: 600 }}
    >
      {label}
      <span
        aria-hidden
        className={clsx("text-[10px] leading-none", active ? "opacity-100" : "opacity-0 group-hover:opacity-50")}
      >
        {active ? (order === "desc" ? "↓" : "↑") : "↕"}
      </span>
    </button>
  );
}

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

export default function NicheFinder() {
  usePageTitle("Niche Finder");
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
  //     list — they swap in different medians, a different saturation_yoy and a different
  //     opportunity_v2 for the same niche (Radar.tsx's BOARD_WINDOW doc spells this out,
  //     which is why the board pins its cut instead of exposing chips). A URL that omits
  //     them doesn't describe what the sender was looking at: the recipient sees the same
  //     rows carrying different numbers.
  //  2. THIS PAGE ALREADY TREATED THE CUT AS PART OF THE ARTIFACT. "Analyse combined"
  //     hands win/min_reviews to nicheCombinedPath, and Export CSV builds its href from
  //     every filter. So a shared /niches?niches=… link restored the ticked rows, silently
  //     re-based them onto the DEFAULT cut, and then produced a different combined page
  //     than the sender got. That is a wrong answer, not an inconvenience.
  //  3. THE APP PROMISES THIS BEHAVIOUR OUT LOUD on /niches/:dim/:key ("This filter lives
  //     in the URL — copy the address bar to share exactly this slice"). A user who learns
  //     the rule one click away reasonably expects it here.
  //
  // Contract, matching NicheDetail (the page these rows link into): DEFAULTS ARE OMITTED,
  // so a pristine /niches stays a clean URL and only a non-default reading writes a param;
  // unknown/garbage values fall back to the default instead of throwing; and every write
  // `replace`s — this page's own convention since the selection landed ("ticking
  // checkboxes shouldn't bury the previous page in history"), and flipping a chip or a
  // sort arrow has exactly the same claim on the back button as ticking a row.
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
  const setDimension = useCallback(
    (d: Dimension) => patchParams({ dim: d === "tag" ? null : d }),
    [patchParams],
  );
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

  const columnHelper = useMemo(() => createColumnHelper<NicheRow>(), []);
  const columns = useMemo(
    () => [
      // Mockup 4a's Niche column is 2fr-wide and draws nothing else in the row for it —
      // the multi-select checkbox rides inside that cell (rather than owning a dedicated
      // grid track the mockup never draws) so the selection feature keeps working without
      // widening the grid past the mockup's 8 columns.
      columnHelper.accessor("key", {
        header: () => (
          <SortLabel label="Niche" help="A Steam community tag or Steam genre. The small badge marks non-buildable tiers (theme = a setting you attach to a game; umbrella = a genre container; meta = a reception tag)." col="key" active={sort === "key"} order={order} onSort={toggleSort} />
        ),
        cell: (info) => {
          const tier = info.row.original.tier;
          const key = info.getValue();
          const ref = `${dimension}:${key}`;
          const on = selectedRefs.has(ref);
          const full = !on && selectedRefs.size >= NICHE_COMBINE_CAP;
          return (
            <div className="flex min-w-0 items-center gap-2">
              <input
                type="checkbox"
                checked={on}
                disabled={full}
                onChange={() => toggleSelected({ dimension, key })}
                aria-label={`${on ? "Remove" : "Add"} ${key} ${on ? "from" : "to"} the combined analysis`}
                title={
                  full
                    ? `You can combine up to ${NICHE_COMBINE_CAP} niches at once`
                    : on
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
                <span className="truncate font-medium text-ink-primary transition-colors group-hover/nk:text-brand">
                  {key}
                </span>
                {tier && tier !== "micro" && tier !== "genre" && (
                  <span
                    className="shrink-0 px-[7px] py-px text-[10px] text-ink-muted"
                    style={{ border: `1px solid ${PAPER_30}` }}
                    title={TIER_TITLE[tier as NicheTier] ?? tier}
                  >
                    {tier}
                  </span>
                )}
              </Link>
            </div>
          );
        },
      }),
      columnHelper.accessor("n_games", {
        header: () => (
          <SortLabel label="Games" help="Scored games in this cut (released inside the window, at or above the review floor). Small counts = thin evidence." col="n_games" active={sort === "n_games"} order={order} onSort={toggleSort} />
        ),
        cell: (info) => <span className="tabular text-ink-secondary">{fmtInt(info.getValue())}</span>,
      }),
      columnHelper.accessor((row) => row.p90_rev ?? null, {
        id: "p90_rev",
        header: () => (
          <SortLabel label="P90 rev" help="What the niche's successful titles earn: the 90th percentile of estimated lifetime revenue across its scored games (1 in 10 does better). Each game's estimate = review count × 30 owners-per-review × launch price — one flat ratio (the mid of the cited 20–55 band), not fitted per genre; gross, lifetime, not reported sales. Median (the typical outcome) is in the deep dive." col="p90_rev" active={sort === "p90_rev"} order={order} onSort={toggleSort} />
        ),
        cell: (info) => {
          const v = info.getValue();
          return (
            <span
              className="tabular text-ink-secondary"
              title="90th-percentile est. lifetime revenue — what the niche's successful titles earn (median lives in the deep dive)"
            >
              {v != null ? fmtUsd(v) : "—"}
            </span>
          );
        },
      }),
      // THE RADAR'S TWO AXES AND ITS CALL (2026-09-09). The three 0–100 percentile meters
      // (Demand / Competition / Quality gap) that sat here were the retired v1 vocabulary
      // drawn beside the v2 score, and none of them is what the board plots. These three
      // columns are the board's X axis, its Y axis and its verdict, through the SAME
      // radarDossier() strings the deep dive's headline and the board's tooltip print, so a
      // row here, its page and its dot cannot disagree in wording. Judged on THIS table's
      // cut — the board pins 24m × ≥50 — and the header sentence says which is which.
      columnHelper.accessor((row) => row.demand_trend_24m_pct ?? null, {
        id: "demand_trend_24m_pct",
        header: () => (
          <SortLabel label="Demand 24m" help="The Radar's X axis: the niche's review inflow over the last 24 complete months vs the 24 before, in percent. At or above +40% is the board's 'enter' bar; at or below −30% its 'declining' bar. One value per niche, identical on every cut. An emerging niche shows no % — its prior window is near zero by construction — and is judged on absolute volume instead." col="demand_trend_24m_pct" active={sort === "demand_trend_24m_pct"} order={order} onSort={toggleSort} />
        ),
        cell: (info) => {
          const d = radarDossier(info.row.original);
          if (d.emerging) {
            return (
              <span
                className="text-ink-muted"
                title={`${EMERGING_DEMAND_LABEL}${d.reviews24m ? ` · ${d.reviews24m} reviews / 24m` : ""}`}
              >
                emerging
              </span>
            );
          }
          const v = info.getValue();
          if (v == null) return <span style={{ color: "var(--verdict-flat)" }} title={d.demand24m}>—</span>;
          // Same up/flat steel as the Players 7d column: direction reads from the glyph and
          // the sign, hue only reinforces.
          return (
            <span
              className="tabular font-medium"
              style={{ color: v >= 0 ? "var(--verdict-up)" : "var(--verdict-flat)" }}
              title="Last 24 complete months vs the prior 24 — the Radar's demand axis"
            >
              {d.demand24m}
            </span>
          );
        },
      }),
      columnHelper.accessor((row) => row.saturation_yoy ?? null, {
        id: "saturation_yoy",
        header: () => (
          <SortLabel label="Releases YoY" help="The Radar's Y axis: is the release pipeline growing? Calculated: (releases last calendar year − releases the year before) ÷ the year before, over the whole niche at every review count. Above +15% is the board's 'flooding' bar. Negative = SHRINKING — 'low competition' in a shrinking niche is decline, not opportunity." col="saturation_yoy" active={sort === "saturation_yoy"} order={order} onSort={toggleSort} />
        ),
        cell: (info) => {
          const row = info.row.original;
          const v = info.getValue();
          if (v == null) return <span className="text-ink-muted">—</span>;
          const title =
            row.n_recent_year != null && row.n_prior_year != null
              ? `(${fmtInt(row.n_recent_year)} releases last year − ${fmtInt(row.n_prior_year)} the year before) ÷ ${fmtInt(row.n_prior_year)} = ${(v * 100).toFixed(1)}%${v < -0.05 ? " — the pipeline is shrinking" : ""}`
              : undefined;
          return (
            <span title={title} className="tabular text-ink-secondary">
              {radarDossier(row).releasesYoy}
            </span>
          );
        },
      }),
      columnHelper.display({
        id: "verdict",
        header: () => (
          // Not a SortLabel: the verdict is computed client-side per row from the two axes
          // and winner concentration, so there is no server order to ask for — a sort arrow
          // here would 422. Same type as its neighbours, minus the button.
          <span
            title="The Radar board's call for this row — Enter now / Watch / Emerging / Crowded / Declining — from the same rules the board rings with, read off Demand 24m, Releases YoY and winner concentration. Judged on this table's cut (the board pins last 24 months · ≥50 reviews). Not sortable: order by its two axes instead."
            className="inline-flex items-center whitespace-nowrap uppercase text-ink-muted"
            style={{ fontFamily: CONDENSED, fontSize: 12, letterSpacing: ".08em", fontWeight: 600 }}
          >
            Verdict
          </span>
        ),
        cell: (info) => {
          const d = radarDossier(info.row.original);
          return (
            <span
              className="inline-flex items-center gap-1.5 text-ink-primary"
              title={d.verdict.reason}
              data-verdict={d.verdict.ring}
            >
              <span className="inline-block h-2 w-2 shrink-0" style={{ backgroundColor: d.color }} aria-hidden />
              {d.verdictLabel}
            </span>
          );
        },
      }),
      columnHelper.accessor("opportunity_v2", {
        header: () => (
          <SortLabel
            label="Opp v2"
            help="The Radar's rank number: the 0–100 opportunity_v2 score, printed exactly as the board's tooltip prints it. It orders the rows; the Verdict column is the board's call. How it is built — four blended sub-scores × a supply brake — is in the docs' score guide, and its parts ride every API row."
            col="opportunity_v2"
            active={sort === "opportunity_v2"}
            order={order}
            onSort={toggleSort}
          />
        ),
        // The small rank number and nothing else (2026-09-09): no 17px display numeral, no
        // "strong" tint, no "×0.96" brake suffix, no blend formula in the hover. The score
        // is the table's order; the verdict two cells left is the headline, as on the board.
        cell: (info) => <span className="tabular text-ink-secondary">{radarDossier(info.row.original).oppV2}</span>,
      }),
      columnHelper.accessor("players_trend_7d_pct", {
        header: () => (
          <SortLabel
            label="Players 7d" help="Live-player momentum. Calculated: (average players over the last 7 days − average over the prior 7) ÷ the prior 7, summed over games measured in BOTH windows — so growing data coverage can't fake an audience trend."
            col="players_trend_7d_pct"
            active={sort === "players_trend_7d_pct"}
            order={order}
            onSort={toggleSort}
          />
        ),
        cell: (info) => {
          const v = info.getValue();
          // Trend verdicts are mono steel — never red/green. Up carries the accent, down
          // (or flat) recedes to muted paper; direction reads from the glyph + sign, not hue.
          if (v == null) return <span style={{ color: "var(--verdict-flat)" }}>—</span>;
          const up = v >= 0;
          return (
            <span
              className="tabular font-medium"
              style={{ color: up ? "var(--verdict-up)" : "var(--verdict-flat)" }}
              title="Last 7d vs prior 7d, same-panel (only games measured in both windows count)"
            >
              {up ? "▲" : "▼"} {up ? "+" : "−"}
              {Math.abs(v).toFixed(1)}%
            </span>
          );
        },
      }),
    ],
    [columnHelper, sort, order, toggleSort, dimension, selectedRefs, toggleSelected],
  );

  const table = useReactTable({
    data: data?.items ?? [],
    columns,
    getCoreRowModel: getCoreRowModel(),
  });

  // ---- "more metrics" panel --------------------------------------------------------
  // Everything the app tracks that the grid above does NOT draw — longevity, total owners,
  // hit rate, and the raw "playing now" count (the grid only draws the 7d *trend*).
  // Saturation YoY left this panel on 2026-09-09: it is the grid's Releases YoY column
  // now, and one number under two names is exactly the drift this table stopped carrying.
  // Not deleted, just not crammed into the grid: reachable below the table, behind an
  // explicit toggle, sharing the exact same sort/order state (and so the exact same row
  // order) as the primary table above it.
  //
  // Routed too (?more=1) precisely BECAUSE it shares that sort state: a link carrying
  // sort=saturation_yoy without the panel would land on a table that has no such column
  // and no arrow to explain the order it is in. keepOffset — opening a disclosure is not
  // a filter change, so it must not re-page the table.
  const showMoreMetrics = searchParams.get("more") === "1";
  const setShowMoreMetrics = useCallback(
    (v: boolean) => patchParams({ more: v ? "1" : null }, { keepOffset: true }),
    [patchParams],
  );
  const moreMetricsColumns = useMemo(
    () => [
      {
        col: "lifetime_survival_12m" as SortKey,
        label: "Longevity",
        help: "Of this niche's games that ever reached 100+ concurrent players, the share still holding 10+ a year later. Calculated: fixed-horizon survival — games whose 100+ month is at least 12 months old only; steamcharts top-8k coverage.",
        render: (row: NicheRow) => {
          const v = row.lifetime_survival_12m ?? null;
          if (v == null) return <span className="text-ink-muted">—</span>;
          const m = row.lifetime_median_dead_months;
          const title =
            `${fmtPct(v)} of its 100+ games still alive after a year` +
            (m != null ? ` · dead ones lasted ~${fmtMonths(m)}` : "");
          return (
            <span className="tabular text-ink-secondary" title={title}>
              {fmtPct(v)}
            </span>
          );
        },
      },
      {
        col: "total_owners" as SortKey,
        label: "Total owners",
        help: "The size of the pie. Calculated: SUM of each scored game's estimated owners (SteamSpy range midpoint; review-modeled where SteamSpy is coarse). A big pie with a low score means people play the HITS — it doesn't hand a new entrant a slice.",
        render: (row: NicheRow) => (
          <span className="tabular text-ink-secondary">{fmtCompact(row.total_owners)}</span>
        ),
      },
      {
        col: "hit_rate_200k" as SortKey,
        label: "Hit ≥$200K",
        help: "The odds a serious title 'works' here. Calculated: share of the niche's scored games whose estimated lifetime revenue clears $200K.",
        render: (row: NicheRow) => {
          const v = row.hit_rate_200k;
          const n = row.n_games;
          const title =
            v != null && n ? `${Math.round(v * n)} of ${fmtInt(n)} scored games clear $200K est. lifetime revenue` : undefined;
          return (
            <span className="tabular text-ink-secondary" title={title}>
              {fmtPct(v)}
            </span>
          );
        },
      },
      {
        col: "total_players_now" as SortKey,
        label: "Playing now",
        help: "Who's playing right now. Calculated: SUM of each scored game's latest nightly player capture (kept up to 7 days). Captures are ~21–22:00 UTC point samples, not daily peaks. Dominated by the niche's hits.",
        render: (row: NicheRow) => (
          <span className="tabular text-ink-secondary" title="Summed current players (nightly point samples, ≤7d carry) — dominated by the niche's hits">
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
        {/* The ranking is Opp v2 (etl/marts/mart_niche.sql `scored_v2`); the labels are the
            Radar's verdicts through lib/radarVerdict.ts — the board's rules, words and colour
            tokens (2026-09-09, user: "use radar numbers in niches"). The board pins its cut at
            24m × ≥50 while this table has chips, so away from that cut the sentence says the
            verdicts are judged HERE, on this cut. NOT "growth-gated" — there is no gate in the
            model; decline_gate is a falsification tell only. */}
        <span className="text-[13px] text-ink-secondary">
          {total > 0 ? `${total.toLocaleString()} niches · ` : ""}
          ranked and labelled as on the Radar — Opp v2 order, the board&rsquo;s verdicts
          {windowParam === DEFAULT_NICHE_CUT.win && minReviews === DEFAULT_NICHE_CUT.min_reviews
            ? " on its own cut (last 24 months · ≥50 reviews)"
            : " judged on this cut (the board itself pins last 24 months · ≥50 reviews)"}
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
            title="No review floor — the whole tag, unreviewed releases included. Game counts are the honest tag size; revenue stats still skip games too small to estimate."
          >
            All games
          </SegButton>
          <SegButton active={minReviews === 50} onClick={() => setMinReviews(50)} title="Broader population, noisier stats">
            ≥50 reviews
          </SegButton>
          <SegButton active={minReviews === 100} onClick={() => setMinReviews(100)} title="Stricter population, cleaner stats">
            ≥100
          </SegButton>
        </Segmented>
        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search niches…"
          className="bg-transparent text-[13px] text-ink-primary outline-none placeholder:text-ink-muted"
          style={{ width: 220, border: `1px solid ${PAPER_30}`, padding: "6px 12px" }}
        />
        {dimension === "tag" && (
          <span className="flex items-center gap-1.5 text-[11px] text-ink-muted">
            Tiers:
            {NICHE_TIERS.map((t) => {
              const active = tiers.includes(t);
              return (
                <button
                  key={t}
                  type="button"
                  onClick={() => toggleTier(t)}
                  title={TIER_TITLE[t]}
                  className={clsx(
                    "px-2.5 py-[3px] text-[11px] font-medium transition-colors",
                    active ? "text-brand" : "text-ink-muted hover:bg-surface2",
                  )}
                  style={{ border: `1px solid ${active ? "var(--brand)" : PAPER_30}` }}
                >
                  {t}
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
          navigate(
            nicheCombinedPath(selection, "intersect", { win: windowParam, min_reviews: minReviews }),
          );
        }}
      />

      <div className={clsx("blueprint", isFetching && "opacity-90 transition-opacity")}>
        <i className="bp-corner" />
        {isLoading && <Loading label="Loading niches…" className="p-8 text-sm" />}
        {/* Was `error.message` in raw — "Failed to load niches: Failed to fetch" with the
            API unreachable (measured on production 2026-09-01), and no way to try again. */}
        {isError && (
          <ErrorState
            title="Couldn't load niches"
            error={error}
            onRetry={() => void refetch()}
            className="p-8"
          />
        )}
        {data && data.items.length === 0 && (
          <EmptyState
            title="No niches match these filters"
            description="Try a broader tier selection, a lower review floor, or clear the search."
          />
        )}
        {data && data.items.length > 0 && (
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
      </div>

      {data && (
        <div className="flex items-center justify-between text-[12px] text-ink-muted">
          <span>
            {total > 0
              ? `${rangeStart.toLocaleString()}–${rangeEnd.toLocaleString()} of ${total.toLocaleString()}`
              : "0 results"}
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
              className={clsx(
                "px-3 py-1 text-ink-primary transition-colors",
                offset + LIMIT >= total ? "pointer-events-none" : "hover:bg-surface2",
              )}
              style={{ border: `1px solid ${PAPER_35}`, color: offset + LIMIT >= total ? PAPER_45 : undefined }}
            >
              Next
            </button>
          </div>
        </div>
      )}

      {/* Mockup 4a draws exactly 8 columns. This page already tracked more sortable
          metrics than that (longevity, total owners, hit rate, raw live-player count) —
          kept, not deleted, but pushed below the table and behind an explicit toggle rather
          than crammed into its grid. Shares the same sort/order state, so its row order
          always matches the table above it. */}
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
              <TableScroll>
                <div role="table" style={{ minWidth: MORE_METRICS_MIN_WIDTH }}>
                  <div role="row" className="border-b border-chartborder" style={{ ...MORE_METRICS_ROW_GRID, padding: "12px 20px" }}>
                    <ColHead active={false} order="desc">
                      <span
                        className="uppercase text-ink-muted"
                        style={{ fontFamily: CONDENSED, fontSize: 12, letterSpacing: ".08em", fontWeight: 600 }}
                      >
                        Niche
                      </span>
                    </ColHead>
                    {moreMetricsColumns.map((c) => (
                      <ColHead key={c.col} active={sort === c.col} order={order}>
                        <SortLabel label={c.label} help={c.help} col={c.col} active={sort === c.col} order={order} onSort={toggleSort} />
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

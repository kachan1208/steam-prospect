import { useCallback, useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { createColumnHelper, flexRender, getCoreRowModel, useReactTable } from "@tanstack/react-table";
import clsx from "clsx";

import { EmptyState } from "../components/ui/EmptyState";
import { Loading } from "../components/ui/Loading";
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
import { fmtCompact, fmtInt, fmtMonths, fmtPct, fmtSigned, fmtUsd } from "../lib/format";
// The "strong score" bar and the supply bars are the Radar's own — one set of constants,
// so the table, the board and the mart cannot disagree about what they mean.
import { ENTRANT_RATIO_CATALOG_NORM, OPP_WATCH_SCORE, SAT_FLOOD_YOY } from "../lib/radarVerdict";
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
const PAPER_15 = "color-mix(in srgb, var(--text-primary) 15%, transparent)";
const PAPER_30 = "color-mix(in srgb, var(--text-primary) 30%, transparent)";
const PAPER_35 = "color-mix(in srgb, var(--text-primary) 35%, transparent)";
const PAPER_45 = "color-mix(in srgb, var(--text-primary) 45%, transparent)";
const PAPER_50 = "color-mix(in srgb, var(--text-primary) 50%, transparent)";
const PAPER_80 = "color-mix(in srgb, var(--text-primary) 80%, transparent)";
const CONDENSED = '"Barlow Condensed", "Barlow", system-ui, sans-serif';

// Umbrella/meta tags are containers/reception labels, not buildable niches — excluded by
// default, same reasoning (and default) as the MCP find_niches tool.
const DEFAULT_TIERS: NicheTier[] = ["micro", "theme"];

const TIER_TITLE: Record<NicheTier, string> = {
  micro: "Buildable game concepts (Colony Sim, Souls-like…)",
  theme: "Settings/aesthetics you attach to a game (Vikings, Pixel Graphics…)",
  umbrella: "Genre/mechanic containers (Open World, Sandbox…) — not buildable on their own",
  meta: "Reception tags (Great Soundtrack…) — never buildable",
};

// Mockup 4a draws exactly 8 columns, at this exact fr-weighted grid — Niche | Games |
// P90 rev | Demand | Competition | Quality gap | Opp v2 ↓ | Players 7d. The real table
// carries more sortable metrics than that (longevity, total owners, hit rate, saturation)
// plus a multi-select checkbox; a prior pass widened this grid to cram all 14 in, which is
// why the page still read as "the old table, recoloured" instead of the mockup's composition.
// Nothing is dropped: the checkbox rides inside the (2fr-wide) Niche cell instead of owning
// its own track, and the four extra metrics move to a second, explicitly-toggled panel
// below the mockup-faithful table (see MORE_METRICS_GRID / "More metrics" below).
const GRID_TEMPLATE = "2fr .7fr 1fr 1fr 1fr 1fr .9fr 1fr";
const TABLE_MIN_WIDTH = 860;

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

/** 4px opportunity meter: track paper 15%, fill accent-300 (demand/quality) or paper 50%
 * (competition — higher is worse, so it never reads as "more of the good color"). */
function MetricBar({ value, tone }: { value: number | null; tone: "accent" | "neutral" }) {
  const pct = value == null ? 0 : Math.max(0, Math.min(100, value));
  return (
    <div className="h-1 w-full" style={{ backgroundColor: PAPER_15 }}>
      <div
        className="h-full"
        style={{ width: `${pct}%`, backgroundColor: tone === "accent" ? "var(--brand)" : PAPER_50 }}
      />
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
  const [dimension, setDimension] = useState<Dimension>("tag");
  // 24m is the market a new entrant actually faces — the all-time cut is context, not an
  // entry decision, so it is NOT the default (same default as the MCP tool).
  const [windowParam, setWindowParam] = useState<Window>(DEFAULT_NICHE_CUT.win);
  // mart materializes exactly 0 (no floor), 50 & 100
  const [minReviews, setMinReviews] = useState(DEFAULT_NICHE_CUT.min_reviews);
  const [tiers, setTiers] = useState<NicheTier[]>(DEFAULT_TIERS);
  const [q, setQ] = useState("");
  const debouncedQ = useDebounced(q, 300);
  const [sort, setSort] = useState<SortKey>("opportunity_v2");
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
  const toggleTier = useCallback((t: NicheTier) => {
    setTiers((cur) => {
      const next = cur.includes(t) ? cur.filter((x) => x !== t) : [...cur, t];
      return next.length === 0 ? cur : next; // never allow an empty selection
    });
  }, []);
  const [offset, setOffset] = useState(0);

  // Any filter change re-pages to the top so offset never points past the new result set.
  useEffect(() => {
    setOffset(0);
  }, [dimension, windowParam, minReviews, tiers, debouncedQ, sort, order]);

  // ---- multi-select ---------------------------------------------------------------
  // A game carries many tags, so it lives in many niches — selecting 2..N and analysing
  // the overlap is a first-class question. The selection rides the URL (repeated
  // `niches=<dimension>:<key>`) so a half-built combination is shareable, exactly like
  // /compare?ids=. Filters stay in component state: they're a browsing pose, the
  // selection is the artifact worth sending someone.
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
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
  const { data, isLoading, isFetching, isError, error } = useNiches({
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
      columnHelper.accessor((row) => row.demand ?? null, {
        id: "demand",
        header: () => (
          <SortLabel label="Demand" help="How hot the market is, 0–100 percentile vs other niches in this cut. Calculated: 0.4×pctile(median revenue) + 0.3×pctile(median owners) + 0.3×pctile(recent 24m review velocity)." col="demand" active={sort === "demand"} order={order} onSort={toggleSort} />
        ),
        cell: (info) => {
          const v = info.getValue();
          return (
            <div title={`Demand: ${v != null ? v.toFixed(1) : "no data"} (0–100 percentile)`}>
              <MetricBar value={v} tone="accent" />
            </div>
          );
        },
      }),
      columnHelper.accessor((row) => row.competition ?? null, {
        id: "competition",
        header: () => (
          <SortLabel label="Competition" help="How crowded it is, 0–100 percentile. Calculated: 0.6×pctile(recently released games) + 0.4×pctile(winner concentration — the top 5% of titles' revenue share). HIGHER IS WORSE for a new entrant." col="competition" active={sort === "competition"} order={order} onSort={toggleSort} />
        ),
        cell: (info) => {
          const v = info.getValue();
          return (
            <div title={`Competition: ${v != null ? v.toFixed(1) : "no data"} (0–100 percentile, higher is worse)`}>
              <MetricBar value={v} tone="neutral" />
            </div>
          );
        },
      }),
      columnHelper.accessor((row) => row.quality_gap ?? null, {
        id: "quality_gap",
        header: () => (
          <SortLabel label="Quality gap" help="How beatable the field is, 0–100 percentile. Calculated: pctile(share of incumbents that are weak — rating under 80% positive OR fewer than 50 reviews). Higher = easier to out-execute." col="quality_gap" active={sort === "quality_gap"} order={order} onSort={toggleSort} />
        ),
        cell: (info) => {
          const v = info.getValue();
          return (
            <div title={`Quality gap: ${v != null ? v.toFixed(1) : "no data"} (0–100 percentile)`}>
              <MetricBar value={v} tone="accent" />
            </div>
          );
        },
      }),
      columnHelper.accessor("opportunity_v2", {
        header: () => (
          <SortLabel
            label="Opp v2" help="The headline score, and the same model the Radar board rings on: a weighted blend of momentum (demand growth — 50 at flat, 88 at the radar's +40%/24m 'enter' bar), market pull (typical revenue + audience size), revenue spread (50 exactly at the 0.85 winner-take-most bar) and quality gap, then multiplied by the supply brake (0.35–1.0; bites when the release pipeline outgrows demand, or when newcomers earn under the catalog norm). A missing input is skipped, never counted as zero."
            col="opportunity_v2"
            active={sort === "opportunity_v2"}
            order={order}
            onSort={toggleSort}
          />
        ),
        cell: (info) => {
          const v = info.getValue();
          const row = info.row.original;
          const brake = row.supply_brake;
          // >= OPP_WATCH_SCORE is the "scores like a niche the radar would say enter" bar
          // (median of the enter ring on the live catalog) — one constant, shared with the
          // board, so the table and the radar can't disagree about what "strong" means.
          const strong = v != null && v >= OPP_WATCH_SCORE;
          // The row's REAL sub-scores substituted into the formula, so the hover answers
          // "why is it this value" without leaving the table. Absent on marts that predate
          // the 2026-08-31 rebuild — then the generic explanation stands in.
          const terms: [string, number | null | undefined, number][] = [
            ["momentum", row.momentum, 0.4],
            ["market", row.market_pull, 0.22],
            ["spread", row.revenue_spread, 0.2],
            ["quality", row.quality_gap, 0.18],
          ];
          const live = terms.filter(([, n]) => n != null);
          // The blend RENORMALISES over the terms that exist, so the printed equation has
          // to show the divisor — otherwise the products visibly don't reach the score
          // whenever a sub-score is null (an emerging niche has no momentum).
          const liveWeight = live.reduce((a, [, , w]) => a + w, 0);
          const skipped = terms.filter(([, n]) => n == null).map(([label]) => label);
          const calc =
            live.length > 0 && brake != null
              ? `${live.map(([label, n, w]) => `${label} ${n!.toFixed(0)}×${w.toFixed(2)}`).join(" + ")}` +
                (skipped.length > 0
                  ? ` ÷ ${liveWeight.toFixed(2)} (${skipped.join(" + ")} unknown — skipped, never counted as 0)`
                  : "") +
                ` → × supply brake ${brake.toFixed(2)} = ${v != null ? v.toFixed(1) : "—"}`
              : null;
          const title =
            calc ??
            "Blend of momentum + market pull + revenue spread + quality gap, × the supply brake";
          return (
            <div className="flex items-baseline gap-1.5" title={title}>
              <span
                className="tabular"
                style={{ fontFamily: CONDENSED, fontWeight: 600, fontSize: 17, color: v == null ? undefined : strong ? "var(--brand)" : PAPER_80 }}
              >
                {v != null ? v.toFixed(1) : "—"}
              </span>
              {brake != null && brake < 0.995 && (
                <span
                  className="tabular"
                  style={{ fontSize: 10, color: PAPER_50 }}
                  title={(() => {
                    // supply_room = MIN(flood_room, entrant_room), so the driver is
                    // whichever of the two is LOWER — not whichever raw signal looks bad.
                    // Naming it from `saturation_yoy > SAT_FLOOD_YOY` alone gets it wrong
                    // exactly when the score most needs explaining: a niche whose demand
                    // is outrunning a fast pipeline has flood_room 100 and is braked by
                    // its entrants, and vice versa. Both sub-scores are recomputed here
                    // from the row's own raw columns (same formula as mart_niche.sql).
                    const sat = row.saturation_yoy;
                    const er = row.entrant_ratio;
                    const trend = row.demand_trend_24m_pct;
                    const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
                    const demandG = trend == null ? 0 : Math.log(Math.max(1 + trend / 100, 0.001)) / 2;
                    const floodRoom =
                      sat == null
                        ? null
                        : 100 *
                          (1 -
                            clamp01(
                              (Math.log(Math.max(1 + sat, 0.001)) - demandG) /
                                (2 * Math.log(1 + SAT_FLOOD_YOY)),
                            ));
                    const entrantRoom =
                      er == null
                        ? null
                        : 100 * clamp01((er - 0.5) / (ENTRANT_RATIO_CATALOG_NORM - 0.5));
                    const floodDriver =
                      sat != null &&
                      (entrantRoom == null || (floodRoom != null && floodRoom <= entrantRoom));
                    const driver = floodDriver
                      ? `the release pipeline is growing ${((sat ?? 0) * 100).toFixed(0)}%/yr — faster than demand${
                          trend != null ? ` (${trend >= 0 ? "+" : ""}${trend.toFixed(0)}% / 24m)` : ""
                        }`
                      : er != null
                        ? `newcomers earn ${er.toFixed(2)}× the back catalog, under the ~${ENTRANT_RATIO_CATALOG_NORM} catalog norm`
                        : "supply is outrunning demand";
                    return `Supply brake ×${brake.toFixed(2)} — ${driver}. The brake takes the WORSE of the two supply reads, so either alone can sink the score.`;
                  })()}
                >
                  ×{brake.toFixed(2)}
                </span>
              )}
            </div>
          );
        },
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
  // Everything the app tracks that mockup 4a does NOT draw — longevity, total owners,
  // hit rate, saturation, and the raw "playing now" count (the mockup only draws the 7d
  // *trend*). Not deleted, just not crammed into the mockup-faithful grid above: reachable
  // below the table, behind an explicit toggle, sharing the exact same sort/order state
  // (and so the exact same row order) as the primary table above it.
  const [showMoreMetrics, setShowMoreMetrics] = useState(false);
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
        col: "saturation_yoy" as SortKey,
        label: "Saturation YoY",
        help: "Is the pipeline growing? Calculated: (releases last calendar year − releases the year before) ÷ the year before. Negative = SHRINKING — 'low competition' in a shrinking niche is decline, not opportunity.",
        render: (row: NicheRow) => {
          const v = row.saturation_yoy;
          const title =
            row.n_recent_year != null && row.n_prior_year != null && v != null
              ? `(${fmtInt(row.n_recent_year)} releases last year − ${fmtInt(row.n_prior_year)} the year before) ÷ ${fmtInt(row.n_prior_year)} = ${(v * 100).toFixed(1)}%${v < -0.05 ? " — the pipeline is shrinking" : ""}`
              : undefined;
          return (
            <span title={title} className="tabular text-ink-secondary">
              {fmtSigned(v)}
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
        {/* NOT "growth-gated" — there is no gate in the current model. opportunity_v2 is a
            weighted blend of four sub-scores times a supply brake (etl/marts/mart_niche.sql,
            `scored_v2`). decline_gate still exists as a column, but it stopped multiplying the
            score and is now a falsification tell only, so describing the ranking as gated
            promised a safety net the score does not apply. */}
        <span className="text-[13px] text-ink-secondary">
          {total > 0
            ? `${total.toLocaleString()} niches · ranked by opportunity — momentum, market pull, revenue spread and quality gap, braked by supply`
            : "ranked by opportunity — momentum, market pull, revenue spread and quality gap, braked by supply"}
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
        {isError && (
          <div className="p-8 text-center text-sm text-status-serious">
            Failed to load niches{error instanceof Error ? `: ${error.message}` : "."}
          </div>
        )}
        {data && data.items.length === 0 && (
          <EmptyState
            title="No niches match these filters"
            description="Try a broader tier selection, a lower review floor, or clear the search."
          />
        )}
        {data && data.items.length > 0 && (
          <div className="overflow-x-auto">
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
          </div>
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
              onClick={() => setOffset((o) => Math.max(0, o - LIMIT))}
              className={clsx("px-3 py-1 text-ink-primary transition-colors", offset === 0 ? "pointer-events-none" : "hover:bg-surface2")}
              style={{ border: `1px solid ${PAPER_35}`, color: offset === 0 ? PAPER_45 : undefined }}
            >
              Prev
            </button>
            <button
              type="button"
              disabled={offset + LIMIT >= total}
              onClick={() => setOffset((o) => o + LIMIT)}
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
          metrics than that (longevity, total owners, hit rate, saturation, raw live-player
          count) — kept, not deleted, but pushed below the mockup-faithful table and behind
          an explicit toggle rather than crammed into its grid. Shares the same sort/order
          state, so its row order always matches the table above it. */}
      {data && data.items.length > 0 && (
        <div className="flex flex-col" style={{ gap: 10 }}>
          <button
            type="button"
            onClick={() => setShowMoreMetrics((v) => !v)}
            aria-expanded={showMoreMetrics}
            className="kicker inline-flex w-fit items-center gap-2 text-ink-muted transition-colors hover:text-ink-secondary"
            style={{ fontSize: 11, border: `1px solid ${PAPER_30}`, padding: "6px 12px" }}
          >
            <span aria-hidden>{showMoreMetrics ? "−" : "+"}</span>
            More metrics — longevity, owners, hit rate, saturation, live players
          </button>
          {showMoreMetrics && (
            <div className="blueprint">
              <i className="bp-corner" />
              <div className="overflow-x-auto">
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
              </div>
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

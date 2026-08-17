import { useCallback, useEffect, useMemo, useState } from "react";
import { createColumnHelper, flexRender, getCoreRowModel, useReactTable } from "@tanstack/react-table";
import clsx from "clsx";

import { OpportunityBars, OPPORTUNITY_LEGEND } from "../components/charts/OpportunityBars";
import { NicheDetailDrawer } from "../components/NicheDetailDrawer";
import { Card } from "../components/ui/Card";
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
import { sequentialColorAt } from "../lib/palette";
import { useDebounced } from "../lib/useDebounced";
import { useTheme } from "../lib/theme";

const LIMIT = 50;

const INPUT_CLS =
  "rounded-lg border border-chartborder bg-surface text-xs text-ink-primary outline-none transition-colors placeholder:text-ink-muted focus:border-brand focus:shadow-[0_0_0_3px_var(--brand-tint)]";

const legColor = (needle: string) =>
  OPPORTUNITY_LEGEND.find((l) => l.label.toLowerCase().includes(needle))?.color;

// Umbrella/meta tags are containers/reception labels, not buildable niches — excluded by
// default, same reasoning (and default) as the MCP find_niches tool.
const DEFAULT_TIERS: NicheTier[] = ["micro", "theme"];

const TIER_TITLE: Record<NicheTier, string> = {
  micro: "Buildable game concepts (Colony Sim, Souls-like…)",
  theme: "Settings/aesthetics you attach to a game (Vikings, Pixel Graphics…)",
  umbrella: "Genre/mechanic containers (Open World, Sandbox…) — not buildable on their own",
  meta: "Reception tags (Great Soundtrack…) — never buildable",
};

/** A clickable column header that drives the server-side sort, with a direction arrow.
 * `help` is the column's plain-language "how to read this" — it becomes the hover tooltip
 * (with the sort hint appended) so every metric column explains itself in place. */
function SortLabel({
  label,
  col,
  active,
  order,
  onSort,
  color,
  help,
}: {
  label: string;
  col: SortKey;
  active: boolean;
  order: "asc" | "desc";
  onSort: (col: SortKey) => void;
  color?: string;
  help?: string;
}) {
  return (
    <button
      type="button"
      onClick={() => onSort(col)}
      title={help ? `${help}\n\nClick to sort by ${label}.` : `Sort by ${label}`}
      className={clsx(
        "group inline-flex items-center gap-1 font-semibold uppercase tracking-wide transition-colors",
        active ? "text-ink-primary" : "text-ink-muted hover:text-ink-secondary",
      )}
    >
      {color && <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: color }} />}
      {label}
      {help && (
        <span aria-hidden className="cursor-help text-[10px] normal-case text-ink-muted/70">
          ⓘ
        </span>
      )}
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
  title,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  title?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
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
  // 24m is the market a new entrant actually faces — the all-time cut is context, not an
  // entry decision, so it is NOT the default (same default as the MCP tool).
  const [windowParam, setWindowParam] = useState<Window>("24m");
  const [minReviews, setMinReviews] = useState(50); // mart materializes exactly 0 (no floor), 50 & 100
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
  const [selected, setSelected] = useState<NicheRow | null>(null);

  // Any filter change re-pages to the top so offset never points past the new result set.
  useEffect(() => {
    setOffset(0);
  }, [dimension, windowParam, minReviews, tiers, debouncedQ, sort, order]);

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
      columnHelper.accessor("key", {
        header: () => (
          <SortLabel label="Niche" help="A Steam community tag or Steam genre. The small badge marks non-buildable tiers (theme = a setting you attach to a game; umbrella = a genre container; meta = a reception tag)." col="key" active={sort === "key"} order={order} onSort={toggleSort} />
        ),
        cell: (info) => {
          const tier = info.row.original.tier;
          return (
            <button
              type="button"
              onClick={() => setSelected(info.row.original)}
              className="group/nk flex items-center gap-2 text-left"
            >
              <span className="font-medium text-ink-primary transition-colors group-hover/nk:text-brand">
                {info.getValue()}
              </span>
              {tier && tier !== "micro" && tier !== "genre" && (
                <span
                  className="rounded-full border border-chartborder px-1.5 py-px text-[10px] text-ink-muted"
                  title={TIER_TITLE[tier as NicheTier] ?? tier}
                >
                  {tier}
                </span>
              )}
            </button>
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
          <SortLabel label="P90 rev" help="What the niche's successful titles earn: the 90th percentile of estimated lifetime revenue across its scored games (1 in 10 does better). Each game's estimate = review count × an owners-per-review ratio (~20–55, genre-fitted) × launch price — gross, lifetime, not reported sales. Median (the typical outcome) is in the deep dive." col="p90_rev" active={sort === "p90_rev"} order={order} onSort={toggleSort} />
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
      columnHelper.display({
        id: "opportunity_bars",
        header: () => (
          <span className="flex items-center gap-1.5 whitespace-nowrap">
            <SortLabel label="Demand" help="How hot the market is, 0–100 percentile vs other niches in this cut. Calculated: 0.4×pctile(median revenue) + 0.3×pctile(median owners) + 0.3×pctile(recent 24m review velocity)." col="demand" color={legColor("demand")} active={sort === "demand"} order={order} onSort={toggleSort} />
            <span className="text-ink-muted/40">/</span>
            <SortLabel label="Comp." help="How crowded it is, 0–100 percentile. Calculated: 0.6×pctile(recently released games) + 0.4×pctile(winner concentration — the top 5% of titles' revenue share). HIGHER IS WORSE for a new entrant." col="competition" color={legColor("competition")} active={sort === "competition"} order={order} onSort={toggleSort} />
            <span className="text-ink-muted/40">/</span>
            <SortLabel label="Quality gap" help="How beatable the field is, 0–100 percentile. Calculated: pctile(share of incumbents that are weak — rating under 80% positive OR fewer than 50 reviews). Higher = easier to out-execute." col="quality_gap" color={legColor("quality")} active={sort === "quality_gap"} order={order} onSort={toggleSort} />
          </span>
        ),
        cell: (info) => {
          const r = info.row.original;
          return (
            <div
              title={`Demand ${r.demand?.toFixed(1) ?? "—"} · Competition ${r.competition?.toFixed(1) ?? "—"} · Quality gap ${r.quality_gap?.toFixed(1) ?? "—"} (each a 0–100 percentile vs other niches in this cut)`}
            >
              <OpportunityBars demand={r.demand} competition={r.competition} quality_gap={r.quality_gap} />
            </div>
          );
        },
      }),
      columnHelper.accessor("opportunity_v2", {
        header: () => (
          <SortLabel
            label="Opportunity v2" help="The headline score. Calculated: 0.5×demand − 0.35×competition + 0.3×quality gap, floored at 0, then × the decline gate (0.5–1.0; shrinks when the release pipeline contracts or newcomers earn under the back catalog). '0.0 floored' = the formula went negative: crowding outweighed demand + quality — a real verdict, not missing data."
            col="opportunity_v2"
            active={sort === "opportunity_v2"}
            order={order}
            onSort={toggleSort}
          />
        ),
        cell: (info) => {
          const v = info.getValue();
          const row = info.row.original;
          const gate = row.decline_gate;
          const dotColor = v == null ? "var(--gridline)" : sequentialColorAt(v / 100, theme);
          // A hard 0 means the formula went NEGATIVE and was floored — competition's
          // penalty outweighed demand + quality gap. Without the note it reads as
          // missing data instead of the real verdict it is.
          const floored = v === 0;
          // The row's REAL numbers substituted into the formula, so the hover answers
          // "why is it this value" without leaving the table.
          const d = row.demand, c = row.competition, q = row.quality_gap;
          const raw = d != null && c != null && q != null ? 0.5 * d - 0.35 * c + 0.3 * q : null;
          const calc =
            raw != null
              ? `0.5×${d!.toFixed(1)} − 0.35×${c!.toFixed(1)} + 0.3×${q!.toFixed(1)} = ${raw >= 0 ? "+" : ""}${raw.toFixed(1)}` +
                (raw < 0 ? " → floored to 0" : "") +
                (gate != null ? ` → × gate ${gate.toFixed(2)} = ${v != null ? v.toFixed(1) : "—"}` : "")
              : null;
          const title = floored
            ? `${calc}\n\nThe competition penalty (C ${c?.toFixed(0)}) outweighs demand (D ${d?.toFixed(0)}) + quality gap (Q ${q?.toFixed(0)}): a crowded niche whose typical game earns little. Big audience ≠ good entry.`
            : calc ?? "0.5×demand − 0.35×competition + 0.3×quality gap, × the decline gate";
          return (
            <div className="flex items-center gap-2" title={title}>
              <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: dotColor }} />
              <span className="tabular font-semibold text-ink-primary">{v != null ? v.toFixed(1) : "—"}</span>
              {floored && <span className="text-[10px] text-ink-muted">floored</span>}
              {gate != null && gate < 0.995 && (
                <span
                  className="tabular text-[10px] text-verdict-serious"
                  title={(() => {
                    const satSev = Math.min(1, Math.max(0, -(row.saturation_yoy ?? 0) / 0.3));
                    const entSev = Math.min(1, Math.max(0, (1 - (row.entrant_ratio ?? 1)) / 0.5));
                    const driver =
                      satSev >= entSev
                        ? `releases ${((row.saturation_yoy ?? 0) * 100).toFixed(1)}%/yr (severity ${satSev.toFixed(2)})`
                        : `newcomers earn ${(row.entrant_ratio ?? 1).toFixed(2)}× the back catalog (severity ${entSev.toFixed(2)})`;
                    return `Decline gate ×${gate.toFixed(2)} = 1 − 0.5×max(pipeline, entrants severity) — driven by ${driver}`;
                  })()}
                >
                  ×{gate.toFixed(2)}
                </span>
              )}
            </div>
          );
        },
      }),
      columnHelper.accessor("total_players_now", {
        header: () => (
          <SortLabel
            label="Playing now" help="Who's playing right now. Calculated: SUM of each scored game's latest nightly player capture (kept up to 7 days). Captures are ~21–22:00 UTC point samples, not daily peaks. Dominated by the niche's hits."
            col="total_players_now"
            active={sort === "total_players_now"}
            order={order}
            onSort={toggleSort}
          />
        ),
        cell: (info) => {
          const v = info.getValue();
          return (
            <span className="tabular text-ink-secondary" title="Summed current players (nightly point samples, ≤7d carry) — dominated by the niche's hits">
              {v != null ? fmtCompact(v) : "—"}
            </span>
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
          if (v == null) return <span className="text-ink-muted">—</span>;
          return (
            <span
              className={clsx("tabular font-medium", v >= 0 ? "text-verdict-good" : "text-verdict-serious")}
              title="Last 7d vs prior 7d, same-panel (only games measured in both windows count)"
            >
              {v >= 0 ? "+" : ""}
              {v.toFixed(1)}%
            </span>
          );
        },
      }),
      columnHelper.accessor((row) => row.lifetime_survival_12m ?? null, {
        id: "lifetime_survival_12m",
        header: () => (
          <SortLabel
            label="Longevity" help="Of this niche's games that ever reached 100+ concurrent players, the share still holding 10+ a year later. Calculated: fixed-horizon survival — games whose 100+ month is at least 12 months old only; steamcharts top-8k coverage."
            col="lifetime_survival_12m"
            active={sort === "lifetime_survival_12m"}
            order={order}
            onSort={toggleSort}
          />
        ),
        cell: (info) => {
          const v = info.getValue();
          if (v == null) return <span className="text-ink-muted">—</span>;
          const m = info.row.original.lifetime_median_dead_months;
          const title =
            `${fmtPct(v)} of its 100+ games still alive after a year` +
            (m != null ? ` · dead ones lasted ~${fmtMonths(m)}` : "");
          return (
            <span className="tabular text-ink-secondary" title={title}>
              {fmtPct(v)}
            </span>
          );
        },
      }),
      columnHelper.accessor("total_owners", {
        header: () => (
          <SortLabel
            label="Total owners" help="The size of the pie. Calculated: SUM of each scored game's estimated owners (SteamSpy range midpoint; review-modeled where SteamSpy is coarse). A big pie with a low score means people play the HITS — it doesn't hand a new entrant a slice."
            col="total_owners"
            active={sort === "total_owners"}
            order={order}
            onSort={toggleSort}
          />
        ),
        cell: (info) => <span className="tabular text-ink-secondary">{fmtCompact(info.getValue())}</span>,
      }),
      columnHelper.accessor("hit_rate_200k", {
        header: () => (
          <SortLabel label="Hit ≥$200K" help="The odds a serious title 'works' here. Calculated: share of the niche's scored games whose estimated lifetime revenue clears $200K." col="hit_rate_200k" active={sort === "hit_rate_200k"} order={order} onSort={toggleSort} />
        ),
        cell: (info) => {
          const v = info.getValue();
          const n = info.row.original.n_games;
          const title =
            v != null && n ? `${Math.round(v * n)} of ${fmtInt(n)} scored games clear $200K est. lifetime revenue` : undefined;
          return (
            <span className="tabular text-ink-secondary" title={title}>
              {fmtPct(v)}
            </span>
          );
        },
      }),
      columnHelper.accessor("saturation_yoy", {
        header: () => (
          <SortLabel label="Saturation YoY" help="Is the pipeline growing? Calculated: (releases last calendar year − releases the year before) ÷ the year before. Negative = SHRINKING — 'low competition' in a shrinking niche is decline, not opportunity." col="saturation_yoy" active={sort === "saturation_yoy"} order={order} onSort={toggleSort} />
        ),
        cell: (info) => {
          const v = info.getValue();
          const r = info.row.original;
          const title =
            r.n_recent_year != null && r.n_prior_year != null && v != null
              ? `(${fmtInt(r.n_recent_year)} releases last year − ${fmtInt(r.n_prior_year)} the year before) ÷ ${fmtInt(r.n_prior_year)} = ${(v * 100).toFixed(1)}%${v < -0.05 ? " — the pipeline is shrinking" : ""}`
              : undefined;
          return (
            <span
              title={title}
              className={clsx("tabular", v != null && v < -0.05 ? "text-verdict-serious" : "text-ink-secondary")}
            >
              {fmtSigned(v)}
            </span>
          );
        },
      }),
    ],
    [columnHelper, theme, sort, order, toggleSort],
  );

  const table = useReactTable({
    data: data?.items ?? [],
    columns,
    getCoreRowModel: getCoreRowModel(),
  });

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
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-ink-primary">Niche Finder</h1>
          <p className="mt-1 max-w-2xl text-sm text-ink-secondary">
            Rank tags and genres by growth-gated opportunity — demand vs. competition vs. quality gap, absolute market
            size, and who's actually playing right now.
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
            <SegButton
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
              ≥100 reviews
            </SegButton>
          </Segmented>
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search niches…"
            className={clsx(INPUT_CLS, "w-44 px-3 py-1.5")}
          />
          <div className="ml-auto flex items-center gap-2">
            <a
              href={csvUrl}
              onClick={() => trackEvent("niche_export_csv")}
              className="rounded-lg border border-chartborder bg-surface px-3 py-1.5 text-xs font-medium text-ink-secondary shadow-xs transition-colors hover:bg-surface2 hover:text-ink-primary"
            >
              Export CSV
            </a>
          </div>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1.5 border-t border-chartborder pt-2.5 text-[11px] text-ink-muted">
          {dimension === "tag" && (
            <span className="flex items-center gap-1.5">
              <span className="font-medium">Tiers</span>
              {NICHE_TIERS.map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => toggleTier(t)}
                  title={TIER_TITLE[t]}
                  className={clsx(
                    "rounded-full border px-2 py-0.5 font-medium transition-colors",
                    tiers.includes(t)
                      ? "border-brand bg-brand-tint text-brand"
                      : "border-chartborder text-ink-muted hover:text-ink-secondary",
                  )}
                >
                  {t}
                </button>
              ))}
            </span>
          )}
          <span className="hidden items-center gap-3 sm:flex">
            <span className="font-medium">Color key</span>
            {OPPORTUNITY_LEGEND.map((l) => (
              <span key={l.label} className="flex items-center gap-1.5">
                <span className="h-2 w-2 rounded-full" style={{ backgroundColor: l.color }} />
                {l.label}
              </span>
            ))}
          </span>
          <span className="ml-auto hidden sm:inline">Click a column header to sort · click a niche for the deep dive</span>
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
            <table className="w-full min-w-[1160px] border-collapse text-sm">
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

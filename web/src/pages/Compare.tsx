import { useEffect, useMemo, type CSSProperties, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useQueries } from "@tanstack/react-query";
import clsx from "clsx";

import {
  CompareTrendsChart,
  SeriesKey,
  compareSeriesColor,
  seriesShapePath,
} from "../components/charts/CompareTrendsChart";
import { EmptyState } from "../components/ui/EmptyState";
import { Loading } from "../components/ui/Loading";
import { TableScroll } from "../components/ui/TableScroll";
import { gameProfileQueryOptions, type GameProfile } from "../lib/api";
import { COMPARE_CAP, removeFromCompare, useCompareList } from "../lib/compareList";
import { estimatedUnits } from "../lib/estimates";
import { fmtCompact, fmtInt, fmtMinutes, fmtPct, fmtPrice, fmtRevenue } from "../lib/format";
import { genreTintStyles } from "../lib/heat";
import { compareSeries } from "../lib/palette";
import { usePageTitle } from "../lib/usePageTitle";

/**
 * Side-by-side comparison for 2-6 games (mockup 4d). The ids ride the URL (?ids=1,2,3) so a
 * comparison is shareable/bookmarkable; with no ids param the page falls back to the
 * stored compare list and immediately normalizes the URL (replace) to match. Column
 * order = id order; the trends overlay uses game 1 as the primary with the rest as
 * ?comps= (one request).
 *
 * Blueprint grammar: hairline frames with "+" corner marks, square corners, condensed
 * headings, mono-steel verdict language (accent-300 up / paper-muted down, never red-
 * green). The overlay chart is CompareTrendsChart, already on the house chart tokens;
 * this page renders the one legend inline with the panel title (mockup 4d) and passes
 * hideLegend so the chart doesn't repeat it.
 */

// Hairline alphas the mockup calls that don't already have a named Tailwind token
// (--border is 22%, --border-strong is 35%) — built the same way index.css builds every
// other hairline: color-mix against the theme's own foreground, so it tracks light/dark
// and any accent swap instead of a hardcoded paper rgba.
const PANEL_BORDER = "color-mix(in srgb, var(--text-primary) 25%, transparent)";
const ROW_RULE = "color-mix(in srgb, var(--text-primary) 12%, transparent)";
const STRIPE_THUMB =
  "repeating-linear-gradient(45deg, color-mix(in srgb, var(--text-primary) 12%, transparent), " +
  "color-mix(in srgb, var(--text-primary) 12%, transparent) 4px, transparent 4px, transparent 8px)";
// Condensed 600 is automatic on <h1>-<h6> (index.css applies it by element); anything else
// that reads condensed in the mockup (buttons, column names, big values) needs it inline.
const CONDENSED: CSSProperties = { fontFamily: '"Barlow Condensed", "Barlow", system-ui, sans-serif' };

function parseIds(raw: string | null): number[] {
  if (!raw) return [];
  const out: number[] = [];
  const seen = new Set<number>();
  for (const tok of raw.split(",")) {
    const v = Number(tok.trim());
    if (!Number.isInteger(v) || v <= 0 || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
    if (out.length >= COMPARE_CAP) break;
  }
  return out;
}

interface StatRowDef {
  key: string;
  label: string;
  fmt: (p: GameProfile) => string;
  /** Numeric accessor for best-in-row highlighting (max wins, bold accent-300); omit = no highlight. */
  best?: (p: GameProfile) => number | null;
  /** Trend-verdict rows (▲/▼ + signed %, accent-300 up / paper-muted down) instead of a
   * best-in-row bold — matches the "Players 7d" row in mockup 4d. */
  verdict?: (p: GameProfile) => number | null;
}

// Order matches README §4d's metric grid exactly for the first five rows (revenue, units,
// rating, "Peak CCU", players 7d). The mart has no tracked PEAK CCU — live_players is an
// explicit point sample at the nightly capture, NOT a daily peak (see GameProfile's own
// help text) — so that row is honestly relabeled "Live players (now)" rather than wearing
// a name the data can't back up. The remaining rows are the page's pre-existing real
// metrics (percentile, velocity, playtime, genre), kept below in the same grammar rather
// than dropped — restyle, not rewrite.
const STAT_ROWS: StatRowDef[] = [
  {
    key: "revenue",
    label: "Est. gross revenue",
    fmt: (p) => fmtRevenue(p.est_rev_reviews, p.price_initial === 0),
    best: (p) => (p.price_initial === 0 ? null : p.est_rev_reviews),
  },
  // Units come from the SAME reviews-based estimator as the revenue row above (lib/estimates.ts),
  // never from the owners-based owners_mid. Pairing the two estimators in one column pair is what
  // let this grid show a game with MORE units AND LESS revenue at a HIGHER price — Silksong vs
  // Hollow Knight — a comparison no reader can act on. Now units × price === the revenue printed
  // one row up, for every paid title in the grid.
  {
    key: "units",
    label: "Est. units",
    fmt: (p) => fmtCompact(estimatedUnits(p.est_rev_reviews, p.price_initial, p.total_reviews)),
    best: (p) => estimatedUnits(p.est_rev_reviews, p.price_initial, p.total_reviews),
  },
  { key: "rating", label: "Rating", fmt: (p) => fmtPct(p.positive_ratio), best: (p) => p.positive_ratio },
  {
    key: "live_players",
    label: "Live players (now)",
    fmt: (p) => (p.live_players != null ? fmtCompact(p.live_players) : "—"),
    best: (p) => p.live_players,
  },
  {
    key: "players_7d",
    label: "Players 7d",
    fmt: (p) =>
      p.players_trend_7d_pct != null
        ? `${p.players_trend_7d_pct >= 0 ? "+" : ""}${p.players_trend_7d_pct.toFixed(1)}%`
        : "—",
    verdict: (p) => p.players_trend_7d_pct ?? null,
  },
  { key: "reviews", label: "Total reviews", fmt: (p) => fmtInt(p.total_reviews), best: (p) => p.total_reviews },
  {
    key: "rev_pct",
    label: "Revenue percentile in genre",
    fmt: (p) => (p.rev_pct_in_genre != null ? `P${Math.round(p.rev_pct_in_genre)}` : "—"),
    best: (p) => p.rev_pct_in_genre,
  },
  {
    key: "velocity",
    label: "Reviews · trailing 30d (sampled)",
    fmt: (p) => fmtInt(p.n_reviews_trailing_30d),
    best: (p) => p.n_reviews_trailing_30d,
  },
  { key: "playtime", label: "Median playtime", fmt: (p) => fmtMinutes(p.playtime_p50) },
  { key: "genre", label: "Genre", fmt: (p) => p.primary_genre ?? "—" },
];

/** The blueprint frame: hairline + "+" corner marks. The class draws two marks itself; the
 * other two come from the one .bp-corner child (see index.css). */
function Panel({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={clsx("blueprint", className)} style={{ borderColor: PANEL_BORDER }}>
      <i className="bp-corner" />
      {children}
    </div>
  );
}

export default function Compare() {
  usePageTitle("Compare");
  const [searchParams, setSearchParams] = useSearchParams();
  const stored = useCompareList();

  const idsParam = searchParams.get("ids");
  const ids = useMemo(() => parseIds(idsParam), [idsParam]);

  // No ids in the URL but a stored list exists → normalize the URL so it's shareable.
  useEffect(() => {
    if (!idsParam && stored.length > 0) {
      setSearchParams({ ids: stored.map((e) => e.appid).join(",") }, { replace: true });
    }
  }, [idsParam, stored, setSearchParams]);

  const results = useQueries({ queries: ids.map((id) => gameProfileQueryOptions(id)) });
  const anyLoading = results.some((r) => r.isLoading);
  const profiles = new Map<number, GameProfile>();
  results.forEach((r, i) => {
    if (r.data) profiles.set(ids[i], r.data);
  });

  // Remove from BOTH the URL ids and the stored tray list, so the two stay in step.
  function remove(appid: number) {
    removeFromCompare(appid);
    const next = ids.filter((id) => id !== appid);
    setSearchParams(next.length > 0 ? { ids: next.join(",") } : {});
  }

  const names = new Map<number, string>();
  for (const id of ids) {
    const p = profiles.get(id);
    const fallback = stored.find((e) => e.appid === id)?.name;
    names.set(id, p?.name ?? fallback ?? `App ${id}`);
  }

  // Tags appearing on 2+ of the compared games — the overlap that makes them competitors.
  const sharedTags = useMemo(() => {
    const counts = new Map<string, number>();
    for (const p of profiles.values()) {
      for (const t of new Set(p.top_tags)) counts.set(t, (counts.get(t) ?? 0) + 1);
    }
    return new Set([...counts.entries()].filter(([, n]) => n >= 2).map(([t]) => t));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [results.map((r) => r.dataUpdatedAt).join(",")]);

  if (ids.length === 0) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeading ids={ids} />
        <Panel className="p-8">
          <EmptyState
            title="Nothing to compare yet"
            description={
              <>
                Add games with the <span className="font-semibold">+</span> button on any search result row or the
                “+ Compare” button on a game profile — up to {COMPARE_CAP} at once. The tray at the bottom of the
                screen collects them; hit “Compare” there to land here.
              </>
            }
            action={
              <Link
                to="/games"
                style={CONDENSED}
                className="bg-brand px-3 py-1.5 text-xs font-semibold text-brand-fg transition-colors hover:bg-brand-hover"
              >
                Browse games
              </Link>
            }
          />
        </Panel>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeading ids={ids} />

      {ids.length === 1 && (
        <Panel className="p-8">
          <EmptyState
            title={`Only one game selected — ${names.get(ids[0])}`}
            description="A comparison needs at least two games. Add a competitor from search (the + button on any row) or from its profile page; its comparables table is a good place to find candidates."
            action={
              <div className="flex items-center gap-2">
                <Link
                  to="/games"
                  style={CONDENSED}
                  className="bg-brand px-3 py-1.5 text-xs font-semibold text-brand-fg transition-colors hover:bg-brand-hover"
                >
                  Find a competitor
                </Link>
                <Link
                  to={`/games/${ids[0]}`}
                  style={CONDENSED}
                  className="border border-borderstrong px-3 py-1.5 text-xs text-ink-primary transition-colors hover:bg-ink-primary/[0.08]"
                >
                  Open its profile
                </Link>
              </div>
            }
          />
        </Panel>
      )}

      {ids.length >= 2 && (
        <>
          {/* Mockup 4d titles this panel "Review velocity, first 12 weeks" — deliberately NOT
              copied verbatim. CompareTrendsChart (components/charts/*, not editable here)
              plots monthly-sampled review velocity over each game's FULL history, not a
              12-week-since-launch window (see its own module doc); its x-axis literally
              shows a decade of calendar months. Printing "first 12 weeks" directly above
              that axis would be a checkable, immediately-falsified claim — the same honesty
              call as relabeling "Peak CCU" to "Live players (now)" below. What the mockup
              actually wants: a per-game launch-relative x-axis (week 0-12 since release) in
              exactly three fixed mono-steel tones (accent-300 / paper 75% / paper 35%,
              solid strokes) with no axis labels, just 3 gridlines. Reaching that needs (a) a
              trends response keyed by weeks-since-launch instead of calendar period, and (b)
              CompareTrendsChart switching its x-axis domain accordingly — both out of scope
              for this page. */}
          <Panel className="px-6 py-5">
            <div className="mb-3.5 flex flex-wrap items-baseline gap-4">
              <h2 className="text-[16px] text-ink-primary">Review velocity</h2>
              <div className="flex flex-wrap items-center gap-4 sm:ml-auto">
                {ids.map((id, i) => (
                  <span key={id} className="inline-flex items-center gap-1.5 text-[11px] text-ink-muted">
                    {/* Was a flat 14x2 colour bar. Two of the three games rendered it in
                        greys 1.25:1 apart, so the legend was as unreadable as the chart —
                        it now repeats the line's dash and marker too (SeriesKey). */}
                    <SeriesKey style={compareSeries(i)} />
                    {names.get(id)}
                  </span>
                ))}
              </div>
            </div>
            {/* hideLegend: the ONE legend lives inline with the title above (mockup 4d);
                without it CompareTrendsChart repeats the same legend under the chart. */}
            <CompareTrendsChart ids={ids} names={names} hideLegend />
          </Panel>

          <Panel>
            {anyLoading && <Loading label="Loading games…" className="p-6 text-sm" />}
            {!anyLoading && (
              <TableScroll>
                {/* `relative` matters: the sr-only "(best in this row)" spans are absolutely
                    positioned, and without a positioned ancestor INSIDE this scroll container
                    they resolve against the .blueprint panel — landing past the page edge and
                    giving the whole page a horizontal scrollbar at 390px. */}
                <div className="relative" style={{ minWidth: `${220 + ids.length * 150}px` }}>
                  <div
                    className="grid items-end gap-3.5 border-b px-5 py-3.5"
                    style={{ gridTemplateColumns: `1.2fr repeat(${ids.length}, 1fr)`, borderColor: PANEL_BORDER }}
                  >
                    <span />
                    {ids.map((id, i) => {
                      const p = profiles.get(id);
                      return (
                        <div key={id} className="flex flex-col gap-1.5">
                          <div className="flex items-start justify-between gap-1">
                            {/* Series mark ties the column to its line in the trends chart.
                                It carries the line's SHAPE as well as its colour, because
                                two columns can otherwise wear near-identical tones. */}
                            <svg
                              aria-hidden
                              width={10}
                              height={10}
                              viewBox="0 0 10 10"
                              className="mt-1 shrink-0 overflow-visible"
                            >
                              <path
                                d={seriesShapePath(compareSeries(i).shape, 5, 5, 3.6)}
                                fill={compareSeriesColor(i)}
                              />
                            </svg>
                            <button
                              type="button"
                              onClick={() => remove(id)}
                              aria-label={`Remove ${names.get(id)} from comparison`}
                              title="Remove from comparison"
                              className="-m-1 flex h-6 w-6 items-center justify-center text-xs text-ink-muted transition-colors hover:bg-ink-primary/[0.08] hover:text-ink-primary"
                            >
                              ✕
                            </button>
                          </div>
                          {p?.header_image ? (
                            <img src={p.header_image} alt="" className="h-10 w-full object-cover" />
                          ) : (
                            <div aria-hidden className="h-10 w-full" style={{ background: STRIPE_THUMB }} />
                          )}
                          <Link
                            to={`/games/${id}`}
                            style={{ ...CONDENSED, fontWeight: 600 }}
                            className="text-[17px] leading-tight text-ink-primary hover:text-brand hover:underline"
                          >
                            {names.get(id)}
                          </Link>
                          {p ? (
                            <span className="text-[11px] text-ink-muted">
                              {p.release_year ?? "—"} · {fmtPrice(p.price_initial)}
                            </span>
                          ) : (
                            <span className="text-[11px] text-verdict-serious">
                              {anyLoading ? "Loading…" : "Not in catalog"}
                            </span>
                          )}
                        </div>
                      );
                    })}
                  </div>

                  {STAT_ROWS.map((row) => {
                    if (row.verdict) {
                      const verdictFn = row.verdict;
                      return (
                        <div
                          key={row.key}
                          className="grid gap-3.5 border-b px-5 py-[11px] text-sm"
                          style={{ gridTemplateColumns: `1.2fr repeat(${ids.length}, 1fr)`, borderColor: ROW_RULE }}
                        >
                          <span className="text-ink-muted">{row.label}</span>
                          {ids.map((id) => {
                            const p = profiles.get(id);
                            const v = p ? verdictFn(p) : null;
                            if (v == null) {
                              return (
                                <span key={id} className="tabular text-ink-muted">
                                  —
                                </span>
                              );
                            }
                            const up = v > 0;
                            return (
                              <span key={id} className={clsx("tabular", up ? "text-brand" : "text-ink-muted")}>
                                {up ? "▲" : "▼"} {v >= 0 ? "+" : ""}
                                {v.toFixed(1)}%
                              </span>
                            );
                          })}
                        </div>
                      );
                    }

                    // Best-in-row (max) among the loaded, non-null values — only marked
                    // when at least two games actually have the metric.
                    let bestIds: Set<number> = new Set();
                    if (row.best) {
                      const bestFn = row.best;
                      const vals = ids
                        .map((id) => ({ id, v: profiles.has(id) ? bestFn(profiles.get(id)!) : null }))
                        .filter((x): x is { id: number; v: number } => x.v != null);
                      if (vals.length >= 2) {
                        const max = Math.max(...vals.map((x) => x.v));
                        bestIds = new Set(vals.filter((x) => x.v === max).map((x) => x.id));
                      }
                    }
                    return (
                      <div
                        key={row.key}
                        className="grid gap-3.5 border-b px-5 py-[11px] text-sm"
                        style={{ gridTemplateColumns: `1.2fr repeat(${ids.length}, 1fr)`, borderColor: ROW_RULE }}
                      >
                        <span className="text-ink-muted">{row.label}</span>
                        {ids.map((id) => {
                          const p = profiles.get(id);
                          return (
                            <span
                              key={id}
                              className={clsx(
                                "tabular",
                                bestIds.has(id) ? "font-semibold text-brand" : "text-ink-primary",
                              )}
                            >
                              {p ? row.fmt(p) : "—"}
                              {bestIds.has(id) && <span className="sr-only"> (best in this row)</span>}
                            </span>
                          );
                        })}
                      </div>
                    );
                  })}

                  <div
                    className="grid gap-3.5 px-5 py-[11px]"
                    style={{ gridTemplateColumns: `1.2fr repeat(${ids.length}, 1fr)` }}
                  >
                    <span className="text-sm text-ink-muted">
                      Top tags
                      <span className="mt-0.5 block text-[11px] font-normal">(shared highlighted)</span>
                    </span>
                    {ids.map((id) => {
                      const p = profiles.get(id);
                      const tags = (p?.top_tags ?? []).slice(0, 8);
                      // Tinted as a GROUP so no two chips in one cell land on the same
                      // slot; the shared ones are excluded because they take the brand
                      // highlight instead and never spend a slot. See lib/heat.ts.
                      const tinted = tags.filter((t) => !sharedTags.has(t));
                      const tints = new Map(genreTintStyles(tinted).map((s, i) => [tinted[i], s]));
                      return (
                        <div key={id} className="flex flex-wrap gap-1">
                          {tags.map((t) => (
                            <span
                              key={t}
                              className={clsx(
                                "border px-1.5 py-0.5 text-[10px]",
                                sharedTags.has(t)
                                  ? "border-brand bg-brand-tint font-medium text-brand"
                                  : "border-ink-primary/[0.18] text-ink-secondary",
                              )}
                              // Shared tags keep the brand highlight (that's the signal on this
                              // page); only the rest wear their categorical genre tint.
                              style={sharedTags.has(t) ? undefined : tints.get(t)}
                            >
                              {t}
                            </span>
                          ))}
                        </div>
                      );
                    })}
                  </div>
                </div>
              </TableScroll>
            )}
          </Panel>
        </>
      )}
    </div>
  );
}

function PageHeading({ ids }: { ids: number[] }) {
  const n = ids.length;
  const capReached = n >= COMPARE_CAP;
  return (
    <div className="flex flex-wrap items-baseline gap-3.5">
      <h1 className="text-[25px] leading-none text-ink-primary">Compare</h1>
      {n > 0 && (
        <span className="text-[13px] text-ink-muted">
          {n} of {COMPARE_CAP} slots · share this view by URL
        </span>
      )}
      {n > 0 && !capReached && (
        <Link
          to="/games"
          style={CONDENSED}
          className="ml-auto border border-borderstrong px-3 py-1 text-xs text-ink-primary transition-colors hover:bg-ink-primary/[0.08]"
        >
          + Add game
        </Link>
      )}
    </div>
  );
}

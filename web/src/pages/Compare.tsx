import { useEffect, useMemo } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useQueries } from "@tanstack/react-query";
import clsx from "clsx";

import { CompareTrendsChart, compareSeriesColor } from "../components/charts/CompareTrendsChart";
import { Card } from "../components/ui/Card";
import { EmptyState } from "../components/ui/EmptyState";
import { gameProfileQueryOptions, type GameProfile } from "../lib/api";
import { COMPARE_CAP, removeFromCompare, useCompareList } from "../lib/compareList";
import { fmtCompact, fmtInt, fmtMinutes, fmtPct, fmtPrice, fmtRevenue } from "../lib/format";
import { genreTintStyle } from "../lib/heat";

/**
 * Side-by-side comparison for 2-6 games. The ids ride the URL (?ids=1,2,3) so a
 * comparison is shareable/bookmarkable; with no ids param the page falls back to the
 * stored compare list and immediately normalizes the URL (replace) to match. Column
 * order = id order; the trends overlay uses game 1 as the primary with the rest as
 * ?comps= (one request).
 */

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
  /** Numeric accessor for best-in-row highlighting (max wins); omit = no highlight. */
  best?: (p: GameProfile) => number | null;
}

const STAT_ROWS: StatRowDef[] = [
  { key: "owners", label: "Owners (est.)", fmt: (p) => fmtCompact(p.owners_mid), best: (p) => p.owners_mid },
  { key: "reviews", label: "Total reviews", fmt: (p) => fmtInt(p.total_reviews), best: (p) => p.total_reviews },
  { key: "positive", label: "Positive rating", fmt: (p) => fmtPct(p.positive_ratio), best: (p) => p.positive_ratio },
  {
    key: "revenue",
    label: "Est. revenue",
    fmt: (p) => fmtRevenue(p.est_rev_reviews, p.price_initial === 0),
    best: (p) => (p.price_initial === 0 ? null : p.est_rev_reviews),
  },
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

export default function Compare() {
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
      <div className="flex flex-col gap-4">
        <PageHeading n={0} />
        <Card>
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
                className="rounded-lg bg-brand px-3 py-1.5 text-xs font-semibold text-brand-fg shadow-xs hover:bg-brand-hover"
              >
                Browse games
              </Link>
            }
          />
        </Card>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <PageHeading n={ids.length} />

      {ids.length === 1 && (
        <Card>
          <EmptyState
            title={`Only one game selected — ${names.get(ids[0])}`}
            description="A comparison needs at least two games. Add a competitor from search (the + button on any row) or from its profile page; its comparables table is a good place to find candidates."
            action={
              <div className="flex items-center gap-2">
                <Link
                  to="/games"
                  className="rounded-lg bg-brand px-3 py-1.5 text-xs font-semibold text-brand-fg shadow-xs hover:bg-brand-hover"
                >
                  Find a competitor
                </Link>
                <Link
                  to={`/games/${ids[0]}`}
                  className="rounded-lg border border-chartborder px-3 py-1.5 text-xs font-medium text-ink-secondary hover:text-ink-primary"
                >
                  Open its profile
                </Link>
              </div>
            }
          />
        </Card>
      )}

      {ids.length >= 2 && (
        <>
          <Card className="!p-0">
            {anyLoading && <div className="p-6 text-sm text-ink-muted">Loading games…</div>}
            {!anyLoading && (
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-sm" style={{ minWidth: `${180 + ids.length * 170}px` }}>
                  <thead>
                    <tr className="border-b border-chartborder align-top">
                      <th className="w-44 px-3 py-3" />
                      {ids.map((id, i) => {
                        const p = profiles.get(id);
                        return (
                          <th key={id} className="min-w-[160px] px-3 py-3 text-left align-top font-normal">
                            <div className="flex flex-col gap-1.5">
                              <div className="flex items-start justify-between gap-1">
                                {/* series dot ties the column to its line in the trends chart */}
                                <span
                                  aria-hidden
                                  className="mt-1 h-2 w-2 shrink-0 rounded-full"
                                  style={{ backgroundColor: compareSeriesColor(i) }}
                                />
                                <button
                                  type="button"
                                  onClick={() => remove(id)}
                                  aria-label={`Remove ${names.get(id)} from comparison`}
                                  title="Remove from comparison"
                                  className="text-xs text-ink-muted hover:text-ink-primary"
                                >
                                  ✕
                                </button>
                              </div>
                              {p?.header_image && (
                                <img src={p.header_image} alt="" className="h-16 w-full rounded-sm object-cover" />
                              )}
                              <Link
                                to={`/games/${id}`}
                                className="text-[13px] font-semibold leading-tight text-ink-primary hover:text-series-1 hover:underline"
                              >
                                {names.get(id)}
                              </Link>
                              {p ? (
                                <span className="text-[11px] text-ink-muted">
                                  {p.release_year ?? "—"} · {fmtPrice(p.price_initial)}
                                </span>
                              ) : (
                                <span className="text-[11px] text-status-serious">Not in catalog</span>
                              )}
                            </div>
                          </th>
                        );
                      })}
                    </tr>
                  </thead>
                  <tbody>
                    {STAT_ROWS.map((row) => {
                      // Best-in-row (max) among the loaded, non-null values — only marked
                      // when at least two games actually have the metric.
                      let bestIds: Set<number> = new Set();
                      if (row.best) {
                        const vals = ids
                          .map((id) => ({ id, v: profiles.has(id) ? row.best!(profiles.get(id)!) : null }))
                          .filter((x): x is { id: number; v: number } => x.v != null);
                        if (vals.length >= 2) {
                          const max = Math.max(...vals.map((x) => x.v));
                          bestIds = new Set(vals.filter((x) => x.v === max).map((x) => x.id));
                        }
                      }
                      return (
                        <tr key={row.key} className="border-b border-chartborder/60">
                          <td className="whitespace-nowrap px-3 py-2 text-xs font-medium text-ink-muted">{row.label}</td>
                          {ids.map((id) => {
                            const p = profiles.get(id);
                            return (
                              <td
                                key={id}
                                className={clsx(
                                  "tabular px-3 py-2 text-sm",
                                  bestIds.has(id) ? "font-semibold text-status-good" : "text-ink-secondary",
                                )}
                              >
                                {p ? row.fmt(p) : "—"}
                                {bestIds.has(id) && (
                                  <span aria-hidden className="ml-1 text-[10px] text-status-good" title="Best in this row">
                                    ▲
                                  </span>
                                )}
                              </td>
                            );
                          })}
                        </tr>
                      );
                    })}
                    <tr>
                      <td className="whitespace-nowrap px-3 py-2 align-top text-xs font-medium text-ink-muted">
                        Top tags
                        <span className="mt-0.5 block font-normal">(shared highlighted)</span>
                      </td>
                      {ids.map((id) => {
                        const p = profiles.get(id);
                        return (
                          <td key={id} className="px-3 py-2 align-top">
                            <div className="flex flex-wrap gap-1">
                              {(p?.top_tags ?? []).slice(0, 8).map((t) => (
                                <span
                                  key={t}
                                  className={clsx(
                                    "rounded-full border px-1.5 py-0.5 text-[10px]",
                                    sharedTags.has(t)
                                      ? "border-brand bg-brand-tint font-medium text-brand"
                                      : "text-ink-secondary",
                                  )}
                                  // Shared tags keep the brand highlight (that's the signal on this
                                  // page); only the rest wear their categorical genre tint.
                                  style={sharedTags.has(t) ? undefined : genreTintStyle(t)}
                                >
                                  {t}
                                </span>
                              ))}
                            </div>
                          </td>
                        );
                      })}
                    </tr>
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          <Card
            title="Momentum — sampled review velocity"
            subtitle="Monthly review velocity for every compared game on one axis (game 1 is the primary; the rest ride the trends endpoint's comps overlay)"
          >
            <CompareTrendsChart ids={ids} names={names} />
          </Card>
        </>
      )}
    </div>
  );
}

function PageHeading({ n }: { n: number }) {
  return (
    <div>
      <h1 className="text-lg font-semibold text-ink-primary">Compare</h1>
      <p className="mt-0.5 text-sm text-ink-muted">
        {n >= 2
          ? `Side-by-side across ${n} games — scale, quality, revenue, momentum, and tag overlap.`
          : "Put up to six games side by side — scale, quality, revenue, momentum, and tag overlap."}
      </p>
    </div>
  );
}

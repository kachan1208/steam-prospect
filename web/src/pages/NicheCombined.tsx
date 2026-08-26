import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useQueries } from "@tanstack/react-query";
import clsx from "clsx";

import { Card } from "../components/ui/Card";
import { EmptyState } from "../components/ui/EmptyState";
import { trackEvent } from "../lib/analytics";
import {
  ApiError,
  request,
  useNichesCombined,
  type Dimension,
  type NicheCombined as NicheCombinedResponse,
  type NicheCombineMode,
  type NicheCombinedPerNiche,
  type NicheDetail,
  type Window,
} from "../lib/api";
import { fmtCompact, fmtInt, fmtPct, fmtPrice, fmtRevenue, fmtUsd } from "../lib/format";
// The deep-dive page owns the canonical /niches/:dimension/:key link builder AND the §4b
// KPI-cell primitive (condensed-numeral, 1px-gap blueprint grid); re-exported/reused below so
// the two pages share one link site and one visual language instead of drifting apart.
import { KpiCell, nicheDetailPath } from "./NicheDetail";

export { nicheDetailPath };

/**
 * Combined niche analysis — the answer to "a game carries many tags, so it lives in many
 * niches; what does the OVERLAP look like?".
 *
 * A niche selection rides the URL as repeated `niches=<dimension>:<key>` params (plus
 * `mode`, `win`, `min_reviews`), so every combination is shareable and bookmarkable —
 * the same reasoning as /compare?ids=. Keys carry spaces, ampersands and apostrophes
 * ("Point & Click", "Beat 'em up"), so every hop through a URL goes through
 * URLSearchParams / encodeURIComponent and never through hand-rolled string joins.
 *
 * This module is the single source of truth for the SELECTION URL contract: NicheFinder
 * imports the helpers below to WRITE the links this page READS, so a serialize/parse
 * mismatch can't drift between the two pages. The single-niche deep-dive link is NicheDetail's
 * (that page owns its own route); it is re-exported above so the finder has one import site.
 */

/** Six is the point where the intersection is almost always empty and the chips stop
 * fitting on one row — the same cap, for the same reason, as the games compare list. */
export const NICHE_COMBINE_CAP = 6;

export interface NicheSelection {
  dimension: Dimension;
  key: string;
}

const DIMENSIONS: Dimension[] = ["tag", "genre"];

/** "tag:Point & Click" — dimension, a colon, then the key VERBATIM (URL encoding is the
 * URLSearchParams layer's job, not this one's). */
export function formatNicheRef(sel: NicheSelection): string {
  return `${sel.dimension}:${sel.key}`;
}

/** Inverse of formatNicheRef. Splits on the FIRST colon so a key containing one survives;
 * returns null for an unknown dimension or an empty key rather than inventing a niche. */
export function parseNicheRef(raw: string): NicheSelection | null {
  const i = raw.indexOf(":");
  if (i <= 0) return null;
  const dimension = raw.slice(0, i);
  const key = raw.slice(i + 1);
  if (!DIMENSIONS.includes(dimension as Dimension) || key === "") return null;
  return { dimension: dimension as Dimension, key };
}

/** Every valid `niches=` param, deduped, in URL order, capped at NICHE_COMBINE_CAP. */
export function parseNicheSelection(params: URLSearchParams): NicheSelection[] {
  const out: NicheSelection[] = [];
  const seen = new Set<string>();
  for (const raw of params.getAll("niches")) {
    const sel = parseNicheRef(raw);
    if (!sel) continue;
    const ref = formatNicheRef(sel);
    if (seen.has(ref)) continue;
    seen.add(ref);
    out.push(sel);
    if (out.length >= NICHE_COMBINE_CAP) break;
  }
  return out;
}

export function parseCombineMode(raw: string | null): NicheCombineMode {
  return raw === "union" ? "union" : "intersect";
}

export interface NicheCut {
  win: Window;
  min_reviews: number;
}

/** /niches/combined?niches=tag:Roguelike&niches=tag:Deckbuilding&mode=intersect — the
 * link the finder's "Analyse combined" button navigates to. */
export function nicheCombinedPath(
  selection: NicheSelection[],
  mode: NicheCombineMode,
  cut?: NicheCut,
): string {
  const sp = new URLSearchParams();
  for (const s of selection) sp.append("niches", formatNicheRef(s));
  sp.set("mode", mode);
  if (cut) {
    sp.set("win", cut.win);
    sp.set("min_reviews", String(cut.min_reviews));
  }
  return `/niches/combined?${sp.toString()}`;
}

/** Back-link to the finder with the selection intact, so the checkboxes stay ticked. */
export function nicheFinderPath(selection: NicheSelection[]): string {
  if (selection.length === 0) return "/niches";
  const sp = new URLSearchParams();
  for (const s of selection) sp.append("niches", formatNicheRef(s));
  return `/niches?${sp.toString()}`;
}

const PAGE = 25;
const MIN_REVIEW_OPTIONS = [0, 50, 100];

function parseMinReviews(raw: string | null): number {
  const v = Number(raw);
  return MIN_REVIEW_OPTIONS.includes(v) ? v : 50;
}

function parseWin(raw: string | null): Window {
  return raw === "all" ? "all" : "24m";
}

/** The prose the whole page hangs on: a reader who thinks a union is an intersection will
 * size the market wrong by an order of magnitude, so the mode is spelled out in words. */
function modeSentence(mode: NicheCombineMode, names: string[]): string {
  const joined = names.join(mode === "intersect" ? " AND " : " OR ");
  return mode === "intersect"
    ? `Every game counted below carries ALL ${names.length} niches — ${joined}.`
    : `Every game counted below carries AT LEAST ONE of these ${names.length} niches — ${joined}.`;
}

// Square-cornered segmented control, selected cell = accent-300 fill + accent-900 text — the
// same construction as the Niche Finder's Tags/Genres and window/floor segments (README §4a),
// reused here so mode/window/review-floor read as the identical control everywhere they occur.
function Segmented({ children }: { children: React.ReactNode }) {
  return <div className="flex items-stretch border border-ink-primary/25">{children}</div>;
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
      aria-pressed={active}
      className={clsx(
        "border-l border-ink-primary/25 px-3 py-1.5 text-xs font-medium transition-colors first:border-l-0",
        active ? "bg-brand text-brand-fg" : "text-ink-muted hover:text-ink-secondary",
      )}
    >
      {children}
    </button>
  );
}

/** The per-input sizes, under whichever name the API used (`inputs` today, `per_niche` in
 * the original spec) — see the NicheCombined type. */
function combinedInputs(data: NicheCombinedResponse | undefined): NicheCombinedPerNiche[] {
  return data?.inputs ?? data?.per_niche ?? [];
}

/** A niche's own size in the same cut, read out of the detail endpoint's variant list.
 * Falls back to the first variant so a mart without the exact cut still shows a number
 * (labelled as such by the caller). */
function variantGames(detail: NicheDetail | undefined, cut: NicheCut): number | null {
  if (!detail) return null;
  const exact = detail.variants.find((v) => v.window === cut.win && v.min_reviews === cut.min_reviews);
  return (exact ?? detail.variants[0])?.n_games ?? null;
}

export default function NicheCombined() {
  const [searchParams, setSearchParams] = useSearchParams();

  const selection = useMemo(() => parseNicheSelection(searchParams), [searchParams]);
  const mode = parseCombineMode(searchParams.get("mode"));
  const cut: NicheCut = {
    win: parseWin(searchParams.get("win")),
    min_reviews: parseMinReviews(searchParams.get("min_reviews")),
  };
  const [offset, setOffset] = useState(0);

  const refs = useMemo(() => selection.map(formatNicheRef), [selection]);
  const refsKey = refs.join("|");
  const enough = selection.length >= 2;

  // Any change to what we're asking re-pages to the top.
  useEffect(() => {
    setOffset(0);
  }, [refsKey, mode, cut.win, cut.min_reviews]);

  // Event names must exist in the backend allowlist (api/app/analytics_metrics.py:
  // KNOWN_EVENTS) or they're dropped server-side — reuse niche_open rather than invent one.
  useEffect(() => {
    if (enough) trackEvent("niche_open");
  }, [enough, refsKey, mode]);

  const combinedQ = useNichesCombined({
    niches: refs,
    mode,
    win: cut.win,
    min_reviews: cut.min_reviews,
    limit: PAGE,
    offset,
  });

  const apiError = combinedQ.error instanceof ApiError ? combinedQ.error : null;
  // 503 is the EXPECTED state for the first hours after a deploy: the combined mart is
  // still being rebuilt. Not an error the user caused, and not a spinner — a stated wait.
  const martPending = apiError?.status === 503;
  const degraded = martPending || combinedQ.data?.degraded === true;
  // 422 + "not materialised" = the cut isn't served here (the message names the ones that
  // are). Distinct from a real failure, and fixable in one click.
  const cutUnavailable = apiError?.status === 422 && /materialis/i.test(apiError.message);

  // Without the combined endpoint we can still show each input niche's own size (the
  // per-niche marts are already live), which is most of the "what WOULD this be" answer.
  const needFallback =
    enough && (martPending || (combinedQ.data != null && combinedInputs(combinedQ.data).length === 0));
  const detailQs = useQueries({
    queries: selection.map((s) => ({
      // Same key shape as useNicheDetail so this shares its cache with the deep-dive page.
      queryKey: ["niche-detail", s.dimension, s.key] as const,
      queryFn: () => request<NicheDetail>(`/niches/${s.dimension}/${encodeURIComponent(s.key)}`),
      enabled: needFallback,
      staleTime: 5 * 60_000,
      retry: false,
    })),
  });

  const apiInputs = combinedInputs(combinedQ.data);
  const perNiche = selection.map((s, i) => {
    const fromApi = apiInputs.find((p) => p.dimension === s.dimension && p.key === s.key);
    return {
      ...s,
      n_games: fromApi?.n_games ?? variantGames(detailQs[i]?.data, cut),
    };
  });
  const names = selection.map((s) => s.key);
  const smallest = perNiche.reduce<number | null>(
    (min, p) => (p.n_games == null ? min : min == null ? p.n_games : Math.min(min, p.n_games)),
    null,
  );

  const update = useCallback(
    (mutate: (sp: URLSearchParams) => void) => {
      const sp = new URLSearchParams(searchParams);
      mutate(sp);
      setSearchParams(sp);
    },
    [searchParams, setSearchParams],
  );

  const setMode = (next: NicheCombineMode) => {
    if (next === mode) return;
    trackEvent("niche_filter_apply");
    update((sp) => sp.set("mode", next));
  };

  const removeNiche = (sel: NicheSelection) => {
    const next = selection.filter((s) => formatNicheRef(s) !== formatNicheRef(sel));
    update((sp) => {
      sp.delete("niches");
      for (const s of next) sp.append("niches", formatNicheRef(s));
    });
  };

  const data = combinedQ.data;
  const combinedGames = data?.n_games ?? null;
  const emptyIntersection = !degraded && data != null && data.n_games === 0;
  const modeLabel = mode === "intersect" ? "Intersection" : "Union";

  return (
    <div className="flex flex-col gap-4">
      <div className="text-[11px] text-ink-primary/55">
        <Link to={nicheFinderPath(selection)} className="hover:text-ink-primary">
          Niches
        </Link>
        {" / "}Combined
      </div>

      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[28px] text-ink-primary sm:text-[32px]">
            Combined niche
            {selection.length > 0 && (
              <span className="text-ink-primary/55"> · {names.join(mode === "intersect" ? " ∩ " : " ∪ ")}</span>
            )}
          </h1>
          <p className="mt-1 max-w-2xl text-sm text-ink-secondary">
            {enough
              ? modeSentence(mode, names)
              : "Games carry many tags at once, so they belong to many niches. Combine two or more to size the overlap."}
          </p>
        </div>
        {enough && (
          <span
            className={clsx(
              "shrink-0 border px-3 py-1 text-xs font-semibold",
              mode === "intersect" ? "border-brand text-brand" : "border-ink-primary/30 text-ink-primary/65",
            )}
            title={
              mode === "intersect"
                ? "Intersection: only games that carry every selected niche"
                : "Union: games that carry any selected niche, counted once"
            }
          >
            {modeLabel} · {selection.length} niches
          </span>
        )}
      </div>

      {/* The combination itself: which niches, which mode, which cut — all editable here. */}
      <div className="blueprint relative border-ink-primary/25 p-4">
        <i className="bp-corner" />
        <div className="flex flex-wrap items-center gap-2.5">
          <span className="kicker text-[11px] text-ink-primary/55">Niches</span>
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
            {selection.length === 0 && <span className="text-xs text-ink-muted">None selected</span>}
            {selection.map((s) => (
              <span
                key={formatNicheRef(s)}
                className="inline-flex max-w-[220px] items-center gap-1 border border-ink-primary/25 bg-page px-2 py-0.5 text-[11px] text-ink-secondary"
              >
                <Link to={nicheDetailPath(s.dimension, s.key)} className="truncate hover:text-brand hover:underline">
                  {s.key}
                </Link>
                <button
                  type="button"
                  onClick={() => removeNiche(s)}
                  aria-label={`Remove ${s.key} from the combination`}
                  className="-my-1 flex h-6 w-6 shrink-0 items-center justify-center text-ink-muted hover:bg-ink-primary/10 hover:text-ink-primary"
                >
                  ✕
                </button>
              </span>
            ))}
            <Link
              to={nicheFinderPath(selection)}
              className="border border-ink-primary/25 px-2 py-0.5 text-[11px] font-medium text-ink-muted hover:text-ink-primary"
            >
              + Add niches
            </Link>
          </div>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2.5 border-t border-ink-primary/20 pt-2.5">
          <Segmented>
            <SegButton
              active={mode === "intersect"}
              onClick={() => setMode("intersect")}
              title="Only games carrying EVERY selected niche — the buildable overlap"
            >
              Intersect (all)
            </SegButton>
            <SegButton
              active={mode === "union"}
              onClick={() => setMode("union")}
              title="Games carrying ANY selected niche, counted once — total reach, not a segment"
            >
              Union (any)
            </SegButton>
          </Segmented>
          <Segmented>
            <SegButton
              active={cut.win === "24m"}
              onClick={() => update((sp) => sp.set("win", "24m"))}
              title="Games released in the last 24 months — the market a new entrant faces"
            >
              Last 24 months
            </SegButton>
            <SegButton
              active={cut.win === "all"}
              onClick={() => update((sp) => sp.set("win", "all"))}
              title="Full history — context, not an entry decision"
            >
              All-time
            </SegButton>
          </Segmented>
          <Segmented>
            {MIN_REVIEW_OPTIONS.map((n) => (
              <SegButton
                key={n}
                active={cut.min_reviews === n}
                onClick={() => update((sp) => sp.set("min_reviews", String(n)))}
                title={n === 0 ? "No review floor — the whole population" : `Only games with ${n}+ reviews`}
              >
                {n === 0 ? "All games" : `≥${n} reviews`}
              </SegButton>
            ))}
          </Segmented>
          {mode === "union" && (
            <span className="text-[11px] text-verdict-serious" title="A union sums two audiences; it is not a segment you can build for.">
              A union sizes total reach, not a segment you can build for.
            </span>
          )}
        </div>
      </div>

      {!enough && (
        <Card>
          <EmptyState
            title={selection.length === 1 ? `Only one niche selected — ${names[0]}` : "No niches selected"}
            description={
              <>
                A combination needs at least two niches — one niche on its own is just the niche, and its deep dive
                already covers it. Pick 2–{NICHE_COMBINE_CAP} in the Niche Finder with the checkboxes on each row, then
                hit “Analyse combined”.
              </>
            }
            action={
              <div className="flex items-center gap-2">
                <Link
                  to={nicheFinderPath(selection)}
                  className="bg-brand px-3 py-1.5 text-xs font-semibold text-brand-fg hover:bg-brand-hover"
                >
                  {selection.length === 1 ? "Add another niche" : "Open the Niche Finder"}
                </Link>
                {selection.length === 1 && (
                  <Link
                    to={nicheDetailPath(selection[0].dimension, selection[0].key)}
                    className="border border-chartborder px-3 py-1.5 text-xs font-medium text-ink-secondary hover:text-ink-primary"
                  >
                    Open its deep dive
                  </Link>
                )}
              </div>
            }
          />
        </Card>
      )}

      {enough && combinedQ.isLoading && (
        <Card>
          <div className="py-8 text-center text-sm text-ink-muted">Combining {selection.length} niches…</div>
        </Card>
      )}

      {/* Degraded: the combined mart isn't built yet. Say what the combination WOULD be,
          show every input's own size (those marts ARE live), and refuse to invent the rest. */}
      {enough && degraded && (
        <Card
          title="This combination can’t be computed yet"
          subtitle={
            data?.note ??
            (martPending
              ? "The combined-niche mart is rebuilt by the nightly ETL and lands a few hours after a deploy. Everything below is what will be computed — no numbers are being guessed in the meantime."
              : "The API answered from an incomplete mart, so the combined figures are not trustworthy yet.")
          }
        >
          <div className="flex flex-col gap-3">
            <p className="text-sm text-ink-secondary">{modeSentence(mode, names)}</p>
            <PerNicheFunnel
              perNiche={perNiche}
              mode={mode}
              combined={null}
              smallest={smallest}
              loading={detailQs.some((q) => q.isLoading)}
            />
            <button
              type="button"
              onClick={() => combinedQ.refetch()}
              disabled={combinedQ.isFetching}
              className="self-start border border-chartborder bg-surface px-3 py-1.5 text-xs font-medium text-ink-secondary transition-colors hover:text-ink-primary disabled:opacity-40"
            >
              {combinedQ.isFetching ? "Checking…" : "Check again"}
            </button>
          </div>
        </Card>
      )}

      {/* The API only serves cuts its mart actually materialises; asking for another is a
          422 that NAMES the available ones. That's a cut problem, not a failure. */}
      {enough && cutUnavailable && (
        <Card
          title="That cut isn’t available for combined analysis"
          subtitle={apiError?.message}
        >
          <div className="flex flex-col gap-3">
            <p className="text-sm text-ink-secondary">
              Combined stats are computed per materialised cut — the niche list offers cuts this surface
              doesn’t carry yet.
            </p>
            <button
              type="button"
              onClick={() =>
                update((sp) => {
                  sp.set("win", "24m");
                  sp.set("min_reviews", "50");
                })
              }
              className="self-start bg-brand px-3 py-1.5 text-xs font-semibold text-brand-fg hover:bg-brand-hover"
            >
              Use the default cut (last 24 months, ≥50 reviews)
            </button>
          </div>
        </Card>
      )}

      {enough && !degraded && !cutUnavailable && combinedQ.isError && (
        <Card>
          <div className="py-8 text-center text-sm text-status-serious">
            Failed to combine these niches
            {combinedQ.error instanceof Error ? `: ${combinedQ.error.message}` : "."}
          </div>
        </Card>
      )}

      {/* An empty intersection is a FINDING, not an error: nobody has shipped that
          combination in this cut. The escape hatches say which knob to turn to check
          whether it's genuinely unexplored or just a tight cut. */}
      {enough && emptyIntersection && (
        <Card
          title={mode === "intersect" ? "Nobody has built this combination" : "No games in this union"}
          subtitle={
            mode === "intersect"
              ? "Zero games in this cut carry all of these niches at once. That is a real answer — either the overlap is genuinely unexplored, or the cut below is too tight to show it."
              : "Zero games in this cut carry any of these niches, which usually means the cut is too tight."
          }
        >
          <div className="flex flex-col gap-3">
            <PerNicheFunnel perNiche={perNiche} mode={mode} combined={0} smallest={smallest} loading={false} />
            <div className="flex flex-wrap items-center gap-2 text-xs text-ink-secondary">
              <span className="font-medium text-ink-muted">Check the cut:</span>
              {cut.win !== "all" && (
                <button
                  type="button"
                  onClick={() => update((sp) => sp.set("win", "all"))}
                  className="border border-chartborder px-2 py-1 font-medium hover:text-ink-primary"
                >
                  Widen to all-time
                </button>
              )}
              {cut.min_reviews !== 0 && (
                <button
                  type="button"
                  onClick={() => update((sp) => sp.set("min_reviews", "0"))}
                  className="border border-chartborder px-2 py-1 font-medium hover:text-ink-primary"
                >
                  Drop the review floor
                </button>
              )}
              {mode === "intersect" && (
                <button
                  type="button"
                  onClick={() => setMode("union")}
                  className="border border-chartborder px-2 py-1 font-medium hover:text-ink-primary"
                >
                  Show the union instead
                </button>
              )}
              {selection.length > 2 && <span>…or drop a niche above — every extra one shrinks the overlap.</span>}
            </div>
          </div>
        </Card>
      )}

      {enough && !degraded && data && data.n_games > 0 && (
        <>
          <div className="grid grid-cols-1 gap-px border border-ink-primary/20 bg-ink-primary/20 sm:grid-cols-2 lg:grid-cols-4">
            <KpiCell
              label={mode === "intersect" ? `Games in ALL ${selection.length} niches` : `Games in ANY of ${selection.length} niches`}
              value={fmtInt(data.n_games)}
              valueClassName="text-brand"
              footnote={
                mode === "intersect" && smallest != null && smallest > 0
                  ? `${fmtPct(data.n_games / smallest, 1)} of the smallest input niche (${fmtInt(smallest)} games)`
                  : undefined
              }
            />
            <KpiCell
              label="Median est. revenue"
              value={fmtUsd(data.median_rev)}
              footnote={
                data.p25_rev != null || data.p75_rev != null
                  ? `P25 ${fmtUsd(data.p25_rev)} · P75 ${fmtUsd(data.p75_rev)}`
                  : undefined
              }
            />
            <KpiCell label="P90 est. revenue" value={fmtUsd(data.p90_rev)} footnote="1 in 10 does better" />
            <KpiCell label="Median price" value={fmtPrice(data.median_price)} />
          </div>

          <Card
            title="Where the games went"
            subtitle="Each input niche's own size in this cut, and what survives the combination — the drop is the point."
          >
            <PerNicheFunnel
              perNiche={perNiche}
              mode={mode}
              combined={combinedGames}
              smallest={smallest}
              loading={false}
            />
          </Card>

          <div className="blueprint relative border-ink-primary/25">
            <i className="bp-corner" />
            <div className="flex items-center justify-between gap-3 border-b border-ink-primary/20 px-4 py-3">
              <div>
                <h3 className="text-ink-primary">
                  {mode === "intersect" ? "Games in the overlap" : "Games in the union"}
                </h3>
                <p className="mt-1 text-xs leading-relaxed text-ink-muted">{modeSentence(mode, names)}</p>
              </div>
            </div>
            {data.items.length === 0 ? (
              <div className="p-8 text-center text-sm text-ink-muted">
                The API returned no game rows for this page of the combination.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[720px] border-collapse text-sm">
                  <thead>
                    <tr className="kicker border-b border-ink-primary/20 text-left text-[11px] text-ink-primary/55">
                      <th className="px-4 py-2.5 font-semibold">Game</th>
                      <th className="px-4 py-2.5 font-semibold">Year</th>
                      <th className="px-4 py-2.5 font-semibold">Price</th>
                      <th className="px-4 py-2.5 font-semibold">Reviews</th>
                      <th className="px-4 py-2.5 font-semibold">Owners (est.)</th>
                      <th className="px-4 py-2.5 font-semibold" title="Estimated lifetime gross: reviews × a genre-fitted owners-per-review ratio × launch price">
                        Est. revenue
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.items.map((g) => (
                      <tr key={g.appid} className="border-b border-chartborder/70 transition-colors last:border-0 hover:bg-surface2/60">
                        <td className="px-4 py-2.5">
                          <Link to={`/games/${g.appid}`} className="font-medium text-ink-primary hover:text-brand">
                            {g.name ?? `App ${g.appid}`}
                          </Link>
                        </td>
                        <td className="tabular whitespace-nowrap px-4 py-2.5 text-ink-secondary">{g.release_year ?? "—"}</td>
                        <td className="tabular whitespace-nowrap px-4 py-2.5 text-ink-secondary">{fmtPrice(g.price_initial)}</td>
                        <td className="tabular whitespace-nowrap px-4 py-2.5 text-ink-secondary">{fmtCompact(g.total_reviews)}</td>
                        <td className="tabular whitespace-nowrap px-4 py-2.5 text-ink-secondary">{fmtCompact(g.owners_est)}</td>
                        <td className="tabular whitespace-nowrap px-4 py-2.5 text-ink-secondary">
                          {fmtRevenue(g.est_revenue, g.price_initial === 0)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <div className="flex items-center justify-between border-t border-chartborder px-4 py-2.5 text-xs text-ink-muted">
              <span>
                {data.n_games > 0
                  ? `${(offset + 1).toLocaleString()}–${Math.min(offset + PAGE, data.n_games).toLocaleString()} of ${data.n_games.toLocaleString()}`
                  : "0 results"}
              </span>
              {/* Only when there's actually a second page — a permanently disabled
                  Prev/Next pair on a one-page result is dead-control noise. */}
              {(offset > 0 || data.n_games > PAGE) && (
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    disabled={offset === 0}
                    onClick={() => setOffset((o) => Math.max(0, o - PAGE))}
                    className="border border-chartborder bg-surface px-3 py-1 font-medium text-ink-secondary transition-colors hover:text-ink-primary disabled:pointer-events-none disabled:opacity-40"
                  >
                    Prev
                  </button>
                  <button
                    type="button"
                    disabled={offset + PAGE >= data.n_games}
                    onClick={() => setOffset((o) => o + PAGE)}
                    className="border border-chartborder bg-surface px-3 py-1 font-medium text-ink-secondary transition-colors hover:text-ink-primary disabled:pointer-events-none disabled:opacity-40"
                  >
                    Next
                  </button>
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

/** Input niches with their own sizes, then the combined figure — the "8,000 and 3,000 →
 * 40" drop rendered as the finding it is. `combined = null` means "not computed yet". */
function PerNicheFunnel({
  perNiche,
  mode,
  combined,
  smallest,
  loading,
}: {
  perNiche: (NicheSelection & { n_games: number | null })[];
  mode: NicheCombineMode;
  combined: number | null;
  smallest: number | null;
  loading: boolean;
}) {
  return (
    <div className="flex flex-wrap items-stretch gap-2" data-testid="per-niche-funnel">
      {perNiche.map((p, i) => (
        <div key={formatNicheRef(p)} className="flex items-center gap-2">
          {i > 0 && (
            <span aria-hidden className="text-lg text-ink-muted">
              {mode === "intersect" ? "∩" : "∪"}
            </span>
          )}
          <div className="rounded-card border border-chartborder bg-page px-3 py-2">
            <Link to={nicheDetailPath(p.dimension, p.key)} className="text-xs font-medium text-ink-primary hover:text-brand">
              {p.key}
            </Link>
            <div className="tabular mt-0.5 text-sm font-semibold text-ink-secondary">
              {p.n_games != null ? `${fmtInt(p.n_games)} games` : loading ? "…" : "size unavailable"}
            </div>
          </div>
        </div>
      ))}
      <span aria-hidden className="self-center text-lg text-ink-muted">
        →
      </span>
      <div
        className={clsx(
          "rounded-card border px-3 py-2",
          combined === 0 ? "border-chartborder bg-surface2" : "border-brand bg-brand-tint",
        )}
      >
        <div className="text-xs font-medium text-ink-muted">
          {mode === "intersect" ? "In all of them" : "In any of them"}
        </div>
        <div
          className={clsx(
            "tabular mt-0.5 text-sm font-semibold",
            combined === null ? "text-ink-muted" : combined === 0 ? "text-ink-secondary" : "text-brand",
          )}
        >
          {combined === null ? "not computed yet" : `${fmtInt(combined)} games`}
        </div>
        {combined != null && combined > 0 && smallest != null && smallest > 0 && mode === "intersect" && (
          <div className="mt-0.5 text-[11px] text-ink-muted">{fmtPct(combined / smallest, 1)} of the smallest</div>
        )}
      </div>
    </div>
  );
}

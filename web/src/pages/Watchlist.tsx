import { useState, type CSSProperties, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { useQueries } from "@tanstack/react-query";

import { EmptyState } from "../components/ui/EmptyState";
import { Loading } from "../components/ui/Loading";
import { gameProfileQueryOptions, request, useHealth, type Dimension, type GameProfile, type NicheDetail, type NicheRow } from "../lib/api";
import { monthName } from "../lib/format";
import {
  defaultRuleFor,
  editorValueToThreshold,
  formatMetricValue,
  formatRuleLabel,
  metricIsSigned,
  METRIC_META,
  METRICS_BY_KIND,
  removeFromWatchlist,
  ruleFires,
  setWatchlistRule,
  thresholdToEditorValue,
  useWatchlist,
  type AlertMetric,
  type AlertRule,
  type WatchlistEntry,
  type WatchlistKind,
} from "../lib/watchlist";
import { nicheDetailPath } from "../lib/nichePath";

/**
 * Watchlist — saved niches & games with alert rules (mockup 4f).
 *
 * There is no backend for this feature (see lib/watchlist.ts's module doc for the full
 * honesty accounting). Two things that follow from that and are worth stating up front for
 * whoever reads this next to the mockup:
 *
 *  - The mockup's banner claims a rule "passed the +20% threshold on Aug 19" — a dated
 *    crossing event. Nothing in this stack records history, so that date is not
 *    reproducible truthfully; this page's banner states the CURRENT state of the rule
 *    ("currently meets your alert") with no invented "fired on" date. The one honest
 *    timestamp available — the mart's own build time (useHealth().built_at) — is surfaced
 *    once, in the page subtitle, labeled for what it is ("data as of").
 *  - The mockup's rule column header is "90d trend"; every rule here evaluates against a
 *    field the API genuinely serves (players_trend_7d_pct, saturation_yoy, opportunity_v2,
 *    price_initial — see lib/watchlist.ts), none of which is a 90-day trend, so the table
 *    column is labeled "Trend" rather than repeating a timeframe the data doesn't back.
 *
 * Blueprint grammar (hairline + "+" corner marks, mono-steel verdicts) matches the rest of
 * the restyled app; components/charts/* and other pages are untouched.
 */

const PAPER_30 = "color-mix(in srgb, var(--text-primary) 30%, transparent)";
const PAPER_65 = "color-mix(in srgb, var(--text-primary) 65%, transparent)";
const CONDENSED: CSSProperties = { fontFamily: '"Barlow Condensed", "Barlow", system-ui, sans-serif' };
const ROW_GRID: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "1.6fr .7fr 1.6fr 1fr 1fr",
  gap: 14,
  alignItems: "center",
};
const TABLE_MIN_WIDTH = 720;

const WATCHLIST_ICON = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" />
    <circle cx="12" cy="12" r="3" />
  </svg>
);

// Mirrors useNicheDetail's own queryKey/queryFn (lib/api.ts) exactly so a niche this page
// fans out over shares its cache entry with the niche detail page, rather than double-fetching
// when the user has already visited it. nichePath() itself isn't exported from lib/api.ts, so
// the URL is rebuilt here the same way (dimension/key, key percent-encoded).
function nicheDetailQueryOptions(dimension: Dimension, key: string) {
  return {
    queryKey: ["niche-detail", dimension, key] as const,
    queryFn: () => request<NicheDetail>(`/niches/${dimension}/${encodeURIComponent(key)}`),
  };
}

// The mart only materializes a handful of (window × min_reviews) cuts; 24m/50 is the app-wide
// default (NicheFinder's own initial state) — same fallback chain NicheDetail.tsx uses to pick
// activeVariant when the exact cut isn't available.
function pickVariant(variants: NicheRow[] | undefined): NicheRow | null {
  const list = variants ?? [];
  return list.find((v) => v.window === "24m" && v.min_reviews === 50) ?? list.find((v) => v.window === "24m") ?? list[0] ?? null;
}

function nicheMetricValue(detail: NicheDetail | undefined, metric: AlertMetric): number | null {
  if (!detail) return null;
  const variant = pickVariant(detail.variants);
  switch (metric) {
    case "players_trend_7d_pct":
      return detail.players?.players_trend_7d_pct ?? variant?.players_trend_7d_pct ?? null;
    case "opportunity_v2":
      return variant?.opportunity_v2 ?? null;
    case "saturation_yoy":
      return variant?.saturation_yoy ?? null;
    default:
      return null;
  }
}

function gameMetricValue(profile: GameProfile | undefined, metric: AlertMetric): number | null {
  if (!profile) return null;
  switch (metric) {
    case "players_trend_7d_pct":
      return profile.players_trend_7d_pct ?? null;
    case "price_initial":
      return profile.price_initial ?? null;
    default:
      return null;
  }
}

function entryPath(entry: WatchlistEntry): string {
  return entry.kind === "niche" ? nicheDetailPath(entry.dimension as Dimension, entry.key as string) : `/games/${entry.appid}`;
}

/** "Aug 19" from an ISO build timestamp, or null if there isn't one (older marts / API down) —
 * never a placeholder date. Read in UTC (not the viewer's local offset) since built_at is a
 * server timestamp and the point is "which mart build", not a moment in the viewer's day. */
function formatBuiltAt(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return `${monthName(d.getUTCMonth() + 1)} ${d.getUTCDate()}`;
}

export default function Watchlist() {
  const entries = useWatchlist();
  const healthQ = useHealth();

  const nicheEntries = entries.filter((e) => e.kind === "niche");
  const gameEntries = entries.filter((e) => e.kind === "game");

  const nicheResults = useQueries({
    queries: nicheEntries.map((e) => nicheDetailQueryOptions(e.dimension as Dimension, e.key as string)),
  });
  const gameResults = useQueries({
    queries: gameEntries.map((e) => gameProfileQueryOptions(e.appid as number)),
  });

  const nicheData = new Map<string, NicheDetail>();
  nicheEntries.forEach((e, i) => {
    const d = nicheResults[i]?.data;
    if (d) nicheData.set(e.id, d);
  });
  const gameData = new Map<string, GameProfile>();
  gameEntries.forEach((e, i) => {
    const p = gameResults[i]?.data;
    if (p) gameData.set(e.id, p);
  });

  function currentValue(entry: WatchlistEntry): number | null {
    if (!entry.rule) return null;
    return entry.kind === "niche"
      ? nicheMetricValue(nicheData.get(entry.id), entry.rule.metric)
      : gameMetricValue(gameData.get(entry.id), entry.rule.metric);
  }

  // THE HONESTY GATE for the alert banners. currentValue() returns null for "still
  // loading" AND "failed to load" alike, and ruleFires maps null -> null — so filtering
  // on `=== true` alone would render the same confident bannerless page during the
  // fan-out and after a network failure as for a genuine all-clear. The banners may
  // only claim "nothing fired" once EVERY fan-out query has resolved; failures are
  // named, with a retry, because an unreachable metric is "unknown", never "not fired".
  const alertChecks = [
    ...nicheEntries.map((e, i) => ({ entry: e, result: nicheResults[i] })),
    ...gameEntries.map((e, i) => ({ entry: e, result: gameResults[i] })),
  ].filter((c) => c.entry.rule != null && c.result != null);
  const alertsPending = alertChecks.some((c) => c.result.isPending);
  const failedEntries = alertChecks.filter((c) => c.result.isError).map((c) => c.entry);
  const retryFailed = () => {
    for (const c of alertChecks) if (c.result.isError) void c.result.refetch();
  };

  const fired = entries.filter((e) => e.rule && ruleFires(e.rule, currentValue(e)) === true);
  const builtAt = formatBuiltAt(healthQ.data?.built_at);

  if (entries.length === 0) {
    return (
      <div className="flex flex-col gap-[18px]">
        <Header count={0} builtAt={null} />
        <div className="blueprint">
          <i className="bp-corner" />
          <EmptyState
            icon={WATCHLIST_ICON}
            title="Nothing on your watchlist yet"
            description={
              <>
                Add a niche or a game from its deep dive with the <span className="font-medium text-ink-primary">+ Watchlist</span> button.
                It'll show up here with a starter alert rule you can tune — evaluated live against Prospect's current data, not on a
                schedule.
              </>
            }
          />
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-[18px]">
      <Header count={entries.length} builtAt={builtAt} />

      {/* Alerts section: loading until every fan-out query resolves; failures named with
          a retry; banners (or their honest absence) only once the answers are real. */}
      {alertsPending ? (
        <div className="blueprint px-5 py-1.5">
          <i className="bp-corner" />
          <Loading label="Checking alert rules against live data…" className="py-2 text-[13px]" />
        </div>
      ) : (
        <>
          {failedEntries.length > 0 && (
            <div
              role="alert"
              className="blueprint flex flex-wrap items-center gap-3.5 px-5 py-3.5"
              style={{ borderColor: "var(--status-serious)" }}
            >
              <i className="bp-corner" />
              <span className="text-sm text-ink-primary">
                Couldn&rsquo;t check alerts for{" "}
                <strong className="font-semibold">{failedEntries.map((e) => e.name).join(", ")}</strong> — live data
                failed to load, so those rules are unknown, not &ldquo;not fired&rdquo;.
              </span>
              <button
                type="button"
                onClick={retryFailed}
                className="ml-auto shrink-0 border border-chartborder px-3.5 py-1.5 text-xs font-semibold text-ink-primary transition-colors hover:border-brand hover:text-brand"
              >
                Retry
              </button>
            </div>
          )}
          {fired.map((entry) => (
            <AlertBanner key={entry.id} entry={entry} value={currentValue(entry)} to={entryPath(entry)} />
          ))}
        </>
      )}

      <div className="blueprint">
        <i className="bp-corner" />
        <div className="overflow-x-auto">
          <div style={{ minWidth: TABLE_MIN_WIDTH }}>
            <div
              role="row"
              className="border-b border-chartborder text-[11px] uppercase tracking-[0.08em] text-ink-muted"
              style={{ ...ROW_GRID, ...CONDENSED, padding: "10px 20px" }}
            >
              <span>Item</span>
              <span>Type</span>
              <span>Alert rule</span>
              <span>Trend</span>
              <span title="Prospect doesn't keep a per-item change-event log — only the current value in Trend.">
                Last change
              </span>
            </div>
            {entries.map((entry) => (
              <Row key={entry.id} entry={entry} value={currentValue(entry)} to={entryPath(entry)} />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function Header({ count, builtAt }: { count: number; builtAt: string | null }) {
  return (
    <div className="flex flex-wrap items-baseline gap-3.5">
      <h1 className="text-[25px] leading-none text-ink-primary">Watchlist</h1>
      <span className="text-[13px] text-ink-muted">
        {count > 0
          ? `${count} item${count === 1 ? "" : "s"} · alerts evaluated live against current data${builtAt ? ` · data as of ${builtAt}` : ""}`
          : "saved niches & games — alerts evaluate live against current data, not a nightly job"}
      </span>
    </div>
  );
}

function AlertBanner({ entry, value, to }: { entry: WatchlistEntry; value: number | null; to: string }) {
  const rule = entry.rule as AlertRule;
  return (
    <div className="blueprint flex flex-wrap items-center gap-3.5 px-5 py-3.5" style={{ borderColor: "var(--brand)" }}>
      <i className="bp-corner" />
      <span aria-hidden className="text-[22px] font-semibold leading-none" style={{ ...CONDENSED, color: "var(--brand)" }}>
        ▲
      </span>
      <span className="text-sm text-ink-primary">
        <strong className="font-semibold">{entry.name}</strong> currently meets your alert — {formatRuleLabel(rule)}
        {value != null ? ` (now ${formatMetricValue(rule.metric, value)})` : ""}.
      </span>
      <Link
        to={to}
        className="ml-auto shrink-0 bg-brand px-3.5 py-1.5 text-xs font-semibold text-brand-fg transition-colors hover:bg-brand-hover"
      >
        Open deep dive
      </Link>
    </div>
  );
}

function Row({ entry, value, to }: { entry: WatchlistEntry; value: number | null; to: string }) {
  return (
    <div
      role="row"
      className="border-b border-line-grid transition-colors last:border-0 hover:bg-surface2/60"
      style={{ ...ROW_GRID, padding: "13px 20px", fontSize: 14 }}
    >
      <ItemCell entry={entry} to={to} />
      <TypeTag kind={entry.kind} />
      <RuleCell entry={entry} />
      <MetricCell rule={entry.rule} value={value} />
      <span
        className="text-[13px]"
        style={{ color: PAPER_65 }}
        title="Prospect doesn't keep a change-event history for watchlist items — only the current value shown in Trend."
      >
        —
      </span>
    </div>
  );
}

function ItemCell({ entry, to }: { entry: WatchlistEntry; to: string }) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <Link to={to} className="truncate font-medium text-ink-primary hover:text-brand hover:underline">
        {entry.name}
      </Link>
      <button
        type="button"
        onClick={() => removeFromWatchlist(entry.id)}
        aria-label={`Remove ${entry.name} from watchlist`}
        title="Remove from watchlist"
        className="shrink-0 text-ink-muted transition-colors hover:text-ink-primary"
      >
        ×
      </button>
    </div>
  );
}

function TypeTag({ kind }: { kind: WatchlistKind }) {
  if (kind === "niche") {
    return <span className="justify-self-start border border-brand px-2.5 py-[3px] text-[11px] text-brand">niche</span>;
  }
  return (
    <span className="justify-self-start border px-2.5 py-[3px] text-[11px]" style={{ borderColor: PAPER_30, color: PAPER_65 }}>
      game
    </span>
  );
}

function RuleCell({ entry }: { entry: WatchlistEntry }) {
  const [editing, setEditing] = useState(false);
  const rule = entry.rule;

  if (!editing) {
    return (
      <button
        type="button"
        onClick={() => {
          if (!rule) setWatchlistRule(entry.id, defaultRuleFor(entry.kind));
          setEditing(true);
        }}
        className="text-left text-[13px] transition-colors hover:text-ink-primary"
        style={{ color: PAPER_65 }}
        title="Click to edit this alert rule"
      >
        {rule ? formatRuleLabel(rule) : "No rule set — click to add one"}
      </button>
    );
  }

  const active = rule ?? defaultRuleFor(entry.kind);
  const meta = METRIC_META[active.metric];
  const metrics = METRICS_BY_KIND[entry.kind];

  return (
    <div className="flex flex-wrap items-center gap-1.5 text-[12px]">
      <select
        aria-label={`Alert metric for ${entry.name}`}
        value={active.metric}
        onChange={(e) => {
          const metric = e.target.value as AlertMetric;
          const m = METRIC_META[metric];
          setWatchlistRule(entry.id, { metric, comparator: m.defaultComparator, threshold: m.defaultThreshold });
        }}
        className="border bg-transparent px-1 py-0.5 text-ink-primary"
        style={{ borderColor: PAPER_30 }}
      >
        {metrics.map((m) => (
          <option key={m} value={m}>
            {METRIC_META[m].label}
          </option>
        ))}
      </select>
      <select
        aria-label={`Alert direction for ${entry.name}`}
        value={active.comparator}
        onChange={(e) => setWatchlistRule(entry.id, { ...active, comparator: e.target.value as "gt" | "lt" })}
        className="border bg-transparent px-1 py-0.5 text-ink-primary"
        style={{ borderColor: PAPER_30 }}
      >
        <option value="gt">above</option>
        <option value="lt">below</option>
      </select>
      <input
        aria-label={`Alert threshold for ${entry.name}`}
        type="number"
        step={meta.unit === "usd" ? 0.01 : 1}
        value={thresholdToEditorValue(active)}
        onChange={(e) => {
          const n = Number(e.target.value);
          if (!Number.isFinite(n)) return;
          setWatchlistRule(entry.id, { ...active, threshold: editorValueToThreshold(active.metric, n) });
        }}
        className="tabular w-16 border bg-transparent px-1 py-0.5 text-ink-primary"
        style={{ borderColor: PAPER_30 }}
      />
      <span style={{ color: PAPER_65 }}>{meta.unit === "usd" ? "USD" : meta.unit === "score" ? "" : "%"}</span>
      <button type="button" onClick={() => setEditing(false)} className="font-medium text-brand hover:text-brand-hover">
        Done
      </button>
    </div>
  );
}

function MetricCell({ rule, value }: { rule: AlertRule | null; value: number | null }): ReactNode {
  if (!rule) return <span style={{ color: "var(--verdict-flat)" }}>—</span>;
  if (value == null) {
    return (
      <span style={{ color: "var(--verdict-flat)" }} title="No live data yet for this metric">
        —
      </span>
    );
  }
  if (metricIsSigned(rule.metric)) {
    const up = value >= 0;
    return (
      <span className="tabular font-medium" style={{ color: up ? "var(--verdict-up)" : "var(--verdict-flat)" }}>
        {up ? "▲" : "▼"} {formatMetricValue(rule.metric, value)}
      </span>
    );
  }
  return <span className="tabular text-ink-primary">{formatMetricValue(rule.metric, value)}</span>;
}

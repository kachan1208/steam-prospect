import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import clsx from "clsx";

import { Badge } from "../components/ui/Badge";
import { Card } from "../components/ui/Card";
import { EmptyState } from "../components/ui/EmptyState";
import { StatTile } from "../components/ui/StatTile";
import { API_BASE } from "../lib/api";

// Local fetch helper mirroring lib/api.ts's private `request`, built on the exported
// API_BASE — that module's `request` is not exported and the file is owned by another track,
// and the alerts endpoints have no generated hooks there, so we call them directly here.
async function apiRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    let detail: unknown = res.statusText;
    try {
      const body = (await res.clone().json()) as { detail?: unknown };
      detail = body?.detail ?? detail;
    } catch {
      /* non-JSON error body; keep statusText */
    }
    throw new Error(typeof detail === "string" ? detail : JSON.stringify(detail));
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

interface AlertRule {
  id: number;
  kind: string;
  params: Record<string, unknown>;
  enabled: boolean;
  created_at: string;
}

interface AlertEvent {
  id: number;
  kind: string;
  title: string;
  body: string;
  appid: number | null;
  created_at: string;
  seen: boolean;
  edge?: boolean; // fired by an edge-triggered rule (change), not a standing condition
}

interface DigestKindCount {
  kind: string;
  count: number;
}

interface Digest {
  since: string;
  until: string;
  days: number;
  total: number;
  by_kind: DigestKindCount[];
  top: AlertEvent[];
}

interface Preset {
  key: string;
  label: string;
  description: string;
  kind: string;
  kind_label: string;
  edge: boolean;
  params: Record<string, unknown>;
  added: boolean;
}

interface SentDigest {
  id: number;
  subject: string;
  body: string;
  signal_count: number;
  created_at: string;
}

const RULE_KINDS: { value: string; label: string; hint: string; color: string; edge?: boolean }[] = [
  {
    value: "watchlist_velocity",
    label: "Watchlist velocity",
    hint: "Trailing-30d review surges or stalls on games you watch.",
    color: "var(--series-1)",
  },
  {
    value: "new_in_niche",
    label: "New in niche",
    hint: "Strong new releases this year in a genre you already watch.",
    color: "var(--status-good)",
  },
  {
    value: "niche_median_rev",
    label: "Niche median revenue",
    hint: "A watched genre's median est. revenue crosses a dollar threshold.",
    color: "var(--status-warning)",
  },
  // Edge-triggered kinds — these fire on a *change* vs. the last check, not a standing condition.
  {
    value: "velocity_change",
    label: "Momentum shift",
    hint: "Fires when a watched game's review pace jumps or drops sharply vs. the last check.",
    color: "var(--series-5)",
    edge: true,
  },
  {
    value: "comp_launch",
    label: "Competitor launch",
    hint: "Fires the moment a watched game crosses a review milestone — a launch/traction signal.",
    color: "var(--series-8)",
    edge: true,
  },
  {
    value: "sentiment_drop",
    label: "Sentiment drop",
    hint: "Fires when a watched game's positive rating falls vs. the last check.",
    color: "var(--series-6)",
    edge: true,
  },
];

const EDGE_KINDS = new Set(RULE_KINDS.filter((k) => k.edge).map((k) => k.value));

const KIND_META: Record<string, { label: string; color: string }> = Object.fromEntries(
  RULE_KINDS.map((k) => [k.value, { label: k.label, color: k.color }]),
);

function kindLabel(kind: string): string {
  return KIND_META[kind]?.label ?? kind;
}

function kindColor(kind: string): string {
  return KIND_META[kind]?.color ?? "var(--series-1)";
}

/** Compact relative time, falling back to a short date beyond a week. */
function fmtWhen(iso: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const mins = Math.round((Date.now() - d.getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export default function AlertsPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [newKind, setNewKind] = useState<string>(RULE_KINDS[0].value);
  const [digestPreview, setDigestPreview] = useState<SentDigest | null>(null);

  const digest = useQuery({ queryKey: ["alerts", "digest"], queryFn: () => apiRequest<Digest>("/alerts/digest") });
  const rules = useQuery({ queryKey: ["alerts", "rules"], queryFn: () => apiRequest<AlertRule[]>("/alerts/rules") });
  const feed = useQuery({ queryKey: ["alerts", "feed"], queryFn: () => apiRequest<AlertEvent[]>("/alerts/feed") });
  const presets = useQuery({ queryKey: ["alerts", "presets"], queryFn: () => apiRequest<Preset[]>("/alerts/presets") });
  const digestHistory = useQuery({
    queryKey: ["alerts", "digest", "history"],
    queryFn: () => apiRequest<SentDigest[]>("/alerts/digest/history"),
  });

  const invalidateSignals = () => {
    qc.invalidateQueries({ queryKey: ["alerts", "feed"] });
    qc.invalidateQueries({ queryKey: ["alerts", "digest"] });
  };

  const evaluate = useMutation({
    mutationFn: () => apiRequest<AlertEvent[]>("/alerts/evaluate", { method: "POST" }),
    onSuccess: invalidateSignals,
  });
  const createRule = useMutation({
    mutationFn: (kind: string) =>
      apiRequest<AlertRule>("/alerts/rules", { method: "POST", body: JSON.stringify({ kind, params: {} }) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["alerts", "rules"] });
      qc.invalidateQueries({ queryKey: ["alerts", "presets"] });
    },
  });
  const addPreset = useMutation({
    mutationFn: (key: string) => apiRequest<AlertRule>(`/alerts/presets/${key}`, { method: "POST" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["alerts", "rules"] });
      qc.invalidateQueries({ queryKey: ["alerts", "presets"] });
    },
  });
  const toggleRule = useMutation({
    mutationFn: (v: { id: number; enabled: boolean }) =>
      apiRequest<AlertRule>(`/alerts/rules/${v.id}`, { method: "PATCH", body: JSON.stringify({ enabled: v.enabled }) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["alerts", "rules"] });
      qc.invalidateQueries({ queryKey: ["alerts", "presets"] });
    },
  });
  const markSeen = useMutation({
    mutationFn: (id: number) => apiRequest<AlertEvent>(`/alerts/feed/${id}/seen`, { method: "POST" }),
    onSuccess: invalidateSignals,
  });
  const sendDigest = useMutation({
    mutationFn: () => apiRequest<SentDigest>("/alerts/digest/send", { method: "POST" }),
    onSuccess: (data) => {
      setDigestPreview(data);
      qc.invalidateQueries({ queryKey: ["alerts", "digest", "history"] });
    },
  });

  const runNow = (
    <button
      type="button"
      onClick={() => evaluate.mutate()}
      disabled={evaluate.isPending}
      className="rounded-md bg-brand px-3 py-1.5 text-xs font-medium text-brand-fg transition-colors hover:bg-brand-hover disabled:opacity-50"
    >
      {evaluate.isPending ? "Running…" : "Run now"}
    </button>
  );

  const digestSendButton = (
    <button
      type="button"
      onClick={() => sendDigest.mutate()}
      disabled={sendDigest.isPending}
      className="shrink-0 rounded-md border border-chartborder px-3 py-1.5 text-xs font-medium text-ink-secondary transition-colors hover:bg-surface2 hover:text-ink-primary disabled:opacity-50"
    >
      {sendDigest.isPending ? "Preparing…" : "Preview & send weekly digest"}
    </button>
  );

  const digestData = digest.data;
  const evaluatedCount = evaluate.data?.length ?? null;

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-lg font-semibold text-ink-primary">Alerts</h1>
        <p className="mt-0.5 text-sm text-ink-muted">
          Signals from your watchlist and niches — edge alerts that fire on change, a weekly digest you can preview &amp; send, and one-click preset rules.
        </p>
      </div>

      {/* Weekly digest ------------------------------------------------------------------ */}
      <Card
        title="Weekly digest"
        subtitle={digestData ? `Last ${digestData.days} days · ${digestData.total} signal${digestData.total === 1 ? "" : "s"}` : "Last 7 days"}
        action={digestSendButton}
      >
        {digest.isLoading && <div className="py-6 text-sm text-ink-muted">Loading digest…</div>}
        {digest.isError && (
          <div className="py-6 text-sm text-status-serious">
            Failed to load digest{digest.error instanceof Error ? `: ${digest.error.message}` : "."}
          </div>
        )}
        {digestData && digestData.total === 0 && (
          <EmptyState
            title="No signals this week"
            description="Add a rule below, then Run now to evaluate your watchlist and niches against the latest data."
            action={runNow}
          />
        )}
        {digestData && digestData.total > 0 && (
          <div className="flex flex-col gap-4">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <StatTile label="Signals this week" value={digestData.total} />
              {digestData.by_kind.map((k) => (
                <StatTile key={k.kind} label={kindLabel(k.kind)} value={k.count} />
              ))}
            </div>
            <div className="flex flex-col gap-2">
              <div className="text-xs font-semibold uppercase tracking-wide text-ink-muted">Top signals</div>
              {digestData.top.map((e) => (
                <div key={e.id} className="flex items-start gap-2 border-b border-chartborder/60 pb-2 last:border-0 last:pb-0">
                  <span className="mt-1 h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: kindColor(e.kind) }} />
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium text-ink-primary">{e.title}</div>
                    <div className="text-xs text-ink-secondary">{e.body}</div>
                  </div>
                  <span className="ml-auto shrink-0 text-[11px] text-ink-muted">{fmtWhen(e.created_at)}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {sendDigest.isError && (
          <div className="mt-3 text-xs text-status-serious">
            Failed to send digest{sendDigest.error instanceof Error ? `: ${sendDigest.error.message}` : "."}
          </div>
        )}

        {digestPreview && (
          <div className="mt-4 border-t border-chartborder pt-4">
            <div className="mb-2 flex items-center justify-between gap-2">
              <div className="text-xs font-semibold uppercase tracking-wide text-ink-muted">
                Digest preview · {fmtWhen(digestPreview.created_at)}
              </div>
              <button
                type="button"
                onClick={() => setDigestPreview(null)}
                className="text-[11px] text-ink-muted transition-colors hover:text-ink-secondary"
              >
                Dismiss
              </button>
            </div>
            <pre className="max-h-96 overflow-auto whitespace-pre-wrap rounded-lg border border-chartborder bg-page p-3 text-xs leading-relaxed text-ink-secondary">
              {digestPreview.body}
            </pre>
            <p className="mt-2 text-[11px] text-ink-muted">
              This is the exact text a subscriber would receive. Delivery is logged below — solo mode doesn&apos;t contact a real inbox.
            </p>
          </div>
        )}

        {digestHistory.data && digestHistory.data.length > 0 && (
          <div className="mt-4 border-t border-chartborder pt-3">
            <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-muted">Recently sent</div>
            <div className="flex flex-col">
              {digestHistory.data.slice(0, 5).map((h) => (
                <button
                  key={h.id}
                  type="button"
                  onClick={() => setDigestPreview(h)}
                  className="flex items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-xs text-ink-secondary transition-colors hover:bg-surface2"
                >
                  <span className="truncate">{h.subject}</span>
                  <span className="shrink-0 tabular text-[11px] text-ink-muted">{fmtWhen(h.created_at)}</span>
                </button>
              ))}
            </div>
          </div>
        )}
      </Card>

      {/* Rules -------------------------------------------------------------------------- */}
      <Card
        title="Alert rules"
        subtitle="Enable the signals you care about, then run an evaluation on demand."
        action={runNow}
      >
        {evaluatedCount !== null && (
          <div className="mb-3 rounded-md border border-chartborder bg-page px-3 py-2 text-xs text-ink-secondary">
            Last run created <span className="font-medium text-ink-primary">{evaluatedCount}</span> new{" "}
            {evaluatedCount === 1 ? "signal" : "signals"}.
          </div>
        )}

        {/* One-click presets — the fast path; edge presets fire on change, not a standing state. */}
        {presets.data && presets.data.length > 0 && (
          <div className="mb-4">
            <div className="mb-2 flex items-center gap-2">
              <span className="text-xs font-semibold uppercase tracking-wide text-ink-muted">One-click presets</span>
              <span className="text-[11px] text-ink-muted">Ready-made rules — add a whole signal in one tap.</span>
            </div>
            <div className="flex flex-wrap gap-2">
              {presets.data.map((p) => (
                <button
                  key={p.key}
                  type="button"
                  onClick={() => addPreset.mutate(p.key)}
                  disabled={p.added || addPreset.isPending}
                  title={p.description}
                  className={clsx(
                    "inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors",
                    p.added
                      ? "cursor-default border-chartborder bg-surface2 text-ink-muted"
                      : "border-chartborder text-ink-secondary hover:border-brand hover:bg-brand-tint hover:text-brand disabled:opacity-50",
                  )}
                >
                  <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: kindColor(p.kind) }} />
                  <span>{p.label}</span>
                  {p.edge && (
                    <span className="rounded-sm bg-page px-1 text-[9px] font-semibold uppercase tracking-wide text-ink-muted">
                      on change
                    </span>
                  )}
                  <span className="ml-0.5 text-[11px] text-ink-muted">{p.added ? "Added" : "Add"}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="mb-4 flex flex-wrap items-center gap-2">
          <select
            value={newKind}
            onChange={(ev) => setNewKind(ev.target.value)}
            className="rounded-md border border-chartborder bg-surface px-2 py-1.5 text-sm text-ink-primary"
          >
            {RULE_KINDS.map((k) => (
              <option key={k.value} value={k.value}>
                {k.label}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => createRule.mutate(newKind)}
            disabled={createRule.isPending}
            className="rounded-md border border-chartborder px-3 py-1.5 text-xs font-medium text-ink-secondary transition-colors hover:bg-surface2 hover:text-ink-primary disabled:opacity-50"
          >
            Add rule
          </button>
          <span className="text-[11px] text-ink-muted">{RULE_KINDS.find((k) => k.value === newKind)?.hint}</span>
        </div>

        {rules.isLoading && <div className="py-2 text-sm text-ink-muted">Loading rules…</div>}
        {rules.isError && (
          <div className="py-2 text-sm text-status-serious">
            Failed to load rules{rules.error instanceof Error ? `: ${rules.error.message}` : "."}
          </div>
        )}
        {rules.data && rules.data.length === 0 && (
          <p className="py-2 text-sm text-ink-muted">No rules yet — add one above to start generating signals.</p>
        )}
        {rules.data && rules.data.length > 0 && (
          <div className="flex flex-col divide-y divide-chartborder/60">
            {rules.data.map((r) => (
              <div key={r.id} className="flex items-center gap-3 py-2.5">
                <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: kindColor(r.kind) }} />
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium text-ink-primary">{kindLabel(r.kind)}</div>
                  <div className="truncate text-[11px] text-ink-muted">
                    {RULE_KINDS.find((k) => k.value === r.kind)?.hint ?? r.kind}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => toggleRule.mutate({ id: r.id, enabled: !r.enabled })}
                  disabled={toggleRule.isPending}
                  aria-pressed={r.enabled}
                  className={clsx(
                    "ml-auto shrink-0 rounded-full px-3 py-1 text-xs font-medium transition-colors disabled:opacity-50",
                    r.enabled
                      ? "bg-brand-tint text-brand"
                      : "border border-chartborder text-ink-muted hover:text-ink-secondary",
                  )}
                >
                  {r.enabled ? "Enabled" : "Disabled"}
                </button>
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* Feed --------------------------------------------------------------------------- */}
      <Card className="!p-0">
        <div className="flex items-center justify-between gap-3 border-b border-chartborder px-4 py-3">
          <div>
            <h3 className="text-sm font-semibold text-ink-primary">Alert feed</h3>
            <p className="mt-0.5 text-xs text-ink-muted">Every signal, newest first.</p>
          </div>
        </div>

        {feed.isLoading && <div className="p-6 text-sm text-ink-muted">Loading feed…</div>}
        {feed.isError && (
          <div className="p-6 text-sm text-status-serious">
            Failed to load feed{feed.error instanceof Error ? `: ${feed.error.message}` : "."}
          </div>
        )}
        {feed.data && feed.data.length === 0 && (
          <EmptyState
            title="No alerts yet"
            description="Signals appear here once a rule matches. Add a rule and Run now to evaluate immediately."
            action={runNow}
          />
        )}
        {feed.data && feed.data.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] border-collapse text-sm">
              <thead>
                <tr className="border-b border-chartborder text-left text-xs text-ink-muted">
                  <th className="px-4 py-2 font-medium">Signal</th>
                  <th className="px-4 py-2 font-medium">Type</th>
                  <th className="px-4 py-2 font-medium">When</th>
                  <th className="px-4 py-2 font-medium" />
                </tr>
              </thead>
              <tbody>
                {feed.data.map((e) => (
                  <tr key={e.id} className={clsx("border-b border-chartborder/60 hover:bg-page", !e.seen && "bg-page/60")}>
                    <td className="px-4 py-2.5 align-top">
                      <div className="flex items-start gap-2">
                        {!e.seen && (
                          <span
                            className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full"
                            style={{ backgroundColor: kindColor(e.kind) }}
                            aria-label="Unseen"
                          />
                        )}
                        <div className="min-w-0">
                          <div className="flex items-center gap-1.5">
                            {e.appid != null ? (
                              <button
                                type="button"
                                onClick={() => navigate(`/games/${e.appid}`)}
                                className={clsx(
                                  "min-w-0 truncate text-left font-medium hover:text-series-1 hover:underline",
                                  e.seen ? "text-ink-secondary" : "text-ink-primary",
                                )}
                              >
                                {e.title}
                              </button>
                            ) : (
                              <span className={clsx("min-w-0 truncate font-medium", e.seen ? "text-ink-secondary" : "text-ink-primary")}>
                                {e.title}
                              </span>
                            )}
                            {e.edge && (
                              <span className="shrink-0 rounded-sm bg-surface2 px-1 text-[9px] font-semibold uppercase tracking-wide text-ink-muted">
                                on change
                              </span>
                            )}
                          </div>
                          <span className="block text-xs text-ink-muted">{e.body}</span>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-2.5 align-top">
                      <Badge color={kindColor(e.kind)}>{kindLabel(e.kind)}</Badge>
                    </td>
                    <td className="tabular whitespace-nowrap px-4 py-2.5 align-top text-ink-secondary">{fmtWhen(e.created_at)}</td>
                    <td className="px-4 py-2.5 align-top text-right">
                      {e.seen ? (
                        <span className="text-[11px] text-ink-muted">Seen</span>
                      ) : (
                        <button
                          type="button"
                          onClick={() => markSeen.mutate(e.id)}
                          disabled={markSeen.isPending}
                          className="rounded-md px-2 py-1 text-[11px] font-medium text-ink-muted transition-colors hover:bg-surface2 hover:text-ink-primary disabled:opacity-50"
                        >
                          Mark seen
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

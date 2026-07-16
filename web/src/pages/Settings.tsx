import { type ReactNode, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import clsx from "clsx";

import { Badge } from "../components/ui/Badge";
import { Card } from "../components/ui/Card";
import { EmptyState } from "../components/ui/EmptyState";
import { StatTile } from "../components/ui/StatTile";
import {
  type ApiKeyCreated,
  useAccount,
  useApiKeys,
  useCreateApiKey,
  useDeleteSavedView,
  useRevokeApiKey,
  useSavedViews,
  useUsage,
} from "../lib/api";
import { fmtInt } from "../lib/format";
import { ACCENTS, PRESETS, useTheme } from "../lib/theme";

type Tab = "profile" | "views" | "api-keys" | "usage";

const TABS: { id: Tab; label: string; path: string }[] = [
  { id: "profile", label: "Profile & preferences", path: "/settings" },
  { id: "views", label: "Saved views", path: "/settings/views" },
  { id: "api-keys", label: "API keys", path: "/settings/api-keys" },
  { id: "usage", label: "Usage", path: "/settings/usage" },
];

function tabFromPath(pathname: string): Tab {
  if (pathname === "/settings/views") return "views";
  if (pathname === "/settings/api-keys") return "api-keys";
  if (pathname === "/settings/usage") return "usage";
  return "profile";
}

function dateOnly(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleDateString();
}

function Field({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div>
      <div className="text-xs text-ink-muted">{label}</div>
      <div className="mt-0.5 text-sm font-medium text-ink-primary">{value}</div>
    </div>
  );
}

function PreferenceRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2.5">
      <span className="text-xs font-medium text-ink-secondary">{label}</span>
      {children}
    </div>
  );
}

// ---- Profile & preferences ---------------------------------------------------------------
function ProfileTab() {
  const { data, isLoading, isError, error } = useAccount();
  const { theme, setTheme, accent, setAccent, preset, setPreset } = useTheme();

  return (
    <div className="flex flex-col gap-4">
      <Card title="Organization" subtitle="Your workspace on Prospect.">
        {isLoading && <div className="text-sm text-ink-muted">Loading…</div>}
        {isError && (
          <div className="text-sm text-status-serious">
            Failed to load account{error instanceof Error ? `: ${error.message}` : "."}
          </div>
        )}
        {data && (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Field label="Organization" value={data.org.name} />
            <Field label="Plan" value={<Badge>{data.org.plan}</Badge>} />
            <Field label="Member since" value={dateOnly(data.user.member_since)} />
          </div>
        )}
      </Card>

      <Card title="Profile">
        {data && (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Email" value={data.user.email} />
            <Field label="Display name" value={data.user.display_name ?? "—"} />
          </div>
        )}
        <p className="mt-3 border-t border-chartborder pt-3 text-xs text-ink-muted">
          Profile editing and team invites arrive alongside multi-user accounts — solo mode has one seeded profile.
        </p>
      </Card>

      <Card title="Appearance" subtitle="Also available from the sidebar — applies instantly and is saved to this browser.">
        <div className="flex flex-col gap-3.5">
          <PreferenceRow label="Mode">
            <div className="flex items-center gap-0.5 rounded-lg bg-surface2 p-0.5">
              {(["light", "dark"] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setTheme(t)}
                  className={clsx(
                    "rounded-md px-3 py-1 text-xs font-medium capitalize transition-all",
                    theme === t ? "bg-surface text-ink-primary shadow-xs" : "text-ink-muted hover:text-ink-secondary",
                  )}
                >
                  {t}
                </button>
              ))}
            </div>
          </PreferenceRow>
          <PreferenceRow label="Theme">
            <div className="flex items-center gap-0.5 rounded-lg bg-surface2 p-0.5">
              {PRESETS.map((pz) => (
                <button
                  key={pz.id}
                  type="button"
                  onClick={() => setPreset(pz.id)}
                  className={clsx(
                    "rounded-md px-3 py-1 text-xs font-medium transition-all",
                    preset === pz.id ? "bg-surface text-ink-primary shadow-xs" : "text-ink-muted hover:text-ink-secondary",
                  )}
                >
                  {pz.name}
                </button>
              ))}
            </div>
          </PreferenceRow>
          <PreferenceRow label="Accent">
            <div className="flex items-center gap-1.5">
              {ACCENTS.map((a) => {
                const active = accent === a.id;
                return (
                  <button
                    key={a.id}
                    type="button"
                    onClick={() => setAccent(a.id)}
                    title={a.name}
                    aria-label={`Accent color: ${a.name}`}
                    aria-pressed={active}
                    className="h-5 w-5 rounded-full transition-transform hover:scale-110"
                    style={{
                      backgroundColor: a.swatch,
                      outline: active ? `2px solid ${a.swatch}` : "2px solid transparent",
                      outlineOffset: "2px",
                    }}
                  />
                );
              })}
            </div>
          </PreferenceRow>
        </div>
      </Card>

      <Card title="Getting started">
        <div className="flex items-center justify-between gap-3">
          <p className="text-xs text-ink-secondary">Revisit the four-surface welcome tour any time.</p>
          <Link to="/welcome" className="shrink-0 text-xs font-medium text-series-1 hover:underline">
            Reopen the welcome guide →
          </Link>
        </div>
      </Card>
    </div>
  );
}

// ---- Saved views ---------------------------------------------------------------------------
function SavedViewsTab() {
  const { data, isLoading, isError, error } = useSavedViews();
  const deleteView = useDeleteSavedView();

  return (
    <Card title="Saved views" subtitle="Filter/sort presets you've saved across Prospect's surfaces.">
      {isLoading && <div className="py-6 text-center text-sm text-ink-muted">Loading…</div>}
      {isError && (
        <div className="py-6 text-center text-sm text-status-serious">
          Failed to load saved views{error instanceof Error ? `: ${error.message}` : "."}
        </div>
      )}
      {data && data.length === 0 && (
        <EmptyState
          title="No saved views yet"
          description="Save a filter/sort combination from the Niche Finder or Explorer to get back to it in one click."
          action={
            <Link to="/niches" className="text-xs font-medium text-series-1 hover:underline">
              Open Niche Finder →
            </Link>
          }
        />
      )}
      {data && data.length > 0 && (
        <div className="overflow-x-auto rounded-card border border-chartborder">
          <table className="w-full min-w-[560px] text-sm">
            <thead>
              <tr className="border-b border-chartborder text-left text-xs text-ink-muted">
                <th className="px-3 py-2 font-medium">Name</th>
                <th className="px-3 py-2 font-medium">Surface</th>
                <th className="px-3 py-2 font-medium">Created</th>
                <th className="px-3 py-2 font-medium" />
              </tr>
            </thead>
            <tbody>
              {data.map((v) => (
                <tr key={v.id} className="border-b border-chartborder/60 last:border-0">
                  <td className="px-3 py-2 font-medium text-ink-primary">{v.name}</td>
                  <td className="px-3 py-2">
                    <span className="rounded-full border border-chartborder bg-page px-2 py-0.5 text-[11px] text-ink-secondary">
                      {v.surface}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-ink-secondary">{dateOnly(v.created_at)}</td>
                  <td className="px-3 py-2 text-right">
                    <button
                      type="button"
                      onClick={() => deleteView.mutate(v.id)}
                      disabled={deleteView.isPending}
                      aria-label={`Delete ${v.name}`}
                      className="rounded-md px-2 py-1 text-xs text-ink-muted hover:text-status-critical disabled:opacity-40"
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

// ---- API keys -------------------------------------------------------------------------------
function ApiKeysTab() {
  const { data, isLoading, isError, error } = useApiKeys();
  const createKey = useCreateApiKey();
  const revokeKey = useRevokeApiKey();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [justCreated, setJustCreated] = useState<ApiKeyCreated | null>(null);
  const [copied, setCopied] = useState(false);

  function submit() {
    const trimmed = name.trim();
    if (!trimmed) return;
    createKey.mutate(
      { name: trimmed },
      {
        onSuccess: (created) => {
          setJustCreated(created);
          setName("");
          setCreating(false);
        },
      },
    );
  }

  function copySecret() {
    if (!justCreated) return;
    navigator.clipboard
      ?.writeText(justCreated.secret)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      })
      .catch(() => {
        // Clipboard API unavailable/denied — the key is still visible to copy by hand.
      });
  }

  return (
    <div className="flex flex-col gap-4">
      {justCreated && (
        <Card className="!border-brand/40">
          <div className="flex flex-col gap-2">
            <div className="text-sm font-semibold text-ink-primary">&ldquo;{justCreated.name}&rdquo; created</div>
            <p className="text-xs text-ink-secondary">Copy this key now — you won&apos;t be able to see it again.</p>
            <div className="flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate rounded-md border border-chartborder bg-page px-2.5 py-1.5 text-xs text-ink-primary">
                {justCreated.secret}
              </code>
              <button
                type="button"
                onClick={copySecret}
                className="shrink-0 rounded-md border border-chartborder px-2.5 py-1.5 text-xs font-medium text-ink-secondary hover:text-ink-primary"
              >
                {copied ? "Copied!" : "Copy"}
              </button>
            </div>
            <button
              type="button"
              onClick={() => setJustCreated(null)}
              className="self-start text-xs text-ink-muted hover:text-ink-primary"
            >
              Done
            </button>
          </div>
        </Card>
      )}

      <Card
        title="API keys"
        subtitle="Programmatic access to your Prospect data. Keep keys secret — anyone with one can read your account's data."
        action={
          !creating ? (
            <button
              type="button"
              onClick={() => setCreating(true)}
              className="shrink-0 rounded-md bg-series-1 px-3 py-1.5 text-xs font-semibold text-white transition-opacity hover:opacity-90"
            >
              + New key
            </button>
          ) : undefined
        }
      >
        {creating && (
          <div className="mb-4 flex flex-wrap items-center gap-2 rounded-md border border-chartborder bg-page p-3">
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submit();
                if (e.key === "Escape") {
                  setCreating(false);
                  setName("");
                }
              }}
              placeholder='Key name, e.g. "CI export"'
              className="min-w-0 flex-1 rounded-md border border-chartborder bg-surface px-2.5 py-1.5 text-xs text-ink-primary outline-none focus:border-series-1"
            />
            <button
              type="button"
              onClick={submit}
              disabled={!name.trim() || createKey.isPending}
              className="shrink-0 rounded-md border border-series-1 px-2.5 py-1.5 text-xs font-medium text-series-1 hover:bg-page disabled:opacity-50"
            >
              {createKey.isPending ? "Creating…" : "Create"}
            </button>
            <button
              type="button"
              onClick={() => {
                setCreating(false);
                setName("");
              }}
              className="shrink-0 rounded-md px-2 py-1.5 text-xs text-ink-muted hover:text-ink-primary"
            >
              Cancel
            </button>
          </div>
        )}
        {createKey.isError && (
          <div className="mb-3 text-xs text-status-serious">
            {createKey.error instanceof Error ? createKey.error.message : "Failed to create key."}
          </div>
        )}

        {isLoading && <div className="py-6 text-center text-sm text-ink-muted">Loading…</div>}
        {isError && (
          <div className="py-6 text-center text-sm text-status-serious">
            Failed to load API keys{error instanceof Error ? `: ${error.message}` : "."}
          </div>
        )}
        {data && data.length === 0 && !creating && (
          <EmptyState title="No API keys yet" description="Create one to script access to your niches, benchmarks, and exports." />
        )}
        {data && data.length > 0 && (
          <div className="overflow-x-auto rounded-card border border-chartborder">
            <table className="w-full min-w-[640px] text-sm">
              <thead>
                <tr className="border-b border-chartborder text-left text-xs text-ink-muted">
                  <th className="px-3 py-2 font-medium">Name</th>
                  <th className="px-3 py-2 font-medium">Key</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                  <th className="px-3 py-2 font-medium">Created</th>
                  <th className="px-3 py-2 font-medium">Last used</th>
                  <th className="px-3 py-2 font-medium" />
                </tr>
              </thead>
              <tbody>
                {data.map((k) => (
                  <tr key={k.id} className="border-b border-chartborder/60 last:border-0">
                    <td className="px-3 py-2 font-medium text-ink-primary">{k.name}</td>
                    <td className="px-3 py-2">
                      <code className="text-xs text-ink-secondary">{k.prefix}&hellip;</code>
                    </td>
                    <td className="px-3 py-2">
                      <span className="inline-flex items-center gap-1.5 text-xs text-ink-secondary">
                        <span
                          className="h-1.5 w-1.5 rounded-full"
                          style={{ backgroundColor: k.active ? "var(--status-good)" : "var(--text-muted)" }}
                        />
                        {k.active ? "Active" : "Revoked"}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-ink-secondary">{dateOnly(k.created_at)}</td>
                    <td className="px-3 py-2 text-ink-secondary">{k.last_used_at ? dateOnly(k.last_used_at) : "Never"}</td>
                    <td className="px-3 py-2 text-right">
                      {k.active && (
                        <button
                          type="button"
                          onClick={() => revokeKey.mutate(k.id)}
                          disabled={revokeKey.isPending}
                          className="rounded-md px-2 py-1 text-xs text-ink-muted hover:text-status-critical disabled:opacity-40"
                        >
                          Revoke
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

// ---- Usage ------------------------------------------------------------------------------
function UsageTab() {
  const { data, isLoading, isError, error } = useUsage();

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <StatTile label="Saved views" value={data ? fmtInt(data.saved_views) : "—"} />
        <StatTile label="Watchlist items" value={data ? fmtInt(data.watchlist_items) : "—"} />
        <StatTile label="Active API keys" value={data ? fmtInt(data.api_keys_active) : "—"} />
      </div>
      {isLoading && <Card className="py-6 text-center text-sm text-ink-muted">Loading usage…</Card>}
      {isError && (
        <Card className="py-6 text-center text-sm text-status-serious">
          Failed to load usage{error instanceof Error ? `: ${error.message}` : "."}
        </Card>
      )}
      <Card title="Activity" subtitle="Queries, exports, and chat messages.">
        <EmptyState
          title="Detailed usage analytics — coming soon"
          description={
            data?.note ??
            "Per-query, export, and chat-message tracking is planned but not wired up yet — this panel will chart your activity once it ships."
          }
        />
      </Card>
    </div>
  );
}

export default function Settings() {
  const location = useLocation();
  const tab = tabFromPath(location.pathname);

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h1 className="text-lg font-semibold text-ink-primary">Settings</h1>
        <p className="mt-0.5 text-sm text-ink-muted">Profile, saved views, API keys, and usage for Solo Studio.</p>
      </div>

      <div className="flex flex-wrap items-center gap-1 border-b border-chartborder">
        {TABS.map((t) => (
          <Link
            key={t.id}
            to={t.path}
            className={clsx(
              "-mb-px border-b-2 px-3 py-2 text-xs font-medium transition-colors",
              tab === t.id
                ? "border-brand text-ink-primary"
                : "border-transparent text-ink-muted hover:text-ink-secondary",
            )}
          >
            {t.label}
          </Link>
        ))}
      </div>

      {tab === "profile" && <ProfileTab />}
      {tab === "views" && <SavedViewsTab />}
      {tab === "api-keys" && <ApiKeysTab />}
      {tab === "usage" && <UsageTab />}
    </div>
  );
}

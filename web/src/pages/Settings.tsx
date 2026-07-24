import { type ReactNode } from "react";
import { Link } from "react-router-dom";
import clsx from "clsx";

import { Card } from "../components/ui/Card";
import { EmptyState } from "../components/ui/EmptyState";
import { useDeleteSavedView, useHealth, useSavedViews } from "../lib/api";
import { ACCENTS, PRESETS, useTheme } from "../lib/theme";
import { useTour } from "../lib/tour";

function dateOnly(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleDateString();
}

function PreferenceRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2.5">
      <span className="text-xs font-medium text-ink-secondary">{label}</span>
      {children}
    </div>
  );
}

// Appearance — the only genuinely stateful setting; everything is browser-local (no account).
function AppearanceCard() {
  const { theme, setTheme, accent, setAccent, preset, setPreset } = useTheme();
  return (
    <Card title="Appearance" subtitle="Applies instantly and is saved to this browser — also on the sidebar.">
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
  );
}

// Saved views — still a live feature (the Niche Finder saves filter/sort presets here).
function SavedViewsCard() {
  const { data, isLoading, isError, error } = useSavedViews();
  const deleteView = useDeleteSavedView();

  return (
    <Card title="Saved views" subtitle="Filter and sort presets you've saved on the Niche Finder.">
      {isLoading && <div className="py-6 text-center text-sm text-ink-muted">Loading…</div>}
      {isError && (
        <div className="py-6 text-center text-sm text-status-serious">
          Failed to load saved views{error instanceof Error ? `: ${error.message}` : "."}
        </div>
      )}
      {data && data.length === 0 && (
        <EmptyState
          title="No saved views yet"
          description="Save a filter/sort combination from the Niche Finder to get back to it in one click."
          action={
            <Link to="/niches" className="text-xs font-medium text-series-1 hover:underline">
              Open Niche Finder →
            </Link>
          }
        />
      )}
      {data && data.length > 0 && (
        <div className="overflow-x-auto rounded-card border border-chartborder">
          <table className="w-full min-w-[520px] text-sm">
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

function GettingStartedCard() {
  const { startTour } = useTour();
  return (
    <Card title="Getting started">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-md text-xs text-ink-secondary">
          Replay the guided tour — a spotlight walkthrough across Niche Finder, Benchmarks, Timing, Games, the
          Estimator, and Use in Claude.
        </p>
        <button
          type="button"
          onClick={startTour}
          className="shrink-0 rounded-md border border-brand/40 bg-brand-tint px-3 py-1.5 text-xs font-semibold text-brand transition-colors hover:bg-brand hover:text-white"
        >
          Replay tour →
        </button>
      </div>
    </Card>
  );
}

// About — replaces the old fake Organization/Plan/Profile cards with what actually matters for a
// free, login-less tool: how fresh the data is and where to go next.
function AboutCard() {
  const { data } = useHealth();
  return (
    <Card
      title="About the data"
      subtitle="Prospect reads a nightly snapshot of public, aggregate Steam data — no login, nothing to configure."
    >
      <div className="flex flex-col gap-3">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <div className="text-xs text-ink-muted">Data as of</div>
            <div className="mt-0.5 text-sm font-medium text-ink-primary">
              {data?.built_at ? dateOnly(data.built_at) : "—"}
            </div>
          </div>
          <div>
            <div className="text-xs text-ink-muted">Snapshot version</div>
            <div className="mt-0.5 text-sm font-medium tabular text-ink-primary">{data?.mart_version ?? "—"}</div>
          </div>
        </div>
        <div className="flex flex-wrap gap-x-4 gap-y-1.5 border-t border-chartborder pt-3 text-xs">
          <Link to="/datalog" className="font-medium text-series-1 hover:underline">
            Data log — refresh history →
          </Link>
          <Link to="/chat" className="font-medium text-series-1 hover:underline">
            Use in Claude (MCP) →
          </Link>
          <Link to="/docs" className="font-medium text-series-1 hover:underline">
            Docs →
          </Link>
        </div>
      </div>
    </Card>
  );
}

export default function Settings() {
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-5">
      <div>
        <h1 className="text-lg font-semibold text-ink-primary">Settings</h1>
        <p className="mt-0.5 text-sm text-ink-muted">
          Appearance and workspace preferences. Prospect is free and open — there's no account to manage.
        </p>
      </div>

      <AppearanceCard />
      <SavedViewsCard />
      <GettingStartedCard />
      <AboutCard />
    </div>
  );
}

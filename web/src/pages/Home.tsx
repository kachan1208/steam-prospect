import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";

import { Badge } from "../components/ui/Badge";
import { Card } from "../components/ui/Card";
import { EmptyState } from "../components/ui/EmptyState";
import { request, useWatchlist } from "../lib/api";
import { fmtCompact, fmtInt, fmtPct } from "../lib/format";

// ---- types (mirror the API responses this page reads) -----------------------------------
interface Project {
  id: number;
  appid: number | null;
  name: string;
  genre: string | null;
  stage: string;
  is_active: boolean;
  comps_count: number;
  header_image: string | null;
  steam_name: string | null;
  steam_genre: string | null;
  live_players: number | null;
  total_reviews: number | null;
  positive_ratio: number | null;
}

interface AlertEvent {
  id: number;
  kind: string;
  title: string;
  body: string;
  appid: number | null;
  created_at: string;
  seen: boolean;
}

interface RadarEvent {
  id: string;
  name: string;
  type: string;
  start_date: string;
  submission_deadline: string | null;
  days_until_start: number;
  days_until_deadline: number | null;
  url: string | null;
}

interface RadarResponse {
  today: string;
  upcoming: RadarEvent[];
  recent_past: RadarEvent[];
}

// ---- hooks ------------------------------------------------------------------------------
function useActiveProject() {
  return useQuery({
    queryKey: ["active-project"],
    queryFn: () => request<Project | null>("/projects/active"),
  });
}

function useAlertsFeed() {
  return useQuery({
    queryKey: ["alerts-feed", "home"],
    queryFn: () => request<AlertEvent[]>("/alerts/feed?limit=6"),
  });
}

function useRadar() {
  return useQuery({
    queryKey: ["radar"],
    queryFn: () => request<RadarResponse>("/radar"),
    staleTime: 5 * 60_000,
  });
}

// ---- stage identity ---------------------------------------------------------------------
const STAGE_META: Record<string, { label: string; color: string }> = {
  prototype: { label: "Prototype", color: "var(--series-4)" },
  production: { label: "In production", color: "var(--series-1)" },
  announced: { label: "Announced", color: "var(--series-3)" },
  demo: { label: "Demo out", color: "var(--series-5)" },
  launched: { label: "Launched", color: "var(--status-good)" },
};
function stageMeta(s: string) {
  return STAGE_META[s] ?? { label: s, color: "var(--text-muted)" };
}

const RADAR_TYPE_LABEL: Record<string, string> = {
  next_fest: "Next Fest",
  steam_sale: "Steam Sale",
  festival: "Festival",
  awards: "Awards",
};

// ---- small helpers ----------------------------------------------------------------------
function timeAgo(iso: string): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "";
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return "just now";
  const m = s / 60;
  if (m < 60) return `${Math.floor(m)}m ago`;
  const h = m / 60;
  if (h < 24) return `${Math.floor(h)}h ago`;
  const d = h / 24;
  if (d < 30) return `${Math.floor(d)}d ago`;
  return `${Math.floor(d / 30)}mo ago`;
}

function daysLabel(n: number): string {
  if (n === 0) return "Today";
  if (n === 1) return "Tomorrow";
  if (n < 0) return `${-n}d ago`;
  return `in ${n}d`;
}

/** A metric cell used across the summary cards. */
function Stat({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div>
      <div className="tabular text-lg font-semibold text-ink-primary">{value}</div>
      <div className="text-[11px] uppercase tracking-wide text-ink-muted">{label}</div>
    </div>
  );
}

/** "View all →" link shown in each column card's header. */
function MoreLink({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Link to={to} className="shrink-0 text-xs font-medium text-brand hover:underline">
      {children}
    </Link>
  );
}

// ---- active-project summary -------------------------------------------------------------
function ActiveProjectCard() {
  const { data: project, isLoading, isError } = useActiveProject();

  if (isLoading) {
    return (
      <Card>
        <div className="py-6 text-sm text-ink-muted">Loading your game…</div>
      </Card>
    );
  }

  if (isError || !project) {
    return (
      <Card>
        <EmptyState
          title="Set up your game"
          description="Add your in-development game and its competitors to make this dashboard your command center."
          action={
            <Link
              to="/project"
              className="rounded-lg bg-brand px-3.5 py-2 text-sm font-semibold text-brand-fg transition-colors hover:bg-brand-hover"
            >
              Create your game
            </Link>
          }
        />
      </Card>
    );
  }

  const meta = stageMeta(project.stage);
  const hasSteam = project.appid !== null;

  return (
    <Card className="!p-0 overflow-hidden">
      <div className="flex flex-col gap-4 p-5 sm:flex-row sm:items-center">
        {project.header_image ? (
          <img
            src={project.header_image}
            alt=""
            loading="lazy"
            className="h-20 w-full shrink-0 rounded-lg object-cover sm:w-40"
          />
        ) : (
          <div className="flex h-20 w-full shrink-0 items-center justify-center rounded-lg border border-dashed border-chartborder bg-page text-xs text-ink-muted sm:w-40">
            No store page yet
          </div>
        )}

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-muted">Your game</span>
            <Badge color={meta.color}>{meta.label}</Badge>
          </div>
          <h2 className="mt-1 truncate text-xl font-semibold text-ink-primary">{project.name}</h2>
          <div className="mt-0.5 truncate text-sm text-ink-muted">
            {project.genre ?? project.steam_genre ?? "Genre not set"}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-6 sm:gap-8">
          <Stat label="Competitors" value={fmtInt(project.comps_count)} />
          {hasSteam ? (
            <>
              <Stat label="Live players" value={project.live_players != null ? fmtCompact(project.live_players) : "—"} />
              <Stat label="Reviews" value={fmtCompact(project.total_reviews)} />
              <Stat label="Positive" value={fmtPct(project.positive_ratio)} />
            </>
          ) : (
            <div className="max-w-[200px] text-xs text-ink-muted">
              Link a Steam page on the game to pull live players, reviews and rating here.
            </div>
          )}
        </div>
      </div>

      <div className="flex items-center justify-between border-t border-chartborder bg-page px-5 py-2.5">
        <span className="text-xs text-ink-muted">The stage of your game shapes what this watchtower surfaces.</span>
        <Link to="/project" className="text-xs font-medium text-brand hover:underline">
          Manage game →
        </Link>
      </div>
    </Card>
  );
}

// ---- column: watched games --------------------------------------------------------------
function WatchedCard() {
  const { data, isLoading, isError } = useWatchlist();
  const items = (data ?? []).slice(0, 5);

  return (
    <Card
      title="Watched games"
      action={<MoreLink to="/watchlist">View all</MoreLink>}
    >
      {isLoading && <div className="py-4 text-sm text-ink-muted">Loading…</div>}
      {isError && <div className="py-4 text-sm text-status-serious">Failed to load watchlist.</div>}
      {data && data.length === 0 && (
        <EmptyState
          className="!py-6"
          title="Nothing watched yet"
          description="Track games to see their live players and review velocity at a glance."
          action={
            <Link to="/games" className="text-xs font-medium text-brand hover:underline">
              Find games to watch →
            </Link>
          }
        />
      )}
      {items.length > 0 && (
        <ul className="flex flex-col">
          {items.map((w) => (
            <li key={w.id} className="border-b border-chartborder/60 last:border-0">
              <Link to={`/games/${w.appid}`} className="flex items-center gap-2.5 py-2 hover:opacity-90">
                {w.header_image && (
                  <img src={w.header_image} alt="" loading="lazy" className="h-8 w-14 shrink-0 rounded-sm object-cover" />
                )}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-ink-primary">{w.name ?? `App ${w.appid}`}</span>
                  <span className="block truncate text-[11px] text-ink-muted">{w.primary_genre ?? "—"}</span>
                </span>
                <span className="shrink-0 text-right">
                  <span className="tabular block text-sm text-ink-primary">
                    {w.live_players != null ? fmtCompact(w.live_players) : "—"}
                  </span>
                  <span className="block text-[10px] uppercase tracking-wide text-ink-muted">live</span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

// ---- column: recent alerts --------------------------------------------------------------
function AlertsCard() {
  const { data, isLoading, isError } = useAlertsFeed();
  const items = data ?? [];

  return (
    <Card title="Recent alerts" action={<MoreLink to="/alerts">View all</MoreLink>}>
      {isLoading && <div className="py-4 text-sm text-ink-muted">Loading…</div>}
      {isError && <div className="py-4 text-sm text-status-serious">Failed to load alerts.</div>}
      {data && data.length === 0 && (
        <EmptyState
          className="!py-6"
          title="No alerts yet"
          description="Set up rules to get pinged when a watched game surges or a niche shifts."
          action={
            <Link to="/alerts" className="text-xs font-medium text-brand hover:underline">
              Set up alerts →
            </Link>
          }
        />
      )}
      {items.length > 0 && (
        <ul className="flex flex-col">
          {items.map((e) => {
            const row = (
              <div className="flex items-start gap-2 py-2">
                <span
                  className={
                    "mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full " + (e.seen ? "bg-chartborder" : "bg-brand")
                  }
                />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium text-ink-primary">{e.title}</div>
                  <div className="text-[11px] text-ink-muted">{timeAgo(e.created_at)}</div>
                </div>
              </div>
            );
            return (
              <li key={e.id} className="border-b border-chartborder/60 last:border-0">
                {e.appid ? (
                  <Link to={`/games/${e.appid}`} className="block hover:opacity-90">
                    {row}
                  </Link>
                ) : (
                  <Link to="/alerts" className="block hover:opacity-90">
                    {row}
                  </Link>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

// ---- column: next opportunities ---------------------------------------------------------
function OpportunitiesCard() {
  const { data, isLoading, isError } = useRadar();
  const items = (data?.upcoming ?? []).slice(0, 4);

  return (
    <Card title="Next opportunities" action={<MoreLink to="/radar">View all</MoreLink>}>
      {isLoading && <div className="py-4 text-sm text-ink-muted">Loading…</div>}
      {isError && <div className="py-4 text-sm text-status-serious">Failed to load the radar.</div>}
      {data && items.length === 0 && (
        <EmptyState className="!py-6" title="Nothing on the radar" description="No upcoming events in the calendar right now." />
      )}
      {items.length > 0 && (
        <ul className="flex flex-col">
          {items.map((ev) => {
            const urgent = ev.days_until_start >= 0 && ev.days_until_start < 14;
            const body = (
              <div className="flex items-center gap-2 py-2">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium text-ink-primary">{ev.name}</div>
                  <div className="text-[11px] text-ink-muted">{RADAR_TYPE_LABEL[ev.type] ?? ev.type}</div>
                </div>
                <span
                  className={
                    "tabular shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium " +
                    (urgent ? "border border-status-warning text-status-warning" : "bg-surface2 text-ink-secondary")
                  }
                >
                  {daysLabel(ev.days_until_start)}
                </span>
              </div>
            );
            return (
              <li key={ev.id} className="border-b border-chartborder/60 last:border-0">
                {ev.url ? (
                  <a href={ev.url} target="_blank" rel="noreferrer" className="block hover:opacity-90">
                    {body}
                  </a>
                ) : (
                  <Link to="/radar" className="block hover:opacity-90">
                    {body}
                  </Link>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

// ---- page -------------------------------------------------------------------------------
export default function Home() {
  return (
    <div className="flex flex-col gap-5">
      <div>
        <h1 className="text-lg font-semibold text-ink-primary">Watchtower</h1>
        <p className="mt-0.5 text-sm text-ink-muted">
          Your command center — your game, the competitors you're watching, and the signals and moments that
          matter this week, in one place.
        </p>
      </div>

      <ActiveProjectCard />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <WatchedCard />
        <AlertsCard />
        <OpportunitiesCard />
      </div>
    </div>
  );
}

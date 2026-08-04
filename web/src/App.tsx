import { Link, NavLink, Navigate, Outlet, Route, Routes, useLocation } from "react-router-dom";
import clsx from "clsx";
import { useEffect, type ReactNode } from "react";

import { useHealth } from "./lib/api";
import { initAnalytics, trackPageview } from "./lib/analytics";
import { useTheme, ACCENTS, PRESETS } from "./lib/theme";
import LaunchTiming from "./pages/LaunchTiming";
import GameSearch from "./pages/GameSearch";
import GameProfile from "./pages/GameProfile";
import EntityProfile from "./pages/EntityProfile";
import Chat from "./pages/Chat";
import DataLog from "./pages/DataLog";
import Docs from "./pages/Docs";
import Terms from "./pages/Terms";
import Privacy from "./pages/Privacy";

const ICONS: Record<string, ReactNode> = {
  calendar: (
    <>
      <rect x="3.5" y="5" width="17" height="15.5" rx="2" />
      <line x1="3.5" y1="9.5" x2="20.5" y2="9.5" />
      <line x1="8" y1="3" x2="8" y2="6.5" />
      <line x1="16" y1="3" x2="16" y2="6.5" />
    </>
  ),
  grid: (
    <>
      <rect x="3.5" y="3.5" width="7" height="7" rx="1.5" />
      <rect x="13.5" y="3.5" width="7" height="7" rx="1.5" />
      <rect x="3.5" y="13.5" width="7" height="7" rx="1.5" />
      <rect x="13.5" y="13.5" width="7" height="7" rx="1.5" />
    </>
  ),
  chat: (
    <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5Z" />
  ),
  history: (
    <>
      <path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1" />
      <path d="M3 4.5V9h4.5" />
      <path d="M12 7.8v4.4l2.9 1.7" />
    </>
  ),
};

function Icon({ name }: { name: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-[18px] w-[18px] shrink-0"
    >
      {ICONS[name]}
    </svg>
  );
}

// Four surfaces, deliberately. The two that need pixels (a game's teardown charts, the
// seasonality heatmap), the connector, and the data-freshness receipt. Everything the old
// nav carried — niches, benchmarks, the estimator, marketing pitch lists — is still fully
// answerable, but through the MCP against current.duckdb rather than a page of its own.
const NAV_ITEMS: { to: string; label: string; icon: string }[] = [
  { to: "/games", label: "Games", icon: "grid" },
  { to: "/timing", label: "Launch & Timing", icon: "calendar" },
  { to: "/chat", label: "Use in Claude", icon: "chat" },
  { to: "/datalog", label: "Data log", icon: "history" },
];

function Logo() {
  return (
    <div className="flex h-8 w-8 items-center justify-center rounded-[9px] bg-brand shadow-sm">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.4" strokeLinecap="round">
        <path d="M5 19v-6M12 19V6M19 19v-9" />
      </svg>
    </div>
  );
}

function ThemeToggle() {
  const { theme, toggle } = useTheme();
  return (
    <button
      type="button"
      onClick={toggle}
      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-ink-muted transition-colors hover:bg-surface2 hover:text-ink-primary"
      aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
      title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
    >
      {theme === "dark" ? (
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
        </svg>
      ) : (
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8Z" />
        </svg>
      )}
    </button>
  );
}

function ThemePresetPicker() {
  const { preset, setPreset } = useTheme();
  return (
    <div className="mt-2.5 flex items-center gap-2 px-1">
      <span className="text-[10px] font-semibold uppercase tracking-wider text-ink-muted">Theme</span>
      <div className="flex items-center gap-0.5 rounded-lg bg-surface2 p-0.5">
        {PRESETS.map((pz) => (
          <button
            key={pz.id}
            type="button"
            onClick={() => setPreset(pz.id)}
            className={clsx(
              "rounded-md px-2 py-1 text-[11px] font-medium transition-all",
              preset === pz.id ? "bg-surface text-ink-primary shadow-xs" : "text-ink-muted hover:text-ink-secondary",
            )}
          >
            {pz.name}
          </button>
        ))}
      </div>
    </div>
  );
}

function AccentPicker() {
  const { accent, setAccent } = useTheme();
  return (
    <div className="mt-2.5 flex items-center gap-2 px-1">
      <span className="text-[10px] font-semibold uppercase tracking-wider text-ink-muted">Accent</span>
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
              className="h-4 w-4 rounded-full transition-transform hover:scale-110"
              style={{
                backgroundColor: a.swatch,
                outline: active ? `2px solid ${a.swatch}` : "2px solid transparent",
                outlineOffset: "2px",
              }}
            />
          );
        })}
      </div>
    </div>
  );
}

function HealthRow() {
  const { data, isError, isLoading } = useHealth();
  const ok = !!data && data.status === "ok";
  const color = isLoading ? "var(--text-muted)" : isError || !ok ? "var(--status-critical)" : "var(--status-good)";
  const label = isLoading ? "Checking API…" : isError ? "API unreachable" : ok ? "API connected" : "API degraded";
  const title = data
    ? `${label}${data.mart_version ? ` — mart ${data.mart_version}` : ""}${data.built_at ? ` (built ${data.built_at})` : ""}`
    : label;
  return (
    <div
      className="flex items-center gap-2 rounded-lg bg-surface2 px-2.5 py-1.5 text-[11px] font-medium text-ink-secondary"
      title={title}
    >
      <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: color }} />
      <span className="truncate">{label}</span>
      {data?.mart_version && <span className="ml-auto shrink-0 text-ink-muted">mart {data.mart_version}</span>}
    </div>
  );
}

function Sidebar() {
  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-chartborder bg-surface">
      <Link to="/games" className="flex items-center gap-2.5 px-5 py-[18px]">
        <Logo />
        <div className="leading-tight">
          <div className="text-sm font-semibold tracking-tight text-ink-primary">Prospect</div>
          <div className="text-[11px] text-ink-muted">Steam market intel</div>
        </div>
      </Link>

      <nav className="flex flex-1 flex-col gap-0.5 overflow-y-auto px-3 pb-3">
        {NAV_ITEMS.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            className={({ isActive }) =>
              clsx(
                "flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13px] font-medium transition-colors",
                isActive
                  ? "bg-brand-tint text-brand"
                  : "text-ink-secondary hover:bg-surface2 hover:text-ink-primary",
              )
            }
          >
            <Icon name={item.icon} />
            <span className="truncate min-w-0">{item.label}</span>
          </NavLink>
        ))}
      </nav>

      <div className="border-t border-chartborder p-3">
        <HealthRow />
        <ThemePresetPicker />
        <AccentPicker />
        <div className="mt-2.5 flex items-center justify-between gap-2.5 px-1 py-1">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-ink-muted">Mode</span>
          <ThemeToggle />
        </div>
        <div className="mt-2.5 flex flex-wrap items-center gap-x-2 gap-y-1 px-1 text-[10px] text-ink-muted">
          <Link to="/docs" className="hover:text-ink-secondary">
            Docs
          </Link>
          <span aria-hidden="true">·</span>
          <Link to="/terms" className="hover:text-ink-secondary">
            Terms
          </Link>
          <span aria-hidden="true">·</span>
          <Link to="/privacy" className="hover:text-ink-secondary">
            Privacy
          </Link>
        </div>
      </div>
    </aside>
  );
}

function AppShell() {
  return (
    <div className="flex h-full bg-page">
      <Sidebar />
      <main className="min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[1320px] px-6 py-8 lg:px-10">
          <Outlet />
        </div>
      </main>
    </div>
  );
}

// Emits a page-view event on every client-side route change (the server never sees SPA
// navigations) and wires the flush-on-unload listeners once. Rendered inside the Router.
function RouteTracker() {
  const location = useLocation();
  useEffect(() => {
    initAnalytics();
  }, []);
  useEffect(() => {
    trackPageview(location.pathname);
  }, [location.pathname]);
  return null;
}

export default function App() {
  return (
    <>
      <RouteTracker />
      <Routes>
        <Route path="/" element={<Navigate to="/games" replace />} />
        <Route path="/terms" element={<Terms />} />
        <Route path="/privacy" element={<Privacy />} />
        <Route element={<AppShell />}>
          <Route path="/games" element={<GameSearch />} />
          <Route path="/games/:appid" element={<GameProfile />} />
          {/* Developer/publisher career profiles — reached from game-profile credit links,
              deliberately NOT a sidebar item (the four-surface trim stands). Entity names
              carry slashes/unicode, so the name rides ?name=, not the path. */}
          <Route path="/entity/:role" element={<EntityProfile />} />
          <Route path="/timing" element={<LaunchTiming />} />
          <Route path="/chat" element={<Chat />} />
          <Route path="/datalog" element={<DataLog />} />
          <Route path="/docs" element={<Docs />} />
          <Route path="/docs/:slug" element={<Docs />} />
        </Route>
        {/* Anything else (including the retired /niches, /benchmarks, /estimator,
            /marketing, /press, /devlog, /settings, /welcome) lands on Games. */}
        <Route path="*" element={<Navigate to="/games" replace />} />
      </Routes>
    </>
  );
}

import { Link, NavLink, Outlet, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import clsx from "clsx";
import { useEffect, type ReactNode } from "react";

import { useHealth } from "./lib/api";
import { useTheme, ACCENTS, PRESETS } from "./lib/theme";
import NicheFinder from "./pages/NicheFinder";
import MarketBenchmarks from "./pages/MarketBenchmarks";
import LaunchTiming from "./pages/LaunchTiming";
import Estimator from "./pages/Estimator";
import GameSearch from "./pages/GameSearch";
import GameProfile from "./pages/GameProfile";
import Press from "./pages/Press";
import Marketing from "./pages/Marketing";
import WatchlistPage from "./pages/Watchlist";
import Explorer from "./pages/Explorer";
import Chat from "./pages/Chat";
import Alerts from "./pages/Alerts";
import Outreach from "./pages/Outreach";
import DevLog from "./pages/DevLog";
import Radar from "./pages/Radar";
import Home from "./pages/Home";
import MyGame from "./pages/MyGame";
import DataLog from "./pages/DataLog";
import Landing from "./pages/Landing";
import Onboarding, { ONBOARDING_STORAGE_KEY } from "./pages/Onboarding";
import Settings from "./pages/Settings";
import Docs from "./pages/Docs";
import Terms from "./pages/Terms";
import Privacy from "./pages/Privacy";

const ICONS: Record<string, ReactNode> = {
  compass: (
    <>
      <circle cx="12" cy="12" r="9" />
      <polygon points="15.5 8.5 13.5 13.5 8.5 15.5 10.5 10.5" />
    </>
  ),
  bars: (
    <>
      <line x1="6" y1="20" x2="6" y2="13" />
      <line x1="12" y1="20" x2="12" y2="7" />
      <line x1="18" y1="20" x2="18" y2="11" />
    </>
  ),
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
  calculator: (
    <>
      <rect x="5" y="3" width="14" height="18" rx="2" />
      <line x1="8" y1="7" x2="16" y2="7" />
      <line x1="8" y1="12" x2="16" y2="12" />
      <line x1="8" y1="16" x2="13" y2="16" />
    </>
  ),
  sliders: (
    <>
      <line x1="4" y1="8" x2="20" y2="8" />
      <circle cx="9" cy="8" r="2.3" />
      <line x1="4" y1="16" x2="20" y2="16" />
      <circle cx="15" cy="16" r="2.3" />
    </>
  ),
  megaphone: (
    <>
      <path d="M4 9v6h3l7 4V5L7 9H4Z" />
      <path d="M17.5 8.5a5 5 0 0 1 0 7" />
    </>
  ),
  bookmark: <path d="M6 3.5h12a1 1 0 0 1 1 1V21l-7-4-7 4V4.5a1 1 0 0 1 1-1Z" />,
  chat: (
    <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5Z" />
  ),
  flag: (
    <>
      <path d="M6 21V4" />
      <path d="M6 4h11l-2.5 3.5L17 11H6" />
    </>
  ),
  gear: (
    <>
      <circle cx="12" cy="12" r="3.2" />
      <path d="M12 3.5v2.2M12 18.3v2.2M20.5 12h-2.2M5.7 12H3.5M17.7 6.3l-1.55 1.55M7.85 16.15 6.3 17.7M17.7 17.7l-1.55-1.55M7.85 7.85 6.3 6.3" />
    </>
  ),
  book: (
    <>
      <path d="M4 5.5c0-1 .9-1.8 2-1.8h5.5v15.6H6c-1.1 0-2 .3-2 1.2V5.5Z" />
      <path d="M20 5.5c0-1-.9-1.8-2-1.8h-5.5v15.6H18c1.1 0 2 .3 2 1.2V5.5Z" />
    </>
  ),
  bell: (
    <>
      <path d="M18 8.5a6 6 0 0 0-12 0c0 6.5-2.5 8.5-2.5 8.5h17S18 15 18 8.5" />
      <path d="M13.7 20.5a2 2 0 0 1-3.4 0" />
    </>
  ),
  target: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <circle cx="12" cy="12" r="4.5" />
      <circle cx="12" cy="12" r="1" />
    </>
  ),
  home: (
    <>
      <path d="M3.5 11.5 12 4l8.5 7.5" />
      <path d="M5.5 10v9.5h13V10" />
    </>
  ),
  rocket: (
    <>
      <path d="M12 3.2c2.8 1.6 4.3 4.9 4.3 7.8l-1.8 1.9H9.5L7.7 11C7.7 8.1 9.2 4.8 12 3.2Z" />
      <circle cx="12" cy="9" r="1.4" />
      <path d="M9.7 14.3 8 18M14.3 14.3 16 18" />
    </>
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

const NAV_GROUPS: { label: string; items: { to: string; label: string; icon: string; end?: boolean }[] }[] = [
  {
    label: "Watchtower",
    items: [
      { to: "/home", label: "Home", icon: "home" },
      { to: "/project", label: "My Game", icon: "rocket" },
    ],
  },
  {
    label: "Guide",
    items: [{ to: "/welcome", label: "Getting Started", icon: "flag" }],
  },
  {
    label: "Discover",
    items: [
      { to: "/niches", label: "Niche Finder", icon: "compass" },
      { to: "/benchmarks", label: "Market Benchmarks", icon: "bars" },
      { to: "/timing", label: "Launch & Timing", icon: "calendar" },
      { to: "/radar", label: "Opportunity Radar", icon: "target" },
    ],
  },
  {
    label: "Analyze",
    items: [
      { to: "/games", label: "Games", icon: "grid" },
      { to: "/estimator", label: "Estimator", icon: "calculator" },
      { to: "/explorer", label: "Explorer", icon: "sliders" },
    ],
  },
  {
    label: "Marketing",
    items: [
      { to: "/marketing", label: "Marketing", icon: "megaphone" },
      { to: "/outreach", label: "Outreach", icon: "chat" },
    ],
  },
  {
    label: "Workspace",
    items: [
      { to: "/watchlist", label: "Watchlist", icon: "bookmark" },
      { to: "/alerts", label: "Alerts", icon: "bell" },
      { to: "/devlog", label: "Dev log", icon: "book" },
      { to: "/datalog", label: "Data log", icon: "history" },
      { to: "/chat", label: "Use in Claude", icon: "chat" },
    ],
  },
  {
    label: "Account",
    items: [
      { to: "/settings", label: "Settings", icon: "gear" },
      { to: "/docs", label: "Docs", icon: "book" },
    ],
  },
];

// Pages added in the watchtower build — flagged "New" in the sidebar so they're easy to spot.
const NEW_PATHS = new Set(["/home", "/project", "/alerts", "/devlog", "/outreach", "/radar", "/datalog"]);

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
      <Link to="/niches" className="flex items-center gap-2.5 px-5 py-[18px]">
        <Logo />
        <div className="leading-tight">
          <div className="text-sm font-semibold tracking-tight text-ink-primary">Prospect</div>
          <div className="text-[11px] text-ink-muted">Steam market intel</div>
        </div>
      </Link>

      <nav className="flex-1 overflow-y-auto px-3 pb-3">
        {NAV_GROUPS.map((group) => (
          <div key={group.label} className="mb-5">
            <div className="px-2.5 pb-1.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-muted">
              {group.label}
            </div>
            <div className="flex flex-col gap-0.5">
              {group.items.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  end={item.end}
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
                  {NEW_PATHS.has(item.to) && (
                    <span className="ml-auto shrink-0 rounded-full bg-brand-tint px-1.5 py-[3px] text-[9px] font-semibold uppercase leading-none tracking-[0.06em] text-brand">
                      New
                    </span>
                  )}
                </NavLink>
              ))}
            </div>
          </div>
        ))}
      </nav>

      <div className="border-t border-chartborder p-3">
        <HealthRow />
        <ThemePresetPicker />
        <AccentPicker />
        <div className="mt-2.5 flex items-center gap-2.5 px-1 py-1">
          <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-brand text-[11px] font-semibold text-brand-fg">
            S
          </div>
          <div className="min-w-0 flex-1 leading-tight">
            <div className="truncate text-[12px] font-semibold text-ink-primary">Solo Studio</div>
            <div className="truncate text-[10px] text-ink-muted">Solo plan · unlimited</div>
          </div>
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
  const location = useLocation();
  const navigate = useNavigate();

  // First-run only: a brand-new session landing on the default /niches entry gets sent to
  // the welcome tour once. Onboarding sets ONBOARDING_STORAGE_KEY on every exit action, so
  // this never re-fires and never touches a direct/deep link (only the canonical /niches
  // entry point is redirected).
  useEffect(() => {
    if (location.pathname === "/niches" && !window.localStorage.getItem(ONBOARDING_STORAGE_KEY)) {
      navigate("/welcome", { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Landing />} />
      <Route path="/terms" element={<Terms />} />
      <Route path="/privacy" element={<Privacy />} />
      <Route element={<AppShell />}>
        <Route path="/niches" element={<NicheFinder />} />
        <Route path="/benchmarks" element={<MarketBenchmarks />} />
        <Route path="/timing" element={<LaunchTiming />} />
        <Route path="/estimator" element={<Estimator />} />
        <Route path="/games" element={<GameSearch />} />
        <Route path="/games/:appid" element={<GameProfile />} />
        <Route path="/press" element={<Press />} />
        <Route path="/marketing" element={<Marketing />} />
        <Route path="/home" element={<Home />} />
        <Route path="/project" element={<MyGame />} />
        <Route path="/watchlist" element={<WatchlistPage />} />
        <Route path="/alerts" element={<Alerts />} />
        <Route path="/outreach" element={<Outreach />} />
        <Route path="/devlog" element={<DevLog />} />
        <Route path="/radar" element={<Radar />} />
        <Route path="/explorer" element={<Explorer />} />
        <Route path="/chat" element={<Chat />} />
        <Route path="/datalog" element={<DataLog />} />
        <Route path="/welcome" element={<Onboarding />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="/settings/views" element={<Settings />} />
        <Route path="/settings/api-keys" element={<Settings />} />
        <Route path="/settings/usage" element={<Settings />} />
        <Route path="/docs" element={<Docs />} />
        <Route path="/docs/:slug" element={<Docs />} />
      </Route>
    </Routes>
  );
}

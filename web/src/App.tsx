import { NavLink, Route, Routes } from "react-router-dom";
import clsx from "clsx";

import { useHealth } from "./lib/api";
import { useTheme } from "./lib/theme";
import NicheFinder from "./pages/NicheFinder";
import MarketBenchmarks from "./pages/MarketBenchmarks";
import LaunchTiming from "./pages/LaunchTiming";
import Estimator from "./pages/Estimator";
import GameSearch from "./pages/GameSearch";
import GameProfile from "./pages/GameProfile";
import Press from "./pages/Press";
import WatchlistPage from "./pages/Watchlist";
import Explorer from "./pages/Explorer";

const NAV_ITEMS = [
  { to: "/", label: "Niche Finder", end: true },
  { to: "/benchmarks", label: "Market Benchmarks" },
  { to: "/timing", label: "Launch & Timing" },
  { to: "/estimator", label: "Estimator" },
  { to: "/games", label: "Games" },
  { to: "/press", label: "Press" },
  { to: "/watchlist", label: "Watchlist" },
  { to: "/explorer", label: "Explorer" },
];

function ThemeToggle() {
  const { theme, toggle } = useTheme();
  return (
    <button
      type="button"
      onClick={toggle}
      className="flex h-8 w-8 items-center justify-center rounded-md border border-chartborder text-ink-secondary transition-colors hover:text-ink-primary"
      aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
      title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
    >
      {theme === "dark" ? (
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
        </svg>
      ) : (
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8Z" />
        </svg>
      )}
    </button>
  );
}

function HealthIndicator() {
  const { data, isError, isLoading } = useHealth();
  const ok = !!data && data.status === "ok";
  const color = isLoading ? "var(--text-muted)" : isError || !ok ? "var(--status-critical)" : "var(--status-good)";
  const label = isLoading ? "Checking API…" : isError ? "API unreachable" : ok ? "API connected" : "API degraded";
  const title = data
    ? `${label}${data.mart_version ? ` — mart ${data.mart_version}` : ""}${data.built_at ? ` (built ${data.built_at})` : ""}`
    : label;
  return (
    <div className="flex items-center gap-1.5 text-xs text-ink-muted" title={title}>
      <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: color }} />
      <span className="hidden sm:inline">{label}</span>
    </div>
  );
}

export default function App() {
  return (
    <div className="flex min-h-full flex-col bg-page">
      <header className="border-b border-chartborder bg-surface">
        <div className="mx-auto flex max-w-[1400px] items-center gap-6 px-4 py-3 sm:px-6">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold tracking-tight text-ink-primary">Prospect</span>
            <span className="hidden text-xs text-ink-muted sm:inline">Steam market intelligence</span>
          </div>
          <nav className="flex flex-1 items-center gap-1">
            {NAV_ITEMS.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                className={({ isActive }) =>
                  clsx(
                    "rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                    isActive
                      ? "bg-page text-ink-primary"
                      : "text-ink-secondary hover:bg-page hover:text-ink-primary",
                  )
                }
              >
                {item.label}
              </NavLink>
            ))}
          </nav>
          <HealthIndicator />
          <ThemeToggle />
        </div>
      </header>
      <main className="mx-auto w-full max-w-[1400px] flex-1 px-4 py-6 sm:px-6">
        <Routes>
          <Route path="/" element={<NicheFinder />} />
          <Route path="/benchmarks" element={<MarketBenchmarks />} />
          <Route path="/timing" element={<LaunchTiming />} />
          <Route path="/estimator" element={<Estimator />} />
          <Route path="/games" element={<GameSearch />} />
          <Route path="/games/:appid" element={<GameProfile />} />
          <Route path="/press" element={<Press />} />
          <Route path="/watchlist" element={<WatchlistPage />} />
          <Route path="/explorer" element={<Explorer />} />
        </Routes>
      </main>
    </div>
  );
}

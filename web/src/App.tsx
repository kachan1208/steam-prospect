import { Link, NavLink, Navigate, Outlet, Route, Routes, useLocation } from "react-router-dom";
import clsx from "clsx";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { useHealth } from "./lib/api";
import { initAnalytics, trackPageview } from "./lib/analytics";
import { useTheme, ACCENTS, PRESETS } from "./lib/theme";
import LaunchTiming from "./pages/LaunchTiming";
import NicheFinder from "./pages/NicheFinder";
import GameSearch from "./pages/GameSearch";
import GameProfile from "./pages/GameProfile";
import Compare from "./pages/Compare";
import { CompareTray } from "./components/CompareTray";
import EntityProfile from "./pages/EntityProfile";
import Studios from "./pages/Studios";
import Chat from "./pages/Chat";
import DataLog from "./pages/DataLog";
import Docs from "./pages/Docs";
import Terms from "./pages/Terms";
import Privacy from "./pages/Privacy";

// Six destinations plus one CTA, deliberately. The old 14-page dashboard was trimmed to
// the surfaces that earn their pixels: Niches (the finder came BACK in 2026-08 — the v2
// growth-gated scores, live-player columns and the deep-dive drawer made it chart-heavy
// again), Games (teardown charts), Studios (developer/publisher track records — added by
// user request: publisher scouting needs a discoverable entry point, not a link buried in
// game credits), Timing (the seasonality heatmap), Data (the freshness receipt), and Docs
// in the footer. "MCP" is the primary CTA, not a peer nav item. Everything else the old
// nav carried — benchmarks, the estimator, marketing pitch lists — is still fully
// answerable, but through the MCP against current.duckdb rather than a page of its own.
// 24x24 stroke icons, same family as the Logo mark. grid/calendar/history are the
// originals from the sidebar era; "building" is new for Studios.
const ICONS: Record<string, ReactNode> = {
  target: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <circle cx="12" cy="12" r="4.75" />
      <circle cx="12" cy="12" r="1.25" fill="currentColor" stroke="none" />
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
  building: (
    <>
      <rect x="4.5" y="3.5" width="10" height="17" rx="1.5" />
      <path d="M14.5 9.5h4a1 1 0 0 1 1 1v10" />
      <path d="M3 20.5h18" />
      <path d="M8 7.5h3M8 11h3M8 14.5h3" />
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
  history: (
    <>
      <path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1" />
      <path d="M3 4.5V9h4.5" />
      <path d="M12 7.8v4.4l2.9 1.7" />
    </>
  ),
};

function NavIcon({ name }: { name: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-4 w-4 shrink-0"
    >
      {ICONS[name]}
    </svg>
  );
}

const NAV_ITEMS: { to: string; label: string; icon: string }[] = [
  { to: "/niches", label: "Niches", icon: "target" },
  { to: "/games", label: "Games", icon: "grid" },
  { to: "/studios", label: "Studios", icon: "building" },
  { to: "/timing", label: "Launch & Timing", icon: "calendar" },
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
    <div className="flex items-center justify-between gap-3">
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
    <div className="flex items-center justify-between gap-3">
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

/** The Theme preset + Accent pickers, relocated from the old sidebar footer into a compact
 * header popover. Plain click-outside/Escape close — no positioning or portal deps. */
function AppearancePopover() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative" data-testid="appearance-popover">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="true"
        aria-expanded={open}
        title="Appearance — theme preset and accent color"
        className={clsx(
          "flex h-7 items-center gap-1.5 rounded-md px-2 text-xs font-medium transition-colors",
          open ? "bg-surface2 text-ink-primary" : "text-ink-muted hover:bg-surface2 hover:text-ink-primary",
        )}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <line x1="4" y1="8" x2="20" y2="8" />
          <line x1="4" y1="16" x2="20" y2="16" />
          <circle cx="9" cy="8" r="2.2" fill="var(--surface-1)" />
          <circle cx="15" cy="16" r="2.2" fill="var(--surface-1)" />
        </svg>
        <span className="hidden sm:inline">Appearance</span>
      </button>
      {open && (
        <div className="absolute right-0 top-full z-40 mt-2 flex w-60 flex-col gap-2.5 rounded-card border border-chartborder bg-surface p-3 shadow-md">
          <ThemePresetPicker />
          <AccentPicker />
        </div>
      )}
    </div>
  );
}

function Header() {
  return (
    <header className="sticky top-0 z-30 border-b border-chartborder bg-surface">
      <div className="mx-auto flex w-full max-w-[1320px] flex-wrap items-center gap-x-5 px-6 lg:px-10">
        <Link to="/games" className="flex h-14 items-center gap-2.5">
          <Logo />
          <span className="text-sm font-semibold tracking-tight text-ink-primary">Prospect</span>
          <span className="hidden text-[11px] text-ink-muted lg:inline">Steam market intel</span>
        </Link>

        {/* Below sm the nav wraps to its own row under the logo (order-last + w-full);
            no hamburger/drawer — four links fit fine as a second row. */}
        <nav className="order-last flex w-full items-center gap-1 pb-2.5 sm:order-none sm:w-auto sm:pb-0">
          {NAV_ITEMS.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) =>
                clsx(
                  "flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[13px] font-medium transition-colors",
                  isActive
                    ? "bg-brand-tint text-brand"
                    : "text-ink-secondary hover:bg-surface2 hover:text-ink-primary",
                )
              }
            >
              <NavIcon name={item.icon} />
              {item.label}
            </NavLink>
          ))}
        </nav>

        <div className="ml-auto flex h-14 items-center gap-2">
          <ThemeToggle />
          <AppearancePopover />
          <NavLink
            to="/chat"
            className={({ isActive }) =>
              clsx(
                "rounded-lg bg-brand px-3 py-1.5 text-xs font-semibold text-brand-fg shadow-xs transition-colors hover:bg-brand-hover",
                isActive && "ring-2 ring-brand/30",
              )
            }
          >
            MCP
          </NavLink>
        </div>
      </div>
    </header>
  );
}

/** The data-freshness signal, relocated from the old sidebar into the footer. Hover for
 * the exact mart version + build timestamp — the authoritative "data as of". */
function HealthRow() {
  const { data, isError, isLoading } = useHealth();
  const ok = !!data && data.status === "ok";
  const color = isLoading ? "var(--text-muted)" : isError || !ok ? "var(--status-critical)" : "var(--status-good)";
  const label = isLoading ? "Checking API…" : isError ? "API unreachable" : ok ? "API connected" : "API degraded";
  const title = data
    ? `${label}${data.mart_version ? ` — mart ${data.mart_version}` : ""}${data.built_at ? ` (built ${data.built_at})` : ""}`
    : label;
  return (
    <div className="flex items-center gap-2 text-[11px] text-ink-muted" title={title}>
      <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: color }} />
      <span className="truncate">
        {label}
        {data?.mart_version && <span> · mart {data.mart_version}</span>}
      </span>
    </div>
  );
}

function Footer() {
  return (
    <footer className="border-t border-chartborder bg-surface">
      <div className="mx-auto flex w-full max-w-[1320px] flex-wrap items-center justify-between gap-x-6 gap-y-1.5 px-6 py-3 lg:px-10">
        <HealthRow />
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-ink-muted">
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
    </footer>
  );
}

function AppShell() {
  return (
    <div className="flex min-h-full flex-col bg-page">
      <Header />
      <main className="flex-1">
        <div className="mx-auto w-full max-w-[1320px] px-6 py-8 lg:px-10">
          <Outlet />
        </div>
      </main>
      {/* Compare tray on every page (sticky above the footer; renders nothing when empty). */}
      <CompareTray />
      <Footer />
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
          {/* Niche Finder — resurrected 2026-08 (removed in the four-surfaces trim) now
              that it earns pixels again: v2-gated scores, live-player columns and the
              per-niche deep-dive drawer are chart-heavy, not a table a chat can beat. */}
          <Route path="/niches" element={<NicheFinder />} />
          <Route path="/games" element={<GameSearch />} />
          <Route path="/games/:appid" element={<GameProfile />} />
          {/* Side-by-side comparison — reached from the CompareTray or a shared ?ids= URL,
              deliberately not a nav item. */}
          <Route path="/compare" element={<Compare />} />
          {/* Developer/publisher career profiles — reached from game-profile credit links
              and the Studios browse table. Entity names carry slashes/unicode, so the name
              rides ?name=, not the path. */}
          <Route path="/entity/:role" element={<EntityProfile />} />
          <Route path="/studios" element={<Studios />} />
          <Route path="/timing" element={<LaunchTiming />} />
          <Route path="/chat" element={<Chat />} />
          <Route path="/datalog" element={<DataLog />} />
          <Route path="/docs" element={<Docs />} />
          <Route path="/docs/:slug" element={<Docs />} />
        </Route>
        {/* Anything else (including the retired /benchmarks, /estimator, /marketing,
            /press, /devlog, /settings, /welcome) lands on Games. */}
        <Route path="*" element={<Navigate to="/games" replace />} />
      </Routes>
    </>
  );
}

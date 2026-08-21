import { Link, NavLink, Navigate, Outlet, Route, Routes, useLocation } from "react-router-dom";
import Radar from "./pages/Radar";
import Watchlist from "./pages/Watchlist";
import clsx from "clsx";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { useHealth } from "./lib/api";
import { initAnalytics, trackPageview } from "./lib/analytics";
import { useTheme, ACCENTS, PRESETS } from "./lib/theme";
import LaunchTiming from "./pages/LaunchTiming";
import NicheFinder from "./pages/NicheFinder";
import NicheDetail, { NICHE_ROUTE_PATH } from "./pages/NicheDetail";
import NicheCombined from "./pages/NicheCombined";
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

// Six destinations plus one CTA, deliberately: Radar (the opportunity feed, new home —
// mockup 3a), Niches (the finder came BACK in 2026-08 — the v2 growth-gated scores,
// live-player columns and the deep-dive drawer made it chart-heavy again), Games
// (teardown charts), Studios (developer/publisher track records — added by user request:
// publisher scouting needs a discoverable entry point, not a link buried in game credits),
// Timing (the seasonality heatmap), and Watchlist (saved niches/games + alert rules —
// mockup 4f). Data log and Docs moved to the footer — a freshness receipt and reference
// material aren't destinations you navigate to, and the footer already carries the
// data-health readout next to them. "MCP" is the primary CTA, not a peer nav item.
// Everything else the old nav carried — benchmarks, the estimator, marketing pitch lists —
// is still fully answerable, but through the MCP against current.duckdb rather than a page
// of its own.
// 24x24 stroke icons, same family as the Logo mark. grid/calendar are the originals from
// the sidebar era; building/pulse/eye are new for Studios/Radar/Watchlist.
const ICONS: Record<string, ReactNode> = {
  target: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <circle cx="12" cy="12" r="4.75" />
      <circle cx="12" cy="12" r="1.25" fill="currentColor" stroke="none" />
    </>
  ),
  pulse: <path d="M3 12.5h4.2l1.8-5.5 3.4 11 2.4-8.5 1.6 3h4.6" />,
  eye: (
    <>
      <path d="M2.5 12S6 5.75 12 5.75 21.5 12 21.5 12 18 18.25 12 18.25 2.5 12 2.5 12Z" />
      <circle cx="12" cy="12" r="2.6" />
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
  { to: "/radar", label: "Radar", icon: "pulse" },
  { to: "/niches", label: "Niches", icon: "target" },
  { to: "/games", label: "Games", icon: "grid" },
  { to: "/studios", label: "Studios", icon: "building" },
  { to: "/timing", label: "Timing", icon: "calendar" },
  { to: "/watchlist", label: "Watchlist", icon: "eye" },
];

/** Concentric-circles target mark (ICONS.target) in accent-300 + the PROSPECT wordmark in
 * Barlow Condensed, uppercase — the mockups' brand lockup. No filled swatch behind the
 * mark; blueprint identity draws the logo the same way it draws everything else: hairline
 * strokes on the ground, not a filled chip. */
function Logo() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="shrink-0 text-brand">
      {ICONS.target}
    </svg>
  );
}

function ThemeToggle() {
  const { theme, toggle } = useTheme();
  return (
    <button
      type="button"
      onClick={toggle}
      className="flex h-7 w-7 shrink-0 items-center justify-center text-ink-muted transition-colors hover:bg-surface2 hover:text-ink-primary"
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
      <span className="kicker text-[10px] text-ink-muted">Theme</span>
      <div className="inline-flex border border-chartborder">
        {PRESETS.map((pz, i) => (
          <button
            key={pz.id}
            type="button"
            onClick={() => setPreset(pz.id)}
            className={clsx(
              "px-2 py-1 text-[11px] font-medium transition-colors",
              i > 0 && "border-l border-chartborder",
              preset === pz.id ? "bg-brand text-brand-fg" : "text-ink-muted hover:text-ink-secondary",
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
          "flex h-7 items-center gap-1.5 px-2 text-xs font-medium transition-colors",
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
        <div className="absolute right-0 top-full z-40 mt-2 flex w-60 flex-col gap-2.5 border border-chartborder bg-surface p-3 shadow-md">
          <ThemePresetPicker />
          <AccentPicker />
        </div>
      )}
    </div>
  );
}

function Header() {
  return (
    <header className="sticky top-0 z-30 border-b border-chartborder bg-page">
      <div className="mx-auto flex w-full max-w-[1320px] flex-wrap items-center gap-x-6 px-6 lg:px-10">
        <Link to="/radar" className="flex h-14 items-center gap-2.5">
          <Logo />
          <span className="kicker text-[15px] text-ink-primary">Prospect</span>
        </Link>

        {/* Below sm the nav wraps to its own block under the logo (order-last + w-full);
            no hamburger/drawer — six links wrap onto a second line at narrow widths rather
            than overflowing (flex-wrap; four links fit one row, six need two on a phone).
            Plain text links, no pill background — active carries the accent, inactive
            recedes to muted paper, matching the mockups' `.nav a` rule exactly (color
            only, never a fill). */}
        <nav className="order-last flex w-full flex-wrap items-center gap-x-4 gap-y-1 pb-2.5 sm:order-none sm:w-auto sm:flex-nowrap sm:gap-x-5 sm:pb-0">
          {NAV_ITEMS.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) =>
                clsx(
                  "flex items-center gap-1.5 py-1.5 text-[13px] font-medium transition-colors",
                  isActive ? "text-brand" : "text-ink-secondary hover:text-ink-primary",
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
                "bg-brand px-3.5 py-1.5 text-xs font-semibold text-brand-fg transition-colors hover:bg-brand-hover",
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
    <footer className="border-t border-chartborder bg-page">
      <div className="mx-auto flex w-full max-w-[1320px] flex-wrap items-center justify-between gap-x-6 gap-y-1.5 px-6 py-3 lg:px-10">
        <HealthRow />
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-ink-muted">
          <Link to="/datalog" className="hover:text-ink-secondary">
            Data log
          </Link>
          <span aria-hidden="true">·</span>
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
        {/* Radar is the new index (mockup 3a); /games keeps its own route. */}
        <Route path="/" element={<Navigate to="/radar" replace />} />
        <Route path="/terms" element={<Terms />} />
        <Route path="/privacy" element={<Privacy />} />
        <Route element={<AppShell />}>
          {/* Niche Finder — resurrected 2026-08 (removed in the four-surfaces trim) now
              that it earns pixels again: v2-gated scores, live-player columns and the
              per-niche deep-dive drawer are chart-heavy, not a table a chat can beat. */}
          <Route path="/radar" element={<Radar />} />
          <Route path="/watchlist" element={<Watchlist />} />
          <Route path="/niches" element={<NicheFinder />} />
          {/* Multi-niche overlap — a game carries many tags, so it lives in many niches;
              the selected niches ride the URL (?niches=tag:Roguelike&niches=…&mode=) so a
              combination is shareable. Static segment, so it can't collide with the
              per-niche deep-dive route. */}
          <Route path="/niches/combined" element={<NicheCombined />} />
          {/* Per-niche deep dive — a real page (was a right-hand drawer until 2026-08), so
              the cut, the tab and the distribution bucket selection all ride the URL and a
              filtered view is a link you can send. Niche keys carry spaces and slashes, so
              the :key segment is percent-encoded by nicheDetailPath() and decoded back by
              React Router; the API matches it with a {key:path} converter for the same
              reason. Mirrors /games/:appid, deliberately. */}
          <Route path={NICHE_ROUTE_PATH} element={<NicheDetail />} />
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

import { Link, NavLink, Navigate, Outlet, Route, Routes, useLocation } from "react-router-dom";
import Radar from "./pages/Radar";
import clsx from "clsx";
import { Suspense, lazy, useEffect, type ReactNode } from "react";

import { useHealth } from "./lib/api";
import { initAnalytics, trackPageview } from "./lib/analytics";
import { NICHE_ROUTE_PATH } from "./lib/nichePath";
import { CompareTray } from "./components/CompareTray";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { Loading } from "./components/ui/Loading";
import Terms from "./pages/Terms";
import Privacy from "./pages/Privacy";

/**
 * ROUTE-LEVEL CODE SPLITTING (2026-08-28). Radar — the index route, always the first
 * paint — stays a static import: it is hand-rolled SVG (RadarBoard) with zero recharts.
 * Every other AppShell page is React.lazy, so the entry chunk no longer ships the whole
 * app (most importantly vendor-recharts, ~109KB gz, which only the chart-heavy pages
 * import). ONE Suspense boundary, inside AppShell around the Outlet, carries the
 * fallback — so a hard load into a lazy route still paints the header/footer chrome
 * immediately; and because main.tsx opts the router into `v7_startTransition`, an IN-APP
 * navigation never shows the spinner at all (the location update is a transition, so the
 * old page holds until the chunk arrives). That flag is load-bearing for this comment:
 * without it react-router 6 sets state synchronously and every navigation to a lazy route
 * flashes the fallback. Terms/Privacy render without the shell and are tiny static text,
 * so they stay eager rather than earning a second boundary.
 */
const Watchlist = lazy(() => import("./pages/Watchlist"));
const LaunchTiming = lazy(() => import("./pages/LaunchTiming"));
const NicheFinder = lazy(() => import("./pages/NicheFinder"));
const NicheDetail = lazy(() => import("./pages/NicheDetail"));
const NicheCombined = lazy(() => import("./pages/NicheCombined"));
const GameSearch = lazy(() => import("./pages/GameSearch"));
const GameProfile = lazy(() => import("./pages/GameProfile"));
const Compare = lazy(() => import("./pages/Compare"));
const EntityProfile = lazy(() => import("./pages/EntityProfile"));
const Studios = lazy(() => import("./pages/Studios"));
const Chat = lazy(() => import("./pages/Chat"));
const DataLog = lazy(() => import("./pages/DataLog"));
const Docs = lazy(() => import("./pages/Docs"));

/**
 * THE page container — ONE width for every surface (2026-08-28, user directive: "not all
 * pages have same size"). Header, footer and the routed page outlet all share this exact
 * class, so every page's content edges line up with the chrome and with each other.
 * 1600px is picked for the widest instrument (the radar board + its rail); pages must
 * not add their own competing max-width — a READING page may cap a text column inside
 * (typography), but its outer frame is this container like everyone else's.
 */
export const PAGE_CONTAINER = "mx-auto w-full max-w-[1600px] px-6 lg:px-10";

// Five destinations plus one CTA, deliberately: Radar (the index — the niche instrument),
// Games (teardown charts), Studios (developer/publisher track records — added by user
// request: publisher scouting needs a discoverable entry point, not a link buried in game
// credits), Timing (the seasonality heatmap), and Watchlist (saved niches/games + alert
// rules — mockup 4f). "Niches" LEFT the nav 2026-08-27 (user: "do we need list of niches
// as separate tab then? … It seems odd" — the radar carries the niche population now,
// with a full-pool search): the /niches route and NicheFinder page are fully intact,
// reached through the radar header's "Open Niche Finder →" link and every in-page link —
// a DEMOTION, not a removal, and deliberately reversible by re-adding the entry below.
// Data log and Docs moved to the footer — a freshness receipt and reference material
// aren't destinations you navigate to, and the footer already carries the data-health
// readout next to them. "MCP" is the primary CTA, not a peer nav item. Everything else
// the old nav carried — benchmarks, the estimator, marketing pitch lists — is still
// fully answerable, but through the MCP against current.duckdb rather than a page of
// its own.
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

export const NAV_ITEMS: { to: string; label: string }[] = [
  { to: "/radar", label: "Radar" },
  { to: "/games", label: "Games" },
  { to: "/studios", label: "Studios" },
  { to: "/timing", label: "Timing" },
  { to: "/watchlist", label: "Watchlist" },
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

function Header() {
  return (
    <header className="sticky top-0 z-30 border-b border-chartborder bg-page">
      <div className={clsx(PAGE_CONTAINER, "flex flex-wrap items-center gap-x-6")}>
        <Link to="/radar" className="flex h-14 items-center gap-2.5">
          <Logo />
          <span className="kicker text-[15px] text-ink-primary">Prospect</span>
        </Link>

        {/* Below sm the nav wraps to its own block under the logo (order-last + w-full);
            no hamburger/drawer — the links wrap onto a second line at narrow widths rather
            than overflowing (flex-wrap; four links fit one row, five may need two on a phone).
            Plain text links, no pill background — active carries the accent, inactive
            recedes to muted paper, matching the mockups' `.nav a` rule exactly (color
            only, never a fill). */}
        {/* Right-aligned, per the mockups: the wordmark holds the left edge and the links sit
            beside the MCP button. ml-auto does the pushing so the wrap behaviour below sm is
            unchanged — the items still wrap rather than running off a 390px screen. */}
        <nav className="order-last flex w-full flex-wrap items-center gap-x-4 gap-y-1 pb-2.5 sm:order-none sm:ml-auto sm:w-auto sm:flex-nowrap sm:gap-x-5 sm:pb-0">
          {NAV_ITEMS.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) =>
                clsx(
                  "flex items-center py-1.5 text-[13px] font-medium transition-colors",
                  isActive ? "text-brand" : "text-ink-secondary hover:text-ink-primary",
                )
              }
            >
              {item.label}
            </NavLink>
          ))}
        </nav>

        <div className="flex h-14 items-center gap-2">
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
      <div className={clsx(PAGE_CONTAINER, "flex flex-wrap items-center justify-between gap-x-6 gap-y-1.5 py-3")}>
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
  // The boundary resets when the PATH changes: an error latches until told otherwise, so
  // without this a single bad page would keep showing the fallback after you navigated
  // away. It wraps only the routed content — the header, nav, compare tray and footer
  // stay alive and usable when a page blows up, which is the whole point.
  const { pathname } = useLocation();
  return (
    <div className="flex min-h-full flex-col bg-page">
      <Header />
      <main className="flex-1">
        <div className={clsx(PAGE_CONTAINER, "py-8")}>
          <ErrorBoundary resetKey={pathname}>
            {/* THE Suspense boundary for every lazy route (one, deliberately — see the
                lazy() block above). Inside the shell so the chrome paints first, and
                inside the ErrorBoundary so a chunk that fails to LOAD is caught too. */}
            <Suspense fallback={<Loading className="py-24 text-sm" />}>
              <Outlet />
            </Suspense>
          </ErrorBoundary>
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

// StrictMode mounts effects twice in dev, which double-fired the MOUNT pageview (back-to-
// back effects for the same path, microseconds apart). Module-level dedupe: the same path
// firing again within ~100ms is the double-mount, not a real revisit — a genuine
// navigate-away-and-back always crosses a different path in between.
let lastTracked = { path: "", at: 0 };
function trackPageviewOnce(path: string): void {
  const now = Date.now();
  if (path === lastTracked.path && now - lastTracked.at < 100) return;
  lastTracked = { path, at: now };
  trackPageview(path);
}

function RouteTracker() {
  const location = useLocation();
  useEffect(() => {
    initAnalytics();
  }, []);
  useEffect(() => {
    trackPageviewOnce(location.pathname);
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

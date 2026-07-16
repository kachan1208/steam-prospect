import type { ReactNode } from "react";
import { useNavigate } from "react-router-dom";

import { Card } from "../components/ui/Card";
import { useHealth, useMarketBenchmarks } from "../lib/api";
import { fmtCompact } from "../lib/format";

/** Read by App.tsx's AppShell to decide whether to redirect a brand-new session's default
 * `/niches` landing to this tour once. Every exit action on this page sets it, so the
 * redirect never fires twice and never touches a direct/deep link. */
export const ONBOARDING_STORAGE_KEY = "prospect_onboarded_v1";

function markSeen() {
  try {
    window.localStorage.setItem(ONBOARDING_STORAGE_KEY, "1");
  } catch {
    // Private-browsing / storage-disabled: non-fatal, the tour just may re-offer next visit.
  }
}

// Small local icon set matching the sidebar's stroke-based style (App.tsx's ICONS aren't
// exported, so these are self-contained copies of the same path data for visual parity).
const PATHS: Record<string, ReactNode> = {
  compass: (
    <>
      <circle cx="12" cy="12" r="9" />
      <polygon points="15.5 8.5 13.5 13.5 8.5 15.5 10.5 10.5" />
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
  grid: (
    <>
      <rect x="3.5" y="3.5" width="7" height="7" rx="1.5" />
      <rect x="13.5" y="3.5" width="7" height="7" rx="1.5" />
      <rect x="3.5" y="13.5" width="7" height="7" rx="1.5" />
      <rect x="13.5" y="13.5" width="7" height="7" rx="1.5" />
    </>
  ),
  megaphone: (
    <>
      <path d="M4 9v6h3l7 4V5L7 9H4Z" />
      <path d="M17.5 8.5a5 5 0 0 1 0 7" />
    </>
  ),
};

function SurfaceIcon({ name }: { name: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className="h-[18px] w-[18px] shrink-0">
      {PATHS[name]}
    </svg>
  );
}

interface Surface {
  to: string;
  icon: string;
  title: string;
  description: string;
  cta: string;
}

const SURFACES: Surface[] = [
  {
    to: "/niches",
    icon: "compass",
    title: "Find your niche",
    description: "Rank every Steam tag and genre by opportunity — demand minus competition, plus how beatable the incumbents are.",
    cta: "Open Niche Finder",
  },
  {
    to: "/estimator",
    icon: "calculator",
    title: "Estimate the payoff",
    description: "Turn a review or wishlist count into an owners and revenue range with the Boxleiter method, fitted per genre.",
    cta: "Open Estimator",
  },
  {
    to: "/games",
    icon: "grid",
    title: "Learn why hits win",
    description: "Mine a game's reviews into praise/complaint themes measured against its genre baseline — correlational, honestly labeled.",
    cta: "Open Games",
  },
  {
    to: "/press",
    icon: "megaphone",
    title: "Find your press",
    description: "Rank the outlets and named journalists actually covering your genre, each with a recent example and an active-or-quiet signal.",
    cta: "Open Press",
  },
];

const STEPS = [
  "Open Niche Finder and sort by Opportunity — filter by a minimum review count so you're reading a real sample.",
  "Take a niche's median reviews into the Estimator for an owners/revenue range.",
  "Save the view or add a comparable game to your Watchlist so you can find your way back to it.",
];

function SurfaceCard({ surface, onGo }: { surface: Surface; onGo: (to: string) => void }) {
  return (
    <button
      type="button"
      onClick={() => onGo(surface.to)}
      className="flex flex-col items-start gap-2 rounded-card border border-chartborder bg-surface p-4 text-left shadow-sm transition-all hover:-translate-y-0.5 hover:border-borderstrong hover:shadow-md"
    >
      <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-brand-tint text-brand">
        <SurfaceIcon name={surface.icon} />
      </span>
      <span className="text-sm font-semibold text-ink-primary">{surface.title}</span>
      <span className="text-xs leading-relaxed text-ink-muted">{surface.description}</span>
      <span className="mt-1 text-xs font-medium text-series-1">{surface.cta} →</span>
    </button>
  );
}

export default function Onboarding() {
  const navigate = useNavigate();
  const { data: health } = useHealth();
  const { data: benchmarks } = useMarketBenchmarks();

  function goTo(to: string) {
    markSeen();
    navigate(to);
  }

  return (
    <div className="flex flex-col gap-6">
      <Card className="flex flex-col items-start gap-3 !p-7">
        <span className="rounded-full border border-chartborder bg-page px-2.5 py-1 text-[11px] font-medium uppercase tracking-wide text-ink-muted">
          Welcome
        </span>
        <h1 className="text-2xl font-semibold tracking-tight text-ink-primary">Let's find your next game.</h1>
        <p className="max-w-2xl text-sm leading-relaxed text-ink-secondary">
          Prospect reads all of Steam — the whole catalog, player reviews, and press coverage — and turns it into four
          decisions a solo dev actually has to make: what to build, what it could earn, why the hits win, and who to
          pitch. Every estimate below is a range, never fake precision.
        </p>
        {benchmarks?.computed.n_games_total && (
          <p className="text-xs text-ink-muted">
            Scoring {fmtCompact(benchmarks.computed.n_games_total)} games right now
            {health?.built_at ? ` · data as of ${health.built_at.slice(0, 10)}` : ""}.
          </p>
        )}
        <div className="mt-1 flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => goTo("/niches")}
            className="rounded-md bg-series-1 px-4 py-2 text-sm font-semibold text-white transition-opacity hover:opacity-90"
          >
            Go to Niche Finder →
          </button>
          <button type="button" onClick={() => goTo("/niches")} className="text-xs font-medium text-ink-muted hover:text-ink-primary">
            Skip for now
          </button>
        </div>
      </Card>

      <div>
        <h2 className="mb-3 text-sm font-semibold text-ink-primary">The four surfaces</h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {SURFACES.map((s) => (
            <SurfaceCard key={s.to} surface={s} onGo={goTo} />
          ))}
        </div>
      </div>

      <Card title="A simple first pass" subtitle="Optional — a three-step route through the product if you're not sure where to start.">
        <ol className="flex flex-col gap-2.5">
          {STEPS.map((step, i) => (
            <li key={i} className="flex gap-3 text-sm text-ink-secondary">
              <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-page text-[11px] font-semibold text-ink-secondary">
                {i + 1}
              </span>
              <span className="leading-relaxed">{step}</span>
            </li>
          ))}
        </ol>
      </Card>

      <p className="text-center text-xs text-ink-muted">
        You can reopen this guide any time from Settings → Profile &amp; preferences, or read the longer reference
        guides under Docs.
      </p>
    </div>
  );
}

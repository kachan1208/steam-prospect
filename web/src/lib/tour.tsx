import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useLocation, useNavigate } from "react-router-dom";

import { useGameSearch } from "./api";

/**
 * The interactive, in-context product tour — driver.js/react-joyride style coach marks that
 * dim the page, cut a spotlight around a real element (via `data-tour="..."` anchors sprinkled
 * across the core pages), and walk the visitor across routes step by step. This file owns the
 * step data + the running/navigation state machine; `components/TourOverlay.tsx` owns the
 * actual spotlight/popover rendering.
 */

// ---- persisted state -----------------------------------------------------------------------

/** "Seen" flag — read by App.tsx's AppShell to decide whether a brand-new session's default
 * `/niches` landing should redirect to `/welcome` (the tour launcher) once. Every way of ending
 * the tour (Finish, Skip, Esc) sets this, so the redirect never fires twice and never hijacks a
 * deep link. Kept as the same key the old static slideshow used, so already-onboarded visitors
 * aren't re-prompted. */
export const ONBOARDING_STORAGE_KEY = "prospect_onboarded_v1";
/** Which step is in progress, so a mid-tour page reload resumes instead of restarting. */
const STEP_STORAGE_KEY = "prospect_onboarding_step_v1";

function markSeen() {
  try {
    window.localStorage.setItem(ONBOARDING_STORAGE_KEY, "1");
  } catch {
    /* private browsing: non-fatal, the tour may just re-offer next visit */
  }
}
function hasBeenSeen(): boolean {
  try {
    return !!window.localStorage.getItem(ONBOARDING_STORAGE_KEY);
  } catch {
    return false;
  }
}
function storeStep(i: number) {
  try {
    window.localStorage.setItem(STEP_STORAGE_KEY, String(i));
  } catch {
    /* ignore */
  }
}
function readStep(): number {
  try {
    const n = parseInt(window.localStorage.getItem(STEP_STORAGE_KEY) || "0", 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}
/** True while a tour is genuinely mid-progress (past step 0, not yet finished/skipped) — e.g.
 * right after a page reload. Read by App.tsx's AppShell: the first-run `/niches` -> `/welcome`
 * redirect must NOT fire for this visitor, since `/welcome` unconditionally restarts the tour
 * at step 0 (see pages/Onboarding.tsx) and would clobber the resume-in-place this file's own
 * mount effect already handles. */
export function hasInProgressTourStep(): boolean {
  return readStep() > 0;
}

function clearStep() {
  try {
    window.localStorage.removeItem(STEP_STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

// ---- MCP connect snippet (reused from the old slideshow's Claude step) ----------------------

// The deployed app serves the MCP endpoint from its own origin at /mcp/ — deriving from
// window.location.origin keeps this correct wherever Prospect is hosted.
const MCP_URL = `${window.location.origin}/mcp/`;

function McpConnect() {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(MCP_URL);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked — the text is selectable anyway */
    }
  };
  return (
    <div className="mt-3 flex flex-col gap-2">
      <div className="flex items-stretch gap-2">
        <code className="flex-1 overflow-x-auto whitespace-nowrap rounded-md border border-chartborder bg-page px-3 py-2 text-xs text-ink-primary">
          {MCP_URL}
        </code>
        <button
          type="button"
          onClick={copy}
          className="shrink-0 rounded-md bg-series-1 px-3 py-2 text-[11px] font-semibold text-white transition-opacity hover:opacity-90"
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <p className="text-xs text-ink-muted">
        In Claude Code:{" "}
        <code className="rounded bg-page px-1 py-0.5 text-ink-secondary">
          claude mcp add --transport http prospect {MCP_URL}
        </code>{" "}
        · or add it as a custom connector in claude.ai. Full steps live on the <b>Use in Claude</b> page.
      </p>
    </div>
  );
}

// ---- step data ------------------------------------------------------------------------------

export type TourPlacement = "top" | "bottom" | "left" | "right" | "center";

export interface TourStep {
  id: string;
  /** Route this step lives on. Omit to show a centered step wherever the visitor already is
   * (used only for the welcome step, so starting the tour never yanks them somewhere new). */
  path?: string;
  /** `data-tour="<anchor>"` value of the real element to spotlight. Omit for a centered step. */
  anchor?: string;
  placement?: TourPlacement;
  /** Short section label, e.g. "Niche Finder" — rendered as "<eyebrow> · <n>/<total>". */
  eyebrow: string;
  title: string;
  body: ReactNode;
  /** Let clicks/hover reach the real element under the spotlight (e.g. "click this row").
   * Default is false: the highlighted element is inert until Next, so a step reads as a
   * deliberate stop rather than an accidental trigger. */
  interactive?: boolean;
}

/** A fixed, well-known indie title for the game-profile steps — thematically on-brand (a
 * solo-dev hit) and a good teardown demo. Falls back to appid 1162750 (present in the mart)
 * if this title isn't in the catalog or the lookup hasn't resolved yet. */
const SAMPLE_GAME_QUERY = "Stardew Valley";
const FALLBACK_APPID = 1162750;

function buildSteps(gameAppid: number): TourStep[] {
  return [
    {
      id: "welcome",
      eyebrow: "Welcome",
      title: "Let's find your next game.",
      body: (
        <>
          Prospect reads all of Steam — the whole catalog, player reviews, and press coverage — and turns it into
          the few decisions a solo dev actually has to make: <b>what to build</b>, <b>what it could earn</b>, and{" "}
          <b>why the hits win</b>. Every number is a range, never fake precision.
          <span className="mt-2 block text-[11px] text-ink-muted">About 90 seconds — skip any time.</span>
        </>
      ),
    },
    {
      id: "niches-sort",
      path: "/niches",
      anchor: "tour-niches-opportunity-sort",
      placement: "bottom",
      eyebrow: "Niche Finder",
      title: "Sort by Opportunity",
      body: "Opportunity blends demand, competition, and quality gap into one score per tag or genre. Sort by it first to see the best-looking gaps rise to the top.",
    },
    {
      id: "niches-min-reviews",
      path: "/niches",
      anchor: "tour-niches-min-reviews",
      placement: "bottom",
      eyebrow: "Niche Finder",
      title: "Filter out tiny samples",
      body: "A niche with a handful of games can look great by pure luck. Raise the minimum review count so every row you're comparing has a real sample behind it.",
    },
    {
      id: "niches-bars",
      path: "/niches",
      anchor: "tour-niches-bars-row0",
      placement: "top",
      eyebrow: "Niche Finder",
      title: "Demand vs. competition vs. quality gap",
      body: "Each row breaks its score into three bars: how much demand exists, how crowded it already is, and how beatable the incumbents look on quality.",
    },
    {
      id: "niches-row",
      path: "/niches",
      anchor: "tour-niches-row0-key",
      placement: "right",
      interactive: true,
      eyebrow: "Niche Finder",
      title: "Open a niche for the full picture",
      body: "Click any niche to open its drawer — saturation trend, revenue histogram, and the games actually ranking there. Try it, then come back to Next.",
    },
    {
      id: "benchmarks",
      path: "/benchmarks",
      anchor: "tour-benchmarks-distribution",
      placement: "top",
      eyebrow: "Market Benchmarks",
      title: "Where the market actually lands",
      body: "This long-tail chart plots every game's revenue (or reviews, or owners) with median and percentile markers — a gut-check for whether a niche's numbers are typical or an outlier.",
    },
    {
      id: "timing",
      path: "/timing",
      anchor: "tour-timing-launch-shape",
      placement: "bottom",
      eyebrow: "Launch & Timing",
      title: "Front-loaded or slow-burn?",
      body: "Tall bars on the left mean a genre's sales cluster right at launch — bet on the splash. Flatter bars mean demand keeps building all year, so sustained marketing pays off instead.",
    },
    {
      id: "games-search",
      path: "/games",
      anchor: "tour-games-search",
      placement: "bottom",
      eyebrow: "Games",
      title: "Look up any title",
      body: "Search by name, genre, or exact tag to profile a specific game or competitor — owners, revenue, rating, and review velocity, all in one place.",
    },
    {
      id: "gameprofile-stats",
      path: `/games/${gameAppid}`,
      anchor: "tour-gameprofile-stats",
      placement: "bottom",
      interactive: true,
      eyebrow: "Game profile",
      title: "Click a stat for its history",
      body: "These aren't just numbers — click any card (revenue, owners, reviews, live players) to open its time-series underneath and see how it got there. Try one.",
    },
    {
      id: "gameprofile-why",
      path: `/games/${gameAppid}`,
      anchor: "tour-gameprofile-why-tab",
      placement: "bottom",
      eyebrow: "Game profile",
      title: "See why it works",
      body: "The “Why it works” tab mines review text for praise and complaints per aspect against the genre baseline, plus the game's press footprint — evidence, not a promise. Open it any time you're profiling a title.",
    },
    {
      id: "estimator",
      path: "/estimator",
      anchor: "tour-estimator-range",
      placement: "top",
      eyebrow: "Estimator",
      title: "Ranges, not fake precision",
      body: "Tweak review count (or wishlists), price, and genre on the left. The Estimator always comes back as an owners and revenue range — using the Boxleiter method fit per genre — never a single misleading number.",
    },
    {
      id: "chat",
      path: "/chat",
      anchor: "tour-chat-mcp",
      placement: "bottom",
      eyebrow: "Use in Claude",
      title: "Ask Prospect from your own Claude",
      body: (
        <>
          Connect this MCP server to Claude Code, Desktop, or claude.ai and just ask — grounded in the same data, no
          copy-paste.
          <McpConnect />
          <span className="mt-3 block text-[11px] text-ink-muted">
            That&apos;s the loop: find a gap → size it → learn from the winners → check the timing. Reopen this tour
            any time from Settings or the sidebar&apos;s Getting Started.
          </span>
        </>
      ),
    },
  ];
}

// ---- context / provider ----------------------------------------------------------------------

interface TourContextValue {
  running: boolean;
  stepIndex: number;
  steps: TourStep[];
  step: TourStep;
  isFirst: boolean;
  isLast: boolean;
  startTour: () => void;
  next: () => void;
  prev: () => void;
  goTo: (i: number) => void;
  endTour: () => void;
}

const TourContext = createContext<TourContextValue | null>(null);

export function useTour(): TourContextValue {
  const ctx = useContext(TourContext);
  if (!ctx) throw new Error("useTour must be used within TourProvider");
  return ctx;
}

export function TourProvider({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const location = useLocation();

  // Cheap, always-on lookup so the game-profile steps have a concrete appid ready well before
  // anyone reaches step 9 — existing hook, no new endpoint. Falls back to a known-good appid
  // if the title isn't in this catalog or the request hasn't resolved yet.
  const sampleGameQ = useGameSearch({
    q: SAMPLE_GAME_QUERY,
    sort: "total_reviews",
    order: "desc",
    limit: 1,
    offset: 0,
  });
  const resolvedAppid = sampleGameQ.data?.items?.[0]?.appid ?? FALLBACK_APPID;

  const [running, setRunning] = useState(false);
  const [stepIndex, setStepIndex] = useState(0);

  // Reactive to resolvedAppid rather than frozen at tour-start: the lookup can still be in
  // flight the instant a brand-new visitor's tour auto-starts (startTour() fires from /welcome's
  // mount effect, essentially racing the network). The route-navigation effect below only
  // depends on [running, stepIndex] — never `steps` — so a late resolution here can't yank
  // someone already on the game-profile steps to a different appid; it just means whichever
  // value is current by the time they actually navigate to step 9 gets used, which in practice
  // is always the resolved one (the query settles in well under the time it takes to click
  // through 8 prior steps, and nothing ever invalidates/refetches it after that).
  const steps = useMemo(() => buildSteps(resolvedAppid), [resolvedAppid]);

  // Resume an in-progress tour after a hard page reload (only if the visitor was genuinely
  // mid-tour — i.e. past step 0 and not yet marked "seen"). A brand-new visitor at step 0 is
  // handled by AppShell's /niches -> /welcome redirect + the /welcome launcher instead, so this
  // doesn't double-fire the very first time someone shows up.
  useEffect(() => {
    const stored = readStep();
    if (!hasBeenSeen() && stored > 0) {
      setStepIndex(Math.min(stored, steps.length - 1));
      setRunning(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep the persisted step in sync while a tour is running, so the effect above can resume it.
  useEffect(() => {
    if (running) storeStep(stepIndex);
  }, [running, stepIndex]);

  // Navigate to whatever route the active step needs. Deliberately keyed on [running, stepIndex]
  // only (not `steps`) — `steps` can change identity when the sample-game lookup resolves, and
  // re-running this on that alone would yank the visitor to a different game mid-step.
  useEffect(() => {
    if (!running) return;
    const target = steps[stepIndex]?.path;
    if (target && target !== location.pathname) navigate(target);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running, stepIndex]);

  const startTour = useCallback(() => {
    clearStep();
    setStepIndex(0);
    setRunning(true);
  }, []);

  const endTour = useCallback(() => {
    setRunning(false);
    markSeen();
    clearStep();
  }, []);

  const goTo = useCallback(
    (i: number) => {
      setStepIndex((cur) => {
        const clamped = Math.max(0, Math.min(steps.length - 1, i));
        return clamped === cur ? cur : clamped;
      });
    },
    [steps.length],
  );

  const next = useCallback(() => {
    setStepIndex((i) => Math.min(steps.length - 1, i + 1));
  }, [steps.length]);

  const prev = useCallback(() => {
    setStepIndex((i) => Math.max(0, i - 1));
  }, []);

  const stepIndexClamped = Math.min(stepIndex, steps.length - 1);

  const value = useMemo<TourContextValue>(
    () => ({
      running,
      stepIndex: stepIndexClamped,
      steps,
      step: steps[stepIndexClamped],
      isFirst: stepIndexClamped === 0,
      isLast: stepIndexClamped === steps.length - 1,
      startTour,
      next,
      prev,
      goTo,
      endTour,
    }),
    [running, stepIndexClamped, steps, startTour, next, prev, goTo, endTour],
  );

  // <TourOverlay /> (components/TourOverlay.tsx) is mounted alongside this provider in App.tsx
  // rather than imported here, so lib/tour.tsx (state) and components/TourOverlay.tsx
  // (rendering) don't form a circular import — TourOverlay reads everything it needs via
  // useTour().
  return <TourContext.Provider value={value}>{children}</TourContext.Provider>;
}

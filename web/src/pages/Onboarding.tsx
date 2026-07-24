import { useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";

import { Card } from "../components/ui/Card";
import { useHealth, useMarketBenchmarks } from "../lib/api";
import { fmtCompact } from "../lib/format";

/** Read by App.tsx's AppShell to decide whether to redirect a brand-new session's default
 * `/niches` landing to this tour once. Every exit action here sets it, so the redirect never
 * fires twice and never hijacks a deep link. */
export const ONBOARDING_STORAGE_KEY = "prospect_onboarded_v1";
/** Which step the visitor is on — so leaving via "Try it" and coming back resumes the tour. */
const STEP_KEY = "prospect_onboarding_step_v1";

function markSeen() {
  try {
    window.localStorage.setItem(ONBOARDING_STORAGE_KEY, "1");
  } catch {
    /* private browsing: non-fatal, the tour may just re-offer next visit */
  }
}
function storeStep(i: number) {
  try {
    window.localStorage.setItem(STEP_KEY, String(i));
  } catch {
    /* ignore */
  }
}
function readStep(): number {
  try {
    const n = parseInt(window.localStorage.getItem(STEP_KEY) || "0", 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}
function clearStep() {
  try {
    window.localStorage.removeItem(STEP_KEY);
  } catch {
    /* ignore */
  }
}

// Stroke-based icons matching the sidebar (App.tsx's ICONS aren't exported).
const PATHS: Record<string, ReactNode> = {
  spark: (
    <>
      <path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M18 6l-2.5 2.5M8.5 15.5 6 18" />
    </>
  ),
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
  plug: (
    <>
      <path d="M9 3v5M15 3v5" />
      <path d="M6 8h12v3a6 6 0 0 1-12 0V8Z" />
      <path d="M12 17v4" />
    </>
  ),
  check: <path d="M20 6 9 17l-5-5" />,
};

function StepIcon({ name }: { name: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-5 w-5 shrink-0"
    >
      {PATHS[name]}
    </svg>
  );
}

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
        In Claude Code: <code className="rounded bg-page px-1 py-0.5 text-ink-secondary">claude mcp add --transport http prospect {MCP_URL}</code>
        {" "}· or add it as a custom connector in claude.ai. Full steps live on the <b>Use in Claude</b> page.
      </p>
    </div>
  );
}

interface Step {
  icon: string;
  eyebrow: string;
  title: string;
  body: ReactNode;
  to?: string;
  cta?: string;
}

export default function Onboarding() {
  const navigate = useNavigate();
  const { data: health } = useHealth();
  const { data: benchmarks } = useMarketBenchmarks();
  const [step, setStep] = useState<number>(() => readStep());

  const total = benchmarks?.computed.n_games_total;
  const asOf = health?.built_at?.slice(0, 10);

  const STEPS: Step[] = [
    {
      icon: "spark",
      eyebrow: "Welcome",
      title: "Let's find your next game.",
      body: (
        <>
          Prospect reads all of Steam — the whole catalog, player reviews, and press coverage — and turns it into the
          few decisions a solo dev actually has to make: <b>what to build</b>, <b>what it could earn</b>, and{" "}
          <b>why the hits win</b>. Every number is a range, never fake precision.
          {total ? (
            <span className="mt-2 block text-xs text-ink-muted">
              Scoring {fmtCompact(total)} games{asOf ? ` · data as of ${asOf}` : ""}. This 60-second tour is optional —
              skip any time.
            </span>
          ) : null}
        </>
      ),
    },
    {
      icon: "compass",
      eyebrow: "Step 1 · Find a gap",
      title: "Rank every niche by opportunity",
      body: (
        <>
          The <b>Niche Finder</b> scores every Steam tag and genre by <i>demand − competition</i>, plus how beatable the
          incumbents are. Sort by Opportunity and set a minimum review count so you're reading a real sample, not noise.
        </>
      ),
      to: "/niches",
      cta: "Try the Niche Finder",
    },
    {
      icon: "calculator",
      eyebrow: "Step 2 · Size the payoff",
      title: "Turn reviews into a revenue range",
      body: (
        <>
          Take a niche's median review count into the <b>Estimator</b>. It converts reviews (or wishlists) into an
          owners and revenue <i>range</i> using the Boxleiter method, fitted per genre — so you know if the upside is
          worth it before you build.
        </>
      ),
      to: "/estimator",
      cta: "Try the Estimator",
    },
    {
      icon: "grid",
      eyebrow: "Step 3 · Learn from hits",
      title: "See why the winners win",
      body: (
        <>
          Open any game in <b>Games</b> for a teardown: its review themes (praise vs. complaints) measured against the
          genre baseline, plus its press footprint. Correlational and honestly labeled — evidence, not a promise.
        </>
      ),
      to: "/games",
      cta: "Try a game teardown",
    },
    {
      icon: "plug",
      eyebrow: "Step 4 · Take it with you",
      title: "Ask Prospect inside your own Claude",
      body: (
        <>
          Connect Prospect's analytics as an <b>MCP server</b> to your own Claude (Code, Desktop, or claude.ai) and just
          ask — “what's an under-served co-op niche under 500 reviews?” — grounded in the same data, no copy-paste.
          <McpConnect />
        </>
      ),
    },
    {
      icon: "check",
      eyebrow: "You're set",
      title: "That's the loop.",
      body: (
        <>
          Find a gap → size it → learn from the winners → take it to your Claude. Everything's read-only and free — poke
          around. You can reopen this tour any time from <b>Settings</b>, or read the deeper <b>Docs</b>.
        </>
      ),
    },
  ];

  const isLast = step === STEPS.length - 1;
  const cur = STEPS[step];

  function go(next: number) {
    const clamped = Math.max(0, Math.min(STEPS.length - 1, next));
    setStep(clamped);
    storeStep(clamped);
  }
  function tryIt(to: string) {
    markSeen(); // prevents the /niches → /welcome redirect from looping us back
    storeStep(step + 1); // resume on the next step when they return via "Getting Started"
    navigate(to);
  }
  function finish() {
    markSeen();
    clearStep();
    navigate("/niches");
  }

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-5 py-2">
      {/* progress */}
      <div className="flex items-center gap-3">
        <div className="flex flex-1 items-center gap-1.5">
          {STEPS.map((s, i) => (
            <button
              key={i}
              type="button"
              aria-label={`Go to step ${i + 1}: ${s.title}`}
              onClick={() => go(i)}
              className={`h-1.5 flex-1 rounded-full transition-colors ${
                i < step ? "bg-brand" : i === step ? "bg-brand" : "bg-surface2"
              } ${i <= step ? "opacity-100" : "opacity-60 hover:opacity-100"}`}
            />
          ))}
        </div>
        <span className="shrink-0 text-[11px] font-medium tabular-nums text-ink-muted">
          {step + 1} / {STEPS.length}
        </span>
        <button type="button" onClick={finish} className="shrink-0 text-[11px] font-medium text-ink-muted hover:text-ink-primary">
          Skip
        </button>
      </div>

      <Card className="flex flex-col gap-4 !p-7">
        <div className="flex items-center gap-3">
          <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-brand-tint text-brand">
            <StepIcon name={cur.icon} />
          </span>
          <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-muted">{cur.eyebrow}</span>
        </div>
        <h1 className="text-xl font-semibold tracking-tight text-ink-primary">{cur.title}</h1>
        <div className="text-sm leading-relaxed text-ink-secondary">{cur.body}</div>

        {cur.to && (
          <button
            type="button"
            onClick={() => tryIt(cur.to!)}
            className="mt-1 inline-flex w-fit items-center gap-1.5 rounded-md border border-brand/40 bg-brand-tint px-3.5 py-2 text-sm font-semibold text-brand transition-colors hover:bg-brand hover:text-white"
          >
            {cur.cta} →
          </button>
        )}
      </Card>

      {/* footer nav */}
      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={() => go(step - 1)}
          disabled={step === 0}
          className="rounded-md px-3 py-2 text-sm font-medium text-ink-muted transition-colors hover:text-ink-primary disabled:invisible"
        >
          ← Back
        </button>
        {isLast ? (
          <button
            type="button"
            onClick={finish}
            className="rounded-md bg-series-1 px-4 py-2 text-sm font-semibold text-white transition-opacity hover:opacity-90"
          >
            Start exploring →
          </button>
        ) : (
          <button
            type="button"
            onClick={() => go(step + 1)}
            className="rounded-md bg-series-1 px-4 py-2 text-sm font-semibold text-white transition-opacity hover:opacity-90"
          >
            Next →
          </button>
        )}
      </div>
    </div>
  );
}

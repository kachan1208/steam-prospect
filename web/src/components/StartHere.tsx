import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import clsx from "clsx";

/**
 * "Start here" — the three-step path through the app for a first visit (2026-09-22 UX
 * review: a new user lands on a dense radar with no idea what order to read things in).
 * Exported for the Radar page to place; it renders nothing once dismissed.
 *
 *   1. find a niche on the Radar
 *   2. read its "Read this first" flags and its games
 *   3. check the competitors and the launch timing
 *
 * Dismissal persists in localStorage (versioned key, so a rewritten guide can come back
 * once); every storage access is try/catch-wrapped — private mode, a sandboxed frame or a
 * full quota must not break the page, they just mean the strip reappears next visit.
 */
export const START_HERE_STORAGE_KEY = "prospect.startHere.dismissed.v1";

function readDismissed(): boolean {
  try {
    return window.localStorage.getItem(START_HERE_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function writeDismissed(): void {
  try {
    window.localStorage.setItem(START_HERE_STORAGE_KEY, "1");
  } catch {
    // Remembered for this page's life only (component state below).
  }
}

const LINK = "font-medium text-brand transition-colors hover:text-brand-hover";

const STEPS: { title: string; body: ReactNode }[] = [
  {
    title: "Find a niche on the Radar",
    body: (
      <>
        The inner rings are the strongest “build here” reads. Click a dot for its verdict and the numbers behind
        it — or rank every niche in the{" "}
        <Link to="/niches" className={LINK}>
          Niche Finder
        </Link>
        .
      </>
    ),
  },
  {
    title: "Read its “Read this first” and its games",
    body: (
      <>
        Open the niche: the flags that argue AGAINST it come first, then the games that actually sell there and what
        they earn.
      </>
    ),
  },
  {
    title: "Check competitors and launch timing",
    body: (
      <>
        Tear down the closest{" "}
        <Link to="/games" className={LINK}>
          competing games
        </Link>
        , then pick a window on{" "}
        <Link to="/timing" className={LINK}>
          Launch timing
        </Link>
        .
      </>
    ),
  },
];

export function StartHere({ className, onDismiss }: { className?: string; onDismiss?: () => void }) {
  const [dismissed, setDismissed] = useState(readDismissed);
  if (dismissed) return null;

  return (
    <section
      aria-labelledby="start-here-title"
      data-testid="start-here"
      className={clsx("border border-chartborder px-4 py-3", className)}
    >
      <div className="mb-2 flex items-center justify-between gap-3">
        <h2 id="start-here-title" className="kicker text-[12px] text-brand">
          Start here
        </h2>
        <div className="flex items-center gap-3 text-[12px]">
          <Link to="/docs" className={LINK}>
            Read the guide →
          </Link>
          <button
            type="button"
            aria-label="Dismiss the Start here guide"
            onClick={() => {
              writeDismissed();
              setDismissed(true);
              onDismiss?.();
            }}
            className="border border-borderstrong px-2 py-0.5 text-[11px] font-medium text-ink-secondary transition-colors hover:text-ink-primary"
          >
            Dismiss
          </button>
        </div>
      </div>
      <ol className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {STEPS.map((s, i) => (
          <li key={s.title} className="flex gap-2.5">
            <span
              aria-hidden
              className="kicker flex h-5 w-5 shrink-0 items-center justify-center border border-borderstrong text-[11px] text-ink-primary"
            >
              {i + 1}
            </span>
            <div className="min-w-0">
              <div className="text-[13px] font-semibold text-ink-primary">{s.title}</div>
              <p className="mt-0.5 text-[12px] leading-relaxed text-ink-secondary">{s.body}</p>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

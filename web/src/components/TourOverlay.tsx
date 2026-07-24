import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { useTour, type TourPlacement, type TourStep } from "../lib/tour";

/**
 * Renders the running tour's dim scrim + spotlight hole + anchored popover, portaled to
 * document.body. Pure presentation — all state/navigation lives in lib/tour.tsx's TourProvider.
 * Returns null whenever no tour is running, so mounting this unconditionally (from
 * TourProvider) is cheap.
 */

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

const HOLE_PAD = 8;
const HOLE_RADIUS = 12;
const POPOVER_WIDTH = 340;
const GAP = 14;
const MARGIN = 16;
const POLL_INTERVAL_MS = 150;
const POLL_TIMEOUT_MS = 4000;

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}

function padRect(r: DOMRect, pad: number): Rect {
  return { x: r.left - pad, y: r.top - pad, width: r.width + pad * 2, height: r.height + pad * 2 };
}

/** Full-viewport rect path (clockwise). */
function outerPath(w: number, h: number): string {
  return `M0,0 H${w} V${h} H0 Z`;
}

/** Rounded-rect path, radius clamped to half the shorter side so small targets don't pinch. */
function roundedRectPath(rect: Rect, radius: number): string {
  const r = Math.max(0, Math.min(radius, rect.width / 2, rect.height / 2));
  const { x, y, width: w, height: h } = rect;
  if (r === 0) return `M${x},${y} H${x + w} V${y + h} H${x} Z`;
  return [
    `M${x + r},${y}`,
    `H${x + w - r}`,
    `A${r},${r} 0 0 1 ${x + w},${y + r}`,
    `V${y + h - r}`,
    `A${r},${r} 0 0 1 ${x + w - r},${y + h}`,
    `H${x + r}`,
    `A${r},${r} 0 0 1 ${x},${y + h - r}`,
    `V${y + r}`,
    `A${r},${r} 0 0 1 ${x + r},${y}`,
    "Z",
  ].join(" ");
}

type TargetStatus = "pending" | "found" | "missing";

/** Locates the current step's `[data-tour]` anchor, polling for up to POLL_TIMEOUT_MS since
 * targets can load async (TanStack Query). Scrolls it into view once found, then keeps the
 * rect in sync on scroll (capture-phase, so it also catches the scrollable <main>, not just
 * window) and resize. Falls back to "missing" (centered popover, no spotlight) rather than
 * ever leaving the visitor stuck on a step that can't resolve. */
function useTourTarget(
  anchor: string | undefined,
  key: string,
  active: boolean,
): { rect: Rect | null; status: TargetStatus } {
  const [state, setState] = useState<{ rect: Rect | null; status: TargetStatus }>({
    rect: null,
    status: anchor ? "pending" : "found",
  });

  useEffect(() => {
    if (!active) return;
    if (!anchor) {
      setState({ rect: null, status: "found" });
      return;
    }
    setState({ rect: null, status: "pending" });

    let cancelled = false;
    let el: Element | null = null;
    let rafId: number | null = null;
    let pollId: number | null = null;
    let settleIds: number[] = [];

    function computeAndSet() {
      if (!el || !el.isConnected) return;
      setState({ rect: padRect(el.getBoundingClientRect(), HOLE_PAD), status: "found" });
    }

    function scheduleUpdate() {
      if (rafId !== null) return;
      rafId = requestAnimationFrame(() => {
        rafId = null;
        if (!cancelled) computeAndSet();
      });
    }

    function onScrollOrResize() {
      scheduleUpdate();
    }

    function tryFind(elapsed: number) {
      if (cancelled) return;
      const found = document.querySelector(`[data-tour="${anchor}"]`);
      if (found) {
        el = found;
        found.scrollIntoView({
          behavior: prefersReducedMotion() ? "auto" : "smooth",
          block: "center",
          inline: "nearest",
        });
        computeAndSet();
        window.addEventListener("scroll", onScrollOrResize, true);
        window.addEventListener("resize", onScrollOrResize);
        // A couple of follow-up reads catch the smooth-scroll animation settling.
        settleIds.push(window.setTimeout(scheduleUpdate, 260));
        settleIds.push(window.setTimeout(scheduleUpdate, 520));
        return;
      }
      if (elapsed >= POLL_TIMEOUT_MS) {
        setState({ rect: null, status: "missing" });
        return;
      }
      pollId = window.setTimeout(() => tryFind(elapsed + POLL_INTERVAL_MS), POLL_INTERVAL_MS);
    }

    tryFind(0);

    return () => {
      cancelled = true;
      if (pollId !== null) window.clearTimeout(pollId);
      if (rafId !== null) cancelAnimationFrame(rafId);
      settleIds.forEach((id) => window.clearTimeout(id));
      window.removeEventListener("scroll", onScrollOrResize, true);
      window.removeEventListener("resize", onScrollOrResize);
    };
  }, [anchor, key, active]);

  return state;
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(Math.max(n, min), max);
}

/** Where to put the popover for a hole + desired placement — flips to the opposite side if it
 * would overflow, then clamps fully inside the viewport with a margin. */
function computePopoverPosition(
  hole: Rect | null,
  placement: TourPlacement,
  size: { width: number; height: number },
  viewport: { width: number; height: number },
): { top: number; left: number } {
  const { width: pw, height: ph } = size;
  if (!hole || placement === "center") {
    return {
      top: clamp((viewport.height - ph) / 2, MARGIN, Math.max(MARGIN, viewport.height - ph - MARGIN)),
      left: clamp((viewport.width - pw) / 2, MARGIN, Math.max(MARGIN, viewport.width - pw - MARGIN)),
    };
  }

  const fitsBottom = hole.y + hole.height + GAP + ph <= viewport.height - MARGIN;
  const fitsTop = hole.y - GAP - ph >= MARGIN;
  const fitsRight = hole.x + hole.width + GAP + pw <= viewport.width - MARGIN;
  const fitsLeft = hole.x - GAP - pw >= MARGIN;

  let actual = placement;
  if (actual === "bottom" && !fitsBottom && fitsTop) actual = "top";
  else if (actual === "top" && !fitsTop && fitsBottom) actual = "bottom";
  else if (actual === "right" && !fitsRight && fitsLeft) actual = "left";
  else if (actual === "left" && !fitsLeft && fitsRight) actual = "right";

  let top: number;
  let left: number;
  if (actual === "top") {
    top = hole.y - GAP - ph;
    left = hole.x + hole.width / 2 - pw / 2;
  } else if (actual === "left") {
    top = hole.y + hole.height / 2 - ph / 2;
    left = hole.x - GAP - pw;
  } else if (actual === "right") {
    top = hole.y + hole.height / 2 - ph / 2;
    left = hole.x + hole.width + GAP;
  } else {
    top = hole.y + hole.height + GAP;
    left = hole.x + hole.width / 2 - pw / 2;
  }

  return {
    top: clamp(top, MARGIN, Math.max(MARGIN, viewport.height - ph - MARGIN)),
    left: clamp(left, MARGIN, Math.max(MARGIN, viewport.width - pw - MARGIN)),
  };
}

function useViewportSize() {
  const [size, setSize] = useState({ width: window.innerWidth, height: window.innerHeight });
  useEffect(() => {
    function onResize() {
      setSize({ width: window.innerWidth, height: window.innerHeight });
    }
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return size;
}

function TourPopover({
  hole,
  placement,
  step,
  index,
  total,
  isFirst,
  isLast,
  onNext,
  onPrev,
  onSkip,
}: {
  hole: Rect | null;
  placement: TourPlacement;
  step: TourStep;
  index: number;
  total: number;
  isFirst: boolean;
  isLast: boolean;
  onNext: () => void;
  onPrev: () => void;
  onSkip: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const viewport = useViewportSize();
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  useLayoutEffect(() => {
    const size = {
      width: ref.current?.offsetWidth || POPOVER_WIDTH,
      height: ref.current?.offsetHeight || 200,
    };
    setPos(computePopoverPosition(hole, placement, size, viewport));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hole?.x, hole?.y, hole?.width, hole?.height, placement, viewport.width, viewport.height, step.id]);

  useEffect(() => {
    ref.current?.focus({ preventScroll: true });
  }, [step.id]);

  const reduced = prefersReducedMotion();

  return (
    <div
      ref={ref}
      role="dialog"
      aria-label={`${step.eyebrow}: ${step.title}`}
      aria-live="polite"
      tabIndex={-1}
      style={{
        position: "fixed",
        top: pos?.top ?? viewport.height / 2,
        left: pos?.left ?? viewport.width / 2,
        width: POPOVER_WIDTH,
        visibility: pos ? "visible" : "hidden",
        transition: reduced ? undefined : "top 180ms ease, left 180ms ease",
      }}
      className="pointer-events-auto flex max-w-[calc(100vw-32px)] flex-col gap-3 rounded-card border border-chartborder bg-surface p-5 shadow-lg outline-none"
    >
      <div className="flex items-center justify-between gap-3">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-brand">
          {step.eyebrow} · {index + 1}/{total}
        </span>
        <button
          type="button"
          onClick={onSkip}
          aria-label="Skip tour"
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-ink-muted hover:bg-page hover:text-ink-primary"
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
      </div>

      <div className="h-1 w-full overflow-hidden rounded-full bg-surface2">
        <div
          className="h-full rounded-full bg-brand transition-[width] duration-300"
          style={{ width: `${((index + 1) / total) * 100}%` }}
        />
      </div>

      <div>
        <h2 className="text-sm font-semibold text-ink-primary">{step.title}</h2>
        <div className="mt-1.5 text-xs leading-relaxed text-ink-secondary">{step.body}</div>
      </div>

      <div className="mt-1 flex items-center justify-between">
        <button
          type="button"
          onClick={onPrev}
          disabled={isFirst}
          className="rounded-md px-2.5 py-1.5 text-xs font-medium text-ink-muted transition-colors hover:text-ink-primary disabled:invisible"
        >
          ← Back
        </button>
        <div className="flex items-center gap-2">
          <button type="button" onClick={onSkip} className="text-xs font-medium text-ink-muted hover:text-ink-primary">
            Skip
          </button>
          <button
            type="button"
            onClick={onNext}
            className="rounded-md bg-series-1 px-3.5 py-1.5 text-xs font-semibold text-white transition-opacity hover:opacity-90"
          >
            {isLast ? "Finish" : "Next →"}
          </button>
        </div>
      </div>
    </div>
  );
}

export function TourOverlay() {
  const { running, step, stepIndex, steps, next, prev, endTour, isFirst, isLast } = useTour();
  const { rect: hole, status } = useTourTarget(step.anchor, step.id, running);
  const viewport = useViewportSize();

  useEffect(() => {
    if (!running) return;
    function onKeyDown(e: KeyboardEvent) {
      // An interactive step can open a real app modal/drawer on top of the tour (e.g. clicking
      // a niche row opens NicheDetailDrawer). That owns Escape/focus while it's up — TourPopover
      // deliberately never sets aria-modal, so a real one is how we tell them apart. Without this
      // guard, Esc-to-close-the-drawer would also end the tour out from under the visitor.
      if (document.querySelector('[aria-modal="true"]')) return;
      const tag = (e.target as HTMLElement | null)?.tagName;
      const inField = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
      if (e.key === "Escape") {
        e.preventDefault();
        endTour();
        return;
      }
      if (inField) return; // don't hijack typing during an interactive step
      if (e.key === "ArrowRight" || e.key === "Enter") {
        e.preventDefault();
        if (isLast) endTour();
        else next();
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        if (!isFirst) prev();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [running, next, prev, endTour, isFirst, isLast]);

  if (!running) return null;

  const showSpotlight = !!step.anchor && status === "found" && !!hole;
  const placement: TourPlacement = showSpotlight ? step.placement ?? "bottom" : "center";
  // Constant, theme-agnostic dim — a "dimming" scrim reads correctly over both a light and a
  // dark page, so this deliberately isn't wired to the surface/page CSS vars.
  const scrimFill = "rgba(10, 11, 14, 0.62)";

  return createPortal(
    <div className="pointer-events-none fixed inset-0 z-40">
      {/* The <svg> root itself is left non-interactive (inherits pointer-events:none from the
          wrapping div) — an SVG root with pointer-events:auto claims its whole rectangular box
          for hit-testing regardless of what its children paint, which would defeat the evenodd
          cutout below. Each *path* sets its own pointer-events instead, and those correctly
          respect fill-rule/fill for hit-testing since they're not the root. */}
      <svg className="absolute inset-0 h-full w-full" width={viewport.width} height={viewport.height}>
        <path
          d={showSpotlight ? `${outerPath(viewport.width, viewport.height)} ${roundedRectPath(hole!, HOLE_RADIUS)}` : outerPath(viewport.width, viewport.height)}
          fillRule="evenodd"
          fill={scrimFill}
          style={{ pointerEvents: "auto" }}
        />
        {showSpotlight && (
          <>
            {/* Blocks clicks on the target unless the step opts into pass-through. */}
            <path d={roundedRectPath(hole!, HOLE_RADIUS)} fill="transparent" style={{ pointerEvents: step.interactive ? "none" : "auto" }} />
            {/* Decorative ring around the hole — never intercepts clicks. */}
            <path
              d={roundedRectPath(hole!, HOLE_RADIUS)}
              fill="none"
              stroke="var(--brand)"
              strokeWidth={2}
              style={{ pointerEvents: "none" }}
            />
          </>
        )}
      </svg>

      <TourPopover
        hole={showSpotlight ? hole : null}
        placement={placement}
        step={step}
        index={stepIndex}
        total={steps.length}
        isFirst={isFirst}
        isLast={isLast}
        onNext={() => (isLast ? endTour() : next())}
        onPrev={prev}
        onSkip={endTour}
      />
    </div>,
    document.body,
  );
}

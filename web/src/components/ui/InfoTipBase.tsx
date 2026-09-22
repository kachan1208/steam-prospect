import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type FocusEvent,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import clsx from "clsx";

/**
 * THE ⓘ — one accessible, in-place explanation for every metric (2026-09-22).
 *
 * Before this, explanations were native `title=` tooltips: hover-only, never shown on
 * keyboard focus or on a tap, invisible to screen readers on most elements, clipped by
 * nothing but also findable by nobody (StatTile drew a decorative ⓘ that was aria-hidden
 * and did nothing when pressed). This is a real <button>:
 *
 *   - opens on mouse HOVER (after a short intent delay), on keyboard FOCUS, and on a
 *     CLICK / TAP — a click or tap PINS it open, so a phone user can read it;
 *   - closes on Esc (without moving focus), on blur, on a press outside it, on a second
 *     click, and when the pointer leaves both the trigger and the panel (the panel itself
 *     is hoverable, per WCAG 1.4.13, so the pointer can travel into it);
 *   - wires `aria-expanded` and, while open, `aria-describedby` → the role="tooltip" panel;
 *   - renders the panel in a PORTAL with `position: fixed`, placed by computeTipPosition()
 *     to stay inside the viewport (flips above when there's no room below, clamps to an
 *     8px margin, caps its width at min(20rem, 100vw − 16px) — so it fits a 390px phone),
 *     which is also what lets it work inside table headers and cells: `overflow-x: auto`
 *     scrollers (TableScroll) cannot clip a portal;
 *   - never shifts layout: the trigger is always rendered (a fixed 14px box whose hit
 *     area is widened to 24px by an absolutely-positioned ::after), and the panel is out
 *     of flow;
 *   - swallows its own clicks and Enter/Space, so it can sit inside a clickable tile, a
 *     sortable header or a linked row without triggering them.
 *
 * CONTENT follows the owner's rule for metrics: the plain label, what it MEANS, the exact
 * FORMULA, the row's own numbers WORKED through it ("(176 − 190) ÷ 190 = −7.4%"), a
 * visible SENTINEL note when the value is floored / clamped / missing, and the SOURCE.
 *
 * This file is the glossary-FREE core, so the app shell (DataAge, in the entry chunk) can
 * use it without shipping lib/glossary.ts on first paint. Pages use <InfoTip term="…">
 * from ./InfoTip, which resolves the glossary and renders this.
 */

export interface InfoTipContent {
  /** Plain-language name — the panel's heading. */
  label: string;
  /** What the number means. */
  meaning: ReactNode;
  /** The exact computation. */
  formula?: ReactNode;
  /** THIS row's real numbers substituted into the formula, e.g. "(176 − 190) ÷ 190 = −7.4%". */
  worked?: ReactNode;
  /** Why the value on screen is a sentinel, e.g. "floored to 0 — see note". Shown flagged. */
  sentinel?: ReactNode;
  /** Where the data comes from. */
  source?: ReactNode;
  /** Caveats. */
  notes?: ReactNode;
}

export interface InfoTipBaseProps extends Partial<InfoTipContent> {
  /** Accessible name of the trigger. Default "About <label>". */
  ariaLabel?: string;
  /** Heading for the `worked` block. Default "With these numbers". */
  workedLabel?: string;
  /** Extra classes on the trigger button. */
  className?: string;
  /** Extra content appended to the panel (after notes, before source). */
  children?: ReactNode;
}

/** Hover-intent delay before opening, and grace period before closing (ms). */
export const INFOTIP_OPEN_DELAY = 120;
export const INFOTIP_CLOSE_DELAY = 150;
/** Minimum distance the panel keeps from every viewport edge, and from its trigger (px). */
export const TIP_MARGIN = 8;
export const TIP_GAP = 6;

export interface TipRect {
  top: number;
  left: number;
  bottom: number;
  width: number;
  height: number;
}
export interface TipSize {
  width: number;
  height: number;
}
export interface TipPosition {
  top: number;
  left: number;
  /** The room on the chosen side; the panel scrolls inside it when taller. */
  maxHeight: number;
  placement: "bottom" | "top";
}

/**
 * Where to put a panel of `tip` size next to `anchor` so it stays inside `viewport`.
 * Pure (no DOM) so the rule is unit-testable at any width: centred on the trigger, clamped
 * to TIP_MARGIN from both sides, below the trigger unless it doesn't fit there and there is
 * more room above, and never taller than the room on the side it lands on.
 */
export function computeTipPosition(anchor: TipRect, tip: TipSize, viewport: TipSize): TipPosition {
  const width = Math.min(tip.width, Math.max(0, viewport.width - 2 * TIP_MARGIN));
  const centred = anchor.left + anchor.width / 2 - width / 2;
  const left = Math.max(TIP_MARGIN, Math.min(centred, viewport.width - TIP_MARGIN - width));
  const below = viewport.height - anchor.bottom - TIP_GAP - TIP_MARGIN;
  const above = anchor.top - TIP_GAP - TIP_MARGIN;
  const placeBelow = tip.height <= below || below >= above;
  const room = Math.max(0, placeBelow ? below : above);
  const height = Math.min(tip.height, room);
  return {
    top: placeBelow ? anchor.bottom + TIP_GAP : anchor.top - TIP_GAP - height,
    left,
    maxHeight: room,
    placement: placeBelow ? "bottom" : "top",
  };
}

function isMousePointer(e: PointerEvent): boolean {
  // jsdom and some older engines leave pointerType empty; treat that as a mouse.
  return !e.pointerType || e.pointerType === "mouse";
}

/** The trigger + panel. Renders nothing without a label and a meaning. */
export function InfoTipBase({
  label,
  meaning,
  formula,
  worked,
  sentinel,
  source,
  notes,
  ariaLabel,
  workedLabel = "With these numbers",
  className,
  children,
}: InfoTipBaseProps) {
  const content: InfoTipContent | null =
    label && meaning != null ? { label, meaning, formula, worked, sentinel, source, notes } : null;

  const id = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [pos, setPos] = useState<TipPosition | null>(null);
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // A press (mouse/touch) focuses the button BEFORE its click fires; the click decides
  // what happens, so that focus must not open the panel first (or the click would close it).
  const pressing = useRef(false);

  const clearTimers = useCallback(() => {
    if (openTimer.current) clearTimeout(openTimer.current);
    if (closeTimer.current) clearTimeout(closeTimer.current);
    openTimer.current = null;
    closeTimer.current = null;
  }, []);

  const show = useCallback(() => {
    clearTimers();
    setOpen(true);
  }, [clearTimers]);

  const hide = useCallback(() => {
    clearTimers();
    setOpen(false);
    setPinned(false);
    setPos(null);
  }, [clearTimers]);

  useEffect(() => clearTimers, [clearTimers]);

  const place = useCallback(() => {
    const trigger = triggerRef.current;
    const panel = panelRef.current;
    if (!trigger || !panel) return;
    const t = trigger.getBoundingClientRect();
    const p = panel.getBoundingClientRect();
    const next = computeTipPosition(
      { top: t.top, left: t.left, bottom: t.bottom, width: t.width, height: t.height },
      { width: p.width, height: p.height },
      { width: window.innerWidth, height: window.innerHeight },
    );
    // Only commit a MOVE — this runs after every render while open, and an unconditional
    // set would re-render forever.
    setPos((cur) =>
      cur &&
      cur.top === next.top &&
      cur.left === next.left &&
      cur.maxHeight === next.maxHeight &&
      cur.placement === next.placement
        ? cur
        : next,
    );
  }, []);

  // Measure and place before paint, so the panel never flashes at the wrong spot — after
  // EVERY render while open, since new `worked` numbers can change the panel's size.
  useLayoutEffect(() => {
    if (open) place();
  });

  useEffect(() => {
    if (!open) return;
    let frame = 0;
    const onMove = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        // A panel pointing at a trigger that scrolled out of view explains nothing.
        const t = triggerRef.current?.getBoundingClientRect();
        if (t && (t.bottom < 0 || t.top > window.innerHeight || t.right < 0 || t.left > window.innerWidth)) {
          hide();
          return;
        }
        place();
      });
    };
    const onPointerDown = (e: Event) => {
      const target = e.target as Node | null;
      if (target && (triggerRef.current?.contains(target) || panelRef.current?.contains(target))) return;
      hide();
    };
    const onKeyDown = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Esc closes the innermost layer only: a sheet or dialog behind this panel must not
      // close on the same keypress.
      e.stopPropagation();
      hide();
    };
    window.addEventListener("scroll", onMove, true);
    window.addEventListener("resize", onMove);
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("scroll", onMove, true);
      window.removeEventListener("resize", onMove);
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [open, place, hide]);

  if (!content) return null;

  function onPointerEnter(e: PointerEvent) {
    if (!isMousePointer(e)) return;
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = null;
    if (!open && !openTimer.current) openTimer.current = setTimeout(show, INFOTIP_OPEN_DELAY);
  }

  function onPointerLeave(e: PointerEvent) {
    if (!isMousePointer(e)) return;
    if (openTimer.current) clearTimeout(openTimer.current);
    openTimer.current = null;
    if (open && !pinned) closeTimer.current = setTimeout(hide, INFOTIP_CLOSE_DELAY);
  }

  function onClick(e: MouseEvent) {
    // Inside a clickable tile, a sortable header or a linked row: the ⓘ is its own control.
    e.preventDefault();
    e.stopPropagation();
    pressing.current = false;
    if (open && pinned) {
      hide();
    } else {
      show();
      setPinned(true);
    }
  }

  function onFocus() {
    if (pressing.current) return; // the click that follows decides
    show();
  }

  function onBlur(e: FocusEvent) {
    pressing.current = false;
    const next = e.relatedTarget as Node | null;
    if (next && (panelRef.current?.contains(next) || triggerRef.current?.contains(next))) return;
    hide();
  }

  function onKeyDown(e: KeyboardEvent) {
    // Enter/Space activate THIS button (the browser turns them into its click); they must
    // not also reach a parent's key handler (an interactive tile, a row).
    if (e.key === "Enter" || e.key === " ") e.stopPropagation();
  }

  const panelStyle: CSSProperties = {
    top: pos?.top ?? 0,
    left: pos?.left ?? 0,
    maxHeight: pos?.maxHeight,
    maxWidth: "min(20rem, calc(100vw - 16px))",
    visibility: pos ? "visible" : "hidden",
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-label={ariaLabel ?? `About ${content.label}`}
        aria-expanded={open}
        aria-describedby={open ? id : undefined}
        data-infotip=""
        data-state={open ? "open" : "closed"}
        onPointerEnter={onPointerEnter}
        onPointerLeave={onPointerLeave}
        onPointerDown={() => {
          pressing.current = true;
        }}
        onPointerCancel={() => {
          // A touch that turned into a scroll never clicks; don't let it swallow the next
          // keyboard focus.
          pressing.current = false;
        }}
        onClick={onClick}
        onFocus={onFocus}
        onBlur={onBlur}
        onKeyDown={onKeyDown}
        className={clsx(
          "relative inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center align-middle normal-case tracking-normal transition-colors",
          "after:absolute after:-inset-[5px] after:content-['']",
          open ? "text-ink-primary" : "text-ink-muted hover:text-ink-primary",
          className,
        )}
      >
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" aria-hidden="true">
          <circle cx="8" cy="8" r="6.75" strokeWidth="1.25" />
          <path d="M8 7.25v4.25" strokeWidth="1.5" strokeLinecap="round" />
          <circle cx="8" cy="4.75" r="0.95" fill="currentColor" stroke="none" />
        </svg>
      </button>
      {open &&
        createPortal(
          <div
            ref={panelRef}
            id={id}
            role="tooltip"
            tabIndex={-1}
            data-placement={pos?.placement}
            onPointerEnter={onPointerEnter}
            onPointerLeave={onPointerLeave}
            onBlur={onBlur}
            // React bubbles portal events through the COMPONENT tree: without these a press
            // inside the panel would reach the tile / row / header the ⓘ sits in.
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
            className="fixed z-[60] w-max overflow-y-auto border border-borderstrong bg-surface2 px-3 py-2.5 text-left text-[12px] font-normal normal-case leading-relaxed tracking-normal text-ink-secondary outline-none"
            style={panelStyle}
          >
            <InfoTipBody content={content} workedLabel={workedLabel}>
              {children}
            </InfoTipBody>
          </div>,
          document.body,
        )}
    </>
  );
}

/** The panel's content, exported so a page can render the same explanation inline (e.g. an
 * expanded row) without a trigger. */
export function InfoTipBody({
  content,
  workedLabel = "With these numbers",
  children,
}: {
  content: InfoTipContent;
  workedLabel?: string;
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="kicker text-[11px] text-ink-primary">{content.label}</div>
      {content.meaning !== "" && <div>{content.meaning}</div>}
      {content.formula != null && (
        <div>
          <div className="kicker text-[10px] text-ink-muted">Formula</div>
          <div className="tabular text-ink-primary">{content.formula}</div>
        </div>
      )}
      {content.worked != null && (
        <div>
          <div className="kicker text-[10px] text-ink-muted">{workedLabel}</div>
          <div className="tabular text-ink-primary">{content.worked}</div>
        </div>
      )}
      {content.sentinel != null && (
        <div className="border-l-2 pl-2 text-ink-primary" style={{ borderColor: "var(--status-warning)" }}>
          <span className="kicker mr-1 text-[10px] text-ink-muted">Flagged value</span>
          {content.sentinel}
        </div>
      )}
      {content.notes != null && <div className="text-ink-muted">{content.notes}</div>}
      {children}
      {content.source != null && <div className="text-[11px] text-ink-muted">Source: {content.source}</div>}
    </div>
  );
}

import { useCallback, useEffect, useRef, useState, type HTMLAttributes, type ReactNode } from "react";
import clsx from "clsx";

/** Which side still has content the reader can't see. `null` = the table fits. */
export type HiddenSide = "left" | "right" | "both";

/**
 * THE shared horizontal scroller for the wide data tables and grids (B1).
 *
 * Every one of them used to be a bare `overflow-x-auto` div, and below ~1100px that
 * quietly amputates the page: macOS/iOS overlay scrollbars stay invisible until touched,
 * so the clipped column ends at a crisp card edge and reads as "that's all there is".
 * Measured on production 2026-09-01: /studios @390 hides 799px of a 1139px row — 70%, i.e.
 * Years, Active, Total est. revenue, P90, Hit rate and Top genres are ALL off-screen on a
 * page whose entire pitch is "track records" — /niches @390 hides 520px of 860 (60%), the
 * /games/:id comparables table @390 hides 346px of 640, /niches/combined 380px, /entity/*
 * 355px, /niches/tag/* 300px, and /studios still hides 197px at 1024. Nothing on screen
 * hinted any of it existed.
 *
 * This is the same silent cap the radar rail already fixed on the vertical axis, where
 * "a clipped list read as 'the list ends at #22'" (.rail-scroll in index.css, paired with
 * a bottom fade). Generalised here to the inline axis so it is fixed in ONE place rather
 * than re-patched per page: a permanent thin scrollbar plus an edge fade.
 *
 * Both cues are conditional on real overflow — `data-hidden` is only set when something is
 * actually clipped, so every one of these tables at 1440 renders exactly as it did before.
 */
export function TableScroll({
  children,
  className,
  ...rest
}: {
  children: ReactNode;
  className?: string;
} & Omit<HTMLAttributes<HTMLDivElement>, "children" | "className">) {
  const ref = useRef<HTMLDivElement>(null);
  const [hidden, setHidden] = useState<HiddenSide | null>(null);

  const measure = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    // 1px of slack: sub-pixel column widths leave scrollWidth a fraction over clientWidth
    // on tables that genuinely fit, and a fade on a complete table is a lie.
    const left = el.scrollLeft > 1;
    const right = el.scrollWidth - el.clientWidth - el.scrollLeft > 1;
    setHidden(left && right ? "both" : right ? "right" : left ? "left" : null);
  }, []);

  // After every render: rows/columns change without the viewport ever resizing (sort,
  // filter, "More metrics", a new page of results), and each of those changes what's
  // hidden. Two cheap layout reads; setHidden to the same value doesn't re-render.
  useEffect(measure);

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    // Observe the viewport AND the content: a breakpoint change resizes the first, a
    // wider table resizes the second, and either one alone misses half the cases.
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    if (el.firstElementChild) ro.observe(el.firstElementChild);
    return () => ro.disconnect();
  }, [measure]);

  return (
    <div
      {...rest}
      ref={ref}
      onScroll={measure}
      data-hidden={hidden ?? undefined}
      className={clsx("table-scroll", className)}
    >
      {children}
    </div>
  );
}

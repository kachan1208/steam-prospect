import type { ReactNode } from "react";
import clsx from "clsx";

export function Card({
  children,
  className,
  title,
  subtitle,
  action,
  blueprint,
  accentBorder,
}: {
  children: ReactNode;
  className?: string;
  title?: ReactNode;
  subtitle?: ReactNode;
  action?: ReactNode;
  /**
   * Opt into the "blueprint" frame treatment (design_handoff_prospect_dark_ui): four
   * 11x11px "+" registration marks overhanging the corners by 6px, via the foundation's
   * `.blueprint`/`.bp-corner` classes (index.css — consumed here, not redefined). Those
   * marks are pseudo-elements of the OUTER box and must not be clipped, so turning this on
   * splits Card into an outer border-only frame plus an inner box that carries `className`
   * (padding, background, an `overflow-hidden` for a scrolling table, ...) — clipping the
   * inner never eats the marks. Off by default: every existing call site renders
   * byte-for-byte as before. Corners are always square here regardless of the active
   * preset — the "+" marks only read correctly against a right-angle corner.
   */
  blueprint?: boolean;
  /** Only meaningful with `blueprint` — the emphasized-frame variant (mockups 4c
   * "Estimates" sidebar, 4f watchlist alert banner): border goes accent, corner marks stay
   * muted paper exactly as in the mockups (only the border is re-tinted). */
  accentBorder?: boolean;
}) {
  const body = (
    <>
      {(title || action) && (
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            {title && <h3 className="text-sm font-semibold text-ink-primary">{title}</h3>}
            {subtitle && <p className="mt-1 text-xs leading-relaxed text-ink-muted">{subtitle}</p>}
          </div>
          {action}
        </div>
      )}
      {children}
    </>
  );

  if (blueprint) {
    return (
      <div className="blueprint" style={accentBorder ? { borderColor: "var(--brand)" } : undefined}>
        <i className="bp-corner" />
        <div className={clsx("rounded-none bg-surface shadow-sm p-5", className)}>{body}</div>
      </div>
    );
  }

  return (
    <div className={clsx("rounded-card border border-chartborder bg-surface shadow-sm p-5", className)}>
      {body}
    </div>
  );
}

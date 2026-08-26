import type { ReactNode } from "react";
import clsx from "clsx";

export function Card({
  children,
  className,
  title,
  subtitle,
  action,
}: {
  children: ReactNode;
  className?: string;
  title?: ReactNode;
  subtitle?: ReactNode;
  action?: ReactNode;
}) {
  const body = (
    <>
      {(title || action) && (
        /* flex-wrap + a title minimum: a wide `action` (e.g. NotableCoverageCard's tone
           chip) drops to its own line at phone widths instead of squeezing the title
           column to one word per line — flex only wraps once an item can't shrink, and
           without the min-width the title always could. */
        <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-[14rem] max-w-full flex-1">
            {title && <h3 className="text-sm font-semibold text-ink-primary">{title}</h3>}
            {subtitle && <p className="mt-1 text-xs leading-relaxed text-ink-muted">{subtitle}</p>}
          </div>
          {action}
        </div>
      )}
      {children}
    </>
  );

return (
    <div className={clsx("rounded-card border border-chartborder bg-surface shadow-sm p-5", className)}>
      {body}
    </div>
  );
}

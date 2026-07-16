import type { ReactNode } from "react";
import clsx from "clsx";

/**
 * A consistent, polished "nothing here yet" block: icon, heading, description, and an
 * optional action — as distinct from a loading or error state. Generalizes the pattern
 * already used ad hoc on Chat/Watchlist so new surfaces (Settings, Onboarding, Docs) don't
 * reinvent it.
 */
export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
}: {
  icon?: ReactNode;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={clsx("flex flex-col items-center gap-2 py-10 text-center", className)}>
      <div className="flex h-10 w-10 items-center justify-center rounded-full border border-chartborder text-ink-muted">
        {icon ?? (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="9" />
            <path d="M9 9.5a3 3 0 0 1 5.6-1.5c0 2-2.6 2-2.6 4M12 16.2v.1" />
          </svg>
        )}
      </div>
      <h3 className="text-sm font-semibold text-ink-primary">{title}</h3>
      {description && <p className="max-w-sm text-xs leading-relaxed text-ink-muted">{description}</p>}
      {action && <div className="mt-1.5">{action}</div>}
    </div>
  );
}

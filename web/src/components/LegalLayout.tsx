import type { ReactNode } from "react";
import { Link } from "react-router-dom";

/**
 * Minimal standalone chrome for legal documents (Terms/Privacy) — reachable from the
 * marketing footer without the authenticated app shell, matching how most SaaS products
 * present ToS/Privacy as their own lightweight page rather than inside the dashboard
 * sidebar. Uses the same clean-light design tokens as the app shell.
 */
export function LegalLayout({
  title,
  updated,
  children,
}: {
  title: string;
  updated: string;
  children: ReactNode;
}) {
  return (
    <div className="min-h-full bg-page">
      <div className="border-b border-chartborder bg-surface">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-6 py-4">
          <Link to="/" className="flex items-center gap-2.5">
            <div className="flex h-7 w-7 items-center justify-center rounded-[8px] bg-brand shadow-sm">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.4" strokeLinecap="round">
                <path d="M5 19v-6M12 19V6M19 19v-9" />
              </svg>
            </div>
            <span className="text-sm font-semibold tracking-tight text-ink-primary">Prospect</span>
          </Link>
          <Link to="/niches" className="text-xs font-medium text-ink-secondary hover:text-ink-primary">
            Open the app →
          </Link>
        </div>
      </div>

      <div className="mx-auto max-w-3xl px-6 py-10">
        <h1 className="text-2xl font-semibold tracking-tight text-ink-primary">{title}</h1>
        <p className="mt-1 text-xs text-ink-muted">Last updated {updated}</p>
        <div className="mt-8 rounded-card border border-chartborder bg-surface p-6 shadow-sm">{children}</div>
        <div className="mt-6 flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-muted">
          <Link to="/terms" className="hover:text-ink-primary">
            Terms
          </Link>
          <Link to="/privacy" className="hover:text-ink-primary">
            Privacy
          </Link>
          <Link to="/docs" className="hover:text-ink-primary">
            Docs
          </Link>
        </div>
      </div>
    </div>
  );
}

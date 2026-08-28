import { Component, type ErrorInfo, type ReactNode } from "react";

/**
 * The app's only render-error backstop. Before this existed, ONE throw in any page
 * component unmounted the whole tree and left a white screen with the error only in the
 * console — the chrome, the nav and the "go somewhere else" escape hatch all vanished
 * with it.
 *
 * Deliberately a class: error boundaries have no hooks equivalent (componentDidCatch /
 * getDerivedStateFromError are class-only, still, in React 18).
 *
 * RESET ON ROUTE CHANGE is the load-bearing behavior. A boundary latches its error state
 * forever, so without a reset key a single bad page would keep showing the fallback even
 * after navigating away — the app would look permanently broken. App.tsx passes the
 * pathname as `resetKey`; when it changes we drop the error and re-render the children.
 */
interface Props {
  children: ReactNode;
  /** Change this to clear a latched error — App.tsx passes the current pathname. */
  resetKey?: string;
}
interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // No error-reporting backend in this stack (see lib/analytics.ts — pageviews only),
    // so the console IS the report. Keep the component stack: it names the page.
    console.error("Render error:", error, info.componentStack);
  }

  componentDidUpdate(prev: Props): void {
    if (this.state.error !== null && prev.resetKey !== this.props.resetKey) {
      this.setState({ error: null });
    }
  }

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="blueprint px-6 py-10" role="alert">
        <i className="bp-corner" />
        <div className="flex flex-col items-center gap-3 text-center">
          <h2 className="text-[22px] text-ink-primary">This view hit an error</h2>
          <p className="max-w-md text-sm text-ink-muted">
            Something in this page failed to render. The rest of the app still works — reload the view, or pick another
            destination from the navigation above.
          </p>
          {/* The message, not a stack: enough to report it, not a wall of frames. */}
          <code className="max-w-full overflow-x-auto whitespace-pre-wrap px-2 py-1 text-[11px] text-ink-secondary">
            {error.message}
          </code>
          <button
            type="button"
            onClick={() => this.setState({ error: null })}
            className="mt-1 bg-brand px-3.5 py-1.5 text-xs font-semibold text-brand-fg transition-colors hover:bg-brand-hover"
          >
            Reload view
          </button>
        </div>
      </div>
    );
  }
}

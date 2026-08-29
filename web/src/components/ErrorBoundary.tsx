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
 *
 * TWO KINDS OF FAILURE, TWO REMEDIES (2026-08-29). Since the routes are React.lazy, this
 * boundary also catches a chunk that failed to LOAD — and for that one a state reset is
 * inert: the bundler runtime caches the rejected module promise, so re-rendering the same
 * lazy component just re-throws the same rejection. That is the ORDINARY post-deploy
 * experience (an open tab's chunk URLs stop existing the moment the new build lands), so
 * it gets its own fallback whose button does the only thing that works — a real document
 * reload, which re-fetches index.html and with it the current chunk names.
 */
interface Props {
  children: ReactNode;
  /** Change this to clear a latched error — App.tsx passes the current pathname. */
  resetKey?: string;
  /** Seam for the test only: jsdom refuses a spy on location.reload (non-configurable). */
  reloadPage?: () => void;
}
interface State {
  error: Error | null;
}

/**
 * Does this error mean "the JS chunk never arrived" rather than "the page threw"?
 *
 * Every engine phrases a failed dynamic import differently and none of them expose a
 * dedicated error type, so the message IS the signal: Chrome "Failed to fetch dynamically
 * imported module: …", Firefox "error loading dynamically imported module", Safari
 * "Importing a module script failed.", plus Vite's own preload helper ("Unable to preload
 * CSS for …"). Matching wide is the safe direction here — the worst case of a false
 * positive is offering a page reload for a render throw, which still clears the screen.
 */
export function isChunkLoadError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return (
    /dynamically imported module/i.test(message) ||
    /Importing a module script failed/i.test(message) ||
    /Unable to preload CSS/i.test(message) ||
    /Loading chunk \S+ failed/i.test(message)
  );
}

function reloadPage(): void {
  window.location.reload();
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // No error-reporting backend in this stack (see lib/analytics.ts — pageviews only),
    // so the console IS the report. Keep the component stack: it names the page.
    console.error(isChunkLoadError(error) ? "Chunk load error:" : "Render error:", error, info.componentStack);
  }

  componentDidUpdate(prev: Props): void {
    if (this.state.error !== null && prev.resetKey !== this.props.resetKey) {
      this.setState({ error: null });
    }
  }

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    // The fallback is the only heading on screen — the boundary wraps the routed outlet and
    // the chrome around it contributes none — so it's the page's h1, not an h2.
    const stale = isChunkLoadError(error);
    return (
      <div className="blueprint px-6 py-10" role="alert">
        <i className="bp-corner" />
        <div className="flex flex-col items-center gap-3 text-center">
          <h1 className="text-[22px] text-ink-primary">{stale ? "This view didn't load" : "This view hit an error"}</h1>
          <p className="max-w-md text-sm text-ink-muted">
            {stale
              ? "This page's code never arrived — usually because the app was updated while this tab was open, so the files it was holding onto are gone. Reloading the page picks up the new version."
              : "Something in this page failed to render. The rest of the app still works — reload the view, or pick another destination from the navigation above."}
          </p>
          {/* The message, not a stack: enough to report it, not a wall of frames. */}
          <code className="max-w-full overflow-x-auto whitespace-pre-wrap px-2 py-1 text-[11px] text-ink-secondary">
            {error.message}
          </code>
          <button
            type="button"
            // A state reset re-renders the SAME lazy component, and its rejected module
            // promise is cached by the bundler runtime — so for a stale chunk only a real
            // document load can recover. Ordinary render throws keep the cheap reset.
            onClick={() => (stale ? (this.props.reloadPage ?? reloadPage)() : this.setState({ error: null }))}
            className="mt-1 bg-brand px-3.5 py-1.5 text-xs font-semibold text-brand-fg transition-colors hover:bg-brand-hover"
          >
            {stale ? "Reload page" : "Reload view"}
          </button>
        </div>
      </div>
    );
  }
}

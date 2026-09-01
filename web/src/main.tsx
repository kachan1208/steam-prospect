import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter } from "react-router-dom";

import "@fontsource-variable/inter";
import { ThemeProvider } from "./lib/theme";
import { DEFAULT_QUERY_OPTIONS } from "./lib/api";
import App from "./App";
import "./index.css";

// Defined in lib/api.ts (and pinned by its tests) rather than spelled out here. Its `retry`
// is NOT the bare `retry: 1` this used to carry — that retried 404s, and a 404 is an answer,
// not a blip. /games/999999999 fires five endpoints; under `retry: 1` that was ten doomed
// requests and 6-9 seconds of header-and-footer-only page before the "not found" message the
// very first response had already justified. Hooks needing a different policy still declare
// their own `retry` (see lib/api.ts's retryUnlessUnavailable).
const queryClient = new QueryClient({ defaultOptions: { queries: DEFAULT_QUERY_OPTIONS } });

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("#root element not found");

createRoot(rootEl).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        {/* v7_startTransition makes the router wrap its location state update in
            React.startTransition — which is what lets App's ONE Suspense boundary hold the
            OLD page on screen while a lazy route's chunk downloads, instead of blanking it
            to a spinner on every in-app navigation. Without the flag (react-router 6.30's
            default) that claim is simply false. See the comment above the lazy() block in
            App.tsx; the two must stay in agreement. */}
        <BrowserRouter future={{ v7_startTransition: true }}>
          <App />
        </BrowserRouter>
      </ThemeProvider>
    </QueryClientProvider>
  </StrictMode>,
);

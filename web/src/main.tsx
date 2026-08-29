import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter } from "react-router-dom";

import "@fontsource-variable/inter";
import { ThemeProvider } from "./lib/theme";
import App from "./App";
import "./index.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      staleTime: 30_000,
      retry: 1,
    },
  },
});

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

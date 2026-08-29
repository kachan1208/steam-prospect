import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Link, MemoryRouter, Route, Routes } from "react-router-dom";
import { Suspense, lazy, type ComponentType } from "react";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * WHY THE ROUTER'S v7_startTransition FLAG IS LOAD-BEARING (2026-08-29).
 *
 * App.tsx runs ONE Suspense boundary for every lazy route and its comment promises that an
 * in-app navigation keeps the old page on screen while the next chunk downloads. That is
 * only true if the router's location update is a React transition — react-router 6.30
 * makes it one ONLY under `future={{ v7_startTransition: true }}`, which main.tsx passes.
 * Drop the flag and every navigation to a lazy route flashes the spinner instead.
 *
 * Both halves are pinned: the behaviour (with the flag and without, same harness), and the
 * fact that main.tsx actually sets it — a comment that quietly stops being true is exactly
 * what this replaces.
 */

function deferredLazy() {
  let resolveModule!: (m: { default: ComponentType }) => void;
  const module = new Promise<{ default: ComponentType }>((r) => {
    resolveModule = r;
  });
  const Lazy = lazy(() => module);
  return { Lazy, arrive: () => resolveModule({ default: () => <div>chunk page</div> }) };
}

function renderApp(future?: { v7_startTransition: true }) {
  const { Lazy, arrive } = deferredLazy();
  render(
    <MemoryRouter initialEntries={["/here"]} future={future}>
      <Suspense fallback={<div>spinner</div>}>
        <Routes>
          <Route path="/here" element={<Link to="/lazy">go</Link>} />
          <Route path="/lazy" element={<Lazy />} />
        </Routes>
      </Suspense>
    </MemoryRouter>,
  );
  return { arrive };
}

afterEach(cleanup);

describe("lazy-route navigation", () => {
  it("with v7_startTransition, the old view holds — no spinner mid-navigation", async () => {
    const { arrive } = renderApp({ v7_startTransition: true });
    fireEvent.click(screen.getByText("go"));

    expect(screen.queryByText("spinner")).toBeNull();
    // Still on screen, not merely still in the DOM (see the display:none note below).
    expect(screen.getByText("go").style.display).not.toBe("none");

    arrive();
    await waitFor(() => expect(screen.getByText("chunk page")).toBeTruthy());
  });

  it("without the flag the same navigation blanks to the Suspense fallback", async () => {
    const { arrive } = renderApp();
    fireEvent.click(screen.getByText("go"));

    expect(screen.getByText("spinner")).toBeTruthy();
    // React doesn't unmount the old tree when a boundary re-suspends outside a transition,
    // it HIDES it — display:none is the DOM's way of saying "the user is looking at the
    // spinner now", which is exactly the flash the flag exists to prevent.
    expect(screen.getByText("go").style.display).toBe("none");

    arrive();
    await waitFor(() => expect(screen.getByText("chunk page")).toBeTruthy());
  });

  it("main.tsx opts in — the App.tsx comment depends on it", () => {
    const main = readFileSync(join(resolve(__dirname), "main.tsx"), "utf8");
    expect(main).toMatch(/<BrowserRouter[^>]*future=\{\{\s*v7_startTransition:\s*true\s*\}\}/);
  });
});

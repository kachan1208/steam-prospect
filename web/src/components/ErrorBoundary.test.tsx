import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";

import { ErrorBoundary, isChunkLoadError } from "./ErrorBoundary";

/**
 * The backstop that keeps one render throw from white-screening the app. Three behaviors
 * are load-bearing and pinned here: the fallback renders INSTEAD of the crash, the
 * boundary un-latches when the route changes (otherwise navigating away from a broken
 * page would leave the fallback stuck on screen forever), and a FAILED LAZY CHUNK — the
 * ordinary post-deploy failure — gets the reload-the-document remedy instead of the state
 * reset, which cannot clear it (the rejected module promise is cached by the bundler).
 */

function Boom({ explode }: { explode: boolean }): React.ReactElement {
  if (explode) throw new Error("kaboom in render");
  return <div>page content</div>;
}

beforeEach(() => {
  // React logs the caught error itself; keep the test output readable.
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("ErrorBoundary", () => {
  it("renders children untouched when nothing throws", () => {
    render(
      <ErrorBoundary>
        <Boom explode={false} />
      </ErrorBoundary>,
    );
    expect(screen.getByText("page content")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("catches a render throw and shows the fallback with the message, not a white screen", () => {
    render(
      <ErrorBoundary>
        <Boom explode />
      </ErrorBoundary>,
    );
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.getByText("This view hit an error")).toBeTruthy();
    expect(screen.getByText("kaboom in render")).toBeTruthy();
    expect(screen.queryByText("page content")).toBeNull();
  });

  it("'Reload view' re-renders the children — a fixed error recovers", () => {
    // Flag flipped by the test, not by the render itself: React re-renders a throwing
    // subtree while collecting the component stack, so a "throws only once" child would
    // heal on its own and never prove the button does anything.
    let broken = true;
    function Flaky() {
      if (broken) throw new Error("transient");
      return <div>recovered</div>;
    }
    render(
      <ErrorBoundary>
        <Flaky />
      </ErrorBoundary>,
    );
    expect(screen.getByText("This view hit an error")).toBeTruthy();

    broken = false;
    fireEvent.click(screen.getByRole("button", { name: "Reload view" }));
    expect(screen.getByText("recovered")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("the fallback heading is the page's h1 — the chrome around the outlet has no heading", () => {
    render(
      <ErrorBoundary>
        <Boom explode />
      </ErrorBoundary>,
    );
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("This view hit an error");
  });

  describe("a stale lazy chunk (the ordinary post-deploy failure)", () => {
    // The real messages, verbatim, from each engine + Vite's preload helper.
    const CHUNK_MESSAGES = [
      "Failed to fetch dynamically imported module: https://prospect.example/assets/GameProfile-BN96AJ3l.js",
      "error loading dynamically imported module: https://prospect.example/assets/Docs-Dhn_2yxj.js",
      "Importing a module script failed.",
      "Unable to preload CSS for /assets/index-CNsH8xjB.css",
    ];

    it("recognises every engine's phrasing, and nothing else", () => {
      for (const m of CHUNK_MESSAGES) expect(isChunkLoadError(new Error(m))).toBe(true);
      expect(isChunkLoadError(new Error("Cannot read properties of undefined (reading 'map')"))).toBe(false);
      expect(isChunkLoadError(new TypeError("fetch failed"))).toBe(false);
      expect(isChunkLoadError(undefined)).toBe(false);
    });

    it("offers a real page reload, not the inert state reset", () => {
      const reloadPage = vi.fn();
      function StaleChunk(): React.ReactElement {
        throw new Error(CHUNK_MESSAGES[0]);
      }
      render(
        <ErrorBoundary reloadPage={reloadPage}>
          <StaleChunk />
        </ErrorBoundary>,
      );
      expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("This view didn't load");
      // The copy must promise what the button actually does.
      expect(screen.getByRole("alert").textContent).toContain("Reloading the page");
      expect(screen.queryByRole("button", { name: "Reload view" })).toBeNull();

      fireEvent.click(screen.getByRole("button", { name: "Reload page" }));
      expect(reloadPage).toHaveBeenCalledTimes(1);
      // And it does NOT re-render the children (which would throw the cached rejection again).
      expect(screen.getByRole("alert")).toBeTruthy();
    });

    it("leaves ordinary render throws on the state-reset path", () => {
      const reloadPage = vi.fn();
      render(
        <ErrorBoundary reloadPage={reloadPage}>
          <Boom explode />
        </ErrorBoundary>,
      );
      fireEvent.click(screen.getByRole("button", { name: "Reload view" }));
      expect(reloadPage).not.toHaveBeenCalled();
    });
  });

  it("resets when resetKey changes — navigating away must not leave the fallback latched", () => {
    function Harness() {
      const [path, setPath] = useState("/broken");
      return (
        <>
          <button type="button" onClick={() => setPath("/other")}>
            navigate
          </button>
          <ErrorBoundary resetKey={path}>
            <Boom explode={path === "/broken"} />
          </ErrorBoundary>
        </>
      );
    }
    render(<Harness />);
    expect(screen.getByText("This view hit an error")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "navigate" }));
    expect(screen.getByText("page content")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

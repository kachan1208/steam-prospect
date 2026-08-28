import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";

import { ErrorBoundary } from "./ErrorBoundary";

/**
 * The backstop that keeps one render throw from white-screening the app. Two behaviors
 * are load-bearing and pinned here: the fallback renders INSTEAD of the crash, and the
 * boundary un-latches when the route changes (otherwise navigating away from a broken
 * page would leave the fallback stuck on screen forever).
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

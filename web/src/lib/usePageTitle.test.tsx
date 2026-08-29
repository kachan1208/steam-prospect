import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";

import { usePageTitle } from "./usePageTitle";

const DEFAULT_TITLE = "Prospect — Steam Market Intelligence";

function Page({ title }: { title: string | null | undefined }) {
  usePageTitle(title);
  return null;
}

afterEach(() => {
  cleanup();
  document.title = "";
});

describe("usePageTitle", () => {
  it("suffixes the page name so a history entry names where you were", () => {
    render(<Page title="Watchlist" />);
    expect(document.title).toBe("Watchlist — Prospect");
  });

  it("holds the app default while a dynamic title is still loading", () => {
    // GameProfile passes profileQ.data?.name — undefined until the fetch resolves. It must
    // never render "undefined — Prospect".
    const { rerender } = render(<Page title={undefined} />);
    expect(document.title).toBe(DEFAULT_TITLE);

    rerender(<Page title="Frostharbor" />);
    expect(document.title).toBe("Frostharbor — Prospect");
  });

  it("restores the default on unmount so a stale page name can't linger", () => {
    const { unmount } = render(<Page title="Studios" />);
    expect(document.title).toBe("Studios — Prospect");
    unmount();
    expect(document.title).toBe(DEFAULT_TITLE);
  });
});

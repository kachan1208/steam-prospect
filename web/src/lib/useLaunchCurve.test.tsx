import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

import { useLaunchCurve } from "./api";

/**
 * The `enabled` guard. GameProfile reads its genre from a profile query that resolves
 * later; before this guard it passed "__all__" as a stand-in, firing a throwaway
 * catalog-wide /launch-curve on every mount that the real genre request immediately
 * superseded. null now means "genre not known yet" and fetches nothing — while
 * "__all__" passed EXPLICITLY (LaunchTiming's "All genres") still fetches.
 */

let fetchMock: ReturnType<typeof vi.fn>;

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

function curveUrls(): string[] {
  return fetchMock.mock.calls.map((c) => String(c[0])).filter((u) => u.includes("/launch-curve"));
}

beforeEach(() => {
  fetchMock = vi.fn(
    async () =>
      new Response(JSON.stringify({ genre: "Indie", points: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
  );
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useLaunchCurve", () => {
  it("fetches nothing while the genre is unknown (null)", async () => {
    const { result } = renderHook(() => useLaunchCurve(null), { wrapper });
    await waitFor(() => expect(result.current.fetchStatus).toBe("idle"));
    expect(curveUrls()).toHaveLength(0);
  });

  it("fetches once a real genre is known", async () => {
    const { result } = renderHook(() => useLaunchCurve("Indie"), { wrapper });
    await waitFor(() => expect(result.current.data).toBeTruthy());
    expect(curveUrls()).toHaveLength(1);
    expect(curveUrls()[0]).toContain("genre=Indie");
  });

  it("still fetches the catalog-wide cut when '__all__' is passed EXPLICITLY", async () => {
    const { result } = renderHook(() => useLaunchCurve("__all__"), { wrapper });
    await waitFor(() => expect(result.current.data).toBeTruthy());
    expect(curveUrls()).toHaveLength(1);
    expect(curveUrls()[0]).toContain("genre=__all__");
  });

  it("does not fire a throwaway request first when the genre arrives late", async () => {
    // Exactly GameProfile's shape: null on mount, the real genre on a later render.
    const { result, rerender } = renderHook(({ g }: { g: string | null }) => useLaunchCurve(g), {
      wrapper,
      initialProps: { g: null as string | null },
    });
    await waitFor(() => expect(result.current.fetchStatus).toBe("idle"));
    expect(curveUrls()).toHaveLength(0);

    rerender({ g: "Strategy" });
    await waitFor(() => expect(result.current.data).toBeTruthy());
    // ONE request total, and it's the real genre — no "__all__" round trip wasted.
    expect(curveUrls()).toHaveLength(1);
    expect(curveUrls()[0]).toContain("genre=Strategy");
  });
});

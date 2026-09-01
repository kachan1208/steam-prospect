import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ApiError,
  errorMessage,
  isNotFound,
  isTransportFailure,
  request,
  TRANSPORT_FAILURE_MESSAGE,
} from "./api";

/**
 * The words a failed request is allowed to become.
 *
 * A live audit of production on 2026-09-01 (Playwright, `**\/api\/**` aborted) found the
 * app reporting a NETWORK failure as a statement about the user's data on six of seven
 * routes: "Game not found: Failed to fetch", "Niche not found: Failed to fetch",
 * "App 730 · Not in catalog", and four /timing cards printing "TypeError: Failed to fetch"
 * verbatim. Separately, /games?offset=10025 and /games?after=202 rendered FastAPI's raw
 * pydantic error array on screen.
 *
 * Two rules follow, and both live here rather than in each page — the pages had already
 * drifted apart once (GameProfile stuttered its 404 prefix for months while NicheDetail
 * did not):
 *   1. Only a 404 licenses not-found copy. Everything else is a failure to ANSWER.
 *   2. No exception name, and no serialized error object, ever reaches the screen.
 */

afterEach(() => vi.unstubAllGlobals());

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("classification: did the server answer, or did we never ask?", () => {
  it("treats fetch's bare TypeError as a transport failure, not an answer", () => {
    // This is the literal rejection Chromium hands back for a dropped/blocked request.
    const err = new TypeError("Failed to fetch");
    expect(isTransportFailure(err)).toBe(true);
    expect(isNotFound(err)).toBe(false);
  });

  it("treats a 404 as an ANSWER — the only error that may be reported as not-found", () => {
    const err = new ApiError(404, "game not found: 999999999");
    expect(isNotFound(err)).toBe(true);
    expect(isTransportFailure(err)).toBe(false);
  });

  it("does not let a 500 or a 422 borrow not-found copy", () => {
    for (const status of [400, 422, 500, 503]) {
      const err = new ApiError(status, "boom");
      expect(isNotFound(err)).toBe(false);
      expect(isTransportFailure(err)).toBe(false);
    }
  });

  it("does not call a cancelled fetch a transport failure", () => {
    // react-query aborts in-flight requests on unmount/refetch. That is not a failure at
    // all, and a page that renders "can't reach the API" on every navigation is worse than
    // the bug this file exists to fix.
    const abort = new Error("The user aborted a request.");
    abort.name = "AbortError";
    expect(isTransportFailure(abort)).toBe(false);
  });

  it("says nothing about anything when there is no error", () => {
    expect(isTransportFailure(null)).toBe(false);
    expect(isTransportFailure(undefined)).toBe(false);
    expect(errorMessage(null)).toBe("");
  });
});

describe("errorMessage: what the user is allowed to read", () => {
  it("never surfaces the exception name for a network failure", () => {
    const msg = errorMessage(new TypeError("Failed to fetch"));
    expect(msg).toBe(TRANSPORT_FAILURE_MESSAGE);
    // The exact two strings the audit caught on /timing and on the not-found pages.
    expect(msg).not.toContain("TypeError");
    expect(msg).not.toContain("Failed to fetch");
  });

  it("keeps the API's own words when the API actually spoke", () => {
    expect(errorMessage(new ApiError(404, "game not found: 999999999"))).toBe("game not found: 999999999");
    expect(errorMessage(new ApiError(503, "marts not built"))).toBe("marts not built");
  });
});

describe("request(): a rejected query param becomes a sentence, not a JSON dump", () => {
  it("reads FastAPI's 422 list back as field + message", async () => {
    // Verbatim body from GET /api/games/search?...&offset=10025 on production 2026-09-01.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(
          {
            detail: [
              {
                type: "less_than_equal",
                loc: ["query", "offset"],
                msg: "Input should be less than or equal to 10000",
                input: "10025",
                ctx: { le: 10000 },
              },
            ],
          },
          422,
        ),
      ),
    );

    const err = await request("/games/search?offset=10025").then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ApiError);
    const message = (err as ApiError).message;
    expect(message).toBe("offset: Input should be less than or equal to 10000");
    // The whole point: none of the machine fields the page used to print.
    for (const leak of ['{"type"', "less_than_equal", '"loc"', '"ctx"', "[{"]) {
      expect(message).not.toContain(leak);
    }
  });

  it("joins a multi-field 422 instead of stringifying the array", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(
          {
            detail: [
              { type: "greater_than_equal", loc: ["query", "released_after"], msg: "Input should be greater than or equal to 1970" },
              { type: "less_than_equal", loc: ["query", "released_before"], msg: "Input should be less than or equal to 2100" },
            ],
          },
          422,
        ),
      ),
    );
    const err = (await request("/games/search").catch((e: unknown) => e)) as ApiError;
    expect(err.message).toBe(
      "released_after: Input should be greater than or equal to 1970; " +
        "released_before: Input should be less than or equal to 2100",
    );
  });

  it("still hands the raw detail object to callers that need its structure", async () => {
    // The entity-profile 404 carries {error, suggestions} and EntityProfile renders the
    // suggestions as did-you-mean links — flattening detail to a string would break that.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({ detail: { error: "no such developer", suggestions: ["Valve", "Valve Corporation"] } }, 404),
      ),
    );
    const err = (await request("/entities/profile").catch((e: unknown) => e)) as ApiError;
    expect(err.detail).toEqual({ error: "no such developer", suggestions: ["Valve", "Valve Corporation"] });
    expect(err.message).toBe("no such developer");
  });

  it("leaves a plain string detail exactly as the API wrote it", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ detail: "niche not found: tag/Foo" }, 404)));
    const err = (await request("/niches/tag/Foo").catch((e: unknown) => e)) as ApiError;
    expect(err.message).toBe("niche not found: tag/Foo");
    expect(err.detail).toBeUndefined();
  });
});

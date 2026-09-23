import { describe, expect, it } from "vitest";

import { launchAnchor, monthOrdinal, releaseCaption } from "./lifecycle";

describe("releaseCaption", () => {
  it("prints the release month in the app's one date format", () => {
    expect(releaseCaption({ release_date: "2024-02-20", release_year: 2024 })).toBe("Feb 2024");
    // No date, a year: the year. Neither: nothing — the caller drops the part.
    expect(releaseCaption({ release_date: null, release_year: 2019 })).toBe("2019");
    expect(releaseCaption({ release_date: null, release_year: null })).toBeNull();
  });

  it("tells an Early Access graduate's two dates apart instead of hiding its EA years", () => {
    // Slay the Spire: on sale from Nov 2017, 1.0 in Jan 2019.
    expect(
      releaseCaption({
        release_date: "2019-01-23",
        first_public_date: "2017-11-14",
        release_date_1_0: "2019-01-23",
        is_ea_graduate: true,
      }),
    ).toBe("EA Nov 2017 → 1.0 Jan 2019");
    // Flag without dates still says it went EA → 1.0.
    expect(releaseCaption({ release_date: "2019-01-23", is_ea_graduate: true })).toBe("EA → 1.0 Jan 2019");
    // A game that never was EA reads plainly even when the lifecycle columns are there.
    expect(
      releaseCaption({ release_date: "2024-02-20", first_public_date: "2024-02-20", is_ea_graduate: false }),
    ).toBe("Feb 2024");
  });
});

describe("launchAnchor / monthOrdinal", () => {
  it("anchors on the first public date when the mart has it, else the release date", () => {
    expect(launchAnchor({ release_date: "2019-01-23", first_public_date: "2017-11-14" })).toEqual({
      iso: "2017-11-14",
      source: "first_public",
    });
    expect(launchAnchor({ release_date: "2019-01-23" })).toEqual({ iso: "2019-01-23", source: "release" });
    expect(launchAnchor({ release_date: "Coming soon" })).toBeNull();
  });

  it("does month arithmetic on the ISO digits", () => {
    expect(monthOrdinal("2024-03")! - monthOrdinal("2024-02-20")!).toBe(1);
    expect(monthOrdinal("2025-01-01")! - monthOrdinal("2024-12-31")!).toBe(1);
    expect(monthOrdinal("nope")).toBeNull();
  });
});

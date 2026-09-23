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
    // Slay the Spire: on sale from Nov 2017, 1.0 in Jan 2019. On the rebuilt mart
    // release_date IS the first public date and release_date_1_0 the store date…
    expect(
      releaseCaption({
        release_date: "2017-11-14",
        release_date_1_0: "2019-01-23",
        is_ea_graduate: true,
        release_date_source: "store",
      }),
    ).toBe("EA Nov 2017 → 1.0 Jan 2019");
    // …while the transitional API sent the first public date in its own column.
    expect(
      releaseCaption({
        release_date: "2019-01-23",
        first_public_date: "2017-11-14",
        release_date_1_0: "2019-01-23",
        is_ea_graduate: true,
      }),
    ).toBe("EA Nov 2017 → 1.0 Jan 2019");
    // A game that never was EA reads plainly even when the lifecycle columns are there.
    expect(releaseCaption({ release_date: "2024-02-20", release_date_1_0: "2024-02-20", is_ea_graduate: false })).toBe(
      "Feb 2024",
    );
  });

  it("marks a date inferred from the first review as approximate", () => {
    expect(releaseCaption({ release_date: "2015-06-01", release_date_source: "first_review_month" })).toBe("~Jun 2015");
    expect(releaseCaption({ release_date: "2015-06-14", release_date_source: "first_review" })).toBe("~Jun 2015");
    expect(releaseCaption({ release_date: "2015-06-14", release_date_source: "store" })).toBe("Jun 2015");
  });
});

describe("launchAnchor / monthOrdinal", () => {
  it("anchors on the first public date when the data has it, else the release date", () => {
    expect(launchAnchor({ release_date: "2019-01-23", first_public_date: "2017-11-14" })).toEqual({
      iso: "2017-11-14",
      source: "first_public",
    });
    // On a lifecycle mart release_date already IS the first public date.
    expect(launchAnchor({ release_date: "2017-11-14", release_date_1_0: "2019-01-23", is_ea_graduate: true })).toEqual({
      iso: "2017-11-14",
      source: "first_public",
    });
    // An older mart: the store date, and the anchor says so — including when the API
    // declares the lifecycle fields but serves them null (the column isn't in that mart).
    expect(launchAnchor({ release_date: "2019-01-23" })).toEqual({ iso: "2019-01-23", source: "release" });
    expect(
      launchAnchor({
        release_date: "2019-01-23",
        first_public_date: null,
        release_date_1_0: null,
        is_ea_graduate: null,
        release_date_source: null,
      }),
    ).toEqual({ iso: "2019-01-23", source: "release" });
    expect(launchAnchor({ release_date: "Coming soon" })).toBeNull();
  });

  it("does month arithmetic on the ISO digits", () => {
    expect(monthOrdinal("2024-03")! - monthOrdinal("2024-02-20")!).toBe(1);
    expect(monthOrdinal("2025-01-01")! - monthOrdinal("2024-12-31")!).toBe(1);
    expect(monthOrdinal("nope")).toBeNull();
  });
});

import { describe, expect, it } from "vitest";

import { describeDataAge, fmtAgeDays, fmtDataDate, parseDataDate, STALE_AFTER_HOURS } from "./dataAge";

const NOW = new Date("2026-09-22T12:00:00Z");

// The shape /api/health has always served (api/app/schemas.py Health), with built_at in the
// ETL's own format: datetime.now(timezone.utc).isoformat(timespec="seconds").
const OLD_SHAPE = {
  status: "ok",
  mart_version: "20260921",
  built_at: "2026-09-21T21:34:12+00:00",
  source_db: "/data/current.duckdb",
};

describe("describeDataAge — the original health shape", () => {
  it("dates the data by built_at and derives its age from it", () => {
    const age = describeDataAge(OLD_SHAPE, { now: NOW });
    expect(age.apiState).toBe("ok");
    expect(age.asOfLabel).toBe("Sep 21, 2026");
    expect(age.ageHours).toBeCloseTo(14.43, 1);
    expect(age.ageDays).toBe(0);
    expect(age.ageLabel).toBe("under a day old");
    expect(age.stale).toBe(false);
    expect(age.martVersion).toBe("20260921");
    expect(age.martBehind).toBe(false);
    expect(age.builtAt).toBe(OLD_SHAPE.built_at);
  });

  it("goes stale past three days", () => {
    const age = describeDataAge({ ...OLD_SHAPE, built_at: "2026-09-18T21:00:00+00:00" }, { now: NOW });
    expect(age.ageDays).toBe(3);
    expect(age.ageLabel).toBe("3 days old");
    expect(age.ageHours! > STALE_AFTER_HOURS).toBe(true);
    expect(age.stale).toBe(true);
  });

  it("is not stale at exactly the threshold", () => {
    const built = new Date(NOW.getTime() - STALE_AFTER_HOURS * 3_600_000).toISOString();
    expect(describeDataAge({ ...OLD_SHAPE, built_at: built }, { now: NOW }).stale).toBe(false);
  });

  it("falls back to a YYYYMMDD mart_version when built_at is missing (read as that day's midnight UTC)", () => {
    const age = describeDataAge({ ...OLD_SHAPE, built_at: null }, { now: NOW });
    expect(age.asOfLabel).toBe("Sep 21, 2026");
    expect(age.ageHours).toBe(36);
    expect(age.ageLabel).toBe("1 day old");
  });

  it("reports an unknown date as unknown, never as fresh or stale", () => {
    const age = describeDataAge({ status: "ok", mart_version: null, built_at: null, source_db: null }, { now: NOW });
    expect(age.asOf).toBeNull();
    expect(age.ageLabel).toBeNull();
    expect(age.stale).toBe(false);
  });

  it("reads a build stamped slightly in the future (clock skew) as fresh, not negative", () => {
    const age = describeDataAge({ ...OLD_SHAPE, built_at: "2026-09-22T13:00:00Z" }, { now: NOW });
    expect(age.ageHours).toBe(0);
    expect(age.ageLabel).toBe("under a day old");
  });
});

describe("describeDataAge — the extended health shape", () => {
  it("prefers the server's age_hours and data_as_of", () => {
    const age = describeDataAge(
      { ...OLD_SHAPE, age_hours: 100, data_as_of: "2026-09-18" },
      { now: NOW },
    );
    expect(age.ageHours).toBe(100);
    expect(age.ageDays).toBe(4);
    expect(age.ageLabel).toBe("4 days old");
    expect(age.stale).toBe(true);
    expect(age.asOfLabel).toBe("Sep 18, 2026");
  });

  it("flags a built-but-not-loaded mart", () => {
    const age = describeDataAge(
      { ...OLD_SHAPE, loaded_mart_version: "20260920", target_mart_version: "20260921" },
      { now: NOW },
    );
    expect(age.martVersion).toBe("20260920");
    expect(age.targetMartVersion).toBe("20260921");
    expect(age.martBehind).toBe(true);
  });

  it("dates the SteamSpy owners snapshot", () => {
    const age = describeDataAge({ ...OLD_SHAPE, owners_as_of: "2026-09-01" }, { now: NOW });
    expect(age.ownersAsOfLabel).toBe("Sep 1, 2026");
  });

  it("ignores a non-finite age_hours and derives the age instead", () => {
    const age = describeDataAge({ ...OLD_SHAPE, age_hours: Number.NaN }, { now: NOW });
    expect(age.ageHours).toBeCloseTo(14.43, 1);
  });
});

describe("describeDataAge — API state", () => {
  it("checking / unreachable / degraded", () => {
    expect(describeDataAge(undefined, { now: NOW, isLoading: true }).apiState).toBe("checking");
    expect(describeDataAge(undefined, { now: NOW, isError: true }).apiState).toBe("unreachable");
    expect(describeDataAge({ ...OLD_SHAPE, status: "degraded" }, { now: NOW }).apiState).toBe("degraded");
    expect(describeDataAge({}, { now: NOW }).apiState).toBe("degraded");
  });
});

describe("helpers", () => {
  it("parseDataDate reads ISO dates, timestamps and mart stamps; rejects junk", () => {
    expect(parseDataDate("2026-09-21")?.toISOString()).toBe("2026-09-21T00:00:00.000Z");
    expect(parseDataDate("20260921")?.toISOString()).toBe("2026-09-21T00:00:00.000Z");
    expect(parseDataDate("2026-09-21T21:34:12+00:00")?.toISOString()).toBe("2026-09-21T21:34:12.000Z");
    expect(parseDataDate("v1")).toBeNull();
    expect(parseDataDate(null)).toBeNull();
  });

  it("fmtDataDate prints the UTC date — a late-evening UTC build is still its own day", () => {
    expect(fmtDataDate(new Date("2026-09-21T23:30:00Z"))).toBe("Sep 21, 2026");
    expect(fmtDataDate(null)).toBeNull();
  });

  it("fmtAgeDays", () => {
    expect(fmtAgeDays(0)).toBe("under a day old");
    expect(fmtAgeDays(23.9)).toBe("under a day old");
    expect(fmtAgeDays(24)).toBe("1 day old");
    expect(fmtAgeDays(49)).toBe("2 days old");
    expect(fmtAgeDays(null)).toBeNull();
  });
});

import { useEffect, useState } from "react";

import { useHealth, type Health } from "./api";
import { monthName } from "./format";

/**
 * HOW OLD IS WHAT I'M LOOKING AT (2026-09-22).
 *
 * The footer used to say "API connected · mart 20260921" — a build id, not an age — and
 * pages hard-coded the old droplet's schedule ("starts at 21:00 UTC"), which stops being
 * true the moment the pipeline runs anywhere else or skips a night. Nothing told a reader
 * that the numbers had stopped refreshing. This module turns /api/health into one answer —
 * "data as of Sep 21, 2026 · 1 day old" — and flags it stale after STALE_AFTER_HOURS.
 *
 * It reads BOTH health shapes:
 *   - the original {status, mart_version, built_at, source_db}: the date is built_at (the
 *     mart build's ISO-8601 UTC timestamp), else mart_version when it is a YYYYMMDD stamp,
 *     and the age is derived from it;
 *   - the extended shape adds age_hours (server-computed — preferred, it doesn't depend on
 *     the viewer's clock), data_as_of (preferred over built_at), loaded_mart_version /
 *     target_mart_version (a mismatch = a newer build is waiting to be loaded) and
 *     owners_as_of (the SteamSpy snapshot date behind every Owners figure).
 * Dates print in UTC: they identify a server-side build, not a moment in the viewer's day.
 */

/** Past this many hours the data counts as stale — the nightly pipeline has missed ~3 runs. */
export const STALE_AFTER_HOURS = 72;

export type ApiState = "checking" | "unreachable" | "ok" | "degraded";

export interface DataAgeInfo {
  apiState: ApiState;
  /** When the served data is from; null when the API gave no usable date. */
  asOf: Date | null;
  /** "Sep 21, 2026" (UTC), or null. */
  asOfLabel: string | null;
  /** Age in hours (server-computed when available), or null. */
  ageHours: number | null;
  /** Whole days old, or null. */
  ageDays: number | null;
  /** "under a day old" / "1 day old" / "5 days old", or null. */
  ageLabel: string | null;
  /** True when older than STALE_AFTER_HOURS (the banner's trigger). */
  stale: boolean;
  /** The mart version the API has loaded. */
  martVersion: string | null;
  /** The newest built mart version, when the API reports it. */
  targetMartVersion: string | null;
  /** A newer mart is built but not loaded yet (both versions known and different). */
  martBehind: boolean;
  /** SteamSpy owners snapshot date, when the API reports it. */
  ownersAsOf: Date | null;
  ownersAsOfLabel: string | null;
  /** The raw build timestamp, for the tooltip. */
  builtAt: string | null;
}

/** Parse an ISO date/timestamp, or a YYYYMMDD mart stamp, into a Date (UTC); null if unusable. */
export function parseDataDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const stamp = /^(\d{4})(\d{2})(\d{2})$/.exec(value.trim());
  const d = stamp ? new Date(Date.UTC(+stamp[1], +stamp[2] - 1, +stamp[3])) : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** "Sep 21, 2026", read in UTC. */
export function fmtDataDate(d: Date | null): string | null {
  if (!d) return null;
  return `${monthName(d.getUTCMonth() + 1)} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}

/** "under a day old" / "1 day old" / "N days old" from an age in hours. */
export function fmtAgeDays(ageHours: number | null): string | null {
  if (ageHours === null) return null;
  const days = Math.floor(ageHours / 24);
  if (days <= 0) return "under a day old";
  return days === 1 ? "1 day old" : `${days} days old`;
}

export function describeDataAge(
  health: Partial<Health> | null | undefined,
  {
    now,
    isLoading = false,
    isError = false,
    staleAfterHours = STALE_AFTER_HOURS,
  }: { now: Date; isLoading?: boolean; isError?: boolean; staleAfterHours?: number },
): DataAgeInfo {
  const apiState: ApiState = isLoading
    ? "checking"
    : isError || !health
      ? "unreachable"
      : health.status === "ok"
        ? "ok"
        : "degraded";

  const asOf = parseDataDate(health?.data_as_of) ?? parseDataDate(health?.built_at) ?? parseDataDate(health?.mart_version);
  const serverAge = typeof health?.age_hours === "number" && Number.isFinite(health.age_hours) ? health.age_hours : null;
  const derivedAge = asOf ? (now.getTime() - asOf.getTime()) / 3_600_000 : null;
  // Clock skew can make a fresh build look like it's from the future; that is "fresh", not
  // negative days.
  const rawAge = serverAge ?? derivedAge;
  const ageHours = rawAge === null ? null : Math.max(0, rawAge);

  const martVersion = health?.loaded_mart_version ?? health?.mart_version ?? null;
  const targetMartVersion = health?.target_mart_version ?? null;
  const ownersAsOf = parseDataDate(health?.owners_as_of);

  return {
    apiState,
    asOf,
    asOfLabel: fmtDataDate(asOf),
    ageHours,
    ageDays: ageHours === null ? null : Math.floor(ageHours / 24),
    ageLabel: fmtAgeDays(ageHours),
    stale: ageHours !== null && ageHours > staleAfterHours,
    martVersion,
    targetMartVersion,
    martBehind: martVersion !== null && targetMartVersion !== null && martVersion !== targetMartVersion,
    ownersAsOf,
    ownersAsOfLabel: fmtDataDate(ownersAsOf),
    builtAt: health?.built_at ?? null,
  };
}

/** The current time, re-read every `intervalMs` so an open tab's "N days old" keeps up. */
export function useNow(intervalMs = 60_000): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

/**
 * The served data's age, from /api/health (shared react-query cache — the footer, the
 * banner and any page calling this cost one request between them).
 *
 *   const age = useDataAge();
 *   age.asOfLabel   // "Sep 21, 2026"
 *   age.ageLabel    // "1 day old"
 *   age.stale       // > STALE_AFTER_HOURS
 */
export function useDataAge(opts: { staleAfterHours?: number } = {}): DataAgeInfo {
  const { data, isLoading, isError } = useHealth();
  const now = useNow();
  return describeDataAge(data, { now, isLoading, isError, staleAfterHours: opts.staleAfterHours });
}

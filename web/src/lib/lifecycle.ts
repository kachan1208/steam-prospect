import { fmtIsoMonth, MISSING } from "./format";

/**
 * A game's public LIFECYCLE — when it went on sale, and whether that was Early Access.
 *
 * The mart's release_date is Steam's release date, which for an Early Access graduate is the
 * 1.0 date: Slay the Spire reads "Jan 2019" although it sold (and collected reviews) from
 * Nov 2017. The ETL now carries first_public_date (the first day the game was buyable — the
 * EA start, or the release when it never was EA), release_date_1_0 and is_ea_graduate, and
 * the niche marts judge an EA graduate by its first public date. These helpers make the
 * pages do the same, and read absence (an older mart) as "release date only".
 */
export interface LifecycleFields {
  release_date?: string | null;
  release_year?: number | null;
  first_public_date?: string | null;
  release_date_1_0?: string | null;
  is_ea_graduate?: boolean | null;
}

/**
 * The release part of a row caption, in the app's one date format ("Feb 2024"), falling
 * back to the bare year, then to null (the caller drops it). An Early Access graduate says
 * so — "EA Mar 2023 → 1.0 Jan 2025" — instead of hiding the years it was already on sale.
 */
export function releaseCaption(g: LifecycleFields): string | null {
  const month = g.release_date ? fmtIsoMonth(g.release_date) : MISSING;
  const plain = month !== MISSING ? month : g.release_year != null ? String(g.release_year) : null;
  if (!g.is_ea_graduate) return plain;
  const ea = g.first_public_date ? fmtIsoMonth(g.first_public_date) : MISSING;
  const oneMonth = g.release_date_1_0 ? fmtIsoMonth(g.release_date_1_0) : MISSING;
  const full = oneMonth !== MISSING ? oneMonth : plain;
  if (ea !== MISSING && full) return `EA ${ea} → 1.0 ${full}`;
  return full ? `EA → 1.0 ${full}` : "EA → 1.0";
}

/** Where a game's "launch" is anchored when lining games up by launch. */
export interface LaunchAnchor {
  /** 'YYYY-MM-DD' (or 'YYYY-MM'). */
  iso: string;
  /** Which date it is: the first public date (EA start or release), or the release date
   * because the mart doesn't carry a first public date for this game (yet). */
  source: "first_public" | "release";
}

/** The first public date when the mart has it, else the release date; null when neither
 * parses. */
export function launchAnchor(g: LifecycleFields): LaunchAnchor | null {
  if (g.first_public_date && /^\d{4}-\d{2}/.test(g.first_public_date)) {
    return { iso: g.first_public_date, source: "first_public" };
  }
  if (g.release_date && /^\d{4}-\d{2}/.test(g.release_date)) return { iso: g.release_date, source: "release" };
  return null;
}

/** 'YYYY-MM…' → a month ordinal (year × 12 + month − 1), for month arithmetic. */
export function monthOrdinal(iso: string): number | null {
  const m = /^(\d{4})-(\d{2})/.exec(iso);
  if (!m) return null;
  const month = Number(m[2]);
  if (month < 1 || month > 12) return null;
  return Number(m[1]) * 12 + (month - 1);
}

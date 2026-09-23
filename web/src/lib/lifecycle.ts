import { fmtIsoMonth, MISSING } from "./format";

/**
 * A game's public LIFECYCLE — when it went on sale, and whether that was Early Access.
 *
 * Until the ETL rebuild (PR #178) the mart's release_date was Steam's store date, which for an
 * Early Access graduate is the 1.0 date: Slay the Spire read "Jan 2019" although it sold (and
 * collected reviews) from Nov 2017. The rebuilt mart re-defines the columns:
 *
 *   release_date         the FIRST PUBLIC date — the day the game became buyable (the EA
 *                        start, or the release when it never was EA);
 *   release_date_1_0     Steam's store (1.0) date;
 *   is_ea_graduate       it went Early Access → 1.0;
 *   release_date_source  "store" — the store's own date; "first_review" / "first_review_month"
 *                        — inferred from the first review (month-precision: printed "~Feb 2024").
 *
 * The API's transitional build (PR #177) served the first public date in its own column,
 * first_public_date, beside the OLD release_date; that column is still honoured when present.
 * All of these are optional — an older mart omits them, and every helper here then reads the
 * release date alone, exactly as the pages did before.
 */
export interface LifecycleFields {
  release_date?: string | null;
  release_year?: number | null;
  first_public_date?: string | null;
  release_date_1_0?: string | null;
  is_ea_graduate?: boolean | null;
  release_date_source?: string | null;
}

/** True when the row comes from a mart that carries the lifecycle columns, i.e. where
 * release_date already MEANS the first public date. Judged on NON-null values: the API
 * declares every one of these fields and serves `null` when the loaded mart lacks the
 * column, so "present but null" is exactly what an older mart looks like. */
function isLifecycleMart(g: LifecycleFields): boolean {
  return g.release_date_source != null || g.is_ea_graduate != null;
}

/** True when the release date was inferred from the first review, not read off the store. */
export function isApproxReleaseDate(g: LifecycleFields): boolean {
  return g.release_date_source === "first_review" || g.release_date_source === "first_review_month";
}

/** "Feb 2024", or "~Feb 2024" when the date was inferred from the first review. */
function monthOf(iso: string | null | undefined, approx = false): string | null {
  if (!iso) return null;
  const m = fmtIsoMonth(iso);
  if (m === MISSING) return null;
  return approx ? `~${m}` : m;
}

/**
 * The release part of a row caption, in the app's one date format ("Feb 2024"), falling
 * back to the bare year, then to null (the caller drops it). A date inferred from the first
 * review reads "~Feb 2024". An Early Access graduate says so — "EA Mar 2023 → 1.0 Jan 2025"
 * — instead of hiding the years it was already on sale.
 */
export function releaseCaption(g: LifecycleFields): string | null {
  const approx = isApproxReleaseDate(g);
  const plain = monthOf(g.release_date, approx) ?? (g.release_year != null ? String(g.release_year) : null);
  if (!g.is_ea_graduate) return plain;
  // The first public (EA) date: its own column on the transitional API, else release_date
  // itself on a lifecycle mart.
  const ea = g.first_public_date ? monthOf(g.first_public_date) : monthOf(g.release_date, approx);
  const full = monthOf(g.release_date_1_0);
  if (ea && full) return `EA ${ea} → 1.0 ${full}`;
  if (ea) return `EA ${ea} → 1.0`;
  return full ? `EA → 1.0 ${full}` : "EA → 1.0";
}

/** Where a game's "launch" is anchored when lining games up by launch. */
export interface LaunchAnchor {
  /** 'YYYY-MM-DD' (or 'YYYY-MM'). */
  iso: string;
  /** Which date it is: the first public date (EA start or release), or the store release
   * date because the data doesn't carry a first public date for this game (an older mart —
   * an EA game is then anchored on its 1.0). */
  source: "first_public" | "release";
}

/** The first public date when the data has it, else the release date; null when neither
 * parses. */
export function launchAnchor(g: LifecycleFields): LaunchAnchor | null {
  if (g.first_public_date && /^\d{4}-\d{2}/.test(g.first_public_date)) {
    return { iso: g.first_public_date, source: "first_public" };
  }
  if (g.release_date && /^\d{4}-\d{2}/.test(g.release_date)) {
    return { iso: g.release_date, source: isLifecycleMart(g) ? "first_public" : "release" };
  }
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

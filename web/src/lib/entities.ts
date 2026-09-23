/**
 * Split mart_game's comma-joined `developers` / `publishers` strings into entity names.
 *
 * Steam joins multiple credits with a bare "," ("Mike Klubnika,GDeavid"), but entity names
 * themselves legally contain ", Inc." / ", Ltd." style corporate suffixes ("FromSoftware,
 * Inc.", "CAPCOM Co., Ltd.") — so a naive split(",") shears one company into two. Rule:
 * split on ",", then re-merge any token that is *just* a corporate suffix (optionally
 * trailed by a parenthetical region note, e.g. "Inc. (Japan)") back into the previous
 * token, restoring the ", " the split consumed.
 *
 * This mirrors the ETL's entity-normalization suffix-remerge tunable (the list of suffix
 * tokens the entity marts use when building mart_entity from the same strings) — keep the
 * two lists in sync, or links from game pages will point at names mart_entity doesn't have.
 */
const SUFFIX_TOKEN =
  /^(inc|incorporated|llc|ltd|limited|co|corp|corporation|gmbh|s\.?r\.?o|plc|llp|lp|kk|kg|ag|ab|bv|oy|sa|srl|pte|pty|jr|sr)\.?(\s*\(.*\))?$/i;

export function splitEntities(joined: string | null | undefined): string[] {
  if (!joined) return [];
  const out: string[] = [];
  for (const raw of joined.split(",")) {
    const token = raw.trim();
    if (!token) continue;
    if (out.length > 0 && SUFFIX_TOKEN.test(token)) {
      out[out.length - 1] = `${out[out.length - 1]}, ${token}`;
    } else {
      out.push(token);
    }
  }
  return out;
}

// ---- revenue-estimate base for the career stat tiles -------------------------------------

/**
 * How many of an entity's releases the revenue tiles are actually computed over.
 *
 * mart_entity is explicit that total_rev / median_rev / p90_rev / hit_rate_200k are all over
 * the games that HAVE an estimate — "NULL-estimate games are excluded from the denominator
 * rather than silently counted as misses" (etl/marts/mart_entity.sql). The mart is right; the
 * page was not. It printed hit_rate_200k next to a "Games" tile carrying n_games, and labelled
 * it "Share of releases clearing $200K est." — so /entity/publisher?name=Hooded Horse read
 * "GAMES 50" and "91%", when 91% is 30/33 and the share of the 50 releases it lists is 60%.
 * Same tile group, same defect: "median $3.9M per release" is the median of those 33; over the
 * 50 the page tabulates it is $1.9M. Measured over 700 prod entity profiles (2026-09-01),
 * 41.9% list more releases than the percentage's base, up to 4x (PlayWay S.A.: "GAMES 450",
 * 33.6% = 83/247, but 83/450 = 18.4%).
 *
 * `estimated` is reconstructed from the profile's own games array rather than recomputed from
 * anything: mart_entity_games and _entity_game_facts are built from the same INNER JOIN to
 * mart_game, so "rows with a non-null est_rev_reviews" is the mart's denominator exactly. Spot-
 * checked against prod — Hooded Horse 33, PlayWay S.A. 247, FromSoftware, Inc. 12 — each
 * reproducing the API's hit_rate_200k to the digit.
 */
export interface RevenueEstimateBase {
  /** Releases the page lists — the "Games" tile. */
  listed: number;
  /** Releases with a revenue estimate — the denominator of every revenue tile. */
  estimated: number;
}

export function revenueEstimateBase(
  games: readonly { est_rev_reviews: number | null }[],
): RevenueEstimateBase {
  return {
    listed: games.length,
    estimated: games.filter((g) => g.est_rev_reviews !== null).length,
  };
}

/**
 * Minimum estimated releases before the hit-rate tile paints its "strong" verdict colour.
 *
 * Same rule as the game teardown's STANDOUT_MIN_RATED (components/charts/AspectDivergingBars
 * .tsx), applied to this metric's own distribution — a verdict may not rest on a base too small
 * to produce anything but a degenerate answer. Share of entities whose hit_rate_200k comes out
 * exactly 0% or 100%, by estimated-release base, over the 700-profile prod sweep:
 *
 *     1 -> 100.00%   4 -> 43.86%   8-9   -> 14.29%   20-29 -> 8.57%
 *     2 ->  60.69%   5 -> 24.14%   10-14 ->  6.67%   30-49 -> 14.29%
 *     3 ->  36.67%   6-7 -> 23.73%  15-19 ->  3.70%   50+  ->  0.00%
 *
 * The elbow is the same crossing the aspect curve has, 8-9 -> 10-14 (x0.47), so the floor is
 * the same number. The NUMBER is never suppressed — unlike a 1-of-1 aspect share, "2 of 2
 * releases cleared $200K" is a true and useful fact about a two-game studio, and 73.6% of
 * entities have fewer than 10 estimated releases, so blanking it would gut the page. Only the
 * colour goes: it fires on 87% of all entities today (610/700), 5.4% of them off a single
 * estimated release, which makes it a decoration rather than a verdict. Above the floor it
 * distinguishes something.
 */
export const ENTITY_MIN_ESTIMATED_FOR_VERDICT = 10;

/**
 * THE SMALL-SAMPLE RULE for a studio's hit rate and top-10% revenue (2026-09-23).
 *
 * The profile printed "100%" and a top-10% figure for LocalThunk, whose whole estimated record
 * is one game (Balatro): a "rate" over one release can only be 0% or 100%, and the 90th
 * percentile of one number is that number. Neither was marked. So, over the releases WITH an
 * estimate (the base both are computed over):
 *
 *   - under ENTITY_MIN_ESTIMATED_FOR_VERDICT (10): the hit rate prints as the COUNT it is —
 *     "1 of 1" — never as a percent, and the top-10% figure is withheld: "only 1 game in 10
 *     earns more" needs ten games to mean anything;
 *   - under ENTITY_MIN_FOR_ANY_RATE (3): the same, flagged "tiny sample" instead of "small
 *     sample" — the same 3-game floor /studios' list withholds its hit rate below.
 *
 * The numbers are never hidden without the n that hid them: every withheld value says how
 * many releases the studio has and how many the figure needs.
 */
export const ENTITY_MIN_FOR_ANY_RATE = 3;

export type SampleSize = "ok" | "small" | "tiny" | "none";

/** How much weight a studio's estimated base can carry. */
export function sampleSize(estimated: number): SampleSize {
  if (estimated <= 0) return "none";
  if (estimated < ENTITY_MIN_FOR_ANY_RATE) return "tiny";
  if (estimated < ENTITY_MIN_ESTIMATED_FOR_VERDICT) return "small";
  return "ok";
}

/** The hit rate's COUNT — releases over $200K — recovered from the rate and its base. The
 * mart stores only the ratio; with the base known exactly (revenueEstimateBase) the count is
 * the ratio × base, rounded (Hooded Horse: 0.909… × 33 = 30). */
export function hitCount(hitRate: number | null | undefined, base: RevenueEstimateBase): number | null {
  if (hitRate == null || !Number.isFinite(hitRate) || base.estimated <= 0) return null;
  return Math.round(hitRate * base.estimated);
}

/** "1 of 1 release" / "3 of 5 releases" — the hit rate as the count it is. */
export function hitCountLabel(hits: number, base: RevenueEstimateBase): string {
  return `${hits} of ${base.estimated} ${base.estimated === 1 ? "release" : "releases"}`;
}

/** Sub-label for the "Hit rate >= $200K" tile — always names the denominator, and says how many
 * releases sit outside it, so dividing the two numbers the page shows can only land on the
 * number the page printed (the rule pressToneSummary established for press tone). */
export function hitRateSub(base: RevenueEstimateBase): string {
  if (base.estimated === 0) return "No release has a revenue estimate";
  if (base.estimated === base.listed) {
    return `Share of all ${base.listed} releases clearing $200K est.`;
  }
  return `Share of the ${base.estimated} releases with a revenue estimate — ${
    base.listed - base.estimated
  } of ${base.listed} have none`;
}

/** Sub-label for the "P90 est. revenue" tile. Both p90_rev and median_rev share the estimated
 * base, so one clause covers them. Full coverage keeps the original wording. */
export function medianRevSub(medianText: string, base: RevenueEstimateBase): string {
  if (base.estimated === 0) return "No release has a revenue estimate";
  if (base.estimated === base.listed) return `median ${medianText} per release`;
  return `median ${medianText} — both over the ${base.estimated} of ${base.listed} releases with an estimate`;
}

/** Sub-label for the "Est. revenue, all games" tile — a SUM, but still over the estimated
 * subset only (SUM ignores NULLs), so "across the catalog" was overstating its coverage too.
 * (It used to read "Boxleiter gross …" — the estimator's jargon name; the tile's ⓘ now
 * carries the formula instead.) */
export function totalRevSub(base: RevenueEstimateBase): string {
  if (base.estimated === 0) return "No release has a revenue estimate";
  if (base.estimated === base.listed) {
    return base.listed === 1 ? "Its one release" : `Summed over all ${base.listed} releases`;
  }
  return `Summed over the ${base.estimated} of ${base.listed} releases with an estimate`;
}

/** Sub-label for the "Games" tile — undefined at full coverage, so an entity whose whole
 * catalogue is estimated (the FromSoftware case) reads exactly as it always did. */
export function gamesSub(base: RevenueEstimateBase): string | undefined {
  if (base.estimated === base.listed) return undefined;
  return `${base.listed - base.estimated} with no revenue estimate`;
}

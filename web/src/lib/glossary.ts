/**
 * THE GLOSSARY — the one place every metric the UI prints is named, explained and defined.
 *
 * Why this exists (2026-09-22 UX review): the same number wore several names across pages
 * (revenue alone was "Est. gross", "Est. revenue", "Gross revenue", "Total est. revenue" and
 * "Est. gross revenue"), labels leaked internal jargon ("entrant ratio", "P90", "Opp v2"),
 * and the explanations that did exist were hover-only `title=` strings nobody on a phone or
 * a keyboard could read. Pages now take a metric's words from here — through `<InfoTip
 * term="…">` or the `term` prop on KpiCell / StatTile / BulletMeter / HeaderLabel — so one
 * edit here fixes the copy everywhere, and a rename cannot drift between pages.
 *
 * THE RULES every entry follows (the owner's, and glossary.test.ts enforces them):
 *   - `label` is plain language. Never a column name, never "P90", "Opp v2", "entrant
 *     ratio", "solo-friendly". It is what a card or a tooltip heading says.
 *   - `short` is the column-header form of the SAME name (≤ 16 characters).
 *   - `meaning` says what the number tells a solo developer, bearish reading included.
 *   - `formula` is the exact computation for every computed metric — transcribed from the
 *     code that computes it (etl/marts/*.sql, etl/build_marts.py, lib/radarVerdict.ts),
 *     never paraphrased into something the code does not do. Pages substitute the row's
 *     REAL numbers into it through InfoTip's `worked` prop, e.g. "(176 − 190) ÷ 190 = −7.4%".
 *   - `notes` carries the caveats and the sentinel states (floored / capped / not scored),
 *     so a NULL or a clamp is always explained and never shown bare.
 *   - ONE canonical name per concept. `replaces` lists the retired names so the page agents
 *     can find and swap them.
 *
 * Constants quoted in formulas (0.40 / 0.22 / 0.20 / 0.18, 0.35, 1.08, 0.85, +40%, +15%, 30
 * owners per review …) mirror etl/build_marts.py; keep them in lockstep with it.
 */

export type GlossaryUnit =
  | "score" // 0–100
  | "multiplier" // ×0.35–×1.00
  | "usd"
  | "count"
  | "percent" // a share or a change, printed as %
  | "percentPoints"
  | "ratio" // e.g. 1.08×
  | "players"
  | "hours"
  | "months"
  | "rank" // percentile rank, 0–100
  | "category" // a verdict / tier / flag
  | "series"; // a chart of values over time

export interface GlossaryEntry {
  /** Plain-language name — what a card or tooltip heading says. Never jargon. */
  label: string;
  /** Column-header form of the same name (≤ 16 characters). */
  short: string;
  /** What it means, in one or two plain sentences. */
  meaning: string;
  /** The exact computation. Required whenever `computed` is true. */
  formula?: string;
  unit: GlossaryUnit;
  /** Caveats, how to read it, and what its sentinel states (NULL / floored / capped) mean. */
  notes?: string;
  /** Where the underlying data comes from. */
  source?: string;
  /** False only for raw facts that are shown as-is (a list price, a live sample). */
  computed: boolean;
  /** API fields this entry documents — grep-ability for the page agents. */
  fields?: readonly string[];
  /** Names this canonical label replaces (retired labels still found in pages). */
  replaces?: readonly string[];
}

const REVIEWS_SOURCE =
  "Steam's own review counts where available, else SteamSpy or our review sample (an honest lower bound).";
const CUT_NOTE =
  "Computed per cut — the window (last 24 months or all time) × the review floor — so it moves with those controls.";
const RANK_NOTE =
  "A rank against the other niches in the same cut, not an absolute amount: 50 is a middling niche.";

export const GLOSSARY = {
  // ─────────────────────────────── the Opportunity score ───────────────────────────────
  opportunity_v2: {
    label: "Opportunity score",
    short: "Opportunity",
    meaning:
      "A 0–100 screening score for how well a niche rewards a NEW entrant: growing demand, money that reaches beyond the top few games and a beatable field — then braked when releases outgrow demand or newcomers underearn. A screening result, not a probability of success.",
    formula:
      "(0.40 × Momentum + 0.22 × Market pull + 0.20 × Revenue spread + 0.18 × Quality gap) × Supply brake, clamped to 0–100. A part that can't be computed drops out of both the sum and the weight total, so it never counts as 0.",
    unit: "score",
    notes:
      "Read the parts before the total: the brake and the weakest part say more than the number. 65+ scores like a niche the Radar would ring “Enter now”. " +
      CUT_NOTE,
    source: "mart_niche, rebuilt nightly",
    computed: true,
    fields: ["opportunity_v2"],
    replaces: ["Opp v2", "Opportunity v2", "opp"],
  },
  momentum: {
    label: "Momentum",
    short: "Momentum",
    meaning:
      "Is demand for the niche growing? The 24-month demand trend squashed onto 0–100: 50 = flat, 88 = the Radar's +40% “enter” bar, 11 = its −30% “declining” bar.",
    formula: "50 + 50 × tanh( ln(1 + Demand trend) ÷ ln(1.40) ), with Demand trend as a fraction (+40% → 0.40).",
    unit: "score",
    notes:
      "Weight 0.40 — the largest on purpose: a market's direction outranks its size. Not scored for an emerging niche or one with no prior-window baseline; the blend then drops it instead of reading it as 0.",
    computed: true,
    fields: ["momentum"],
  },
  market_pull: {
    label: "Market pull",
    short: "Market pull",
    meaning:
      "Does a typical game here earn, and how big is the pie? The money term of the score, deliberately given a supporting weight.",
    formula: "0.6 × Typical-game rank + 0.4 × Market size rank",
    unit: "score",
    notes: "Weight 0.22. Always present. " + RANK_NOTE,
    computed: true,
    fields: ["market_pull"],
  },
  typical_game_rank: {
    label: "Typical-game rank",
    short: "Typical rank",
    meaning: "How well the niche's typical game does compared with other niches — revenue, owners and recent reviews.",
    formula:
      "0.4 × rank(Median revenue) + 0.3 × rank(median Owners) + 0.3 × rank(median reviews of games released in the last 24 months); rank = percentile rank among niches in the same cut, 0–100.",
    unit: "rank",
    notes: "The API names this column `demand` — it is NOT the demand trend. " + RANK_NOTE,
    computed: true,
    fields: ["demand"],
  },
  market_size: {
    label: "Market size rank",
    short: "Size rank",
    meaning: "How big the niche's whole audience is compared with other niches.",
    formula: "percentile rank of Total owners among niches in the same cut, 0–100",
    unit: "rank",
    notes: "A big pie with weak per-game numbers means people play the hits — it doesn't hand a new entrant players.",
    computed: true,
    fields: ["market_size"],
  },
  revenue_spread: {
    label: "Revenue spread",
    short: "Rev. spread",
    meaning:
      "Does the money reach more than the top few games? 50 sits exactly on the winner-take-most line (the top 5% hold 85% of revenue); 100 when they hold 70% or less; 0 when they hold all of it.",
    formula: "100 × clamp( (1 − Top-5% revenue share) ÷ 0.30, 0, 1 )",
    unit: "score",
    notes:
      "Weight 0.20. Capped at 100 once the top 5% hold 70% or less, floored at 0 when they hold everything. Not scored when revenue concentration is unknown.",
    computed: true,
    fields: ["revenue_spread"],
  },
  quality_gap: {
    label: "Quality gap",
    short: "Quality gap",
    meaning: "How beatable is the field? The niche's share of thin or weakly-reviewed incumbents, ranked against other niches.",
    formula: "percentile rank of Beatable share among niches in the same cut, 0–100",
    unit: "rank",
    notes:
      "Weight 0.18. A rank, not a share: 90 means more beatable than 90% of niches, not that 90% of its games are weak. " +
      RANK_NOTE,
    computed: true,
    fields: ["quality_gap"],
  },
  beatable_share: {
    label: "Beatable share",
    short: "Beatable",
    meaning: "Share of the niche's scored games that look beatable: under 80% positive reviews, fewer than 50 reviews, or no rating yet.",
    formula: "games with (positive reviews < 80% OR reviews < 50 OR no rating) ÷ scored games",
    unit: "percent",
    notes: CUT_NOTE,
    computed: true,
    fields: ["beatable_share"],
  },
  supply_brake: {
    label: "Supply brake",
    short: "Brake",
    meaning:
      "The score's only downside term: a multiplier from ×0.35 to ×1.00 that bites when releases grow faster than demand, or when recent entrants earn below the catalog norm. Either one alone can sink the score.",
    formula: "0.35 + 0.65 × Supply room ÷ 100; ×1.00 when Supply room is unknown",
    unit: "multiplier",
    notes:
      "Unknown supply is never a penalty (×1.00 = no evidence of pressure). Not the Radar ring's supply read: the ring asks whether releases grow more than 15% a year; the brake asks whether they outgrow DEMAND — about a quarter of niches get different answers, by design.",
    computed: true,
    fields: ["supply_brake"],
  },
  supply_room: {
    label: "Supply room",
    short: "Supply room",
    meaning:
      "How much room new releases leave, 0–100: the weaker of Flood room (releases vs demand) and Entrant room (what recent entrants earn). 100 = no pressure.",
    formula: "min(Flood room, Entrant room); whichever exists when only one does",
    unit: "score",
    notes: "Unknown for emerging niches — the brake then stays at ×1.00.",
    computed: true,
    fields: ["supply_room"],
  },
  flood_room: {
    label: "Flood room",
    short: "Flood room",
    meaning:
      "Are releases outgrowing demand? 100 while demand keeps pace, 50 when releases outgrow demand by 15% a year, 0 at 30%.",
    formula:
      "100 × (1 − clamp( (ln(1 + Releases YoY) − ln(1 + Demand trend) ÷ 2) ÷ (2 × ln 1.15), 0, 1 ))",
    unit: "score",
    notes: "Capped at 100: a shrinking pipeline is at best “calm”, never a bonus — rewarding it is how dying niches used to top the ranking.",
    computed: true,
  },
  entrant_room: {
    label: "Entrant room",
    short: "Entrant room",
    meaning: "Do recent entrants earn? 0 when newcomers earn half the back catalog's median or less, 100 at the 1.08× catalog norm.",
    formula: "100 × clamp( (Newcomer earnings − 0.5) ÷ (1.08 − 0.5), 0, 1 )",
    unit: "score",
    notes: "Capped at 100 at the norm: above it is a survivor artifact, not evidence, so it earns no bonus.",
    computed: true,
  },

  // ─────────────────────────────── the Radar's axes ───────────────────────────────
  demand_trend_24m_pct: {
    label: "Demand trend, 24 months",
    short: "Demand 24m",
    meaning:
      "Is the niche's audience growing? The change in reviews posted on its games over the last 24 complete months vs the 24 before — reviews stand in for player activity.",
    formula: "(reviews in the last 24 months − reviews in the 24 months before) ÷ reviews in the 24 months before",
    unit: "percent",
    notes:
      "The Radar's first axis: +40% or more is its “enter” bar, −30% or worse its “declining” bar. One value per niche — identical at every window and review floor. An emerging niche shows no % (its prior window is near zero by construction).",
    source: "Steam's own monthly review histograms (uncapped), games with 50+ reviews",
    computed: true,
    fields: ["demand_trend_24m_pct", "reviews_24m", "reviews_prev_24m"],
    replaces: ["Demand / 24m"],
  },
  saturation_yoy: {
    label: "Releases, year over year",
    short: "Releases YoY",
    meaning:
      "Is the release pipeline growing? The change in how many games joined the niche last full calendar year vs the year before.",
    formula: "(releases last full year − releases the year before) ÷ releases the year before",
    unit: "percent",
    notes:
      "Whole niche at every review count — it ignores the window and review-floor controls. Above +15% is the Radar's “flooding” line. Negative means a SHRINKING pipeline: low competition in a shrinking niche is decline, not opportunity.",
    computed: true,
    fields: ["saturation_yoy", "n_recent_year", "n_prior_year"],
    replaces: ["Saturation YoY", "Saturation"],
  },
  radar_verdict: {
    label: "Radar verdict",
    short: "Verdict",
    meaning:
      "The Radar's call on a niche — Enter now, Watch, Emerging, Crowded or Declining — read off its demand trend, its release pipeline and how concentrated its revenue is.",
    formula:
      "First match wins: Emerging (no comparable demand base) → Enter now (Demand trend ≥ +40% and Releases YoY ≤ +15% or unknown) → Declining (Demand trend ≤ −30%) → Crowded (top 5% hold > 85% of revenue, or Releases YoY > +15% with demand flat, falling or unknown) → Watch (everything else).",
    unit: "category",
    notes:
      "Newcomer earnings and Singleplayer share are shown beside it but never move it. A verdict on thin evidence is flagged “caution”.",
    computed: true,
    replaces: ["Ring"],
  },
  demand_emerging: {
    label: "Emerging",
    short: "Emerging",
    meaning:
      "The niche has no comparable demand base — typical of a young Steam tag whose older games were never re-tagged — so its trend % isn't headlined and it is judged on absolute volume instead.",
    formula:
      "reviews in the prior 24 months < 1,000 OR (reviews on games released in the last 24 months ÷ reviews in the last 24 months) ≥ 80%",
    unit: "category",
    computed: true,
    fields: ["demand_emerging", "reviews_24m_new_share"],
  },
  reviews_24m: {
    label: "Reviews, last 24 months",
    short: "Reviews 24m",
    meaning: "How many reviews players posted on the niche's games in the last 24 complete months — its absolute demand volume.",
    formula: "sum of each member game's reviews over the last 24 complete months",
    unit: "count",
    source: "Steam's own monthly review histograms, games with 50+ reviews",
    computed: true,
    fields: ["reviews_24m"],
  },

  // ─────────────────────────────── revenue ───────────────────────────────
  est_revenue: {
    label: "Est. revenue",
    short: "Est. revenue",
    meaning:
      "Estimated lifetime GROSS revenue from copies sold — before Steam's ~30% cut, refunds, discounts and taxes. An estimate with real error bars, not reported sales.",
    formula: "reviews × 30 owners-per-review × launch price",
    unit: "usd",
    notes:
      "30 is the mid of the cited 20–55 owners-per-review band, applied flat to every game (not fitted per genre) so every page agrees. Free titles have no box revenue and read “Free”.",
    source: REVIEWS_SOURCE,
    computed: true,
    fields: ["est_rev_reviews", "est_revenue"],
    replaces: ["Est. gross", "Gross revenue", "Est. gross revenue", "Est. rev"],
  },
  est_revenue_range: {
    label: "Est. revenue range",
    short: "Est. range",
    meaning: "The plausible low and high of Est. revenue — roughly a 2–3× spread. Plan on the range, not the middle.",
    formula: "low = reviews × 20 × launch price; high = reviews × 55 × launch price",
    unit: "usd",
    computed: true,
  },
  total_rev: {
    label: "Est. revenue, all games",
    short: "Est. rev (all)",
    meaning: "Est. revenue added up across every game in the set — the size of the pie in dollars, dominated by the hits.",
    formula: "sum of Est. revenue over the scored games",
    unit: "usd",
    computed: true,
    fields: ["total_rev"],
    replaces: ["Total est. revenue"],
  },
  median_rev: {
    label: "Median revenue",
    short: "Median rev",
    meaning: "Half the scored games earn less than this — what a realistic entry should expect, not what the hits make.",
    formula: "median (50th percentile) of Est. revenue across the scored games",
    unit: "usd",
    notes: CUT_NOTE,
    computed: true,
    fields: ["median_rev"],
  },
  p25_rev: {
    label: "Bottom-25% revenue",
    short: "Bottom 25%",
    meaning: "A quarter of the scored games earn less than this.",
    formula: "25th percentile of Est. revenue across the scored games",
    unit: "usd",
    notes: CUT_NOTE,
    computed: true,
    fields: ["p25_rev"],
    replaces: ["P25 revenue", "P25"],
  },
  p75_rev: {
    label: "Top-25% revenue",
    short: "Top 25%",
    meaning: "A quarter of the scored games earn more than this — a good-but-not-exceptional outcome.",
    formula: "75th percentile of Est. revenue across the scored games",
    unit: "usd",
    notes: CUT_NOTE,
    computed: true,
    fields: ["p75_rev"],
    replaces: ["P75 revenue", "P75"],
  },
  p90_rev: {
    label: "Top-10% revenue",
    short: "Top 10% rev",
    meaning: "Only 1 scored game in 10 earns more than this — what the successful titles make, not what a typical entry makes.",
    formula: "90th percentile of Est. revenue across the scored games",
    unit: "usd",
    notes: "Read it beside Median revenue: a big gap means the money sits with a few hits. " + CUT_NOTE,
    computed: true,
    fields: ["p90_rev"],
    replaces: ["P90 rev", "P90 revenue", "P90 est. revenue", "P90"],
  },
  hit_rate_200k: {
    label: "Games earning $200K+",
    short: "Hit ≥$200K",
    meaning: "The odds a serious title “works” here: the share of scored games whose Est. revenue is above $200K.",
    formula: "games with Est. revenue > $200K ÷ scored games",
    unit: "percent",
    notes: CUT_NOTE,
    computed: true,
    fields: ["hit_rate_200k"],
    replaces: ["Hit rate", "Hit rate ≥ $200K"],
  },
  hit_rate_500k: {
    label: "Games earning $500K+",
    short: "Hit ≥$500K",
    meaning: "The share of scored games whose Est. revenue is above $500K — a clear commercial success.",
    formula: "games with Est. revenue > $500K ÷ scored games",
    unit: "percent",
    notes: CUT_NOTE,
    computed: true,
    fields: ["hit_rate_500k"],
    replaces: ["Hit rate ≥ $500K"],
  },
  winner_concentration: {
    label: "Top-5% revenue share",
    short: "Top-5% share",
    meaning:
      "How much of the niche's total Est. revenue its top 5% of games take. Above 85% is winner-take-most: judge the niche by its median, not its hits.",
    formula: "Est. revenue of the games at or above the 95th revenue percentile ÷ Est. revenue of all scored games",
    unit: "percent",
    notes: CUT_NOTE,
    computed: true,
    fields: ["winner_concentration"],
    replaces: ["Winner concentration", "Concentration"],
  },
  entrant_ratio: {
    label: "Newcomer earnings",
    short: "Newcomers earn",
    meaning:
      "What games released in the last 24 months earn compared with the niche's whole back catalog. Read it against the ~1.08× catalog norm, not 1.0: below it, recent entrants underearn the games already there.",
    formula:
      "median Est. revenue of games released in the last 24 months ÷ median Est. revenue of all the niche's games (same review floor)",
    unit: "ratio",
    notes:
      "Never moves a Radar ring, but it feeds the supply brake — on its own it can halve an Opportunity score. Pinned near 1.00 for emerging niches (the two medians are the same games), so it is not used there.",
    computed: true,
    fields: ["entrant_ratio"],
    replaces: ["Entrant ratio", "Newcomer economics"],
  },

  // ─────────────────────────────── solo lens ───────────────────────────────
  singleplayer_share: {
    label: "Singleplayer share",
    short: "Singleplayer",
    meaning:
      "Share of the niche's scored games that can be played single-player — a no-netcode signal, not a claim that the game is a small build.",
    formula: "games playable single-player ÷ scored games",
    unit: "percent",
    notes:
      "Most niches sit between 95% and 99% (catalog median ≈ 97.5%), so it can't rank niches — it flags the few that depend on multiplayer. Under 80% leans multiplayer. " +
      CUT_NOTE,
    source: "Steam's store categories (“Single-player”), with the community tag as fallback",
    computed: true,
    fields: ["solo_viability"],
    replaces: ["Solo-friendly", "Solo viability (as a %)"],
  },
  solo_tier: {
    label: "Solo viability",
    short: "Solo viability",
    meaning:
      "A three-way flag read off Singleplayer share: “solo” (unremarkable, like ~92% of niches), “mixed” (a real multiplayer minority) or “team” (multiplayer-dependent).",
    formula: "team if Singleplayer share < 80%; mixed if 80–90%; solo if ≥ 90%",
    unit: "category",
    notes: "A flag, not a scale, and never part of the Opportunity score or the Radar verdict: buildability depends on the builder, not the market.",
    computed: true,
    fields: ["solo_tier"],
    replaces: ["Solo-friendly"],
  },
  self_published_share: {
    label: "Self-published share",
    short: "Self-pub",
    meaning: "Share of the niche's scored games released by their own developer, without a separate publisher.",
    formula: "self-published games ÷ scored games",
    unit: "percent",
    computed: true,
    fields: ["self_published_share", "self_pub_share"],
  },
  indie_share: {
    label: "Indie share",
    short: "Indie",
    meaning: "Share of the niche's scored games Steam tags as Indie.",
    formula: "games tagged Indie ÷ scored games",
    unit: "percent",
    computed: true,
    fields: ["indie_share"],
  },
  med_playtime_h: {
    label: "Median playtime",
    short: "Playtime",
    meaning: "How much content the niche's typical game offers, read from how long reviewers had played. Over ~20 hours is heavy scope for a solo build.",
    formula: "median over member games of each game's median reviewer playtime, in hours",
    unit: "hours",
    source: "our review sample (recency-biased)",
    computed: true,
    fields: ["med_playtime_h"],
  },

  // ─────────────────────────────── live players ───────────────────────────────
  players_now: {
    label: "Players now",
    short: "Players now",
    meaning: "Concurrent players at our latest capture — a single point sample, not the day's peak.",
    unit: "players",
    notes: "Captured once a night, so a game whose players peak at another hour reads low.",
    source: "Steam's current-players count, sampled nightly",
    computed: false,
    fields: ["live_players"],
    replaces: ["Live players"],
  },
  niche_players_now: {
    label: "Players now, whole niche",
    short: "Playing now",
    meaning: "Everyone playing the niche's games at our latest captures — dominated by its biggest games, so it says little about a newcomer's odds.",
    formula: "sum of each member game's latest nightly sample, if taken within the last 7 days (games with 50+ reviews)",
    unit: "players",
    notes: "Every measured game in the niche — it ignores the window and review-floor controls.",
    computed: true,
    fields: ["total_players_now"],
  },
  players_trend_7d_pct: {
    label: "7-day players trend",
    short: "Players 7d",
    meaning:
      "Is the audience growing this week? Average players over the last 7 days vs the 7 before, counting only games measured in both weeks so wider coverage can't fake a trend.",
    formula:
      "(Σ last-7-day average players − Σ prior-7-day average players) ÷ Σ prior-7-day average players, over games measured in both windows",
    unit: "percent",
    notes:
      "Short-term and seasonal: sales, weekends and holidays move every niche at once — compare it with the market-relative form before reading it as momentum. A niche needs 10+ games measured in both weeks; for one game the sums are just that game's two averages.",
    computed: true,
    fields: ["players_trend_7d_pct"],
    replaces: ["Players / 7d", "7-day trend"],
  },
  players_trend_7d_vs_market: {
    label: "7-day players trend vs market",
    short: "7d vs market",
    meaning:
      "The 7-day players trend minus the whole catalog's, so a Steam-wide week (a sale, a holiday) doesn't read as niche momentum. Positive = growing faster than Steam overall.",
    formula: "7-day players trend − the whole catalog's 7-day players trend, in percentage points (both same-panel)",
    unit: "percentPoints",
    notes: "E.g. +4.0% for the niche vs +6.5% for the catalog = −2.5 pts: it grew, but slower than Steam.",
    computed: true,
  },
  players_7d_avg: {
    label: "7-day average players",
    short: "Avg 7d",
    meaning: "The game's typical concurrent-player level over the last week.",
    formula: "mean of the game's nightly samples over the last 7 days",
    unit: "players",
    computed: true,
    fields: ["players_7d_avg"],
  },
  players_coverage: {
    label: "Fresh-capture share",
    short: "Coverage",
    meaning:
      "How much of Players now was actually measured in the last 2 days; the rest is carried forward from captures up to 7 days old. Low coverage = trust the total less.",
    formula: "players in games sampled within the last 2 days ÷ Players now, whole niche",
    unit: "percent",
    computed: true,
    fields: ["players_coverage"],
  },
  lifetime_survival_12m: {
    label: "Longevity",
    short: "Longevity",
    meaning:
      "Of the niche's games that ever averaged 100+ concurrent players in a month, the share still averaging 10+ a year later.",
    formula:
      "games still alive 12 months after their first 100+ month ÷ games whose first 100+ month is at least 12 months old (dead = first full month averaging under 10 players)",
    unit: "percent",
    source: "steamcharts monthly averages (top ~8,000 games only)",
    computed: true,
    fields: ["lifetime_survival_12m", "lifetime_median_dead_months"],
  },

  // ─────────────────────────────── copies, owners, reviews ───────────────────────────────
  units: {
    label: "Est. units sold",
    short: "Est. units",
    meaning: "Estimated copies sold, on the same estimate as Est. revenue — so Est. revenue ÷ launch price lands exactly here.",
    formula: "reviews × 30 owners-per-review (= Est. revenue ÷ launch price)",
    unit: "count",
    notes: "Owned ≠ played ≠ paid full price. The SteamSpy owners figure is a different method and is shown separately.",
    source: REVIEWS_SOURCE,
    computed: true,
    replaces: ["Units sold", "Est. units"],
  },
  owners: {
    label: "Owners (SteamSpy)",
    short: "Owners",
    meaning: "SteamSpy's estimate of how many Steam accounts own the game — a different method from Est. units sold.",
    formula:
      "midpoint of SteamSpy's owner range; games SteamSpy still places in its bottom 0–20K bucket use reviews × the genre's fitted owners-per-review ratio (20–55) instead",
    unit: "count",
    notes:
      "From a SteamSpy snapshot, not a live feed — check its date before comparing with recent reviews; owners of anything released since lag.",
    source: "SteamSpy snapshot",
    computed: true,
    fields: ["owners_mid", "owners_est"],
  },
  total_owners: {
    label: "Total owners",
    short: "Total owners",
    meaning: "Owners added up across the niche's scored games — the size of the pie, dominated by the hits.",
    formula: "sum of Owners (SteamSpy) over the scored games",
    unit: "count",
    source: "SteamSpy snapshot",
    computed: true,
    fields: ["total_owners"],
  },
  reviews: {
    label: "Reviews",
    short: "Reviews",
    meaning: "The game's total Steam review count — the input every revenue and units estimate multiplies.",
    unit: "count",
    source: REVIEWS_SOURCE,
    computed: false,
    fields: ["total_reviews"],
  },
  positive_ratio: {
    label: "Positive reviews",
    short: "Positive %",
    meaning: "Share of the game's reviews that recommend it. Under ~80% starts costing store visibility (Steam's “Mostly Positive” band).",
    formula: "positive reviews ÷ (positive + negative reviews)",
    unit: "percent",
    source: REVIEWS_SOURCE,
    computed: true,
    fields: ["positive_ratio", "median_positive_ratio"],
    replaces: ["Rating"],
  },
  review_velocity: {
    label: "Monthly reviews",
    short: "Reviews / mo",
    meaning:
      "How many reviews the game collected each calendar month since launch — a proxy for sales momentum. The line is the share of the trailing 3 months' reviews that were positive.",
    formula: "reviews posted in the month; positive line = positive ÷ all reviews over the trailing 3 months",
    unit: "series",
    source: "Steam's own per-month review histogram (full history, uncapped)",
    computed: true,
    replaces: ["Review velocity"],
  },
  percentile_vs_genre: {
    label: "Rank vs genre",
    short: "Genre rank",
    meaning:
      "Where the game sits among games in its primary genre with 50+ reviews: “P73” = it beats 73% of them. The ends read “top 1%” / “bottom 1%”.",
    formula: "games in the same primary genre (50+ reviews) with a lower value ÷ (those games − 1) × 100, rounded down",
    unit: "rank",
    computed: true,
    fields: ["rev_pct_in_genre", "reviews_pct_in_genre", "owners_pct_in_genre"],
    replaces: ["Percentile vs. genre"],
  },
  tag_overlap: {
    label: "Tag overlap",
    short: "Tag overlap",
    meaning: "How alike two games are by their top-10 Steam tags: 100% = the same tags, 0% = none shared.",
    formula: "shared tags ÷ all distinct tags across both games' top 10 (Jaccard similarity)",
    unit: "percent",
    notes: "Comparables are also limited to the same primary genre and a nearby price band.",
    computed: true,
    fields: ["jaccard"],
    replaces: ["Jaccard"],
  },
  launch_shape: {
    label: "Launch shape",
    short: "Launch shape",
    meaning:
      "When a genre's first-year reviews arrive, as a weekly pace: a tall first week that falls away fast = front-loaded (the launch week decides most of the year); bars that stay level = slow burn (updates and marketing keep paying).",
    formula:
      "for each window after launch (1w, 2w, 3–4w, 2m, 3m, 4–6m, 7–12m): (median share of first-year reviews landed by the window's end − by its start) ÷ the window's length in weeks",
    unit: "percent",
    notes:
      "Per week so windows of different lengths compare: months 7–12 hold about a fifth of first-year reviews, but spread over 26 weeks. Front-loaded when week 1's weekly pace is 5× or more the months-7–12 pace.",
    source: "our review sample, games at least a year old — shape, not absolute counts",
    computed: true,
  },
  press_mentions: {
    label: "Press mentions",
    short: "Press",
    meaning: "Articles about the game in the tracked games-press outlets — attention it earned, not proof it caused sales.",
    formula: "articles matched to the game by title, at or above the match-confidence bar (Steam News excluded)",
    unit: "count",
    notes: "A fuzzy-matched sample skewed to the last ~year and to English-language outlets.",
    source: "tracked outlets' article metadata (headline, date, outlet) — never the article text",
    computed: true,
    fields: ["total_mentions", "n_articles"],
  },
  price_history: {
    label: "Price history",
    short: "Price history",
    meaning: "The game's Steam store price over time, with discounts — when it went on sale, and how deep.",
    unit: "series",
    notes: "Daily store snapshots since 24 Aug 2026; earlier history isn't recorded.",
    source: "Steam store price, captured daily",
    computed: false,
    fields: ["final_cents", "original_cents", "discount_pct"],
  },
  launch_price: {
    label: "Launch price",
    short: "Price",
    meaning: "The game's Steam list price, the price every revenue estimate multiplies.",
    unit: "usd",
    notes: "List price, not the average price paid — discounts make real revenue lower.",
    computed: false,
    fields: ["price_initial"],
  },
  median_price: {
    label: "Median price",
    short: "Median price",
    meaning: "The middle list price among the scored games — what the niche's buyers are used to paying.",
    formula: "median of launch price across the scored games",
    unit: "usd",
    computed: true,
    fields: ["median_price"],
  },
  n_games: {
    label: "Games",
    short: "Games",
    meaning: "How many games the numbers are computed over. Small counts = thin evidence.",
    formula: "member games released inside the window, at or above the review floor, with an Est. revenue",
    unit: "count",
    notes: "A niche needs 30+ such games in a cut to be scored at all.",
    computed: true,
    fields: ["n_games"],
  },
} as const satisfies Record<string, GlossaryEntry>;

export type GlossaryKey = keyof typeof GLOSSARY;

export const GLOSSARY_KEYS = Object.keys(GLOSSARY) as GlossaryKey[];

/** The entry for a key, typed as the full GlossaryEntry shape. */
export function glossary(key: GlossaryKey): GlossaryEntry {
  return GLOSSARY[key];
}

/** True when `key` names a glossary entry — for callers holding a plain string. */
export function isGlossaryKey(key: string): key is GlossaryKey {
  return Object.prototype.hasOwnProperty.call(GLOSSARY, key);
}

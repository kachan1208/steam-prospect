import { useState } from "react";
import clsx from "clsx";

import type { ReviewAspect } from "../../lib/api";
import { fmtInt, fmtPct } from "../../lib/format";
import { CSS_VAR, MONO} from "../../lib/palette";
import { Badge } from "../ui/Badge";
import { InfoTip } from "../ui/InfoTip";
import { AspectReviewExamples } from "./AspectReviewExamples";

/**
 * TWO DIFFERENT POPULATIONS, NEVER INTERCHANGEABLE.
 *
 * `total_mentions` is the KEYWORD arm: sampled reviews whose text matched this aspect's regex
 * (n_pos_mentions + n_neg_mentions, keyed by the arm that matched). `n_text_pos/neg/neutral`
 * are the CLASSIFIER's: mentions re-keyed to COALESCE(clf_aspect, aspect) with the ~22% the
 * model reads as NONE dropped, deduped to one row per (review, aspect) — see
 * build_marts.compute_aspect_sentiment and mart_game_teardown.sql. The model both DISCARDS
 * off-topic keyword hits and RE-ROUTES mentions between aspects, so the two counts have no
 * fixed relationship in either direction.
 *
 * Measured over 18,493 rendered aspect rows (1,995 games, prod API 2026-09-01): the keyword
 * count equals the classifier-scored total in 1.9% of rows, exceeds it in 79.7%, and falls
 * below it in 18.5%; the keyword/rated ratio runs 1.20 at p25, 1.57 at p50, 20.2 at p95.
 * So printing "155 mentions" beside a share computed over 1 is not an edge case, it is the
 * normal case. Every percentage below therefore carries its own denominator, and the header
 * count is named for the population it actually is.
 */
export function ratedMentions(a: ReviewAspect): number {
  return a.n_text_pos + a.n_text_neg;
}

/**
 * Minimum RATED mentions (positive + negative — the literal denominator of text_pos_share and
 * of text_delta_vs_genre) before we will print either, or badge the row.
 *
 * Chosen from the distribution, not rounded to taste. Share of rows whose text_pos_share comes
 * out a degenerate 0% or 100% — the signature of a base too small to say anything — against the
 * rated base, over the same 18,493-row prod sweep:
 *
 *     rated  1 -> 100.00%    rated  6-7  -> 16.99%    rated 20-29 -> 0.78%
 *     rated  2 ->  70.75%    rated  8-9  -> 10.59%    rated 30-49 -> 0.29%
 *     rated  3 ->  51.18%    rated 10-14 ->  4.67%    rated 50-99 -> 0.04%
 *     rated  4 ->  33.33%    rated 15-19 ->  2.21%    rated 100+  -> 0.00%
 *     rated  5 ->  27.90%
 *
 * The largest proportional fall anywhere on that curve is 8-9 -> 10-14 (10.59% -> 4.67%,
 * x0.44): saturation more than halves crossing 10, and the same step halves the share of rows
 * claiming a differential of |50pp| or more (2.35% -> 1.17%). Ten is where the artifact stops
 * being a visible feature of the page. The cost is bounded: 15.5% of rendered rows lose their
 * percentage (they keep the aspect, the neutral count, and the overall-vote line, which has its
 * own much larger base), and 324 of 4,753 live "Standout strength" badges (6.8%) go away.
 *
 * The old floor was 5 *keyword* mentions, which is the wrong base twice over — too low, and
 * measured on a population the percentage is not computed from. It is exactly why /games/252490
 * shipped "Map & Navigation / Backtracking · 155 mentions · 100% positive · +95pp · Standout
 * strength" off n_text_pos=1, n_text_neg=0: 155 >= 5 passed, 1 >= 10 does not. That row is not
 * a one-off — 89 games in the sweep carry a badge whose entire evidence is a single mention,
 * printed next to a keyword count of up to 412.
 */
export const STANDOUT_MIN_RATED = 10;

/**
 * THE STANDOUT BAR (2026-09-23). A badge claims "players single this out", so it needs a real
 * lead on a real base — the old rule took the top 3 aspects by ANY positive gap vs the genre,
 * which badged CS2's "Controls & Performance" at 23% positive of 56 rated mentions, +3 pts: a
 * mostly-NEGATIVE aspect called a "Standout strength" for being slightly less hated than the
 * genre's. Now all three must hold:
 *
 *   - the split itself leans the badge's way: >= 50% positive for a strength, <= 50% for a
 *     weakness (a strength nobody likes is not a strength);
 *   - the gap vs the genre's own share is at least 10 points — the size of a gap a reader
 *     would act on, well clear of the +3 that won the old badge;
 *   - at least 30 rated mentions, three times the floor for printing a share at all
 *     (STANDOUT_MIN_RATED): below 30 the ±10-pt gap is inside the noise of the split.
 *
 * Weaknesses get the mirror rule and their own badge — the bearish reading is the one a
 * solo developer can act on first. Still at most three of each, largest gap first.
 */
export const BADGE_MIN_RATED = 30;
export const BADGE_MIN_GAP = 0.1;
const BADGE_TOP_N = 3;

function baselineLabel(genre: string | null): string {
  if (!genre || genre === "__all__") return "catalog";
  return genre;
}

function badgeable(a: ReviewAspect): a is ReviewAspect & { text_pos_share: number; text_delta_vs_genre: number } {
  return a.text_pos_share !== null && a.text_delta_vs_genre !== null && ratedMentions(a) >= BADGE_MIN_RATED;
}

/** Aspects players praise clearly MORE than the genre's players praise the same aspect, by
 * what they write: >= 50% positive, >= +10 pts vs genre, >= 30 rated mentions; top 3. */
export function standoutAspects(aspects: ReviewAspect[]): Set<string> {
  return new Set(
    aspects
      .filter(badgeable)
      .filter((a) => a.text_pos_share >= 0.5 && a.text_delta_vs_genre >= BADGE_MIN_GAP)
      .sort((a, b) => b.text_delta_vs_genre - a.text_delta_vs_genre)
      .slice(0, BADGE_TOP_N)
      .map((a) => a.aspect),
  );
}

/** The mirror: aspects panned clearly MORE than the genre pans them — <= 50% positive,
 * <= -10 pts vs genre, >= 30 rated mentions; top 3 by the widest gap. */
export function weakAspects(aspects: ReviewAspect[]): Set<string> {
  return new Set(
    aspects
      .filter(badgeable)
      .filter((a) => a.text_pos_share <= 0.5 && a.text_delta_vs_genre <= -BADGE_MIN_GAP)
      .sort((a, b) => a.text_delta_vs_genre - b.text_delta_vs_genre)
      .slice(0, BADGE_TOP_N)
      .map((a) => a.aspect),
  );
}

/** "62% positive of 183 rated, +12 pts vs Strategy" — one aspect's badge evidence. */
function evidence(a: ReviewAspect): string {
  const pts = Math.round((a.text_delta_vs_genre ?? 0) * 100);
  return `${a.aspect}: ${fmtPct(a.text_pos_share, 0)} positive of ${fmtInt(ratedMentions(a))} rated, ${pts >= 0 ? "+" : ""}${pts} pts vs ${baselineLabel(
    a.baseline_genre,
  )}`;
}

/** The ⓘ for the badges: the rule, and this game's own aspects that cleared it (or didn't). */
export function StandoutRuleTip({ aspects }: { aspects: ReviewAspect[] }) {
  const strong = aspects.filter((a) => standoutAspects(aspects).has(a.aspect));
  const weak = aspects.filter((a) => weakAspects(aspects).has(a.aspect));
  const worked =
    strong.length + weak.length === 0
      ? "No aspect of this game clears the bar either way."
      : [...weak.map((a) => `Weakness — ${evidence(a)}`), ...strong.map((a) => `Strength — ${evidence(a)}`)].join("; ");
  return (
    <InfoTip
      label="Standout strength / weakness"
      meaning="An aspect this game's reviewers praise — or pan — clearly more than players of its genre do about the same aspect, judged from what they write, not their thumbs-up."
      formula={`Strength: ≥ 50% of rated mentions positive AND ≥ +${Math.round(BADGE_MIN_GAP * 100)} pts vs the genre's positive share AND ≥ ${BADGE_MIN_RATED} rated mentions. Weakness: ≤ 50% positive AND ≤ −${Math.round(
        BADGE_MIN_GAP * 100,
      )} pts AND ≥ ${BADGE_MIN_RATED} rated mentions. At most ${BADGE_TOP_N} of each, widest gap first.`}
      worked={worked}
      notes={`${BADGE_MIN_RATED} rated mentions is three times the ${STANDOUT_MIN_RATED} needed to print a share at all — below it a 10-point gap is within the noise.`}
    />
  );
}

/**
 * The one-line sentiment read under an aspect's bar, and whether there is a bar at all.
 *
 * Modelled on pressToneSummary (components/NotableCoverageCard.tsx), which fixed the identical
 * defect on press tone: a reader who divides the two numbers we print next to each other must
 * land on the number we printed. So the share is always followed by "of N rated", and the
 * neutrals that sit outside that base are named as excluded rather than left to be inferred.
 *
 *   "scored" — rated >= STANDOUT_MIN_RATED: bar, share, and differential.
 *   "thin"   — 1..STANDOUT_MIN_RATED-1 rated: no bar, no share, no differential, no badge. The
 *              percentage exists in the API and is arithmetically true; it is suppressed
 *              because at that base it is indistinguishable from noise (see the table above).
 *   "none"   — 0 rated (text_pos_share is NULL): the pre-existing all-neutral copy.
 */
export function aspectTextSummary(a: ReviewAspect): {
  kind: "scored" | "thin" | "none";
  /** Rendered segments, joined by " · ". `strong` is the tabular-emphasised lead-in (the pts
   * differential); the JSX below styles it and prints `text` after it. */
  parts: { strong?: string; text: string }[];
  /** The same line as flat text — what the tests assert on and what the bar's title carries,
   * derived from `parts` so the two can never drift. */
  detail: string;
} {
  const rated = ratedMentions(a);
  const done = (kind: "scored" | "thin" | "none", parts: { strong?: string; text: string }[]) => ({
    kind,
    parts,
    detail: parts.map((p) => (p.strong ? `${p.strong} ${p.text}` : p.text)).join(" · "),
  });

  if (a.text_pos_share === null || rated === 0) {
    return done("none", [
      {
        text: `Not enough opinionated text to score sentiment (${fmtInt(a.n_text_neutral)} neutral/unclear mention${
          a.n_text_neutral === 1 ? "" : "s"
        }).`,
      },
    ]);
  }
  if (rated < STANDOUT_MIN_RATED) {
    const neutral = a.n_text_neutral > 0 ? `, ${fmtInt(a.n_text_neutral)} neutral` : "";
    return done("thin", [
      {
        text: `Only ${fmtInt(rated)} rated mention${rated === 1 ? "" : "s"}${neutral} — too thin to score (needs ${STANDOUT_MIN_RATED}).`,
      },
    ]);
  }
  const deltaPp = a.text_delta_vs_genre !== null ? Math.round(a.text_delta_vs_genre * 100) : null;
  const parts: { strong?: string; text: string }[] = [
    { text: `${fmtPct(a.text_pos_share, 0)} positive of ${fmtInt(rated)} rated` },
  ];
  if (deltaPp !== null) {
    parts.push({
      strong: `${deltaPp >= 0 ? "+" : ""}${deltaPp} pts`,
      text: `vs ${baselineLabel(a.baseline_genre)} genre`,
    });
  }
  if (a.n_text_neutral > 0) parts.push({ text: `${fmtInt(a.n_text_neutral)} neutral excluded` });
  return done("scored", parts);
}

/**
 * Praise-vs-complaint per aspect — the Game Teardown centerpiece. The headline bar is TEXT
 * sentiment: for every mention we classify the review text AROUND the aspect keyword with the
 * distilled aspect/sentiment model's sentiment head (see etl/aspect_classifier.py and
 * build_marts.compute_aspect_sentiment, where text_sentiment is COALESCE(clf_sentiment, <VADER
 * band>) — VADER is now only the fallback for a build with no model, which is fatal by default
 * and so does not happen in production). It reflects what reviewers actually SAY about the
 * aspect — not their overall thumbs-up/down, which is what the old (and still-shown-for-
 * comparison) vote split conflated. Unlike the lexicon it replaced, it reads gaming usage in
 * context, which is why the copy below can claim "cheap deaths" vs "cheap price". Each row: a
 * 100%-stacked bar (positive accent-300 / negative paper 50% — mono steel, per the design
 * handoff's "never red/green" rule for aspect sentiment; see lib/palette.ts) split by
 * text_pos_share, plus a genre-baseline reference tick, so a bar
 * landing right of its tick is over-indexing vs genre peers on that aspect (the differential).
 * Hand-rolled rather than Recharts — same benchmark-tick-on-a-filled-bar shape BulletMeter
 * already owns, with two fill colors. Sorted by total_mentions (most-discussed first) — the
 * ordering is unchanged, only what each row CLAIMS about its numbers is (see ratedMentions and
 * STANDOUT_MIN_RATED: the keyword count that drives the sort is not the base of the split).
 *
 * Aspect drill-down: every row with data is clickable — expands an inline panel showing the
 * actual positive/negative review excerpts behind that bar (AspectReviewExamples, also split by
 * text sentiment), lazy-loaded on expand. `appid` is only needed for that drill-down fetch.
 */
export function AspectDivergingBars({ appid, aspects }: { appid: number; aspects: ReviewAspect[] }) {
  const [expanded, setExpanded] = useState<string | null>(null);

  if (aspects.length === 0) {
    return (
      <div className="flex h-24 items-center justify-center text-xs text-ink-muted">
        No review-aspect data for this game.
      </div>
    );
  }
  const sorted = [...aspects].sort((a, b) => b.total_mentions - a.total_mentions);
  const standouts = standoutAspects(sorted);
  const weak = weakAspects(sorted);
  // Widest gap first — the order the rule's ⓘ states.
  const gap = (a: ReviewAspect) => a.text_delta_vs_genre ?? 0;
  const weakRows = sorted.filter((a) => weak.has(a.aspect)).sort((a, b) => gap(a) - gap(b));
  const strongRows = sorted.filter((a) => standouts.has(a.aspect)).sort((a, b) => gap(b) - gap(a));
  const pts = (a: ReviewAspect) => {
    const v = Math.round((a.text_delta_vs_genre ?? 0) * 100);
    return `${v >= 0 ? "+" : ""}${v} pts`;
  };

  return (
    <div>
      {/* Bearish reading first: what players single out AGAINST the game, then for it. */}
      <p className="mb-3 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-ink-secondary" data-testid="aspect-standouts">
        {weakRows.length + strongRows.length === 0 ? (
          <span>No aspect stands out from the genre either way.</span>
        ) : (
          <span>
            {weakRows.length > 0 && (
              <>
                <span className="font-medium text-ink-primary">Panned more than the genre:</span>{" "}
                {weakRows.map((a) => `${a.aspect} (${fmtPct(a.text_pos_share, 0)} positive, ${pts(a)})`).join(", ")}.{" "}
              </>
            )}
            {strongRows.length > 0 && (
              <>
                <span className="font-medium text-ink-primary">Praised more than the genre:</span>{" "}
                {strongRows.map((a) => `${a.aspect} (${fmtPct(a.text_pos_share, 0)} positive, ${pts(a)})`).join(", ")}.
              </>
            )}
          </span>
        )}
        <StandoutRuleTip aspects={sorted} />
      </p>
      <div className="mb-2 flex flex-wrap items-center gap-4 text-[11px] text-ink-muted">
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: CSS_VAR.praise }} />
          Positive (text sentiment)
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: CSS_VAR.complaint }} />
          Negative (text sentiment)
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-[14px] w-[2px]" style={{ backgroundColor: "var(--text-primary)" }} />
          Genre baseline (text)
        </span>
      </div>
      {/* The method, one tap away instead of a screen-long paragraph above the bars (on a
          phone it pushed the first bar most of a screen down). */}
      <details className="group mb-3 text-[11px] leading-relaxed text-ink-muted">
        <summary className="cursor-pointer select-none text-ink-secondary hover:text-ink-primary">
          How these bars are read
        </summary>
        <p className="mt-1.5">
          Sentiment is read from the review <span className="font-medium text-ink-secondary">text</span> around each
          aspect keyword by a model trained on game reviews, so a thumbs-up review that criticizes an aspect counts as
          negative here — unlike the overall-vote split shown beneath each bar. On a blind sample it agreed with a human
          read 82% of the time, against 66% for the lexicon scoring this replaced, which could not tell “cheap deaths”
          from a cheap price. Still directional, not exact: English-only, and it leans slightly toward reading a
          borderline passage as negative. Neutral/unclear mentions are excluded from the split and reported separately.
          The <span className="font-medium text-ink-secondary">keyword mentions</span> count on each row is how many
          sampled reviews matched that aspect's keywords — a different, usually larger population than the rated
          mentions the split is computed over, because the model discards matches that turn out not to be about the
          aspect and moves others between aspects. Rows with fewer than {STANDOUT_MIN_RATED} rated mentions show no
          split at all: below that the share is almost always a degenerate 0% or 100%.
        </p>
      </details>
      <div className="flex flex-col divide-y divide-chartborder/60">
        {sorted.map((a) => (
          <AspectRow
            key={a.aspect}
            appid={appid}
            a={a}
            badge={standouts.has(a.aspect) ? "strength" : weak.has(a.aspect) ? "weakness" : null}
            isExpanded={expanded === a.aspect}
            onToggle={() => setExpanded((cur) => (cur === a.aspect ? null : a.aspect))}
          />
        ))}
      </div>
    </div>
  );
}

/** One aspect's ⓘ: what the bar and its gap mean, with this row's own counts worked through. */
function AspectTip({ a }: { a: ReviewAspect }) {
  const rated = ratedMentions(a);
  const label = baselineLabel(a.baseline_genre);
  const share = a.text_pos_share;
  const gap = a.text_delta_vs_genre;
  const worked =
    share === null || rated < STANDOUT_MIN_RATED
      ? `${fmtInt(a.n_text_pos)} positive, ${fmtInt(a.n_text_neg)} negative — ${fmtInt(rated)} rated, under the ${STANDOUT_MIN_RATED} needed to print a share`
      : `${fmtInt(a.n_text_pos)} positive ÷ ${fmtInt(rated)} rated = ${fmtPct(share, 0)}` +
        (gap !== null && a.genre_text_pos_share !== null
          ? `; ${label} genre ${fmtPct(a.genre_text_pos_share, 0)} → ${gap >= 0 ? "+" : ""}${Math.round(gap * 100)} pts`
          : "");
  return (
    <InfoTip
      label={a.aspect}
      meaning="How positively this game's reviewers write about this aspect, next to how the genre's reviewers write about the same aspect."
      formula="positive ÷ (positive + negative) rated mentions; gap = this game's share − the genre's share, in points"
      worked={worked}
      notes={`${fmtInt(a.total_mentions)} keyword mentions = sampled reviews whose text matched this aspect's keywords — a different population from the ${fmtInt(
        rated,
      )} rated mentions the share uses (the model drops off-topic matches and re-routes others between aspects). ${fmtInt(
        a.n_text_neutral,
      )} neutral/unclear mentions are left out of the share.`}
    />
  );
}

function AspectRow({
  appid,
  a,
  badge,
  isExpanded,
  onToggle,
}: {
  appid: number;
  a: ReviewAspect;
  badge: "strength" | "weakness" | null;
  isExpanded: boolean;
  onToggle: () => void;
}) {
  if (a.total_mentions === 0) {
    return (
      <div className="flex items-center justify-between py-2.5 text-xs">
        <span className="text-ink-secondary">{a.aspect}</span>
        <span className="italic text-ink-muted">No mentions in the sampled reviews</span>
      </div>
    );
  }

  const label = baselineLabel(a.baseline_genre);
  const votePct = a.pos_share !== null ? Math.round(a.pos_share * 100) : null;
  const summary = aspectTextSummary(a);
  const scored = summary.kind === "scored";
  const posPct = scored ? (a.text_pos_share as number) * 100 : 0;
  const negPct = 100 - posPct;
  const genrePct = a.genre_text_pos_share !== null ? a.genre_text_pos_share * 100 : null;

  return (
    <div className="py-2.5">
      {/* The name is the real, keyboard-reachable toggle; the ⓘ sits BESIDE it (a button can't
          hold a button), and the bar block below toggles too, as a mouse convenience. */}
      <div className="mb-1.5 flex flex-wrap items-baseline justify-between gap-x-2 gap-y-1">
        <span className="flex min-w-0 flex-wrap items-center gap-1.5 text-xs font-medium text-ink-primary">
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={isExpanded}
            className="inline-flex items-center gap-1.5 text-left hover:text-brand"
          >
            <svg
              width="9"
              height="9"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="3.5"
              className={clsx(
                "shrink-0 text-ink-muted transition-transform duration-150",
                isExpanded && "rotate-90",
              )}
              aria-hidden="true"
            >
              <path d="M9 6l6 6-6 6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            {a.aspect}
          </button>
          <AspectTip a={a} />
          {badge === "strength" && <Badge color={MONO.primary}>Standout strength</Badge>}
          {badge === "weakness" && <Badge color={MONO.paper75}>Standout weakness</Badge>}
        </span>
        {/* Named for the population it IS — sampled reviews whose text matched this aspect's
            keywords — because it is NOT the base of the share below it and usually differs
            from it by a lot (see ratedMentions and the row's ⓘ). */}
        <span className="tabular shrink-0 text-[11px] text-ink-muted">{fmtInt(a.total_mentions)} keyword mentions</span>
      </div>

      <div
        onClick={onToggle}
        className="-mx-1.5 cursor-pointer rounded-md px-1.5 py-0.5 transition-colors hover:bg-page"
      >
        {scored ? (
          <>
            <div
              className="relative h-3 rounded-full bg-page"
              role="img"
              aria-label={`${a.aspect}: ${fmtPct(a.text_pos_share, 0)} positive${
                genrePct !== null ? `, ${label} genre ${Math.round(genrePct)}%` : ""
              }`}
            >
              <div
                className="absolute inset-y-0 left-0 rounded-l-full"
                style={{ width: `${posPct}%`, backgroundColor: CSS_VAR.praise }}
              />
              <div
                className="absolute inset-y-0 right-0 rounded-r-full"
                style={{ width: `${negPct}%`, backgroundColor: CSS_VAR.complaint }}
              />
              {/* 2px surface-color gap separating the two touching segments (mark spec). */}
              <div className="absolute inset-y-0 w-[2px] bg-page" style={{ left: `calc(${posPct}% - 1px)` }} />
              {genrePct !== null && (
                <div
                  className="absolute -top-[3px] h-[18px] w-[2px] bg-ink-primary"
                  style={{ left: `calc(${genrePct}% - 1px)` }}
                />
              )}
            </div>
            <SummaryLine summary={summary} isExpanded={isExpanded} className="mt-1" />
          </>
        ) : (
          <SummaryLine summary={summary} isExpanded={isExpanded} />
        )}

        {votePct !== null && (
          // The one percentage whose base IS total_mentions — pos_share is
          // n_pos_mentions / (n_pos_mentions + n_neg_mentions) — so it names that base outright
          // rather than leaving the header count to be borrowed by the text split above.
          <div className="mt-0.5 text-[11px] text-ink-muted/80">
            Overall vote: <span className="tabular">{votePct}%</span> of the {fmtInt(a.total_mentions)} reviews
            mentioning this were thumbs-up
          </div>
        )}
      </div>
      {isExpanded && (
        <div className="mt-3 border-t border-chartborder/60 pt-3">
          <AspectReviewExamples appid={appid} aspect={a.aspect} />
        </div>
      )}
    </div>
  );
}

/** aspectTextSummary's segments as the row's sub-line, with the drill-down affordance the
 * row toggles. Rendered from `parts` (never from `detail`) so the emphasised pts
 * differential keeps its tabular styling. */
function SummaryLine({
  summary,
  isExpanded,
  className,
}: {
  summary: ReturnType<typeof aspectTextSummary>;
  isExpanded: boolean;
  className?: string;
}) {
  return (
    <div className={clsx("text-[11px] text-ink-muted", className)}>
      {summary.parts.map((p, i) => (
        <span key={i}>
          {i > 0 && " · "}
          {p.strong && (
            <>
              <span className="tabular font-medium text-ink-secondary">{p.strong}</span>{" "}
            </>
          )}
          {p.text}
        </span>
      ))}
      {" · "}
      <span className="text-ink-secondary">{isExpanded ? "Hide reviews" : "See reviews"}</span>
    </div>
  );
}

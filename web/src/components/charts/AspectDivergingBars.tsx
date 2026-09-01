import { useState } from "react";
import clsx from "clsx";

import type { ReviewAspect } from "../../lib/api";
import { fmtInt, fmtPct } from "../../lib/format";
import { CSS_VAR, MONO} from "../../lib/palette";
import { Badge } from "../ui/Badge";
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
const STANDOUT_TOP_N = 3;

function baselineLabel(genre: string | null): string {
  if (!genre || genre === "__all__") return "catalog";
  return genre;
}

/** Top-N aspects by positive TEXT-sentiment genre-differential — "what players praise about
 * THIS game more than genre peers, by what they actually write" — gated by a non-null text
 * share and by STANDOUT_MIN_RATED on the base the differential is actually computed over, so
 * a thin/all-neutral aspect can't win on noise alone. */
export function standoutAspects(aspects: ReviewAspect[]): Set<string> {
  return new Set(
    aspects
      .filter(
        (a) =>
          a.text_pos_share !== null &&
          a.text_delta_vs_genre !== null &&
          a.text_delta_vs_genre > 0 &&
          ratedMentions(a) >= STANDOUT_MIN_RATED,
      )
      .sort((a, b) => (b.text_delta_vs_genre as number) - (a.text_delta_vs_genre as number))
      .slice(0, STANDOUT_TOP_N)
      .map((a) => a.aspect),
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
  /** Rendered segments, joined by " · ". `strong` is the tabular-emphasised lead-in (the pp
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
      strong: `${deltaPp >= 0 ? "+" : ""}${deltaPp}pp`,
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

  return (
    <div>
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
      <p className="mb-3 text-[11px] leading-relaxed text-ink-muted">
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
      <div className="flex flex-col divide-y divide-chartborder/60">
        {sorted.map((a) => (
          <AspectRow
            key={a.aspect}
            appid={appid}
            a={a}
            isStandout={standouts.has(a.aspect)}
            isExpanded={expanded === a.aspect}
            onToggle={() => setExpanded((cur) => (cur === a.aspect ? null : a.aspect))}
          />
        ))}
      </div>
    </div>
  );
}

function AspectRow({
  appid,
  a,
  isStandout,
  isExpanded,
  onToggle,
}: {
  appid: number;
  a: ReviewAspect;
  isStandout: boolean;
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
  const rated = ratedMentions(a);

  return (
    <div className="py-2.5">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={isExpanded}
        title={isExpanded ? "Hide example reviews" : "Click to see example reviews"}
        className="-mx-1.5 block w-[calc(100%+12px)] rounded-md px-1.5 py-0.5 text-left transition-colors hover:bg-page"
      >
        <div className="mb-1.5 flex flex-wrap items-baseline justify-between gap-x-2 gap-y-1">
          <span className="flex items-center gap-1.5 text-xs font-medium text-ink-primary">
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
            {isStandout && <Badge color={MONO.primary}>Standout strength</Badge>}
          </span>
          {/* Named for the population it IS — sampled reviews whose text matched this aspect's
              keywords — because it is NOT the base of the share below it and usually differs
              from it by a lot (see ratedMentions). It used to read a bare "155 mentions" one
              line above "100% positive", which invites exactly the division that cannot work. */}
          <span
            className="tabular shrink-0 text-[11px] text-ink-muted"
            title={`${fmtInt(a.total_mentions)} sampled reviews matched this aspect's keywords. That is a different population from the ${fmtInt(rated)} rated mention${
              rated === 1 ? "" : "s"
            } the split below is computed over: the model drops keyword hits that turn out not to be about this aspect and re-routes others in from another aspect's keywords, so the two counts move independently.`}
          >
            {fmtInt(a.total_mentions)} keyword mentions
          </span>
        </div>

        {scored ? (
          <>
            <div
              className="relative h-3 rounded-full bg-page"
              title={`${fmtPct(a.text_pos_share, 0)} of ${fmtInt(rated)} rated mentions read positive (${a.n_text_pos} positive / ${a.n_text_neg} negative; ${a.n_text_neutral} neutral excluded)${
                genrePct !== null ? ` · ${label} genre text baseline: ${Math.round(genrePct)}% positive` : ""
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
      </button>
      {isExpanded && (
        <div className="mt-3 border-t border-chartborder/60 pt-3">
          <AspectReviewExamples appid={appid} aspect={a.aspect} />
        </div>
      )}
    </div>
  );
}

/** aspectTextSummary's segments as the row's sub-line, with the drill-down affordance the
 * whole row is a button for. Rendered from `parts` (never from `detail`) so the emphasised pp
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

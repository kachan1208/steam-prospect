import { useState } from "react";
import clsx from "clsx";

import type { ReviewAspect } from "../../lib/api";
import { fmtInt, fmtPct } from "../../lib/format";
import { CSS_VAR } from "../../lib/palette";
import { Badge } from "../ui/Badge";
import { AspectReviewExamples } from "./AspectReviewExamples";

// Aspects need at least this many mentions to be eligible for the "Standout strength"
// badge — guards against a 1-2 mention aspect with a lucky 100% positive share reading
// as a differentiator when it's really just noise.
const STANDOUT_MIN_MENTIONS = 5;
const STANDOUT_TOP_N = 3;

function baselineLabel(genre: string | null): string {
  if (!genre || genre === "__all__") return "catalog";
  return genre;
}

/** Top-N aspects by positive TEXT-sentiment genre-differential — "what players praise about
 * THIS game more than genre peers, by what they actually write" — gated by a minimum mention
 * floor and a non-null text share so a thin/all-neutral aspect can't win on noise alone. */
function standoutAspects(aspects: ReviewAspect[]): Set<string> {
  return new Set(
    aspects
      .filter(
        (a) =>
          a.text_pos_share !== null &&
          a.text_delta_vs_genre !== null &&
          a.text_delta_vs_genre > 0 &&
          a.total_mentions >= STANDOUT_MIN_MENTIONS,
      )
      .sort((a, b) => (b.text_delta_vs_genre as number) - (a.text_delta_vs_genre as number))
      .slice(0, STANDOUT_TOP_N)
      .map((a) => a.aspect),
  );
}

/**
 * Praise-vs-complaint per aspect — the Game Teardown centerpiece. The headline bar is now
 * TEXT sentiment: for every mention we score the VADER compound of the review text AROUND the
 * aspect keyword (see mart_game_teardown.sql / build_marts.compute_aspect_sentiment), so it
 * reflects what reviewers actually SAY about the aspect — not their overall thumbs-up/down,
 * which is what the old (and still-shown-for-comparison) vote split conflated. Each row: a
 * 100%-stacked bar (positive blue / negative red — the app's documented diverging pair; see
 * lib/palette.ts) split by text_pos_share, plus a genre-baseline reference tick, so a bar
 * landing right of its tick is over-indexing vs genre peers on that aspect (the differential).
 * Hand-rolled rather than Recharts — same benchmark-tick-on-a-filled-bar shape BulletMeter
 * already owns, with two fill colors. Sorted by total_mentions (most-discussed first).
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
        aspect keyword (VADER lexicon), so a thumbs-up review that criticizes an aspect counts as negative here — unlike
        the overall-vote split shown beneath each bar. Lexicon scoring is coarse: English-only, sarcasm-blind, and
        domain-blind (words like “hard”, “brutal”, “insane” read as negative even where players mean praise), so treat
        it as directional. Neutral/unclear mentions are excluded from the split and reported separately.
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
  const hasText = a.text_pos_share !== null;
  const posPct = hasText ? (a.text_pos_share as number) * 100 : 0;
  const negPct = 100 - posPct;
  const genrePct = a.genre_text_pos_share !== null ? a.genre_text_pos_share * 100 : null;
  const textDeltaPp = a.text_delta_vs_genre !== null ? Math.round(a.text_delta_vs_genre * 100) : null;
  const opinionated = a.n_text_pos + a.n_text_neg;

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
            {isStandout && <Badge color={CSS_VAR.good}>Standout strength</Badge>}
          </span>
          <span className="tabular shrink-0 text-[11px] text-ink-muted">{fmtInt(a.total_mentions)} mentions</span>
        </div>

        {hasText ? (
          <>
            <div
              className="relative h-3 rounded-full bg-page"
              title={`${fmtPct(a.text_pos_share, 0)} of ${fmtInt(opinionated)} opinionated mentions read positive (${a.n_text_pos} positive / ${a.n_text_neg} negative; ${a.n_text_neutral} neutral excluded)${
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
            <div className="mt-1 text-[11px] text-ink-muted">
              {fmtPct(a.text_pos_share, 0)} positive
              {textDeltaPp !== null && (
                <>
                  {" · "}
                  <span className="tabular font-medium text-ink-secondary">
                    {textDeltaPp >= 0 ? "+" : ""}
                    {textDeltaPp}pp
                  </span>{" "}
                  vs {label} genre
                </>
              )}
              {a.n_text_neutral > 0 && <> {" · "}{fmtInt(a.n_text_neutral)} neutral</>}
              {" · "}
              <span className="text-ink-secondary">{isExpanded ? "Hide reviews" : "See reviews"}</span>
            </div>
          </>
        ) : (
          <div className="text-[11px] text-ink-muted">
            Not enough opinionated text to score sentiment ({fmtInt(a.n_text_neutral)} neutral/unclear mention
            {a.n_text_neutral === 1 ? "" : "s"}).{" "}
            <span className="text-ink-secondary">{isExpanded ? "Hide reviews" : "See reviews"}</span>
          </div>
        )}

        {votePct !== null && (
          <div className="mt-0.5 text-[11px] text-ink-muted/80">
            Overall vote: <span className="tabular">{votePct}%</span> of reviews mentioning this were thumbs-up
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

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

/** Top-N aspects by positive genre-differential — the "what makes THIS game special"
 * signal — gated by a minimum mention floor so a thin aspect can't win on noise alone. */
function standoutAspects(aspects: ReviewAspect[]): Set<string> {
  return new Set(
    aspects
      .filter((a) => a.delta_vs_genre !== null && a.delta_vs_genre > 0 && a.total_mentions >= STANDOUT_MIN_MENTIONS)
      .sort((a, b) => (b.delta_vs_genre as number) - (a.delta_vs_genre as number))
      .slice(0, STANDOUT_TOP_N)
      .map((a) => a.aspect),
  );
}

/**
 * Praise-vs-complaint per aspect — the Game Teardown centerpiece. Per aspect: a
 * 100%-stacked horizontal bar (praise blue / complaint red — the app's documented
 * diverging pair; see the rationale in lib/palette.ts) plus a genre-baseline reference
 * tick, so a bar landing to the right of its tick is over-indexing vs. genre peers on
 * that aspect (the differential). Hand-rolled rather than Recharts — this needs the
 * same benchmark-tick-on-a-filled-bar shape BulletMeter already owns in this codebase,
 * just with two fill colors instead of one. Sorted by total_mentions (most-discussed
 * aspect first, matching the API's order) so volume and sentiment are both legible.
 *
 * Aspect drill-down: every row with data is clickable — expands an inline panel (below
 * the row, accordion-style) showing the actual praise/complaint review excerpts behind
 * that bar (AspectReviewExamples), lazy-loaded on expand. `appid` is only needed for that
 * drill-down fetch.
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
      <div className="mb-3 flex flex-wrap items-center gap-4 text-[11px] text-ink-muted">
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: CSS_VAR.praise }} />
          Praise (positive reviews)
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: CSS_VAR.complaint }} />
          Complaint (negative reviews)
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-[14px] w-[2px]" style={{ backgroundColor: "var(--text-primary)" }} />
          Genre baseline (% positive)
        </span>
      </div>
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
  if (a.pos_share === null || a.total_mentions === 0) {
    return (
      <div className="flex items-center justify-between py-2.5 text-xs">
        <span className="text-ink-secondary">{a.aspect}</span>
        <span className="italic text-ink-muted">No mentions in the sampled reviews</span>
      </div>
    );
  }

  const praisePct = a.pos_share * 100;
  const complaintPct = 100 - praisePct;
  const genrePct = a.genre_pos_share !== null ? a.genre_pos_share * 100 : null;
  const deltaPp = a.delta_vs_genre !== null ? Math.round(a.delta_vs_genre * 100) : null;
  const label = baselineLabel(a.baseline_genre);

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
        <div
          className="relative h-3 rounded-full bg-page"
          title={`${fmtPct(a.pos_share, 0)} positive (${a.n_pos_mentions} praise / ${a.n_neg_mentions} complaint mentions)${
            genrePct !== null ? ` · ${label} genre baseline: ${Math.round(genrePct)}% positive` : ""
          }`}
        >
          <div
            className="absolute inset-y-0 left-0 rounded-l-full"
            style={{ width: `${praisePct}%`, backgroundColor: CSS_VAR.praise }}
          />
          <div
            className="absolute inset-y-0 right-0 rounded-r-full"
            style={{ width: `${complaintPct}%`, backgroundColor: CSS_VAR.complaint }}
          />
          {/* 2px surface-color gap separating the two touching segments (mark spec). */}
          <div className="absolute inset-y-0 w-[2px] bg-page" style={{ left: `calc(${praisePct}% - 1px)` }} />
          {genrePct !== null && (
            <div
              className="absolute -top-[3px] h-[18px] w-[2px] bg-ink-primary"
              style={{ left: `calc(${genrePct}% - 1px)` }}
            />
          )}
        </div>
        <div className="mt-1 text-[11px] text-ink-muted">
          {fmtPct(a.pos_share, 0)} positive
          {deltaPp !== null && (
            <>
              {" · "}
              <span className="tabular font-medium text-ink-secondary">
                {deltaPp >= 0 ? "+" : ""}
                {deltaPp}pp
              </span>{" "}
              vs {label} genre
            </>
          )}
          {" · "}
          <span className="text-ink-secondary">{isExpanded ? "Hide reviews" : "See reviews"}</span>
        </div>
      </button>
      {isExpanded && (
        <div className="mt-3 border-t border-chartborder/60 pt-3">
          <AspectReviewExamples appid={appid} aspect={a.aspect} />
        </div>
      )}
    </div>
  );
}

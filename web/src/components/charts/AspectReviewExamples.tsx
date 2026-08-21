import { useRef, useState } from "react";
import type { ReactNode } from "react";
import clsx from "clsx";

import { useAspectReviews } from "../../lib/api";
import type { AspectReviewExcerpt, AspectSentiment } from "../../lib/api";
import { fmtInt, fmtMinutes } from "../../lib/format";
import { CSS_VAR } from "../../lib/palette";

/** Escape a literal string for embedding inside a RegExp character class/alternation. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Collapse every whitespace run to one space — the mart cuts its one-sentence excerpt out of
 * text that still carries the reviewer's own line breaks, so the two disagree on whitespace. */
function collapseWs(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** Drop the leading/trailing ellipsis an excerpt may carry ("…the combat feels weightless…"),
 * which is punctuation the mart added and therefore never appears in the full review. */
function trimEllipsis(s: string): string {
  return s.replace(/^(?:\.{3}|…)\s*/, "").replace(/\s*(?:\.{3}|…)$/, "");
}

/**
 * The full review body — but only when it actually adds something the excerpt does not.
 *
 * Returns null when `review_text` is missing (normal: the mart lags the deploy by hours) and
 * when the "full" review is no longer than the sentence already on screen (a one-line review).
 * Both cases must render as a plain, non-interactive card: a "Read full review" control that
 * opens an empty or identical panel is worse than no control at all.
 */
export function fullReviewText(item: AspectReviewExcerpt): string | null {
  const full = item.review_text?.trim();
  if (!full) return null;
  return collapseWs(full).length > collapseWs(item.excerpt).length ? full : null;
}

/**
 * Split `full` around the sampled sentence -> [before, match, after], so the expanded review can
 * point at WHICH passage counted toward the aspect instead of making the reader re-scan 2000
 * characters for it. Falls back to a whitespace-tolerant match (the excerpt's spaces may have
 * been normalised away from the original line breaks), then to null — callers treat null as
 * "highlight the keywords across the whole body" rather than showing nothing.
 */
export function locateExcerpt(full: string, excerpt: string): [string, string, string] | null {
  const needle = trimEllipsis(collapseWs(excerpt));
  if (!needle) return null;
  const direct = full.indexOf(needle);
  if (direct >= 0) return [full.slice(0, direct), needle, full.slice(direct + needle.length)];
  const loose = new RegExp(needle.split(" ").map(escapeRegExp).join("\\s+"));
  const m = loose.exec(full);
  if (!m) return null;
  return [full.slice(0, m.index), m[0], full.slice(m.index + m[0].length)];
}

/**
 * Wrap every occurrence of any `keywords` entry in `text` so a reader can see exactly which
 * words made this passage count toward the aspect. Deliberately quiet: a ~20% wash of the
 * sentiment tint plus a weight bump, not a saturated block — the marks have to answer "why is
 * this here" without striping the prose they sit in. Longest keywords first so a multi-word
 * phrase ("open world") wins over a shorter one it contains ("world"). `text.split(re)` with a
 * single capture group alternates [non-match, match, non-match, …], so odd indices are always
 * the highlighted spans regardless of which alternative matched.
 */
function highlightKeywords(text: string, keywords: string[], tint: string): ReactNode[] {
  const uniq = [...new Set(keywords.filter(Boolean))].sort((a, b) => b.length - a.length);
  if (uniq.length === 0) return [text];
  const re = new RegExp(`(${uniq.map(escapeRegExp).join("|")})`, "gi");
  return text.split(re).map((part, i) =>
    i % 2 === 1 ? (
      <mark
        key={i}
        className="rounded-[3px] px-[2px] font-medium text-ink-primary"
        style={{ backgroundColor: `color-mix(in srgb, ${tint} 20%, transparent)` }}
      >
        {part}
      </mark>
    ) : (
      <span key={i}>{part}</span>
    ),
  );
}

/**
 * The review prose itself. Collapsed it is the sampled sentence, keyword-marked. Expanded it is
 * the whole review with the sampled sentence carrying a faint tint and full ink while the
 * surrounding paragraphs drop to secondary ink — one locator at sentence level, one at word
 * level, and no keyword marks scattered through context the reader did not ask about.
 */
function ReviewProse({
  item,
  tint,
  expanded,
}: {
  item: AspectReviewExcerpt;
  tint: string;
  expanded: boolean;
}) {
  // `select-text`: the expanded body lives inside a <button>, and WebKit's UA sheet makes
  // button content unselectable — a 2000-char review you cannot copy out of is a bug.
  const base = "select-text whitespace-pre-line text-[13px] leading-[1.65]";
  const full = expanded ? fullReviewText(item) : null;

  if (!full) {
    return (
      <p className={clsx(base, "text-ink-primary")}>
        {highlightKeywords(item.excerpt, item.matched_keywords, tint)}
      </p>
    );
  }

  const parts = locateExcerpt(full, item.excerpt);
  if (!parts) {
    return (
      <p className={clsx(base, "text-ink-primary")}>
        {highlightKeywords(full, item.matched_keywords, tint)}
      </p>
    );
  }

  const [before, match, after] = parts;
  return (
    <p className={clsx(base, "text-ink-secondary")}>
      {before}
      <span
        className="rounded-[3px] text-ink-primary"
        style={{ backgroundColor: `color-mix(in srgb, ${tint} 10%, transparent)` }}
      >
        {highlightKeywords(match, item.matched_keywords, tint)}
      </span>
      {after}
    </p>
  );
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      width="9"
      height="9"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="3.5"
      className={clsx("shrink-0 transition-transform duration-150", open && "rotate-90")}
      aria-hidden="true"
    >
      <path d="M9 6l6 6-6 6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function SteamLink({ href }: { href: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="group inline-flex items-center gap-1 font-medium text-ink-secondary transition-colors hover:text-brand"
    >
      <span className="group-hover:underline">View on Steam</span>
      <svg
        width="10"
        height="10"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="shrink-0"
        aria-hidden="true"
      >
        <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
        <polyline points="15 3 21 3 21 9" />
        <line x1="10" y1="14" x2="21" y2="3" />
      </svg>
    </a>
  );
}

/** The one meta line under a quote. Every entry is conditional: a review with no recorded
 * playtime and no helpful votes prints nothing rather than "— played · 0 found helpful", which
 * is what made every card carry the same three stats whether or not they said anything. */
function metaBits(item: AspectReviewExcerpt): string[] {
  const bits: string[] = [];
  if (item.playtime_minutes !== null) bits.push(`${fmtMinutes(item.playtime_minutes)} played`);
  if (item.date) bits.push(item.date.slice(0, 10));
  const votes = item.votes_up ?? 0;
  if (votes > 0) bits.push(`${fmtInt(votes)} found helpful`);
  return bits;
}

function ExcerptCard({ item, tint }: { item: AspectReviewExcerpt; tint: string }) {
  const [expanded, setExpanded] = useState(false);
  const bodyRef = useRef<HTMLButtonElement>(null);
  const expandable = fullReviewText(item) !== null;
  const bits = metaBits(item);
  // With nothing to expand there is no button, so the permalink can sit inline in the meta
  // line; when the card IS a button the link has to live outside it (no nested interactives).
  const inlineLink = !expandable && item.steam_url ? item.steam_url : null;
  const hasFooter = expanded && !!item.steam_url;

  function toggle() {
    // Don't collapse the review out from under someone mid-selection inside this card —
    // scoped to this card so a stray selection elsewhere can never swallow a keyboard press.
    const sel = typeof window !== "undefined" ? window.getSelection() : null;
    if (sel && !sel.isCollapsed && sel.anchorNode && bodyRef.current?.contains(sel.anchorNode)) return;
    setExpanded((v) => !v);
  }

  const body = (
    <>
      <ReviewProse item={item} tint={tint} expanded={expanded} />
      {(bits.length > 0 || expandable || inlineLink) && (
        <div className="mt-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-[11px] text-ink-muted">
          <span className="tabular">{bits.join(" · ")}</span>
          {expandable && (
            <span className="inline-flex items-center gap-1 font-medium text-ink-secondary">
              {expanded ? "Show less" : "Read full review"}
              <Chevron open={expanded} />
            </span>
          )}
          {inlineLink && <SteamLink href={inlineLink} />}
        </div>
      )}
    </>
  );

  return (
    // No `overflow-hidden` here on purpose: it would clip the app's global focus-visible
    // outline (index.css draws it at outline-offset 2px), so the button carries matching
    // corner radii instead of being clipped by the wrapper.
    <div className="rounded-card border border-chartborder bg-page">
      {expandable ? (
        <button
          type="button"
          ref={bodyRef}
          onClick={toggle}
          aria-expanded={expanded}
          // Short accessible name on purpose: without it the button would be announced as the
          // entire review body.
          aria-label={expanded ? "Hide the full review" : "Read the full review"}
          className={clsx(
            "block w-full px-3 py-2.5 text-left transition-colors hover:bg-surface",
            hasFooter ? "rounded-t-card" : "rounded-card",
          )}
        >
          {body}
        </button>
      ) : (
        <div className="px-3 py-2.5">{body}</div>
      )}
      {expanded && item.steam_url && (
        <div className="border-t border-chartborder px-3 py-2 text-[11px]">
          <SteamLink href={item.steam_url} />
        </div>
      )}
    </div>
  );
}

function SentimentGroup({
  appid,
  aspect,
  sentiment,
  label,
  color,
}: {
  appid: number;
  aspect: string;
  sentiment: AspectSentiment;
  label: string;
  color: string;
}) {
  const q = useAspectReviews(appid, aspect, sentiment);
  return (
    <section>
      <h4 className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-ink-primary">
        <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: color }} />
        {label}
      </h4>
      {q.isLoading && <div className="text-xs text-ink-muted">Loading…</div>}
      {q.isError && (
        <div className="text-xs text-verdict-serious">
          Failed to load{q.error instanceof Error ? `: ${q.error.message}` : "."}
        </div>
      )}
      {q.data && q.data.items.length === 0 && (
        <div className="rounded-card border border-dashed border-chartborder p-3 text-center text-[11px] text-ink-muted">
          No sampled reviews read {sentiment === "praise" ? "positive" : "negative"} about this aspect.
        </div>
      )}
      {q.data && q.data.items.length > 0 && (
        <div className="flex flex-col gap-2.5">
          {q.data.items.map((item, i) => (
            <ExcerptCard key={i} item={item} tint={color} />
          ))}
        </div>
      )}
    </section>
  );
}

/**
 * The aspect drill-down panel — rendered under a clicked aspect row in AspectDivergingBars.
 * Two lazy-loaded groups (positive / negative about the aspect), each backed by its own
 * `useAspectReviews(appid, aspect, sentiment)` call so the query only fires once this panel
 * actually mounts (i.e. once the row is expanded — see AspectDivergingBars' `expanded`
 * state), not on initial teardown load. Excerpts are grouped by the TEXT sentiment of the shown
 * passage, matching the bar above — a thumbs-up review can appear under "Negative" here.
 *
 * Layout: the two groups only sit side by side from `lg` up. Splitting at `sm` put ~40-character
 * lines of prose in each column on a small laptop, which is what made this panel hard to read;
 * below `lg` they stack and each quote gets the full measure.
 */
export function AspectReviewExamples({ appid, aspect }: { appid: number; aspect: string }) {
  return (
    <div>
      <div className="grid grid-cols-1 gap-6 pt-1 lg:grid-cols-2">
        <SentimentGroup
          appid={appid}
          aspect={aspect}
          sentiment="praise"
          label="Positive about this aspect"
          color={CSS_VAR.praise}
        />
        <SentimentGroup
          appid={appid}
          aspect={aspect}
          sentiment="complaint"
          label="Negative about this aspect"
          color={CSS_VAR.complaint}
        />
      </div>
      {/* One line, not three: the full "text sentiment vs. overall vote" explanation already
          sits above the bars in AspectDivergingBars — repeating it here was duplicated prose. */}
      <p className="mt-3 text-[11px] text-ink-muted">
        Grouped by what the quoted passage says — not the reviewer’s overall thumbs-up/down.
      </p>
    </div>
  );
}

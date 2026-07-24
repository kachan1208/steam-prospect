import type { ReactNode } from "react";

import { useAspectReviews } from "../../lib/api";
import type { AspectReviewExcerpt, AspectSentiment } from "../../lib/api";
import { fmtInt, fmtMinutes } from "../../lib/format";
import { CSS_VAR } from "../../lib/palette";

/** Escape a literal string for embedding inside a RegExp character class/alternation. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Wrap every occurrence of any `keywords` entry in `text` with a tinted <mark>, so a reader
 * can see exactly which words made this excerpt count toward the aspect. Longest keywords
 * first so a multi-word phrase ("open world") wins over a shorter one it contains ("world").
 * `text.split(re)` with a single capture group alternates [non-match, match, non-match, …],
 * so odd indices are always the highlighted spans regardless of which alternative matched.
 */
function highlightKeywords(text: string, keywords: string[], tint: string): ReactNode[] {
  const uniq = [...new Set(keywords.filter(Boolean))].sort((a, b) => b.length - a.length);
  if (uniq.length === 0) return [text];
  const re = new RegExp(`(${uniq.map(escapeRegExp).join("|")})`, "gi");
  return text.split(re).map((part, i) =>
    i % 2 === 1 ? (
      <mark
        key={i}
        className="rounded-sm px-0.5 font-semibold text-ink-primary"
        style={{ backgroundColor: `color-mix(in srgb, ${tint} 35%, transparent)` }}
      >
        {part}
      </mark>
    ) : (
      <span key={i}>{part}</span>
    ),
  );
}

function ExcerptCard({ item, tint }: { item: AspectReviewExcerpt; tint: string }) {
  return (
    <div className="rounded-card border border-chartborder bg-page p-2.5">
      <p className="whitespace-pre-line text-xs leading-relaxed text-ink-secondary">
        {highlightKeywords(item.excerpt, item.matched_keywords, tint)}
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-ink-muted">
        {item.playtime_minutes !== null && <span>{fmtMinutes(item.playtime_minutes)} played</span>}
        <span>{fmtInt(item.votes_up ?? 0)} found helpful</span>
        {item.date && <span>{item.date}</span>}
      </div>
    </div>
  );
}

function SentimentColumn({
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
    <div>
      <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-ink-primary">
        <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: color }} />
        {label}
      </div>
      {q.isLoading && <div className="text-xs text-ink-muted">Loading…</div>}
      {q.isError && (
        <div className="text-xs text-status-serious">
          Failed to load{q.error instanceof Error ? `: ${q.error.message}` : "."}
        </div>
      )}
      {q.data && q.data.items.length === 0 && (
        <div className="rounded-card border border-dashed border-chartborder p-3 text-center text-[11px] italic text-ink-muted">
          No sampled reviews read {sentiment === "praise" ? "positive" : "negative"} about this aspect.
        </div>
      )}
      {q.data && q.data.items.length > 0 && (
        <div className="flex flex-col gap-2">
          {q.data.items.map((item, i) => (
            <ExcerptCard key={i} item={item} tint={color} />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * The aspect drill-down panel — rendered under a clicked aspect row in AspectDivergingBars.
 * Two lazy-loaded columns (positive / negative about the aspect), each backed by its own
 * `useAspectReviews(appid, aspect, sentiment)` call so the query only fires once this panel
 * actually mounts (i.e. once the row is expanded — see AspectDivergingBars' `expanded`
 * state), not on initial teardown load. Excerpts are grouped by the TEXT sentiment of the shown
 * passage (VADER), matching the bar above — a thumbs-up review can appear under "Negative" here.
 */
export function AspectReviewExamples({ appid, aspect }: { appid: number; aspect: string }) {
  return (
    <div>
      <div className="grid grid-cols-1 gap-4 pt-1 sm:grid-cols-2">
        <SentimentColumn
          appid={appid}
          aspect={aspect}
          sentiment="praise"
          label="Positive about this aspect"
          color={CSS_VAR.praise}
        />
        <SentimentColumn
          appid={appid}
          aspect={aspect}
          sentiment="complaint"
          label="Negative about this aspect"
          color={CSS_VAR.complaint}
        />
      </div>
      <p className="mt-2.5 text-[11px] italic text-ink-muted">
        Grouped by the sentiment of the highlighted text (VADER), not the reviewer’s overall thumbs-up/down — so a
        broadly positive review can still show up on the negative side for this specific aspect.
      </p>
    </div>
  );
}

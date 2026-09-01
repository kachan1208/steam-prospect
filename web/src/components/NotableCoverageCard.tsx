import { Card } from "./ui/Card";
import { sourceLabel } from "./charts/PressBySourceChart";
import type { GamePress, PressNotableArticle } from "../lib/api";
import { fmtInt, fmtPct } from "../lib/format";
import { CSS_VAR } from "../lib/palette";

/** DuckDB TIMESTAMP strings ("2017-03-06 23:59:53" / "...53.255353") -> "2017-03-06". Kept as a
 * private copy (not imported from GameProfile.tsx) so this file has zero coupling to the page
 * module it's rendered from. */
function dateOnly(s: string | null): string {
  return s ? s.slice(0, 10) : "—";
}

/**
 * Card-header tone chip — the same press_pos_share/n_scored_articles the "Press footprint"
 * card's tone bar uses, just condensed to one line. Returns null when nothing was scored (no
 * chip rendered) rather than a misleading "0% positive".
 *
 * press_pos_share is positive / (positive + negative) — NEUTRALS ARE EXCLUDED (see GamePress in
 * lib/api.ts and mart_game_teardown.sql). The chip used to print that share beside
 * n_scored_articles, a base that includes them: Hollow Knight read "83% positive · 101 scored"
 * over 58 positive / 12 negative / 31 neutral, and 58/101 is 57%, not 83%. A reader who divides
 * the two numbers we put next to each other must land on the number we printed, so the chip now
 * carries the RATED base (positive + negative) and says outright that neutrals sit outside it.
 */
export function pressToneSummary(
  press: GamePress,
): { dotColor: string | null; label: string; detail: string } | null {
  if (press.n_scored_articles === 0) return null;
  const s = press.press_pos_share;
  if (s == null) {
    return { dotColor: null, label: "Neutral coverage", detail: `${fmtInt(press.n_scored_articles)} scored, no clear lean` };
  }
  const label = s >= 0.66 ? "Mostly positive" : s <= 0.34 ? "Mostly negative" : "Mixed tone";
  const dotColor = s >= 0.66 ? CSS_VAR.praise : s <= 0.34 ? CSS_VAR.complaint : CSS_VAR.textMuted;
  const rated = press.n_pos_articles + press.n_neg_articles;
  const detail =
    press.n_neutral_articles > 0
      ? `${fmtPct(s, 0)} positive of ${fmtInt(rated)} rated · ${fmtInt(press.n_neutral_articles)} neutral excluded`
      : `${fmtPct(s, 0)} positive of ${fmtInt(rated)} scored`;
  return { dotColor, label, detail };
}

/** Article title: a real link (with a small external-link glyph) when the article has a URL,
 * plain text otherwise — the field is only populated once the ETL mart carries `articles.url`
 * (see mart_game_teardown.sql), so this degrades gracefully on older marts. */
function ArticleTitle({ item }: { item: PressNotableArticle }) {
  const title = item.title ?? "Untitled";
  if (!item.url) {
    return (
      <div className="truncate font-medium text-ink-primary" title={title}>
        {title}
      </div>
    );
  }
  return (
    <a
      href={item.url}
      target="_blank"
      rel="noopener noreferrer"
      className="group flex min-w-0 items-center gap-1 font-medium text-ink-primary transition-colors hover:text-brand"
      title={title}
    >
      <span className="min-w-0 truncate group-hover:underline">{title}</span>
      <svg
        width="10"
        height="10"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="shrink-0 text-ink-muted transition-colors group-hover:text-brand"
        aria-hidden="true"
      >
        <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
        <polyline points="15 3 21 3 21 9" />
        <line x1="10" y1="14" x2="21" y2="3" />
      </svg>
    </a>
  );
}

function NotableRow({ item }: { item: PressNotableArticle }) {
  const outlet = sourceLabel(item.source);
  // GamesIndustry.biz (and, less often, Game Developer) byline their own short news posts with
  // the outlet's own name — showing it again in the meta line would just repeat the chip.
  const authorIsOutlet = !!item.author && item.author.trim().toLowerCase() === outlet.toLowerCase();
  const tone = item.sentiment;
  const toneColor = tone === "positive" ? CSS_VAR.praise : tone === "negative" ? CSS_VAR.complaint : null;
  const toneTitle =
    tone && typeof item.sentiment_compound === "number"
      ? `${tone === "positive" ? "Positive" : tone === "negative" ? "Negative" : "Neutral"} tone — VADER compound ${
          item.sentiment_compound >= 0 ? "+" : ""
        }${item.sentiment_compound.toFixed(2)} (headline/summary)`
      : undefined;

  return (
    /* Two columns from sm up; STACKED below it (A11, measured 2026-09-01). The fixed
       w-32 outlet column plus gap-3 costs 140px of a 318px card at 390px, which left the
       headline 146px — and the headline is the only thing telling these rows apart, so the
       list read "How to get gold i… / How to get Lead i… / How to get salt in…". Most of
       that 128px was wasted anyway: the outlet pill is a short name. Stacked, the outlet
       and date share one meta line and the headline gets the full 318px. */
    <div className="flex flex-col gap-1 border-b border-chartborder/60 py-2.5 first:pt-0 last:border-0 last:pb-0 sm:flex-row sm:items-start sm:gap-3">
      <div className="flex shrink-0 flex-row items-center gap-2 sm:w-32 sm:flex-col sm:items-start sm:gap-1">
        <span
          className="max-w-full truncate rounded-full border border-chartborder bg-page px-2 py-0.5 text-[10px] font-semibold text-ink-secondary"
          title={outlet}
        >
          {outlet}
        </span>
        <span className="tabular pl-0.5 text-[10px] text-ink-muted">{dateOnly(item.published_at)}</span>
      </div>
      <div className="min-w-0 flex-1 sm:pt-0.5">
        <ArticleTitle item={item} />
        <div className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[11px] text-ink-muted">
          {!authorIsOutlet && item.author && <span>{item.author}</span>}
          {toneColor && (
            <span className="inline-flex items-center gap-1" title={toneTitle}>
              <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: toneColor }} />
              {tone === "positive" ? "Positive tone" : "Negative tone"}
            </span>
          )}
          {item.is_earliest && (
            <span className="inline-flex items-center rounded-full bg-brand-tint px-1.5 py-[1px] text-[10px] font-medium text-brand">
              Earliest coverage found
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * "Notable coverage" press card — the angle: earliest coverage pinned first, then the
 * remaining kept articles (mart_game_press_notable already floors these to the
 * match-confidence top-N, see PRESS_NOTABLE_N) ordered by that same match_confidence, which is
 * what the card's subtitle promises (today's `notable` payload arrives date-sorted; this is the
 * client-side re-sort that actually delivers "most on-topic matches by title-match confidence").
 * Self-contained (owns its own row/tone rendering) so it can be dropped into GameProfile.tsx as
 * a single call and edited here without touching the page file.
 */
export function NotableCoverageCard({ press }: { press: GamePress }) {
  if (press.notable.length === 0) return null;

  const rows = [...press.notable].sort((a, b) => {
    if (a.is_earliest !== b.is_earliest) return a.is_earliest ? -1 : 1;
    if (b.match_confidence !== a.match_confidence) return b.match_confidence - a.match_confidence;
    return (a.published_at ?? "").localeCompare(b.published_at ?? "");
  });

  const tone = pressToneSummary(press);

  return (
    <Card
      title="Notable coverage"
      subtitle="The angle — earliest coverage found, plus the most on-topic matches by title-match confidence"
      action={
        tone ? (
          <span
            // Square corners — blueprint grammar has radius 0 on tags/chips (the 2px dot
            // inside stays a circle; dots aren't chips).
            //
            // WRAPS, and must not be shrink-0 (A3, 2026-09-01). Card's header already drops
            // this chip to its own line at phone widths, but the chip is 372px wide once the
            // detail carries its base ("Mostly positive · 77% positive of 43 rated · 33
            // neutral excluded") and the line is only 318px at 390 — as shrink-0 it simply
            // ran off the end, giving /games/1962700 the app's only body-level horizontal
            // scroll (scrollWidth 417 vs clientWidth 390) and clipping its own text
            // mid-word ("exclud…"). The disclosure is the point of that wording, so wrap it
            // rather than shorten it: label on one line, base on the next.
            className="inline-flex max-w-full flex-wrap items-center gap-x-1.5 gap-y-0.5 border border-chartborder bg-page px-2.5 py-1 text-[11px]"
            title={`${fmtInt(press.n_pos_articles)} positive · ${fmtInt(press.n_neg_articles)} negative${
              press.n_neutral_articles ? ` · ${fmtInt(press.n_neutral_articles)} neutral (excluded from the share)` : ""
            } of ${fmtInt(press.n_scored_articles)} scored — VADER on headlines/summaries`}
          >
            {tone.dotColor && <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: tone.dotColor }} />}
            <span className="font-medium text-ink-primary">{tone.label}</span>
            <span className="text-ink-muted">· {tone.detail}</span>
          </span>
        ) : undefined
      }
    >
      <div className="flex flex-col">
        {rows.map((n, i) => (
          <NotableRow key={`${n.source}-${n.published_at}-${i}`} item={n} />
        ))}
      </div>
    </Card>
  );
}

import { Card } from "./ui/Card";
import { sourceLabel } from "./charts/PressBySourceChart";
import type { GamePress, PressNotableArticle } from "../lib/api";
import { fmtDay } from "../lib/dates";

/**
 * NO TONE HERE, ON PURPOSE (2026-09-23). Each row used to carry a "Positive tone" /
 * "Negative tone" badge and the card header a "Mostly positive · 83% positive of 70 rated"
 * chip — VADER, a word-list sentiment scorer, run over each article's headline and summary.
 * Checked against the served mart before removing it:
 *
 *   - per article it misreads plain news and glowing reviews alike: PC Gamer's "Balatro
 *     review", "Noita review", "Hotline Miami review" and "The Binding of Isaac: Rebirth
 *     review" all score NEGATIVE, as does "Devil May Cry 5 domain name registered";
 *   - in aggregate it measures the game's NAME: games whose title holds a grim word (dead,
 *     death, doom, kill, war, blood, evil…) average 45% "positive" press against 69% for
 *     the rest, while their players rate them the same (77% vs 75% positive reviews);
 *   - across 1,051 games with 10+ rated articles it correlates 0.14 with player sentiment.
 *
 * A number that wrong is worse than none, so the card shows what the scrape actually knows —
 * who covered the game and when — and the page's own caveat about tone is dropped with it.
 */

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
        <span className="tabular pl-0.5 text-[10px] text-ink-muted">{fmtDay(item.published_at) ?? "date unknown"}</span>
      </div>
      <div className="min-w-0 flex-1 sm:pt-0.5">
        <ArticleTitle item={item} />
        <div className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[11px] text-ink-muted">
          {!authorIsOutlet && item.author && <span>{item.author}</span>}
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
 * Self-contained (owns its own row rendering) so it can be dropped into GameProfile.tsx as a
 * single call and edited here without touching the page file.
 */
export function NotableCoverageCard({ press }: { press: GamePress }) {
  if (press.notable.length === 0) return null;

  const rows = [...press.notable].sort((a, b) => {
    if (a.is_earliest !== b.is_earliest) return a.is_earliest ? -1 : 1;
    if (b.match_confidence !== a.match_confidence) return b.match_confidence - a.match_confidence;
    return (a.published_at ?? "").localeCompare(b.published_at ?? "");
  });

  return (
    <Card
      title="Notable coverage"
      subtitle="The angle — earliest coverage found, plus the most on-topic matches by title-match confidence"
    >
      <div className="flex flex-col">
        {rows.map((n, i) => (
          <NotableRow key={`${n.source}-${n.published_at}-${i}`} item={n} />
        ))}
      </div>
    </Card>
  );
}

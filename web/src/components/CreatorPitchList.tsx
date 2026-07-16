import { Card } from "./ui/Card";
import { useCreatorPitchList, type CreatorPitchRow, type MarketingPlatform } from "../lib/api";
import { fmtCompact, fmtInt } from "../lib/format";
import { channelLabel } from "../lib/palette";

/** DuckDB TIMESTAMP strings ("2026-07-10 14:30:15.095") -> "2026-07-10". */
function dateOnly(s: string | null): string {
  return s ? s.slice(0, 10) : "—";
}

function ExampleLink({ title, url, date }: { title: string | null; url: string | null; date: string | null }) {
  if (!title) return <span className="text-xs text-ink-muted">No example mention.</span>;
  return (
    <div className="min-w-0">
      {url ? (
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          className="text-xs font-medium text-ink-secondary hover:text-series-1 hover:underline"
        >
          {title}
        </a>
      ) : (
        <span className="text-xs font-medium text-ink-secondary">{title}</span>
      )}
      <div className="mt-0.5 text-[10px] text-ink-muted">{dateOnly(date)}</div>
    </div>
  );
}

function CreatorRow({ creator, rank }: { creator: CreatorPitchRow; rank: number }) {
  const isActive = creator.n_mentions_recent >= 1;
  return (
    <tr className="border-b border-chartborder/60 align-top last:border-0">
      <td className="tabular px-2 py-2 text-ink-muted">{rank}</td>
      <td className="px-2 py-2">
        {creator.creator_url ? (
          <a
            href={creator.creator_url}
            target="_blank"
            rel="noreferrer"
            className="font-medium text-ink-primary hover:text-series-1 hover:underline"
          >
            {creator.display_name ?? creator.handle ?? `#${creator.creator_id}`}
          </a>
        ) : (
          <div className="font-medium text-ink-primary">{creator.display_name ?? creator.handle ?? `#${creator.creator_id}`}</div>
        )}
        {creator.handle && creator.display_name && creator.handle !== creator.display_name && (
          <div className="text-[10px] text-ink-muted">{creator.handle}</div>
        )}
      </td>
      <td className="px-2 py-2">
        {creator.reach !== null ? (
          <>
            <span className="tabular text-ink-secondary">{fmtCompact(creator.reach)}</span>
            <div className="text-[10px] text-ink-muted">as of {dateOnly(creator.reach_captured_at)}</div>
          </>
        ) : (
          <span className="text-[10px] text-ink-muted">no snapshot yet</span>
        )}
      </td>
      <td className="px-2 py-2">
        <span className="tabular text-ink-secondary">{fmtInt(creator.n_mentions_recent)}</span>{" "}
        <span className={isActive ? "text-[10px] text-status-good" : "text-[10px] text-ink-muted"}>
          {isActive ? "active" : "quiet"}
        </span>
        <div className="tabular text-[10px] text-ink-muted">{fmtInt(creator.n_mentions)} all-time</div>
      </td>
      <td className="tabular px-2 py-2 text-ink-secondary">{fmtInt(creator.n_games_covered)}</td>
      <td className="max-w-[280px] px-2 py-2">
        <ExampleLink title={creator.example_title} url={creator.example_url} date={creator.example_published_at} />
      </td>
    </tr>
  );
}

function CaveatsList({ caveats }: { caveats: string[] }) {
  if (caveats.length === 0) return null;
  return (
    <div className="mt-4 rounded-md border border-chartborder bg-page p-3">
      <div className="mb-1.5 text-xs font-semibold text-ink-primary">Read this with caveats</div>
      <ul className="flex flex-col gap-1.5 text-xs text-ink-secondary">
        {caveats.map((c, i) => (
          <li key={i} className="flex gap-2">
            <span className="shrink-0 text-ink-muted">·</span>
            <span>{c}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Creator pitch list for ONE platform (YouTube/Reddit/Twitch/X) — the creator-platform
 * analogue of Press.tsx's journalist table. Self-contained: owns its own query, loading/
 * error/empty states. The empty state ("connect a channel") points at running the channel
 * scraper, not an API key — this app's channel data comes from public-web scrapers, not
 * paid/keyed platform APIs.
 */
export function CreatorPitchList({ genre, platform }: { genre: string | null; platform: MarketingPlatform }) {
  const pitchQ = useCreatorPitchList(genre, platform, 25);
  const label = channelLabel(platform);

  if (!genre) {
    return <div className="flex h-32 items-center justify-center text-xs text-ink-muted">Pick a genre above.</div>;
  }
  if (pitchQ.isLoading) {
    return <div className="flex h-40 items-center justify-center text-xs text-ink-muted">Loading…</div>;
  }
  if (pitchQ.isError) {
    return (
      <div className="text-xs text-status-serious">
        Failed to load {label} pitch list{pitchQ.error instanceof Error ? `: ${pitchQ.error.message}` : "."}
      </div>
    );
  }
  if (!pitchQ.data || pitchQ.data.items.length === 0) {
    return (
      <div className="flex flex-col items-center gap-4">
        <div className="flex h-32 flex-col items-center justify-center gap-1 text-center text-xs text-ink-muted">
          <span>No {label} creators connected yet for "{genre}".</span>
          <span>Run the {label} channel scraper to start pulling creators and mentions for this genre.</span>
        </div>
        {pitchQ.data && <CaveatsList caveats={pitchQ.data.caveats} />}
      </div>
    );
  }

  return (
    <Card title={`${label} pitch list`} subtitle={`Ranked ${label} creators covering ${genre} — reach x recent activity, with an example mention each`}>
      <div className="overflow-x-auto rounded-card border border-chartborder">
        <table className="w-full min-w-[720px] text-xs">
          <thead>
            <tr className="border-b border-chartborder text-left text-ink-muted">
              <th className="px-2 py-1.5 font-medium">#</th>
              <th className="px-2 py-1.5 font-medium">Creator</th>
              <th className="px-2 py-1.5 font-medium">Reach</th>
              <th className="px-2 py-1.5 font-medium">Recent activity</th>
              <th className="px-2 py-1.5 font-medium">Games</th>
              <th className="px-2 py-1.5 font-medium">Example</th>
            </tr>
          </thead>
          <tbody>
            {pitchQ.data.items.map((c, i) => (
              <CreatorRow key={`${c.platform}-${c.creator_id}`} creator={c} rank={i + 1} />
            ))}
          </tbody>
        </table>
      </div>
      <CaveatsList caveats={pitchQ.data.caveats} />
    </Card>
  );
}

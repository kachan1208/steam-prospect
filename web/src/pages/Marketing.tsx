import { useEffect, useState } from "react";

import { ChannelBuzzList } from "../components/charts/ChannelBuzzList";
import { ChannelMixChart } from "../components/charts/ChannelMixChart";
import { CreatorPitchList } from "../components/CreatorPitchList";
import { Card } from "../components/ui/Card";
import { useChannelBuzz, useChannelMix, useGenres, type GenreOption, type MarketingPlatform } from "../lib/api";
import { channelLabel } from "../lib/palette";
import Press from "./Press";

type ChannelTab = "press" | MarketingPlatform;

const TABS: { id: ChannelTab; label: string }[] = [
  { id: "press", label: "Press" },
  { id: "youtube", label: "YouTube" },
  { id: "reddit", label: "Reddit" },
  { id: "twitch", label: "Twitch" },
  { id: "x", label: "X" },
];

function GenreSelect({
  genre,
  genres,
  onChange,
}: {
  genre: string | null;
  genres: GenreOption[];
  onChange: (genre: string) => void;
}) {
  const options = genres.filter((g) => g.value !== "__all__");
  return (
    <select
      value={genre ?? ""}
      onChange={(e) => onChange(e.target.value)}
      disabled={options.length === 0}
      className="rounded-md border border-chartborder bg-page px-2 py-1.5 text-xs text-ink-primary outline-none focus:border-series-1"
    >
      {options.map((g) => (
        <option key={g.value} value={g.value}>
          {g.label}
        </option>
      ))}
    </select>
  );
}

/**
 * Marketing — the multi-channel evolution of the old Press page: a genre selector + channel
 * tabs (Press · YouTube · Reddit · Twitch · X), each a pitch/target list, plus a channel-mix
 * chart and reach-weighted buzz shared across every channel. The Press tab reuses the
 * existing Press page component unchanged (its own self-contained genre picker included) —
 * everything else here is new (Track M).
 */
export default function Marketing() {
  const [tab, setTab] = useState<ChannelTab>("press");
  const genres = useGenres();
  const [genre, setGenre] = useState<string | null>(null);

  // Default to the first real genre once the catalog's genre list loads (mirrors the old
  // Press page's own "pick a real genre, not a placeholder" default behavior).
  useEffect(() => {
    if (genre !== null) return;
    const firstReal = genres.find((g) => g.value !== "__all__");
    if (firstReal) setGenre(firstReal.value);
  }, [genres, genre]);

  const mixQ = useChannelMix(genre);
  const risingQ = useChannelBuzz("rising", 12);
  const coolingQ = useChannelBuzz("cooling", 12);

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-lg font-semibold text-ink-primary">Marketing</h1>
        <p className="mt-0.5 text-sm text-ink-muted">
          Who to pitch and where to post, across every channel — Press, YouTube, Reddit, Twitch, and X — ranked by
          reach and recent activity, plus reach-weighted buzz and a channel-mix read on where a genre actually gets
          attention.
        </p>
      </div>

      <Card
        title="Pitch / target list"
        subtitle={
          tab === "press"
            ? "Journalist press coverage — outlets and named bylines (this tab has its own genre picker below)"
            : `Ranked ${channelLabel(tab)} creators covering ${genre ?? "…"} — reach x recent activity, with an example mention each`
        }
        action={tab !== "press" ? <GenreSelect genre={genre} genres={genres} onChange={setGenre} /> : undefined}
      >
        <div className="mb-4 flex items-center gap-1 border-b border-chartborder pb-3">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                tab === t.id ? "bg-brand-tint text-brand" : "text-ink-muted hover:bg-surface2 hover:text-ink-primary"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        {tab === "press" ? <Press /> : <CreatorPitchList genre={genre} platform={tab} />}
      </Card>

      <Card
        title="Channel mix"
        subtitle={genre ? `Share of marketing attention by channel — ${genre}` : "Pick a genre"}
        action={<GenreSelect genre={genre} genres={genres} onChange={setGenre} />}
      >
        {mixQ.isLoading && <div className="flex h-32 items-center justify-center text-xs text-ink-muted">Loading…</div>}
        {mixQ.isError && (
          <div className="text-xs text-status-serious">
            Failed to load channel mix{mixQ.error instanceof Error ? `: ${mixQ.error.message}` : "."}
          </div>
        )}
        {mixQ.data && <ChannelMixChart rows={mixQ.data.items} />}
      </Card>

      <Card
        title="Reach-weighted buzz — rising & cooling, across every channel"
        subtitle="Bigram themes mined from press + creator-platform titles, weighted by audience size — last 3 complete months vs. the 3 before that"
      >
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
          <div>
            <div className="mb-2 text-xs font-semibold text-ink-primary">Rising</div>
            {risingQ.isLoading && <div className="flex h-24 items-center justify-center text-xs text-ink-muted">Loading…</div>}
            {risingQ.data && <ChannelBuzzList items={risingQ.data.items} />}
          </div>
          <div>
            <div className="mb-2 text-xs font-semibold text-ink-primary">Cooling</div>
            {coolingQ.isLoading && <div className="flex h-24 items-center justify-center text-xs text-ink-muted">Loading…</div>}
            {coolingQ.data && <ChannelBuzzList items={coolingQ.data.items} />}
          </div>
        </div>
        {(risingQ.data ?? coolingQ.data) && (risingQ.data?.items.length ?? 0) + (coolingQ.data?.items.length ?? 0) === 0 && (
          <div className="mt-2 text-center text-xs text-ink-muted">
            No buzz yet — this builds up once channel scrapers and the press corpus have enough recent volume.
          </div>
        )}
        {risingQ.data && (
          <div className="mt-4 rounded-md border border-chartborder bg-page p-3">
            <div className="mb-1.5 text-xs font-semibold text-ink-primary">Read this with caveats</div>
            <ul className="flex flex-col gap-1.5 text-xs text-ink-secondary">
              {risingQ.data.caveats.map((c, i) => (
                <li key={i} className="flex gap-2">
                  <span className="shrink-0 text-ink-muted">·</span>
                  <span>{c}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </Card>
    </div>
  );
}

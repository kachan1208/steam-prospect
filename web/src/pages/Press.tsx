import { useEffect, useMemo, useState } from "react";

import { BuzzTrendsList } from "../components/charts/BuzzTrendsList";
import { PressBySourceChart, sourceLabel } from "../components/charts/PressBySourceChart";
import { PressCoverageHeatmap } from "../components/charts/PressCoverageHeatmap";
import { PressCoverageScatter } from "../components/charts/PressCoverageScatter";
import { Card } from "../components/ui/Card";
import {
  useBuzzTrends,
  usePitchList,
  usePressCoverage,
  type PitchAuthor,
  type PitchOutlet,
} from "../lib/api";
import { fmtInt, fmtPct, fmtUsd } from "../lib/format";

/** DuckDB TIMESTAMP strings ("2026-07-10 14:30:15.095") -> "2026-07-10". */
function dateOnly(s: string | null): string {
  return s ? s.slice(0, 10) : "—";
}

function ExampleLink({ title, url, date }: { title: string | null; url: string | null; date: string | null }) {
  if (!title) return <span className="text-xs text-ink-muted">No example article.</span>;
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

function OutletCard({ outlet }: { outlet: PitchOutlet }) {
  return (
    <div className="rounded-md border border-chartborder p-2.5">
      <div className="mb-1.5 flex items-baseline justify-between gap-2">
        <span className="text-xs font-semibold text-ink-primary">{sourceLabel(outlet.source)}</span>
        <span className="tabular text-[10px] text-ink-muted">
          {fmtInt(outlet.n_articles)} articles · {fmtInt(outlet.n_articles_recent_24m)} in last 24mo
        </span>
      </div>
      <div className="mb-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] text-ink-muted">
        <span>{fmtInt(outlet.n_games_covered)} games covered</span>
        <span>Median est. rev {fmtUsd(outlet.median_est_rev)}</span>
        <span>Median rating {fmtPct(outlet.median_positive_ratio, 0)}</span>
      </div>
      <ExampleLink title={outlet.example_title} url={outlet.example_url} date={outlet.example_published_at} />
      {outlet.example_author && <div className="mt-0.5 text-[10px] text-ink-muted">by {outlet.example_author}</div>}
    </div>
  );
}

function AuthorRow({ author, rank }: { author: PitchAuthor; rank: number }) {
  const isActive = author.n_articles_recent_24m >= 3;
  return (
    <tr className="border-b border-chartborder/60 align-top last:border-0">
      <td className="tabular px-2 py-2 text-ink-muted">{rank}</td>
      <td className="px-2 py-2">
        <div className="font-medium text-ink-primary">{author.author}</div>
        <div className="mt-1 flex flex-wrap gap-1">
          {author.outlets.map((o) => (
            <span key={o} className="rounded-full border border-chartborder px-1.5 py-0.5 text-[10px] text-ink-secondary">
              {sourceLabel(o)}
            </span>
          ))}
        </div>
      </td>
      <td className="tabular px-2 py-2 text-ink-secondary">{fmtInt(author.n_articles)}</td>
      <td className="px-2 py-2">
        <span className="tabular text-ink-secondary">{fmtInt(author.n_articles_recent_24m)}</span>{" "}
        <span className={isActive ? "text-[10px] text-status-good" : "text-[10px] text-ink-muted"}>
          {isActive ? "active" : "quiet"}
        </span>
      </td>
      <td className="tabular px-2 py-2 text-ink-secondary">{fmtInt(author.n_distinct_games)}</td>
      <td className="max-w-[280px] px-2 py-2">
        <ExampleLink title={author.example_title} url={author.example_url} date={author.example_published_at} />
      </td>
    </tr>
  );
}

function CaveatsList({ caveats }: { caveats: string[] }) {
  if (caveats.length === 0) return null;
  return (
    <Card title="Read this with caveats">
      <ul className="flex flex-col gap-1.5 text-xs text-ink-secondary">
        {caveats.map((c, i) => (
          <li key={i} className="flex gap-2">
            <span className="shrink-0 text-ink-muted">·</span>
            <span>{c}</span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

export default function Press() {
  const coverageQ = usePressCoverage();
  const [genre, setGenre] = useState<string | null>(null);

  // Default to the most-covered genre once the coverage matrix loads (a genre with real
  // signal, not an alphabetically-first pick that might be sparse).
  useEffect(() => {
    if (genre !== null || !coverageQ.data || coverageQ.data.items.length === 0) return;
    const totals = new Map<string, number>();
    for (const r of coverageQ.data.items) totals.set(r.genre, (totals.get(r.genre) ?? 0) + r.n_articles);
    const top = [...totals.entries()].sort((a, b) => b[1] - a[1])[0];
    setGenre(top ? top[0] : coverageQ.data.genres[0] ?? null);
  }, [coverageQ.data, genre]);

  const pitchQ = usePitchList(genre, 20);
  const risingQ = useBuzzTrends("rising", 12);
  const coolingQ = useBuzzTrends("cooling", 12);

  const outletBars = useMemo(
    () => (pitchQ.data?.outlets ?? []).map((o) => ({ source: o.source, n_mentions: o.n_articles })),
    [pitchQ.data],
  );

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-lg font-semibold text-ink-primary">Press / Marketing</h1>
        <p className="mt-0.5 text-sm text-ink-muted">
          Who covers a genre, outlet x genre coverage, and rising/cooling buzz — from 1.12M scraped articles
          (journalist outlets only; Steam News excluded).
        </p>
      </div>

      <Card
        title="Pitch list — who to pitch"
        subtitle={
          genre
            ? `Ranked outlets and named journalists covering ${genre} — with an example headline each`
            : "Pick a genre"
        }
        action={
          <select
            value={genre ?? ""}
            onChange={(e) => setGenre(e.target.value)}
            disabled={!coverageQ.data}
            className="rounded-md border border-chartborder bg-page px-2 py-1.5 text-xs text-ink-primary outline-none focus:border-series-1"
          >
            {(coverageQ.data?.genres ?? []).map((g) => (
              <option key={g} value={g}>
                {g}
              </option>
            ))}
          </select>
        }
      >
        {pitchQ.isLoading && <div className="flex h-40 items-center justify-center text-xs text-ink-muted">Loading…</div>}
        {pitchQ.isError && (
          <div className="text-xs text-status-serious">
            Failed to load pitch list{pitchQ.error instanceof Error ? `: ${pitchQ.error.message}` : "."}
          </div>
        )}
        {pitchQ.data && pitchQ.data.outlets.length === 0 && pitchQ.data.authors.length === 0 && (
          <div className="flex h-24 flex-col items-center justify-center gap-1 text-center text-xs text-ink-muted">
            <span>No confidence-filtered journalist coverage found for "{genre}".</span>
            <span>Try another genre — this one may be a community tag (like "Roguelike"), not a Steam genre.</span>
          </div>
        )}
        {pitchQ.data && (pitchQ.data.outlets.length > 0 || pitchQ.data.authors.length > 0) && (
          <div className="flex flex-col gap-5">
            <div>
              <div className="mb-2 text-xs font-semibold text-ink-primary">Outlets</div>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <PressBySourceChart data={outletBars} />
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  {pitchQ.data.outlets.map((o) => (
                    <OutletCard key={o.source} outlet={o} />
                  ))}
                </div>
              </div>
            </div>

            <div>
              <div className="mb-2 flex items-baseline justify-between">
                <span className="text-xs font-semibold text-ink-primary">Journalists</span>
                <span className="text-[11px] text-ink-muted">
                  Ranked by all-time article volume · "active" = wrote &ge;3 pieces in the last 24 months
                </span>
              </div>
              {pitchQ.data.authors.length === 0 ? (
                <div className="text-xs text-ink-muted">No named (non-staff) bylines found for this genre.</div>
              ) : (
                <div className="overflow-x-auto rounded-card border border-chartborder">
                  <table className="w-full min-w-[720px] text-xs">
                    <thead>
                      <tr className="border-b border-chartborder text-left text-ink-muted">
                        <th className="px-2 py-1.5 font-medium">#</th>
                        <th className="px-2 py-1.5 font-medium">Journalist</th>
                        <th className="px-2 py-1.5 font-medium">Articles</th>
                        <th className="px-2 py-1.5 font-medium">Last 24mo</th>
                        <th className="px-2 py-1.5 font-medium">Games</th>
                        <th className="px-2 py-1.5 font-medium">Example</th>
                      </tr>
                    </thead>
                    <tbody>
                      {pitchQ.data.authors.map((a, i) => (
                        <AuthorRow key={a.author} author={a} rank={i + 1} />
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        )}
      </Card>

      {pitchQ.data && <CaveatsList caveats={pitchQ.data.caveats} />}

      <Card
        title="Outlet x genre coverage"
        subtitle="How much each outlet covers each genre — toggle the measure; hover a cell for the covered games' outcomes"
      >
        {coverageQ.isLoading && <div className="flex h-40 items-center justify-center text-xs text-ink-muted">Loading…</div>}
        {coverageQ.isError && (
          <div className="text-xs text-status-serious">
            Failed to load coverage matrix{coverageQ.error instanceof Error ? `: ${coverageQ.error.message}` : "."}
          </div>
        )}
        {coverageQ.data && <PressCoverageHeatmap rows={coverageQ.data.items} />}
      </Card>

      <Card
        title="Buzz trends — rising &amp; cooling themes"
        subtitle="Bigram frequency in journalist article titles, last 3 complete months vs. the 3 before that — a leading indicator, not a sales signal"
      >
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
          <div>
            <div className="mb-2 text-xs font-semibold text-ink-primary">Rising</div>
            {risingQ.isLoading && <div className="flex h-24 items-center justify-center text-xs text-ink-muted">Loading…</div>}
            {risingQ.data && <BuzzTrendsList items={risingQ.data.items} />}
          </div>
          <div>
            <div className="mb-2 text-xs font-semibold text-ink-primary">Cooling</div>
            {coolingQ.isLoading && <div className="flex h-24 items-center justify-center text-xs text-ink-muted">Loading…</div>}
            {coolingQ.data && <BuzzTrendsList items={coolingQ.data.items} />}
          </div>
        </div>
        {(risingQ.data ?? coolingQ.data) && <CaveatsList caveats={(risingQ.data ?? coolingQ.data)!.caveats} />}
      </Card>

      <Card
        title="Coverage vs. covered-games' outcome"
        subtitle='Each point is one (outlet, genre) cell — correlation ≠ causation: this cannot separate "press moved sales" from "successful games attract more press" (selection bias runs both ways)'
      >
        {coverageQ.data && <PressCoverageScatter rows={coverageQ.data.items} />}
      </Card>
    </div>
  );
}

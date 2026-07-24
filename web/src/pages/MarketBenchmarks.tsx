import { useState } from "react";
import clsx from "clsx";

import { BoxleiterFitChart } from "../components/charts/BoxleiterFitChart";
import { Histogram } from "../components/charts/Histogram";
import { Card } from "../components/ui/Card";
import { StatTile } from "../components/ui/StatTile";
import {
  useGenres,
  useMarketBenchmarks,
  useMarketDistribution,
  type DistributionMetric,
  type Window,
} from "../lib/api";
import { fmtCompact, fmtInt, fmtPct, fmtUsd } from "../lib/format";
import { CSS_VAR, tierColor } from "../lib/palette";
import { useTheme } from "../lib/theme";

const METRIC_OPTIONS: { value: DistributionMetric; label: string; formatX: (n: number) => string }[] = [
  { value: "revenue", label: "Revenue", formatX: fmtUsd },
  { value: "reviews", label: "Reviews", formatX: fmtCompact },
  { value: "owners", label: "Owners", formatX: fmtCompact },
];

function SegButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={clsx(
        "rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
        active ? "bg-page text-ink-primary" : "text-ink-muted hover:text-ink-secondary",
      )}
    >
      {children}
    </button>
  );
}

export default function MarketBenchmarks() {
  const { theme } = useTheme();
  const genres = useGenres();
  const { data: benchmarks, isLoading: benchmarksLoading } = useMarketBenchmarks();

  const [metric, setMetric] = useState<DistributionMetric>("revenue");
  const [distGenre, setDistGenre] = useState("__all__");
  const [distWindow, setDistWindow] = useState<Window>("all");
  const [boxleiterGenre, setBoxleiterGenre] = useState("__all__");

  const { data: dist, isLoading: distLoading } = useMarketDistribution(metric, distGenre, distWindow);
  const metricOpt = METRIC_OPTIONS.find((m) => m.value === metric) ?? METRIC_OPTIONS[0];

  const cited = benchmarks?.cited;
  const computed = benchmarks?.computed;
  const tierPct = new Map((benchmarks?.tiers ?? []).map((t) => [t.tier, t.pct]));

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-lg font-semibold text-ink-primary">Market Benchmarks</h1>
        <p className="mt-0.5 text-sm text-ink-muted">
          Cited indie-market reference points alongside what this catalog actually shows.
        </p>
      </div>

      <div>
        <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-muted">Cited (external research)</div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatTile label="Median indie gross" value={cited ? fmtUsd(cited.median_indie_gross_usd) : "…"} sub="VG Insights 2025" />
          <StatTile
            label="New releases clearing $100K"
            value={cited ? fmtPct(cited.pct_new_releases_over_100k) : "…"}
            sub="of ALL new releases"
          />
          <StatTile
            label="Boxleiter owners/review"
            value={cited ? `${cited.boxleiter_owners_per_review.mid}` : "…"}
            sub={cited ? `range ${cited.boxleiter_owners_per_review.min}-${cited.boxleiter_owners_per_review.max}, genre-dependent` : undefined}
          />
          <StatTile label="Dev revenue share" value={cited ? fmtPct(cited.steam_revenue_share_to_dev) : "…"} sub="after Steam's ~30% cut" />
        </div>
      </div>

      <div>
        <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-muted">This catalog (computed)</div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatTile label="Median revenue (≥10 reviews)" value={computed ? fmtUsd(computed.median_revenue_scored) : "…"} />
          <StatTile label="Median revenue (paid titles)" value={computed ? fmtUsd(computed.median_revenue_paid) : "…"} />
          <StatTile label="Clearing $100K (this catalog)" value={computed ? fmtPct(computed.pct_over_100k_scored) : "…"} />
          <StatTile
            label="Catalog size"
            value={computed ? fmtCompact(computed.n_games_scored) : "…"}
            sub={computed ? `of ${fmtCompact(computed.n_games_total)} total releases` : undefined}
          />
        </div>
        {computed?.population_note && <p className="mt-2 text-[11px] italic text-ink-muted">{computed.population_note}</p>}
        {benchmarksLoading && <p className="mt-2 text-xs text-ink-muted">Loading benchmarks…</p>}
      </div>

      <Card
        title="Long-tail distribution"
        subtitle={dist ? `${dist.n.toLocaleString()} games · log-scaled buckets` : undefined}
        action={
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-0.5 rounded-md border border-chartborder p-0.5">
              {METRIC_OPTIONS.map((m) => (
                <SegButton key={m.value} active={metric === m.value} onClick={() => setMetric(m.value)}>
                  {m.label}
                </SegButton>
              ))}
            </div>
            <div className="flex items-center gap-0.5 rounded-md border border-chartborder p-0.5">
              <SegButton active={distWindow === "all"} onClick={() => setDistWindow("all")}>
                All-time
              </SegButton>
              <SegButton active={distWindow === "24m"} onClick={() => setDistWindow("24m")}>
                24m
              </SegButton>
            </div>
            <select
              value={distGenre}
              onChange={(e) => setDistGenre(e.target.value)}
              className="rounded-md border border-chartborder bg-page px-2 py-1.5 text-xs text-ink-primary outline-none focus:border-series-1"
            >
              {genres.map((g) => (
                <option key={g.value} value={g.value}>
                  {g.label}
                </option>
              ))}
            </select>
          </div>
        }
      >
        {distLoading && !dist && <div className="flex h-40 items-center justify-center text-xs text-ink-muted">Loading…</div>}
        {dist && (
          <div data-tour="tour-benchmarks-distribution">
            <Histogram
              buckets={dist.buckets}
              color={CSS_VAR.demand}
              formatX={metricOpt.formatX}
              marks={dist.benchmark_marks.map((m) => ({ label: m.label, value: m.value }))}
            />
            <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 border-t border-chartborder pt-3 text-xs">
              {dist.percentiles.map((p) => (
                <span key={p.pctile} className="text-ink-secondary">
                  <span className="text-ink-muted">{p.pctile.toUpperCase()}</span>{" "}
                  <span className="tabular font-medium text-ink-primary">{metricOpt.formatX(p.value)}</span>
                </span>
              ))}
            </div>
          </div>
        )}
      </Card>

      <Card
        title="Boxleiter: reviews → owners"
        subtitle="Same conversion the Estimator uses — a genre-fitted slope, clamped to the cited 20-55 band"
        action={
          <select
            value={boxleiterGenre}
            onChange={(e) => setBoxleiterGenre(e.target.value)}
            className="rounded-md border border-chartborder bg-page px-2 py-1.5 text-xs text-ink-primary outline-none focus:border-series-1"
          >
            {genres.map((g) => (
              <option key={g.value} value={g.value}>
                {g.label}
              </option>
            ))}
          </select>
        }
      >
        {benchmarks && (
          <>
            <BoxleiterFitChart
              genre={boxleiterGenre}
              rows={benchmarks.boxleiter_by_genre}
              min={benchmarks.cited.boxleiter_owners_per_review.min}
              max={benchmarks.cited.boxleiter_owners_per_review.max}
            />
            <div className="mt-3 max-h-56 overflow-y-auto rounded-md border border-chartborder">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-surface">
                  <tr className="border-b border-chartborder text-left text-ink-muted">
                    <th className="px-2 py-1.5 font-medium">Genre</th>
                    <th className="px-2 py-1.5 font-medium">n</th>
                    <th className="px-2 py-1.5 font-medium">Median ratio</th>
                    <th className="px-2 py-1.5 font-medium">P25</th>
                    <th className="px-2 py-1.5 font-medium">P75</th>
                    <th className="px-2 py-1.5 font-medium">Fitted slope</th>
                  </tr>
                </thead>
                <tbody>
                  {benchmarks.boxleiter_by_genre.map((b) => (
                    <tr key={b.genre} className="border-b border-chartborder/60 last:border-0">
                      <td className="px-2 py-1.5 font-medium text-ink-primary">{b.genre === "__all__" ? "All genres" : b.genre}</td>
                      <td className="tabular px-2 py-1.5">{fmtInt(b.n)}</td>
                      <td className="tabular px-2 py-1.5">{fmtCompact(b.owners_per_review_median)}</td>
                      <td className="tabular px-2 py-1.5">{fmtCompact(b.owners_per_review_p25)}</td>
                      <td className="tabular px-2 py-1.5">{fmtCompact(b.owners_per_review_p75)}</td>
                      <td className="tabular px-2 py-1.5">{fmtCompact(b.slope)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </Card>

      <Card title="Dev tiers" subtitle="By lifetime copies sold">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {(cited?.dev_tiers ?? []).map((tier) => (
            <div key={tier.label} className="rounded-card border border-chartborder p-3">
              <div className="flex items-center gap-1.5">
                <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: tierColor(tier.label, theme) }} />
                <span className="text-sm font-semibold text-ink-primary">{tier.label}</span>
              </div>
              <div className="mt-1.5 tabular text-xs text-ink-secondary">
                {fmtCompact(tier.min_copies)} – {tier.max_copies ? fmtCompact(tier.max_copies) : "∞"} copies
              </div>
              <div className="tabular text-xs text-ink-secondary">~{fmtUsd(tier.revenue_anchor_usd)} anchor revenue</div>
              {tierPct.has(tier.label) && (
                <div className="tabular mt-1 text-xs text-ink-muted">{fmtPct(tierPct.get(tier.label) ?? 0)} of catalog</div>
              )}
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}

import { useEffect, useState } from "react";
import clsx from "clsx";

import { Histogram } from "./charts/Histogram";
import { OpportunityBars } from "./charts/OpportunityBars";
import { SaturationTrend } from "./charts/SaturationTrend";
import { Badge } from "./ui/Badge";
import { Drawer } from "./ui/Drawer";
import { BulletMeter } from "./ui/Meter";
import { StatTile } from "./ui/StatTile";
import {
  nicheExportCsvUrl,
  useMarketBenchmarks,
  useNicheDetail,
  type Dimension,
  type NicheRow,
  type Window,
} from "../lib/api";
import { fmtCompact, fmtInt, fmtPct, fmtPrice, fmtUsd, titleCase } from "../lib/format";
import { CSS_VAR } from "../lib/palette";

function variantLabel(v: NicheRow): string {
  return `${v.window === "24m" ? "Last 24m" : "All-time"} · ≥${v.min_reviews} reviews`;
}

export function NicheDetailDrawer({
  dimension,
  row,
  onClose,
}: {
  dimension: Dimension;
  row: NicheRow;
  onClose: () => void;
}) {
  const { data: detail, isLoading, isError } = useNicheDetail(dimension, row.key);
  const { data: benchmarks } = useMarketBenchmarks();
  const [activeVariant, setActiveVariant] = useState<NicheRow>(row);

  useEffect(() => {
    setActiveVariant(row);
  }, [row]);

  const catalogHitRateBenchmark = benchmarks?.cited.pct_new_releases_over_100k;

  const csvUrl = nicheExportCsvUrl({
    dimension,
    window: activeVariant.window as Window,
    min_reviews: activeVariant.min_reviews,
    q: row.key,
    limit: 10,
  });

  return (
    <Drawer open onClose={onClose} title={row.key} subtitle={`${titleCase(dimension)} niche · ${variantLabel(activeVariant)}`}>
      <div className="flex flex-col gap-6 pb-8">
        {detail && detail.variants.length > 1 && (
          <div className="flex flex-wrap gap-1.5">
            {detail.variants.map((v) => (
              <button
                key={`${v.window}-${v.min_reviews}`}
                type="button"
                onClick={() => setActiveVariant(v)}
                className={clsx(
                  "rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors",
                  v.window === activeVariant.window && v.min_reviews === activeVariant.min_reviews
                    ? "border-series-1 bg-page text-ink-primary"
                    : "border-chartborder text-ink-muted hover:text-ink-secondary",
                )}
              >
                {variantLabel(v)}
              </button>
            ))}
          </div>
        )}

        <div className="grid grid-cols-3 gap-3">
          <StatTile label="P25 revenue" value={fmtUsd(activeVariant.p25_rev)} />
          <StatTile label="Median revenue" value={fmtUsd(activeVariant.median_rev)} />
          <StatTile label="P75 revenue" value={fmtUsd(activeVariant.p75_rev)} />
        </div>

        <section>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-muted">Opportunity</h3>
          <div className="flex items-center gap-6 rounded-card border border-chartborder p-3">
            <OpportunityBars
              demand={activeVariant.demand}
              competition={activeVariant.competition}
              quality_gap={activeVariant.quality_gap}
            />
            <div className="grid flex-1 grid-cols-3 gap-2 text-center">
              <div>
                <div className="text-[10px] text-ink-muted">Demand</div>
                <div className="tabular text-sm font-semibold text-ink-primary">{fmtCompact(activeVariant.demand)}</div>
              </div>
              <div>
                <div className="text-[10px] text-ink-muted">Competition</div>
                <div className="tabular text-sm font-semibold text-ink-primary">{fmtCompact(activeVariant.competition)}</div>
              </div>
              <div>
                <div className="text-[10px] text-ink-muted">Quality gap</div>
                <div className="tabular text-sm font-semibold text-ink-primary">{fmtCompact(activeVariant.quality_gap)}</div>
              </div>
            </div>
            <div className="shrink-0 border-l border-chartborder pl-6 text-center">
              <div className="text-[10px] text-ink-muted">Opportunity</div>
              <div className="tabular text-xl font-bold text-ink-primary">{fmtCompact(activeVariant.opportunity)}</div>
            </div>
          </div>
        </section>

        <section>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-muted">Hit rates vs. benchmark</h3>
          <div className="flex flex-col gap-3 rounded-card border border-chartborder p-3">
            <BulletMeter
              label="Hit rate ≥ $200K"
              value={activeVariant.hit_rate_200k}
              benchmark={catalogHitRateBenchmark}
              benchmarkLabel={
                catalogHitRateBenchmark !== undefined
                  ? `Catalog-wide: ${fmtPct(catalogHitRateBenchmark)} of ALL releases clear $100K (lower bar, cited for scale)`
                  : undefined
              }
              color={CSS_VAR.demand}
              valueLabel={fmtPct(activeVariant.hit_rate_200k)}
            />
            <BulletMeter
              label="Hit rate ≥ $500K"
              value={activeVariant.hit_rate_500k}
              benchmark={catalogHitRateBenchmark}
              benchmarkLabel={
                catalogHitRateBenchmark !== undefined
                  ? `Catalog-wide: ${fmtPct(catalogHitRateBenchmark)} of ALL releases clear $100K (lower bar, cited for scale)`
                  : undefined
              }
              color={CSS_VAR.demand}
              valueLabel={fmtPct(activeVariant.hit_rate_500k)}
            />
            <BulletMeter
              label="Beatable share (thin/weak competitors)"
              value={activeVariant.beatable_share}
              color={CSS_VAR.qualityGap}
              valueLabel={fmtPct(activeVariant.beatable_share)}
            />
            <BulletMeter
              label="Winner concentration (top 5% revenue share)"
              value={activeVariant.winner_concentration}
              color={CSS_VAR.competition}
              valueLabel={fmtPct(activeVariant.winner_concentration)}
            />
          </div>
        </section>

        <section>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-muted">Saturation trend</h3>
          {isLoading && <div className="text-xs text-ink-muted">Loading trend…</div>}
          {isError && <div className="text-xs text-status-serious">Could not load trend data.</div>}
          {detail && <SaturationTrend points={detail.saturation_trend} />}
        </section>

        <section>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-muted">Revenue distribution in niche</h3>
          {isLoading && <div className="text-xs text-ink-muted">Loading distribution…</div>}
          {detail && (
            <Histogram buckets={detail.revenue_histogram} color={CSS_VAR.demand} formatX={fmtUsd} height={200} />
          )}
        </section>

        <section>
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-muted">Representative games</h3>
            <a
              href={csvUrl}
              className="rounded-md border border-chartborder px-2.5 py-1 text-[11px] font-medium text-ink-secondary hover:text-ink-primary"
            >
              Export CSV
            </a>
          </div>
          {isLoading && <div className="text-xs text-ink-muted">Loading games…</div>}
          {detail && detail.representative_games.length === 0 && (
            <div className="text-xs text-ink-muted">No representative games recorded for this niche.</div>
          )}
          {detail && detail.representative_games.length > 0 && (
            <div className="overflow-x-auto rounded-card border border-chartborder">
              <table className="w-full min-w-[560px] text-xs">
                <thead>
                  <tr className="border-b border-chartborder text-left text-ink-muted">
                    <th className="px-2 py-1.5 font-medium">#</th>
                    <th className="px-2 py-1.5 font-medium">Game</th>
                    <th className="px-2 py-1.5 font-medium">Year</th>
                    <th className="px-2 py-1.5 font-medium">Price</th>
                    <th className="px-2 py-1.5 font-medium">Owners</th>
                    <th className="px-2 py-1.5 font-medium">Reviews</th>
                    <th className="px-2 py-1.5 font-medium">Positive</th>
                    <th className="px-2 py-1.5 font-medium">Est. revenue</th>
                    <th className="px-2 py-1.5 font-medium">Publisher</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.representative_games.map((g) => (
                    <tr key={g.appid} className="border-b border-chartborder/60 last:border-0">
                      <td className="tabular px-2 py-1.5 text-ink-muted">{g.rank_in_niche}</td>
                      <td className="max-w-[180px] truncate px-2 py-1.5 font-medium text-ink-primary" title={g.name ?? undefined}>
                        {g.name ?? `App ${g.appid}`}
                      </td>
                      <td className="tabular px-2 py-1.5">{g.release_year ?? "—"}</td>
                      <td className="tabular px-2 py-1.5">{fmtPrice(g.price_initial)}</td>
                      <td className="tabular px-2 py-1.5">{fmtCompact(g.owners_mid)}</td>
                      <td className="tabular px-2 py-1.5">{fmtInt(g.total_reviews)}</td>
                      <td className="tabular px-2 py-1.5">{fmtPct(g.positive_ratio)}</td>
                      <td className="tabular px-2 py-1.5">{fmtUsd(g.est_rev_reviews)}</td>
                      <td className="px-2 py-1.5">
                        <Badge>{g.self_published ? "Self-published" : "Publisher"}</Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </Drawer>
  );
}

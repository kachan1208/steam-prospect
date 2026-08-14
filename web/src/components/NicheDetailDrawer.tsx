import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import clsx from "clsx";
import { Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

import { Histogram } from "./charts/Histogram";
import { OpportunityBars } from "./charts/OpportunityBars";
import { SaturationTrend } from "./charts/SaturationTrend";
import { TooltipPanel } from "./charts/TooltipPanel";
import { Badge } from "./ui/Badge";
import { Drawer } from "./ui/Drawer";
import { BulletMeter } from "./ui/Meter";
import { StatTile } from "./ui/StatTile";
import {
  nicheExportCsvUrl,
  useMarketBenchmarks,
  useNicheDetail,
  type Dimension,
  type NichePlayers,
  type NichePlayersPoint,
  type NichePressPoint,
  type NicheRow,
  type Window,
} from "../lib/api";
import { fmtCompact, fmtInt, fmtPct, fmtPrice, fmtRevenue, fmtSigned, fmtUsd, titleCase } from "../lib/format";
import { CSS_VAR } from "../lib/palette";

function variantLabel(v: NicheRow): string {
  return `${v.window === "24m" ? "Last 24m" : "All-time"} · ≥${v.min_reviews} reviews`;
}

const TIER_HINT: Record<string, string> = {
  micro: "buildable game concept",
  theme: "setting/aesthetic — attach it to a micro-genre",
  umbrella: "genre container, not a buildable niche",
  meta: "reception tag, never buildable",
  genre: "Steam genre",
};

/** The falsification rules from the growth-gate work, rendered as read-this-first flags:
 * a niche that LOOKS open can be a market in decline, a hits-only market, or not solo-
 * buildable — each check names the trap before the shiny score gets believed. */
function declineFlags(v: NicheRow, players: NichePlayers | null): { serious: boolean; text: string }[] {
  const flags: { serious: boolean; text: string }[] = [];
  if (v.saturation_yoy != null && v.saturation_yoy < -0.05) {
    flags.push({
      serious: v.saturation_yoy < -0.15,
      text: `Release pipeline shrinking ${fmtPct(Math.abs(v.saturation_yoy))}/yr — "low competition" here is everyone leaving, not an open market.`,
    });
  }
  if (v.entrant_ratio != null && v.entrant_ratio < 1) {
    flags.push({
      serious: v.entrant_ratio < 0.7,
      text: `Recent entrants earn ${v.entrant_ratio.toFixed(2)}× the back catalog's median (catalog norm ~1.08) — newcomers underearn here.`,
    });
  }
  if (v.winner_concentration != null && v.winner_concentration > 0.85) {
    flags.push({
      serious: false,
      text: `Winner-take-most: the top 5% of titles hold ${fmtPct(v.winner_concentration)} of revenue — expect the median outcome, not the hits.`,
    });
  }
  if (v.solo_viability != null && v.solo_viability < 0.8) {
    flags.push({
      serious: v.solo_viability < 0.6,
      text: `Leans multiplayer (${fmtPct(v.solo_viability)} of games playable single-player; norm ~90%) — netcode, servers and a live player base are table stakes.`,
    });
  }
  if (players?.players_trend_7d_pct != null && players.players_trend_7d_pct < -10) {
    flags.push({
      serious: false,
      text: `Live players down ${Math.abs(players.players_trend_7d_pct).toFixed(1)}% vs the prior 7 days (same-panel).`,
    });
  }
  return flags;
}

function PlayersSeriesChart({ points }: { points: NichePlayersPoint[] }) {
  if (points.length === 0) {
    return (
      <div className="flex h-24 items-center justify-center text-xs text-ink-muted">
        No daily series yet — fewer than 10 of this niche's games have been measured.
      </div>
    );
  }
  return (
    <ResponsiveContainer width="100%" height={150}>
      <LineChart data={points} margin={{ top: 6, right: 8, left: 0, bottom: 0 }}>
        <CartesianGrid stroke="var(--gridline)" vertical={false} />
        <XAxis
          dataKey="date"
          tick={{ fontSize: 10 }}
          tickFormatter={(v: string) => v.slice(5)}
          interval="preserveStartEnd"
          minTickGap={24}
          tickLine={false}
          axisLine={{ stroke: "var(--baseline)" }}
        />
        <YAxis
          tick={{ fontSize: 10 }}
          tickFormatter={(v: number) => fmtCompact(v)}
          tickLine={false}
          axisLine={false}
          width={44}
        />
        <Tooltip
          cursor={{ stroke: "var(--baseline)" }}
          content={({ active, payload, label }) => {
            if (!active || !payload || payload.length === 0) return null;
            const p = payload[0].payload as NichePlayersPoint;
            return (
              <TooltipPanel
                title={String(label)}
                rows={[
                  { label: "Total players", value: fmtCompact(p.total_players), color: CSS_VAR.demand },
                  {
                    label: `Measured same-day (${fmtInt(p.n_games_measured)} games)`,
                    value: p.measured_players != null ? fmtCompact(p.measured_players) : "—",
                    color: CSS_VAR.competition,
                  },
                ]}
              />
            );
          }}
        />
        <Line
          type="monotone"
          dataKey="total_players"
          stroke={CSS_VAR.demand}
          strokeWidth={2}
          dot={points.length <= 45 ? { r: 2.5, fill: CSS_VAR.demand, strokeWidth: 0 } : false}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}

/** Monthly press-mention volume for the niche — same single-hue count-per-period bar shape
 * (and same aqua hue) as the game page's PressTimelineChart, since both slice the identical
 * underlying metric (journalist press mentions), just per game vs. pooled per niche. */
function NichePressChart({ points }: { points: NichePressPoint[] }) {
  return (
    <ResponsiveContainer width="100%" height={150}>
      <BarChart data={points} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
        <CartesianGrid stroke="var(--gridline)" vertical={false} />
        <XAxis
          dataKey="month"
          tick={{ fontSize: 10 }}
          interval="preserveStartEnd"
          minTickGap={24}
          tickLine={false}
          axisLine={{ stroke: "var(--baseline)" }}
        />
        <YAxis
          tick={{ fontSize: 10 }}
          tickFormatter={(v: number) => fmtInt(v)}
          tickLine={false}
          axisLine={false}
          width={36}
          allowDecimals={false}
        />
        <Tooltip
          cursor={{ fill: "var(--gridline)", opacity: 0.5 }}
          content={({ active, payload, label }) => {
            if (!active || !payload || payload.length === 0) return null;
            const p = payload[0].payload as NichePressPoint;
            return (
              <TooltipPanel
                title={String(label)}
                rows={[{ label: "Articles", value: fmtInt(p.n_articles), color: CSS_VAR.competition }]}
              />
            );
          }}
        />
        <Bar dataKey="n_articles" fill={CSS_VAR.competition} radius={[4, 4, 0, 0]} maxBarSize={20} />
      </BarChart>
    </ResponsiveContainer>
  );
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
  const players = detail?.players ?? null;
  const flags = declineFlags(activeVariant, players);
  const tier = detail?.tier ?? row.tier;

  const csvUrl = nicheExportCsvUrl({
    dimension,
    window: activeVariant.window as Window,
    min_reviews: activeVariant.min_reviews,
    q: row.key,
    limit: 10,
  });

  return (
    <Drawer
      open
      onClose={onClose}
      title={row.key}
      subtitle={`${titleCase(dimension)} niche${tier ? ` · ${tier} (${TIER_HINT[tier] ?? tier})` : ""} · ${variantLabel(activeVariant)}`}
    >
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

        {/* Bearish read FIRST: the traps this exact cut is showing, before the scores. */}
        {flags.length > 0 ? (
          <div className="flex flex-col gap-1.5 rounded-card border border-chartborder bg-surface2/50 p-3">
            <div className="text-xs font-semibold uppercase tracking-wide text-ink-muted">Read this first</div>
            {flags.map((f) => (
              <div key={f.text} className="flex items-start gap-2 text-xs text-ink-secondary">
                <span
                  aria-hidden
                  className={clsx(
                    "mt-1 h-1.5 w-1.5 shrink-0 rounded-full",
                    f.serious ? "bg-[var(--status-critical)]" : "bg-[var(--status-warn,#d97706)]",
                  )}
                />
                {f.text}
              </div>
            ))}
          </div>
        ) : (
          <div className="rounded-card border border-chartborder bg-surface2/50 p-3 text-xs text-ink-secondary">
            No decline flags at this cut — pipeline, entrant economics, concentration and solo-viability all read normal.
          </div>
        )}

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
                <div className="tabular text-sm font-semibold text-ink-primary">
                  {fmtCompact(activeVariant.competition)}
                </div>
              </div>
              <div>
                <div className="text-[10px] text-ink-muted">Quality gap</div>
                <div className="tabular text-sm font-semibold text-ink-primary">
                  {fmtCompact(activeVariant.quality_gap)}
                </div>
              </div>
            </div>
            <div className="shrink-0 border-l border-chartborder pl-6 text-center">
              <div className="text-[10px] text-ink-muted">Opportunity v2</div>
              <div className="tabular text-xl font-bold text-ink-primary">{fmtCompact(activeVariant.opportunity_v2)}</div>
              <div className="text-[10px] text-ink-muted" title="opportunity × decline gate — the gate shrinks with pipeline decline or underearning entrants">
                raw {fmtCompact(activeVariant.opportunity)} × gate{" "}
                {activeVariant.decline_gate != null ? activeVariant.decline_gate.toFixed(2) : "—"}
              </div>
            </div>
          </div>
        </section>

        <section>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-muted">
            Live players — is this niche hot right now
          </h3>
          <div className="rounded-card border border-chartborder p-3">
            <div className="mb-3 grid grid-cols-3 gap-3">
              <StatTile
                label="Playing now"
                value={players?.total_players_now != null ? fmtCompact(players.total_players_now) : "—"}
                sub={players?.n_games_panel != null ? `${fmtInt(players.n_games_panel)} games measured` : undefined}
              />
              <StatTile
                label="7-day trend"
                valueClassName={
                  players?.players_trend_7d_pct == null
                    ? undefined
                    : players.players_trend_7d_pct >= 0
                      ? "text-verdict-good"
                      : "text-verdict-serious"
                }
                value={
                  players?.players_trend_7d_pct != null
                    ? `${players.players_trend_7d_pct >= 0 ? "+" : ""}${players.players_trend_7d_pct.toFixed(1)}%`
                    : "—"
                }
                sub="same-panel vs prior 7d"
              />
              <StatTile
                label="Coverage"
                value={players?.players_coverage != null ? fmtPct(players.players_coverage) : "—"}
                sub="measured fresh (≤2d)"
              />
            </div>
            <PlayersSeriesChart points={players?.series ?? []} />
            <p className="mt-2 text-[11px] italic text-ink-muted">
              Nightly ~21–22:00 UTC point samples, not daily peaks; each game's last capture carries forward up to 7
              days so the capture rotation doesn't read as audience dips. Totals are dominated by the niche's biggest
              games — a big number says people play the hits, not that a new entrant gets players.
            </p>
          </div>
        </section>

        <div className="grid grid-cols-3 gap-3">
          <StatTile label="P25 revenue" value={fmtUsd(activeVariant.p25_rev)} />
          <StatTile label="Median revenue" value={fmtUsd(activeVariant.median_rev)} />
          <StatTile label="P75 revenue" value={fmtUsd(activeVariant.p75_rev)} />
        </div>

        <div className="grid grid-cols-3 gap-3">
          <StatTile
            label="Total owners"
            value={fmtCompact(activeVariant.total_owners)}
            sub={activeVariant.market_size != null ? `market size p${Math.round(activeVariant.market_size)}` : undefined}
          />
          <StatTile
            label="Entrant ratio"
            value={activeVariant.entrant_ratio != null ? `${activeVariant.entrant_ratio.toFixed(2)}×` : "—"}
            sub="24m vs all-time median (norm ~1.08)"
          />
          <StatTile
            label="Solo viability"
            value={fmtPct(activeVariant.solo_viability)}
            sub="playable single-player (norm ~90%)"
          />
        </div>

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
          {activeVariant.saturation_yoy != null && (
            <p className="mt-1.5 text-[11px] text-ink-muted">
              Releases {fmtSigned(activeVariant.saturation_yoy * 100, 0)}% year-over-year — a shrinking pipeline is
              decline even when competition looks invitingly low.
            </p>
          )}
        </section>

        <section>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-muted">
            Revenue distribution in niche
          </h3>
          {isLoading && <div className="text-xs text-ink-muted">Loading distribution…</div>}
          {detail && (
            <Histogram buckets={detail.revenue_histogram} color={CSS_VAR.demand} formatX={fmtUsd} height={200} />
          )}
        </section>

        {detail && detail.themes.length > 0 && (
          <section>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-muted">
              What players praise & complain about
            </h3>
            <div className="overflow-hidden rounded-card border border-chartborder">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-chartborder text-left text-ink-muted">
                    <th className="px-2 py-1.5 font-medium">Aspect</th>
                    <th className="px-2 py-1.5 font-medium">Praise</th>
                    <th className="px-2 py-1.5 font-medium">Complaints</th>
                    <th className="px-2 py-1.5 font-medium">vs catalog</th>
                    <th className="px-2 py-1.5 font-medium">Mentions</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.themes.map((t) => (
                    <tr key={t.aspect} className="border-b border-chartborder/60 last:border-0">
                      <td className="px-2 py-1.5 font-medium text-ink-primary">{t.aspect}</td>
                      <td className="tabular px-2 py-1.5 text-verdict-good">{fmtPct(t.praise_share)}</td>
                      <td className="tabular px-2 py-1.5 text-verdict-serious">{fmtPct(t.complaint_share)}</td>
                      <td
                        className={clsx(
                          "tabular px-2 py-1.5",
                          (t.praise_delta_vs_catalog ?? 0) >= 0 ? "text-verdict-good" : "text-verdict-serious",
                        )}
                        title="Praise share vs the all-catalog baseline for this aspect"
                      >
                        {t.praise_delta_vs_catalog != null
                          ? `${t.praise_delta_vs_catalog >= 0 ? "+" : ""}${(t.praise_delta_vs_catalog * 100).toFixed(1)}pp`
                          : "—"}
                      </td>
                      <td className="tabular px-2 py-1.5 text-ink-secondary">{fmtCompact(t.total_mentions)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-1.5 text-[11px] text-ink-muted">
              Review aspects pooled across the niche (vote-weighted). A complaint the whole niche shares is a
              quality-gap opening; a praise pillar is the bar to clear.
            </p>
          </section>
        )}

        {detail?.press && detail.press.timeline.length > 0 && (
          <section>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-muted">Press coverage</h3>
            <div className="rounded-card border border-chartborder p-3">
              <div className="mb-2 text-xs text-ink-secondary">
                <span className="tabular font-semibold text-ink-primary">{fmtInt(detail.press.total_articles)}</span>{" "}
                dated press mentions of this niche&apos;s games, by month
              </div>
              <NichePressChart points={detail.press.timeline} />
              {detail.press.top_outlets.length > 0 && (
                <div className="mt-3 overflow-hidden rounded-card border border-chartborder">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b border-chartborder text-left text-ink-muted">
                        <th className="px-2 py-1.5 font-medium">Top outlets</th>
                        <th className="px-2 py-1.5 font-medium">Articles</th>
                        <th className="px-2 py-1.5 font-medium">Games covered</th>
                      </tr>
                    </thead>
                    <tbody>
                      {detail.press.top_outlets.slice(0, 10).map((o) => (
                        <tr key={o.source} className="border-b border-chartborder/60 last:border-0">
                          <td className="px-2 py-1.5 font-medium text-ink-primary">{o.source}</td>
                          <td className="tabular px-2 py-1.5 text-ink-secondary">{fmtInt(o.n_articles)}</td>
                          <td className="tabular px-2 py-1.5 text-ink-secondary">{fmtInt(o.n_games_covered)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <p className="mt-2 text-[11px] italic text-ink-muted">
                Journalist coverage only (Steam News excluded), fuzzy-matched with a confidence floor; an article
                covering two of the niche&apos;s games counts once per game. Press follows games that are already
                notable — read this as the niche&apos;s visibility and who to pitch, not as what caused the sales.
              </p>
            </div>
          </section>
        )}

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
                      <td className="max-w-[180px] truncate px-2 py-1.5" title={g.name ?? undefined}>
                        <Link
                          to={`/games/${g.appid}`}
                          className="font-medium text-ink-primary transition-colors hover:text-brand"
                        >
                          {g.name ?? `App ${g.appid}`}
                        </Link>
                      </td>
                      <td className="tabular px-2 py-1.5">{g.release_year ?? "—"}</td>
                      <td className="tabular px-2 py-1.5">{fmtPrice(g.price_initial)}</td>
                      <td className="tabular px-2 py-1.5">{fmtCompact(g.owners_mid)}</td>
                      <td className="tabular px-2 py-1.5">{fmtInt(g.total_reviews)}</td>
                      <td className="tabular px-2 py-1.5">{fmtPct(g.positive_ratio)}</td>
                      <td className="tabular px-2 py-1.5">{fmtRevenue(g.est_rev_reviews, g.price_initial === 0)}</td>
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

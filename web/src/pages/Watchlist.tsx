import { useNavigate } from "react-router-dom";

import { WatchlistSparkline } from "../components/charts/WatchlistSparkline";
import { Card } from "../components/ui/Card";
import { useRemoveWatchlist, useWatchlist } from "../lib/api";
import { fmtCompact, fmtInt, fmtPct, fmtPrice, fmtUsd } from "../lib/format";

export default function WatchlistPage() {
  const navigate = useNavigate();
  const { data, isLoading, isError, error } = useWatchlist();
  const removeWatchlist = useRemoveWatchlist();

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-lg font-semibold text-ink-primary">Watchlist</h1>
        <p className="mt-0.5 text-sm text-ink-muted">
          Games you're tracking — a sampled review-velocity trend and a quick way back into each profile.
        </p>
      </div>

      <Card className="!p-0">
        {isLoading && <div className="p-6 text-sm text-ink-muted">Loading watchlist…</div>}
        {isError && (
          <div className="p-6 text-sm text-status-serious">
            Failed to load watchlist{error instanceof Error ? `: ${error.message}` : "."}
          </div>
        )}
        {data && data.length === 0 && (
          <div className="flex flex-col items-center gap-2 p-10 text-center text-sm text-ink-muted">
            <span>Your watchlist is empty.</span>
            <button type="button" onClick={() => navigate("/games")} className="text-series-1 hover:underline">
              Search games to add one
            </button>
          </div>
        )}
        {data && data.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[900px] border-collapse text-sm">
              <thead>
                <tr className="border-b border-chartborder text-left text-xs text-ink-muted">
                  <th className="px-3 py-2 font-medium">Game</th>
                  <th className="px-3 py-2 font-medium">Price</th>
                  <th className="px-3 py-2 font-medium">Owners</th>
                  <th className="px-3 py-2 font-medium">Reviews</th>
                  <th className="px-3 py-2 font-medium">Positive</th>
                  <th className="px-3 py-2 font-medium">Est. revenue</th>
                  <th className="px-3 py-2 font-medium">Review velocity (12mo)</th>
                  <th className="px-3 py-2 font-medium">Note</th>
                  <th className="px-3 py-2 font-medium" />
                </tr>
              </thead>
              <tbody>
                {data.map((w) => (
                  <tr key={w.id} className="border-b border-chartborder/60 hover:bg-page">
                    <td className="px-3 py-2 align-middle">
                      <button
                        type="button"
                        onClick={() => navigate(`/games/${w.appid}`)}
                        className="flex items-center gap-2 text-left"
                      >
                        {w.header_image && (
                          <img src={w.header_image} alt="" loading="lazy" className="h-9 w-16 shrink-0 rounded-sm object-cover" />
                        )}
                        <span className="min-w-0">
                          <span className="block truncate font-medium text-ink-primary hover:text-series-1 hover:underline">
                            {w.name ?? `App ${w.appid}`}
                          </span>
                          <span className="block truncate text-[11px] text-ink-muted">{w.primary_genre ?? "—"}</span>
                        </span>
                      </button>
                    </td>
                    <td className="tabular px-3 py-2 align-middle">{fmtPrice(w.price_initial)}</td>
                    <td className="tabular px-3 py-2 align-middle">{fmtCompact(w.owners_mid)}</td>
                    <td className="tabular px-3 py-2 align-middle">{fmtInt(w.total_reviews)}</td>
                    <td className="tabular px-3 py-2 align-middle">{fmtPct(w.positive_ratio)}</td>
                    <td className="tabular px-3 py-2 align-middle">{fmtUsd(w.est_rev_reviews)}</td>
                    <td className="px-3 py-2 align-middle">
                      <WatchlistSparkline values={w.velocity_sparkline} />
                    </td>
                    <td className="max-w-[160px] truncate px-3 py-2 align-middle text-ink-secondary" title={w.note ?? undefined}>
                      {w.note ?? "—"}
                    </td>
                    <td className="px-3 py-2 align-middle">
                      <button
                        type="button"
                        onClick={() => removeWatchlist.mutate(w.appid)}
                        disabled={removeWatchlist.isPending}
                        aria-label={`Remove ${w.name ?? w.appid} from watchlist`}
                        className="rounded-md px-2 py-1 text-ink-muted hover:text-status-critical disabled:opacity-40"
                      >
                        ✕
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

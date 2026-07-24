import { useEffect, useState } from "react";

import { Badge } from "../components/ui/Badge";
import { Card } from "../components/ui/Card";
import { useEstimate, useGenres } from "../lib/api";
import { fmtCompact, fmtUsd } from "../lib/format";
import { tierColor } from "../lib/palette";
import { useTheme } from "../lib/theme";

type Basis = "reviews" | "wishlists";

function RangeRow({
  label,
  low,
  mid,
  high,
  format,
}: {
  label: string;
  low: number;
  mid: number;
  high: number;
  format: (n: number) => string;
}) {
  return (
    <div className="rounded-card border border-chartborder p-4">
      <div className="text-xs text-ink-muted">{label}</div>
      <div className="tabular mt-1 text-2xl font-semibold text-ink-primary">{format(mid)}</div>
      <div className="tabular mt-1 text-xs text-ink-secondary">
        {format(low)} – {format(high)} range
      </div>
    </div>
  );
}

export default function Estimator() {
  const { theme } = useTheme();
  const genres = useGenres();
  const estimate = useEstimate();

  const [basis, setBasis] = useState<Basis>("reviews");
  const [reviews, setReviews] = useState(500);
  const [wishlists, setWishlists] = useState(5000);
  const [price, setPrice] = useState(19.99);
  const [genre, setGenre] = useState("__all__");

  function runEstimate() {
    estimate.mutate({
      reviews: basis === "reviews" ? reviews : undefined,
      wishlists: basis === "wishlists" ? wishlists : undefined,
      price,
      genre,
    });
  }

  // Seed a first result on load so the page isn't empty; subsequent runs are explicit.
  useEffect(() => {
    runEstimate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const result = estimate.data;

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-lg font-semibold text-ink-primary">Estimator</h1>
        <p className="mt-0.5 text-sm text-ink-muted">
          Turn a review count or a wishlist count into an owners and revenue range, using the Boxleiter method.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[360px_1fr]">
        <Card title="Inputs">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              runEstimate();
            }}
            className="flex flex-col gap-4"
          >
            <div>
              <div className="mb-1.5 text-xs text-ink-secondary">Basis</div>
              <div className="flex items-center gap-0.5 rounded-md border border-chartborder p-0.5">
                <button
                  type="button"
                  onClick={() => setBasis("reviews")}
                  className={`flex-1 rounded px-3 py-1.5 text-xs font-medium transition-colors ${
                    basis === "reviews" ? "bg-page text-ink-primary" : "text-ink-muted hover:text-ink-secondary"
                  }`}
                >
                  Reviews
                </button>
                <button
                  type="button"
                  onClick={() => setBasis("wishlists")}
                  className={`flex-1 rounded px-3 py-1.5 text-xs font-medium transition-colors ${
                    basis === "wishlists" ? "bg-page text-ink-primary" : "text-ink-muted hover:text-ink-secondary"
                  }`}
                >
                  Wishlists
                </button>
              </div>
            </div>

            {basis === "reviews" ? (
              <label className="flex flex-col gap-1.5 text-xs text-ink-secondary">
                Total Steam reviews
                <input
                  type="number"
                  min={0}
                  value={reviews}
                  onChange={(e) => setReviews(Math.max(0, Number(e.target.value) || 0))}
                  className="rounded-md border border-chartborder bg-page px-3 py-2 text-sm text-ink-primary outline-none focus:border-series-1"
                />
              </label>
            ) : (
              <label className="flex flex-col gap-1.5 text-xs text-ink-secondary">
                Wishlist adds at launch
                <input
                  type="number"
                  min={0}
                  value={wishlists}
                  onChange={(e) => setWishlists(Math.max(0, Number(e.target.value) || 0))}
                  className="rounded-md border border-chartborder bg-page px-3 py-2 text-sm text-ink-primary outline-none focus:border-series-1"
                />
              </label>
            )}

            <label className="flex flex-col gap-1.5 text-xs text-ink-secondary">
              Price (USD)
              <input
                type="number"
                min={0}
                step={0.01}
                value={price}
                onChange={(e) => setPrice(Math.max(0, Number(e.target.value) || 0))}
                className="rounded-md border border-chartborder bg-page px-3 py-2 text-sm text-ink-primary outline-none focus:border-series-1"
              />
            </label>

            <label className="flex flex-col gap-1.5 text-xs text-ink-secondary">
              Genre
              <select
                value={genre}
                onChange={(e) => setGenre(e.target.value)}
                className="rounded-md border border-chartborder bg-page px-3 py-2 text-sm text-ink-primary outline-none focus:border-series-1"
              >
                {genres.map((g) => (
                  <option key={g.value} value={g.value}>
                    {g.label}
                  </option>
                ))}
              </select>
            </label>

            <button
              type="submit"
              disabled={estimate.isPending}
              className="rounded-md bg-series-1 px-3 py-2 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              {estimate.isPending ? "Estimating…" : "Estimate"}
            </button>
            {estimate.isError && (
              <p className="text-xs text-status-serious">
                {estimate.error instanceof Error ? estimate.error.message : "Estimate failed."}
              </p>
            )}
          </form>
        </Card>

        <div className="flex flex-col gap-4">
          {!result && !estimate.isPending && (
            <Card>
              <div className="py-8 text-center text-sm text-ink-muted">Run an estimate to see owners and revenue ranges.</div>
            </Card>
          )}
          {result && (
            <>
              <Card
                title="Dev tier"
                subtitle={`Basis: ${result.basis} · Genre used: ${result.genre === "__all__" ? "all genres" : result.genre}`}
              >
                <div className="flex items-center gap-2">
                  <Badge color={tierColor(result.dev_tier, theme)}>{result.dev_tier}</Badge>
                  <span className="text-xs text-ink-muted">lifetime-copies tier, from the mid estimate</span>
                </div>
              </Card>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3" data-tour="tour-estimator-range">
                <RangeRow
                  label="Estimated owners"
                  low={result.owners.low}
                  mid={result.owners.mid}
                  high={result.owners.high}
                  format={fmtCompact}
                />
                <RangeRow
                  label="Gross revenue"
                  low={result.revenue_gross_usd.low}
                  mid={result.revenue_gross_usd.mid}
                  high={result.revenue_gross_usd.high}
                  format={fmtUsd}
                />
                <RangeRow
                  label="Net revenue (after Steam cut)"
                  low={result.revenue_net_usd.low}
                  mid={result.revenue_net_usd.mid}
                  high={result.revenue_net_usd.high}
                  format={fmtUsd}
                />
              </div>

              <Card title="How this was calculated">
                <ul className="flex flex-col gap-2 text-xs text-ink-secondary">
                  {result.notes.map((n, i) => (
                    <li key={i} className="flex gap-2">
                      <span className="text-ink-muted">—</span>
                      <span>{n}</span>
                    </li>
                  ))}
                </ul>
                <div className="mt-3 border-t border-chartborder pt-3 text-xs text-ink-muted">
                  Owners/review used: {fmtCompact(result.owners_per_review_used.low)} – {fmtCompact(result.owners_per_review_used.high)}
                  {"  "}(mid {fmtCompact(result.owners_per_review_used.mid)})
                </div>
              </Card>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

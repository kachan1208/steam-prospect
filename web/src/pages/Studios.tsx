import { Link, useNavigate } from "react-router-dom";
import { useState } from "react";
import clsx from "clsx";

import { Badge } from "../components/ui/Badge";
import { Card } from "../components/ui/Card";
import { EmptyState } from "../components/ui/EmptyState";
import { ApiError, useEntitySearch, type EntityRole, type EntitySearchRow } from "../lib/api";
import { fmtInt, fmtPct, fmtUsd } from "../lib/format";
import { genreTintStyle, heatDomain, heatStyle } from "../lib/heat";
import { CSS_VAR } from "../lib/palette";
import { useDebounced } from "../lib/useDebounced";

const LIMIT = 50;
// Browse floor: without a search term, only studios with 3+ scored games rank — a lone
// hit (or a lone flop) isn't a track record. Searching drops the floor to 1 so any
// credit in the catalog is findable. The subtitle states this so the list is honest.
const BROWSE_MIN_GAMES = 3;

const ROLES: { id: EntityRole; label: string }[] = [
  { id: "publisher", label: "Publishers" },
  { id: "developer", label: "Developers" },
];

function entityHref(role: EntityRole, name: string): string {
  // Names carry slashes/commas/unicode, so they ride the query string, never the path.
  return `/entity/${role}?name=${encodeURIComponent(name)}`;
}

function fmtYears(first: number | null, last: number | null): string {
  if (first == null && last == null) return "—";
  if (first != null && last != null) return first === last ? String(first) : `${first}–${last}`;
  return String(first ?? last);
}

/**
 * Browse + search developer/publisher track records. Publishers is the default role —
 * publisher scouting (who ships games like mine, and how do those releases do?) is the
 * page's reason to exist. Rows open the full career profile at /entity/:role?name=.
 */
export default function Studios() {
  const navigate = useNavigate();
  const [role, setRole] = useState<EntityRole>("publisher");
  const [q, setQ] = useState("");
  const debouncedQ = useDebounced(q, 300);

  const browsing = debouncedQ.trim().length === 0;
  const { data, isLoading, isFetching, isError, error } = useEntitySearch(
    debouncedQ,
    role,
    browsing ? BROWSE_MIN_GAMES : 1,
    LIMIT,
  );

  const is503 = error instanceof ApiError && error.status === 503;
  const total = data?.total ?? 0;
  const shown = data?.items.length ?? 0;
  const roleNoun = role === "publisher" ? "publishers" : "developers";

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-lg font-semibold text-ink-primary">Studios</h1>
        <p className="mt-0.5 text-sm text-ink-muted">
          Developer and publisher track records — releases, career revenue, hit rate. Browse ranks studios with{" "}
          {BROWSE_MIN_GAMES}+ scored games by total est. revenue; search to find anyone.
        </p>
      </div>

      <Card className="!p-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-0.5 rounded-lg bg-surface2 p-0.5">
            {ROLES.map((r) => (
              <button
                key={r.id}
                type="button"
                onClick={() => setRole(r.id)}
                className={clsx(
                  "rounded-md px-2.5 py-1 text-xs font-medium transition-all",
                  role === r.id ? "bg-surface text-ink-primary shadow-xs" : "text-ink-muted hover:text-ink-secondary",
                )}
              >
                {r.label}
              </button>
            ))}
          </div>
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={`Search ${roleNoun} by name…`}
            className="w-64 rounded-md border border-chartborder bg-page px-2.5 py-1.5 text-xs text-ink-primary outline-none placeholder:text-ink-muted focus:border-brand"
          />
        </div>
      </Card>

      <Card className={clsx("!p-0", isFetching && "opacity-90 transition-opacity")}>
        {isLoading && <div className="p-6 text-sm text-ink-muted">Loading studios…</div>}
        {is503 && (
          <EmptyState
            title="Studio data is refreshing"
            description="Developer/publisher track records are built by the nightly data refresh and aren't available yet. Check back shortly — the rest of the app keeps working meanwhile."
            action={
              <Link to="/games" className="text-xs text-series-1 hover:underline">
                Back to games
              </Link>
            }
          />
        )}
        {isError && !is503 && (
          <div className="p-6 text-sm text-verdict-serious">
            Failed to load studios{error instanceof Error ? `: ${error.message}` : "."}
          </div>
        )}
        {data && data.items.length === 0 && (
          <div className="p-6 text-sm text-ink-muted">
            {browsing
              ? `No ${roleNoun} with ${BROWSE_MIN_GAMES}+ scored games yet.`
              : `No ${roleNoun} match “${debouncedQ.trim()}”.`}
          </div>
        )}
        {data && data.items.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[860px] border-collapse text-sm">
              <thead>
                <tr className="border-b border-chartborder text-left text-xs text-ink-muted">
                  <th className="whitespace-nowrap px-3 py-2 font-medium">Name</th>
                  <th className="whitespace-nowrap px-3 py-2 font-medium">Games</th>
                  <th className="whitespace-nowrap px-3 py-2 font-medium">Years</th>
                  <th className="whitespace-nowrap px-3 py-2 font-medium" title="Released something in the last 24 months">
                    Active
                  </th>
                  <th className="whitespace-nowrap px-3 py-2 font-medium">Total est. revenue</th>
                  <th
                    className="whitespace-nowrap px-3 py-2 font-medium"
                    title="90th-percentile est. lifetime revenue per release — what the entity's successful titles earn"
                  >
                    P90 est. revenue
                  </th>
                  <th className="whitespace-nowrap px-3 py-2 font-medium" title="Share of releases clearing $200K est. revenue">
                    Hit rate ≥ $200K
                  </th>
                  <th className="whitespace-nowrap px-3 py-2 font-medium">Top genres</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((e: EntitySearchRow) => (
                  <tr
                    key={`${e.role}:${e.name}`}
                    className="cursor-pointer border-b border-chartborder/60 hover:bg-page"
                    onClick={() => navigate(entityHref(e.role, e.name))}
                  >
                    <td className="max-w-[280px] px-3 py-2 align-middle">
                      <Link
                        to={entityHref(e.role, e.name)}
                        onClick={(ev) => ev.stopPropagation()}
                        className="block truncate font-medium text-ink-primary hover:text-brand hover:underline"
                        title={e.name}
                      >
                        {e.name}
                      </Link>
                    </td>
                    <td className="tabular px-3 py-2 align-middle">{fmtInt(e.n_games)}</td>
                    <td className="tabular whitespace-nowrap px-3 py-2 align-middle text-ink-secondary">
                      {fmtYears(e.first_release_year, e.last_release_year)}
                    </td>
                    <td className="px-3 py-2 align-middle">
                      {(e.n_recent_24m ?? 0) > 0 ? (
                        <Badge color={CSS_VAR.good}>Active</Badge>
                      ) : (
                        <span className="text-ink-muted">—</span>
                      )}
                    </td>
                    <td className="tabular px-3 py-2 align-middle font-medium text-ink-primary">
                      <span
                        className="rounded px-1.5 py-0.5"
                        style={heatStyle(e.total_rev, ...heatDomain(data.items, (x) => x.total_rev))}
                      >
                        {fmtUsd(e.total_rev)}
                      </span>
                    </td>
                    <td className="tabular px-3 py-2 align-middle">
                      {e.p90_rev != null ? fmtUsd(e.p90_rev) : "—"}
                    </td>
                    <td className="tabular px-3 py-2 align-middle">
                      <span
                        className="rounded px-1.5 py-0.5"
                        style={heatStyle(e.hit_rate_200k, ...heatDomain(data.items, (x) => x.hit_rate_200k), "linear")}
                      >
                        {fmtPct(e.hit_rate_200k, 0)}
                      </span>
                    </td>
                    <td className="px-3 py-2 align-middle">
                      <div className="flex max-w-[220px] flex-wrap gap-1">
                        {e.top_genres.slice(0, 3).map((g) => (
                          <span
                            key={g}
                            className="rounded-full border px-1.5 py-0.5 text-[10px] text-ink-secondary"
                            style={genreTintStyle(g)}
                          >
                            {g}
                          </span>
                        ))}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {data && (
          <div className="border-t border-chartborder px-3 py-2 text-xs text-ink-muted">
            {total > 0 ? (
              <>
                {browsing
                  ? `Top ${fmtInt(shown)} of ${fmtInt(total)} ${roleNoun} with ${BROWSE_MIN_GAMES}+ scored games, by total est. revenue`
                  : `${fmtInt(shown)} of ${fmtInt(total)} matching ${roleNoun}, by total est. revenue`}
                {total > shown && " — refine the search to narrow down"}
              </>
            ) : (
              "0 results"
            )}
          </div>
        )}
      </Card>

      <p className="text-[11px] italic text-ink-muted">
        Names are self-reported Steam credit strings (the same studio may appear under several spellings); revenue is
        review-based estimation, not reported sales.
      </p>
    </div>
  );
}

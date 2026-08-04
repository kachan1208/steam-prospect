import { useMemo } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";

import { EntityReleaseBars } from "../components/charts/EntityReleaseBars";
import { Badge } from "../components/ui/Badge";
import { Card } from "../components/ui/Card";
import { EmptyState } from "../components/ui/EmptyState";
import { StatTile } from "../components/ui/StatTile";
import {
  ApiError,
  useEntityProfile,
  type EntityNotFoundDetail,
  type EntityRole,
} from "../lib/api";
import { fmtInt, fmtPct, fmtPrice, fmtRevenue, fmtUsd } from "../lib/format";
import { CSS_VAR } from "../lib/palette";

const ROLES: EntityRole[] = ["developer", "publisher"];

function entityHref(role: EntityRole, name: string): string {
  // Names carry slashes/commas/unicode, so they ride the query string, never the path.
  return `/entity/${role}?name=${encodeURIComponent(name)}`;
}

/**
 * Developer/publisher career profile at /entity/:role?name=… — reached from the credit
 * links on game profiles and from the Studios browse table (/studios).
 */
export default function EntityProfile() {
  const { role: roleParam } = useParams<{ role: string }>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();

  const role = ROLES.includes(roleParam as EntityRole) ? (roleParam as EntityRole) : null;
  const name = searchParams.get("name");

  const profileQ = useEntityProfile(role, name);
  const entity = profileQ.data?.entity;

  // Portfolio table rows: latest release first (seq DESC) — the API sends seq ASC.
  const tableGames = useMemo(
    () => [...(profileQ.data?.games ?? [])].sort((a, b) => b.seq - a.seq),
    [profileQ.data],
  );

  if (!role || !name) {
    return (
      <Card>
        <div className="py-8 text-center text-sm text-status-serious">
          {!role ? "Invalid entity role in the URL (expected developer or publisher)." : "Missing ?name= in the URL."}
        </div>
      </Card>
    );
  }

  if (profileQ.isLoading) {
    return <div className="p-6 text-sm text-ink-muted">Loading {role}…</div>;
  }

  if (profileQ.isError || !entity) {
    const err = profileQ.error;
    if (err instanceof ApiError && err.status === 404) {
      const detail = err.detail as EntityNotFoundDetail | undefined;
      const suggestions = detail?.suggestions ?? [];
      return (
        <Card>
          <EmptyState
            title={`No ${role} named “${name}”`}
            description={
              suggestions.length > 0
                ? "The credit string on the game page may differ slightly from the normalized entity name. Did you mean:"
                : "Nothing similar in the catalog either — the credit may be too small or too new to have an entity profile yet."
            }
            action={
              <div className="flex flex-col items-center gap-1.5">
                {suggestions.map((s) => (
                  <Link key={s} to={entityHref(role, s)} className="text-xs text-series-1 hover:underline">
                    {s}
                  </Link>
                ))}
                <Link to="/games" className="mt-1 text-xs text-ink-muted hover:text-ink-secondary">
                  Back to games
                </Link>
              </div>
            }
          />
        </Card>
      );
    }
    if (err instanceof ApiError && err.status === 503) {
      return (
        <Card>
          <EmptyState
            title="Entity data is refreshing"
            description="Developer/publisher profiles are built by the nightly data refresh and aren't available yet. Check back shortly — the rest of the app keeps working meanwhile."
            action={
              <Link to="/games" className="text-xs text-series-1 hover:underline">
                Back to games
              </Link>
            }
          />
        </Card>
      );
    }
    return (
      <Card>
        <div className="flex flex-col items-center gap-2 py-8 text-center text-sm">
          <span className="text-status-serious">
            Failed to load {role}{err instanceof Error ? `: ${err.message}` : "."}
          </span>
          <Link to="/games" className="text-series-1 hover:underline">
            Back to games
          </Link>
        </div>
      </Card>
    );
  }

  const active = (entity.n_recent_24m ?? 0) > 0;
  const years =
    entity.first_release_year != null && entity.last_release_year != null
      ? entity.first_release_year === entity.last_release_year
        ? String(entity.first_release_year)
        : `${entity.first_release_year}–${entity.last_release_year}`
      : null;

  return (
    <div className="flex flex-col gap-4">
      <Link to="/games" className="text-xs text-ink-muted hover:text-ink-primary">
        ← Back to games
      </Link>

      <Card>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-lg font-semibold text-ink-primary">{entity.name}</h1>
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs text-ink-muted">
              <Badge color={CSS_VAR.demand}>{entity.role === "developer" ? "Developer" : "Publisher"}</Badge>
              <Badge color={active ? CSS_VAR.good : CSS_VAR.warning}>{active ? "Active" : "Dormant"}</Badge>
              {years && (
                <span title="Years spanned by this entity's releases in our catalog">Releases {years}</span>
              )}
              {active && (
                <>
                  <span aria-hidden="true">·</span>
                  <span>
                    {fmtInt(entity.n_recent_24m)} release{entity.n_recent_24m === 1 ? "" : "s"} in the last 24 months
                  </span>
                </>
              )}
            </div>
            {entity.top_genres.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1">
                {entity.top_genres.map((g) => (
                  <span key={g} className="rounded-full border border-chartborder px-2 py-0.5 text-[10px] text-ink-secondary">
                    {g}
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>
      </Card>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <StatTile label="Games" value={fmtInt(entity.n_games)} />
        <StatTile
          label="Total est. revenue"
          value={fmtUsd(entity.total_rev)}
          sub="Boxleiter gross across the catalog"
        />
        <StatTile label="Median est. revenue" value={fmtUsd(entity.median_rev)} sub="Per release" />
        <StatTile
          label="Hit rate ≥ $200K"
          value={fmtPct(entity.hit_rate_200k, 0)}
          sub="Share of releases clearing $200K est."
        />
        <StatTile
          label="Median rating"
          value={fmtPct(entity.median_positive_ratio, 0)}
          sub={entity.median_reviews != null ? `${fmtInt(entity.median_reviews)} median reviews` : undefined}
        />
        {entity.role === "publisher" ? (
          <StatTile
            label="Dev partners"
            value={fmtInt(entity.n_partners)}
            sub="Distinct developers published"
          />
        ) : (
          <StatTile
            label="Self-published"
            value={fmtPct(entity.self_published_share, 0)}
            sub="Share of releases self-published"
          />
        )}
      </div>

      <Card
        title="Release trajectory"
        subtitle="Estimated revenue of each release in career order (marginal, per game — not cumulative). Click a bar to open that game."
      >
        <EntityReleaseBars games={profileQ.data!.games} onBarClick={(appid) => navigate(`/games/${appid}`)} />
        <p className="mt-2 text-[11px] italic text-ink-muted">
          Boxleiter review-based estimates; free-to-play releases show $0 box revenue by construction.
        </p>
      </Card>

      <Card title="Portfolio" subtitle="Every catalog release credited to this entity, latest first">
        <div className="overflow-x-auto rounded-card border border-chartborder">
          <table className="w-full min-w-[640px] text-xs">
            <thead>
              <tr className="border-b border-chartborder text-left text-ink-muted">
                <th className="px-2 py-1.5 font-medium">#</th>
                <th className="px-2 py-1.5 font-medium">Game</th>
                <th className="px-2 py-1.5 font-medium">Year</th>
                <th className="px-2 py-1.5 font-medium">Genre</th>
                <th className="px-2 py-1.5 font-medium">Price</th>
                <th className="px-2 py-1.5 font-medium">Reviews</th>
                <th className="px-2 py-1.5 font-medium">Positive</th>
                <th className="px-2 py-1.5 font-medium">Est. revenue</th>
              </tr>
            </thead>
            <tbody>
              {tableGames.map((g) => (
                <tr key={g.appid} className="border-b border-chartborder/60 last:border-0 hover:bg-page">
                  <td className="tabular px-2 py-1.5 text-ink-muted">{g.seq}</td>
                  <td className="max-w-[240px] truncate px-2 py-1.5 font-medium" title={g.name ?? undefined}>
                    <Link to={`/games/${g.appid}`} className="text-ink-primary hover:text-series-1 hover:underline">
                      {g.name ?? `App ${g.appid}`}
                    </Link>
                  </td>
                  <td className="tabular px-2 py-1.5">{g.release_year ?? "—"}</td>
                  <td className="px-2 py-1.5">{g.primary_genre ?? "—"}</td>
                  <td className="tabular px-2 py-1.5">{fmtPrice(g.price_initial)}</td>
                  <td className="tabular px-2 py-1.5">{fmtInt(g.total_reviews)}</td>
                  <td className="tabular px-2 py-1.5">{fmtPct(g.positive_ratio)}</td>
                  <td className="tabular px-2 py-1.5">{fmtRevenue(g.est_rev_reviews, g.price_initial === 0)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

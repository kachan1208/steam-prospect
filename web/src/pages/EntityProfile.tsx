import { useMemo } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import clsx from "clsx";

import { EntityReleaseBars } from "../components/charts/EntityReleaseBars";
import { Badge } from "../components/ui/Badge";
import { Card } from "../components/ui/Card";
import { EmptyState } from "../components/ui/EmptyState";
import { HeaderLabel } from "../components/ui/HeaderLabel";
import { InfoTip } from "../components/ui/InfoTip";
import { Loading } from "../components/ui/Loading";
import { SentinelTag } from "../components/ui/SentinelTag";
import { StatTile } from "../components/ui/StatTile";
import { TableScroll } from "../components/ui/TableScroll";
import {
  ApiError,
  useEntityProfile,
  useEntitySearch,
  type EntityNotFoundDetail,
  type EntityRole,
  type EntitySummary,
} from "../lib/api";
import {
  ENTITY_MIN_ESTIMATED_FOR_VERDICT,
  gamesSub,
  hitCount,
  hitCountLabel,
  hitRateSub,
  medianRevSub,
  revenueEstimateBase,
  sampleSize,
  totalRevSub,
  type RevenueEstimateBase,
} from "../lib/entities";
import {
  fmtInt,
  fmtIsoMonth,
  fmtPct,
  fmtPriceFor,
  fmtRevenueFor,
  fmtUsd,
  MISSING,
  PRICE_UNKNOWN,
  PRICE_UNKNOWN_NOTE,
  priceKind,
} from "../lib/format";
import { glossary } from "../lib/glossary";
import { genreTintStyle, genreTintStyles, heatDomain, heatStyle, positiveRatioClass } from "../lib/heat";
import { CSS_VAR, MONO } from "../lib/palette";
import { usePageTitle } from "../lib/usePageTitle";

const ROLES: EntityRole[] = ["developer", "publisher"];

function entityHref(role: EntityRole, name: string): string {
  // Names carry slashes/commas/unicode, so they ride the query string, never the path.
  return `/entity/${role}?name=${encodeURIComponent(name)}`;
}

/** "1 release" / "5 releases". */
function releases(n: number): string {
  return `${fmtInt(n)} ${n === 1 ? "release" : "releases"}`;
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
  // The studio/publisher name rides ?name=, so it titles the tab immediately.
  usePageTitle(name);

  // Same-name entity in the OTHER role. Self-publishing devs exist under both roles with
  // different game sets (e.g. a dev with 4 titles who self-published only 2 — the publisher
  // view is "missing" games unless we say where the rest live).
  //
  // Asked through /entities/search, NOT /entities/profile (2026-09-23): most developers have
  // no publisher record, so probing the profile endpoint answered 404 on nearly every
  // developer page — a red "Failed to load resource" in the console of a page that had
  // loaded fine. The search answers 200 with the matches (a substring search, so the exact
  // name is picked out of them); only when the name is so short that more than a page of
  // names contain it, and the exact one isn't among them, does the page fall back to the
  // profile probe — which can still 404, and then renders nothing.
  const otherRole: EntityRole = role === "developer" ? "publisher" : "developer";
  const counterpartQ = useEntitySearch(
    { q: name ?? undefined, role: otherRole, min_games: 1, sort: "name", order: "asc", limit: 100, offset: 0 },
    { enabled: !!role && !!name },
  );
  const exactCounterpart = counterpartQ.data?.items.find((e) => e.name === name) ?? null;
  const inconclusive =
    !!counterpartQ.data && !exactCounterpart && counterpartQ.data.total > counterpartQ.data.items.length;
  const otherQ = useEntityProfile(inconclusive ? otherRole : null, inconclusive ? name : null);
  const otherGames = exactCounterpart?.n_games ?? otherQ.data?.entity.n_games ?? null;

  // Portfolio table rows: latest release first (seq DESC) — the API sends seq ASC.
  const tableGames = useMemo(
    () => [...(profileQ.data?.games ?? [])].sort((a, b) => b.seq - a.seq),
    [profileQ.data],
  );

  // The denominator behind every revenue tile below — NOT n_games. See revenueEstimateBase.
  const revBase = useMemo(
    () => revenueEstimateBase(profileQ.data?.games ?? []),
    [profileQ.data],
  );

  if (!role || !name) {
    // A malformed URL is still a dead end, so it gets the same shape and the same way OUT as
    // the 404/503 states below — it used to be a bare red sentence with no link at all, which
    // left anyone who mistyped /entity/:role stranded on a page with only the chrome to click.
    // When the role is the broken half and ?name= survived, the two valid spellings of this
    // exact URL are the most useful thing we can offer: one click recovers the request.
    return (
      <Card>
        <EmptyState
          title={!role ? "Invalid entity role in the URL" : "Missing ?name= in the URL"}
          description={
            !role
              ? "A studio profile lives at /entity/developer or /entity/publisher — that segment of the URL is neither."
              : "A studio profile is addressed by name, e.g. /entity/developer?name=Valve."
          }
          action={
            <div className="flex flex-col items-center gap-1.5">
              {!role &&
                name &&
                ROLES.map((r) => (
                  <Link key={r} to={entityHref(r, name)} className="text-xs text-series-1 hover:underline">
                    {name} as {r}
                  </Link>
                ))}
              <Link to="/studios" className="mt-1 text-xs text-ink-muted hover:text-ink-secondary">
                Back to studios
              </Link>
            </div>
          }
        />
      </Card>
    );
  }

  if (profileQ.isLoading) {
    return <Loading label={`Loading ${role}…`} className="p-6 text-sm" />;
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
          <span className="text-verdict-serious">
            Failed to load {role}{err instanceof Error ? `: ${err.message}` : "."}
          </span>
          <Link to="/games" className="text-series-1 hover:underline">
            Back to games
          </Link>
        </div>
      </Card>
    );
  }

  const recent = entity.n_recent_24m ?? 0;
  const active = recent > 0;
  const years =
    entity.first_release_year != null && entity.last_release_year != null
      ? entity.first_release_year === entity.last_release_year
        ? String(entity.first_release_year)
        : `${entity.first_release_year}–${entity.last_release_year}`
      : null;

  return (
    <div className="flex flex-col gap-4">
      <Link to="/studios" className="text-xs text-ink-muted hover:text-ink-primary">
        ← Studios
      </Link>

      {otherGames != null && (
        <div className="flex items-center gap-2 rounded-card border border-chartborder bg-brand-tint px-3.5 py-2.5 text-xs text-ink-secondary">
          <span>
            <span className="font-semibold text-ink-primary">{entity.name}</span> is also a {otherRole} —{" "}
            {otherGames} game{otherGames === 1 ? "" : "s"}
            {entity.role === "publisher" ? " (their full development career)" : " (titles they self-published)"}.
          </span>
          <Link to={entityHref(otherRole, entity.name)} className="ml-auto shrink-0 font-medium text-brand hover:underline">
            View {otherRole} profile →
          </Link>
        </div>
      )}

      <Card>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-lg font-semibold text-ink-primary">{entity.name}</h1>
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs text-ink-muted">
              <Badge color={CSS_VAR.demand}>{entity.role === "developer" ? "Developer" : "Publisher"}</Badge>
              <Badge color={active ? MONO.primary : MONO.paper50}>{active ? "Active" : "Dormant"}</Badge>
              <InfoTip
                label={active ? "Active" : "Dormant"}
                meaning="Active = released at least one game in the 24 months to the data's date; Dormant = nothing in that window. A dormant studio's numbers describe its past, not what it ships now."
                formula="releases dated within 24 months of the data's as-of date > 0"
                worked={`${releases(recent)} in the last 24 months${
                  entity.last_release_year != null ? ` · latest in ${entity.last_release_year}` : ""
                }`}
              />
              {years && <span>Releases {years}</span>}
              {active && (
                <>
                  <span aria-hidden="true">·</span>
                  <span>{releases(recent)} in the last 24 months</span>
                </>
              )}
            </div>
            {entity.top_genres.length > 0 && (
              // Tinted as a GROUP — the per-name hash collided inside this very row
              // (Action = Racing, RPG = Simulation), see lib/heat.ts.
              <div className="mt-2 flex flex-wrap gap-1">
                {(() => {
                  const tints = genreTintStyles(entity.top_genres);
                  return entity.top_genres.map((g, i) => (
                    <span
                      key={g}
                      className="rounded-full border px-2 py-0.5 text-[10px] text-ink-secondary"
                      style={tints[i]}
                    >
                      {g}
                    </span>
                  ));
                })()}
              </div>
            )}
          </div>
        </div>
      </Card>

      <CareerTiles entity={entity} base={revBase} />

      <Card
        title="Release trajectory"
        subtitle="Est. revenue of each release in career order (marginal, per game — not cumulative). Click a bar to open that game."
      >
        <EntityReleaseBars games={profileQ.data!.games} onBarClick={(appid) => navigate(`/games/${appid}`)} />
        <p className="mt-2 text-[11px] italic text-ink-muted">
          Estimates from each game's reviews (reviews × 30 × launch price), not reported sales. Free releases and
          releases with no known price have no estimate — they sit at zero here and their tooltip says which.
        </p>
      </Card>

      <Card title="Portfolio" subtitle="Every catalog release credited to this entity, latest first">
        <TableScroll className="rounded-card border border-chartborder">
          <table className="w-full min-w-[640px] text-xs">
            <thead>
              <tr className="border-b border-chartborder text-left text-ink-muted">
                <th className="px-2 py-1.5 font-medium">#</th>
                <th className="px-2 py-1.5 font-medium">Game</th>
                <th className="px-2 py-1.5 font-medium">Released</th>
                <th className="px-2 py-1.5 font-medium">Genre</th>
                <th className="px-2 py-1.5 font-medium">
                  <HeaderLabel term="launch_price" style={{}} className="normal-case" />
                </th>
                <th className="px-2 py-1.5 font-medium">
                  <HeaderLabel term="reviews" style={{}} className="normal-case" />
                </th>
                <th className="px-2 py-1.5 font-medium">
                  <HeaderLabel term="positive_ratio" label="Positive" style={{}} className="normal-case" />
                </th>
                <th className="px-2 py-1.5 font-medium">
                  <HeaderLabel
                    term="est_revenue"
                    style={{}}
                    className="normal-case"
                    info={{ notes: `${glossary("est_revenue").notes ?? ""} ${PRICE_UNKNOWN_NOTE}` }}
                  />
                </th>
              </tr>
            </thead>
            <tbody>
              {tableGames.map((g) => {
                const kind = priceKind(g);
                const released = g.release_date ? fmtIsoMonth(g.release_date) : MISSING;
                return (
                  <tr
                    key={g.appid}
                    className="cursor-pointer border-b border-chartborder/60 last:border-0 hover:bg-page"
                    onClick={() => navigate(`/games/${g.appid}`)}
                  >
                    <td className="tabular px-2 py-1.5 text-ink-muted">{g.seq}</td>
                    <td className="max-w-[240px] truncate px-2 py-1.5 font-medium" title={g.name ?? undefined}>
                      <Link to={`/games/${g.appid}`} className="text-ink-primary hover:text-brand hover:underline">
                        {g.name ?? `App ${g.appid}`}
                      </Link>
                    </td>
                    <td className="tabular whitespace-nowrap px-2 py-1.5">
                      {released !== MISSING ? (
                        released
                      ) : g.release_year != null ? (
                        g.release_year
                      ) : (
                        <SentinelTag>no date</SentinelTag>
                      )}
                    </td>
                    <td className="px-2 py-1.5">
                      {g.primary_genre ? (
                        <span
                          className="rounded-full border px-1.5 py-0.5 text-[10px] text-ink-secondary"
                          style={genreTintStyle(g.primary_genre)}
                        >
                          {g.primary_genre}
                        </span>
                      ) : (
                        <SentinelTag>no genre</SentinelTag>
                      )}
                    </td>
                    <td className="tabular px-2 py-1.5">
                      {kind === "unknown" ? <SentinelTag>{PRICE_UNKNOWN}</SentinelTag> : fmtPriceFor(g)}
                    </td>
                    <td className="tabular px-2 py-1.5">
                      {g.total_reviews != null ? fmtInt(g.total_reviews) : <SentinelTag>no data</SentinelTag>}
                    </td>
                    <td className={clsx("tabular px-2 py-1.5", positiveRatioClass(g.positive_ratio))}>
                      {g.positive_ratio != null ? fmtPct(g.positive_ratio) : <SentinelTag>no reviews</SentinelTag>}
                    </td>
                    <td className="tabular px-2 py-1.5">
                      {kind === "unknown" ? (
                        <SentinelTag>{PRICE_UNKNOWN}</SentinelTag>
                      ) : kind === "paid" && g.est_rev_reviews == null ? (
                        <SentinelTag>no estimate</SentinelTag>
                      ) : (
                        <span
                          className="rounded px-1.5 py-0.5"
                          style={heatStyle(g.est_rev_reviews, ...heatDomain(tableGames, (x) => x.est_rev_reviews))}
                        >
                          {fmtRevenueFor(g, g.est_rev_reviews)}
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </TableScroll>
      </Card>
    </div>
  );
}

/**
 * The six career tiles, each explaining itself with the glossary's ⓘ and the studio's own
 * numbers — and honest about how small the record behind them is (lib/entities.ts
 * sampleSize): a hit rate over fewer than 10 estimated releases prints as the COUNT it is
 * ("1 of 1 release"), flagged "tiny sample" / "small sample", and the top-10% figure is
 * withheld with the n that withheld it.
 */
function CareerTiles({ entity, base }: { entity: EntitySummary; base: RevenueEstimateBase }) {
  const size = sampleSize(base.estimated);
  const hits = hitCount(entity.hit_rate_200k, base);
  const n = base.estimated;
  const noEstimates = { tag: "no estimates", detail: "None of this studio's releases has a revenue estimate." };
  const whose = entity.role === "developer" ? "developer" : "publisher";

  // ---- Top-10% revenue ----------------------------------------------------------------
  const medianText = fmtUsd(entity.median_rev);
  let p90Value: React.ReactNode;
  let p90Sub: string;
  let p90Sentinel: { tag: string; detail: string } | undefined;
  if (size === "none") {
    p90Value = <span className="text-[15px] text-ink-muted">not computed</span>;
    p90Sub = "No release has a revenue estimate";
    p90Sentinel = noEstimates;
  } else if (size !== "ok") {
    p90Value = <span className="text-[15px] text-ink-muted">needs 10+ releases</span>;
    p90Sub = `median ${medianText} over ${releases(n)}${base.listed > n ? ` with an estimate (of ${base.listed})` : ""}`;
    p90Sentinel = {
      tag: "too few releases",
      detail: `A top-10% line needs at least ${ENTITY_MIN_ESTIMATED_FOR_VERDICT} releases with an estimate — with ${n}, the “90th percentile” is just the studio's best game. The median is shown below instead.`,
    };
  } else {
    p90Value = entity.p90_rev != null ? fmtUsd(entity.p90_rev) : <span className="text-[15px] text-ink-muted">not computed</span>;
    p90Sub = medianRevSub(medianText, base);
    p90Sentinel = entity.p90_rev == null ? { tag: "not computed", detail: "This data build carries no top-10% figure." } : undefined;
  }

  // ---- Games earning $200K+ --------------------------------------------------------------
  let hitValue: React.ReactNode;
  let hitSub: string;
  let hitSentinel: { tag: string; detail: string } | undefined;
  let hitWorked: string | undefined;
  if (size === "none" || hits === null) {
    hitValue = <span className="text-[15px] text-ink-muted">not computed</span>;
    hitSub = hitRateSub(base);
    hitSentinel = noEstimates;
  } else if (size !== "ok") {
    hitValue = hitCountLabel(hits, base);
    hitSub = `cleared $200K est. revenue${
      base.listed > n ? ` — ${base.listed - n} of ${base.listed} releases have no estimate` : ""
    }`;
    hitSentinel = {
      tag: size === "tiny" ? "tiny sample" : "small sample",
      detail: `Only ${releases(n)} with an estimate — a percentage needs ${ENTITY_MIN_ESTIMATED_FOR_VERDICT}+ to mean anything (over ${n} it can only read ${
        n === 1 ? "0% or 100%" : "a few coarse steps"
      }), so the tile prints the count.`,
    };
    hitWorked = `${hits} of ${n} = ${fmtPct(entity.hit_rate_200k, 0)} — not shown as a rate at this size`;
  } else {
    hitValue = fmtPct(entity.hit_rate_200k, 0);
    hitSub = hitRateSub(base);
    hitWorked = `${hits} of ${n} releases with an estimate cleared $200K = ${fmtPct(entity.hit_rate_200k, 0)}`;
  }

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
      <StatTile
        label="Games"
        value={fmtInt(entity.n_games)}
        sub={gamesSub(base)}
        info={{
          label: "Games",
          meaning: `Releases credited to this ${whose} in the catalog — every one, including those with no revenue estimate (which the revenue tiles leave out).`,
          formula: `count of the ${whose}'s catalog releases`,
        }}
        worked={base.listed > n ? `${base.listed} releases, ${n} with a revenue estimate` : undefined}
      />
      <StatTile
        term="total_rev"
        value={entity.total_rev != null ? fmtUsd(entity.total_rev) : <span className="text-[15px] text-ink-muted">not computed</span>}
        sub={totalRevSub(base)}
        info={{
          meaning: `This ${whose}'s releases' Est. revenue added up — the size of its catalog in dollars, dominated by its hits. An estimate, not reported sales.`,
          formula: "sum of Est. revenue (reviews × 30 × launch price) over the releases that have an estimate",
          notes: `Releases with no estimate — free, or with no known price — add nothing. ${PRICE_UNKNOWN_NOTE}`,
        }}
        worked={n > 0 ? `sum over ${releases(n)} = ${fmtUsd(entity.total_rev)}` : undefined}
        sentinel={size === "none" ? noEstimates : undefined}
      />
      <StatTile
        term="p90_rev"
        valueClassName={size === "ok" && entity.p90_rev != null ? "text-brand" : undefined}
        value={p90Value}
        sub={p90Sub}
        info={{
          meaning: `What this ${whose}'s successful releases earn: only 1 release in 10 earns more. Not what a typical release makes — that is the median beneath it.`,
          formula: "90th percentile of Est. revenue over the releases with an estimate",
          notes: `Withheld under ${ENTITY_MIN_ESTIMATED_FOR_VERDICT} releases with an estimate: below that, the “top 10%” is a single game.`,
        }}
        worked={
          size === "ok" && entity.p90_rev != null
            ? `90th percentile of ${releases(n)}' Est. revenue = ${fmtUsd(entity.p90_rev)}; median ${medianText}`
            : undefined
        }
        sentinel={p90Sentinel}
      />
      <StatTile
        term="hit_rate_200k"
        // Metric verdict, not an error state — same mono-steel rule as
        // positiveRatioClass (lib/heat.ts): strong reads accent-300, never green.
        // Gated on ENTITY_MIN_ESTIMATED_FOR_VERDICT: the colour is a claim about the
        // studio, and it was firing on entities whose whole record is one estimated
        // release, where the rate can only ever read 0% or 100%.
        valueClassName={
          size === "ok" && (entity.hit_rate_200k ?? 0) >= 0.25 ? "text-[color:var(--accent-300)]" : undefined
        }
        value={hitValue}
        sub={hitSub}
        info={{
          meaning: `The odds a release of this ${whose} “works”: the share of its releases WITH a revenue estimate that clear $200K.`,
          formula: "releases with Est. revenue > $200K ÷ releases with an Est. revenue",
          notes: `Printed as a count (“3 of 5 releases”) under ${ENTITY_MIN_ESTIMATED_FOR_VERDICT} releases with an estimate.`,
        }}
        worked={hitWorked}
        sentinel={hitSentinel}
      />
      <StatTile
        term="positive_ratio"
        label="Median positive"
        valueClassName={positiveRatioClass(entity.median_positive_ratio)}
        value={
          entity.median_positive_ratio != null ? (
            fmtPct(entity.median_positive_ratio, 0)
          ) : (
            <span className="text-[15px] text-ink-muted">no reviews</span>
          )
        }
        sub={entity.median_reviews != null ? `${fmtInt(entity.median_reviews)} median reviews` : undefined}
        info={{
          label: "Median positive reviews",
          meaning: `The middle release's share of positive reviews — how well this ${whose}'s games are received. Under ~80% starts costing store visibility.`,
          formula: "median over releases of positive ÷ (positive + negative reviews)",
        }}
        worked={
          base.listed === 1 ? "one release — this is that game's own share" : undefined
        }
      />
      {entity.role === "publisher" ? (
        <StatTile
          label="Dev partners"
          value={entity.n_partners != null ? fmtInt(entity.n_partners) : <span className="text-[15px] text-ink-muted">unknown</span>}
          sub="Distinct developers published"
          info={{
            label: "Development partners",
            meaning: "How many different developers this publisher has released games for — a label with many partners spreads its bets.",
            formula: "distinct developers co-credited on the publisher's releases",
          }}
        />
      ) : (
        <StatTile
          term="self_published_share"
          label="Self-published"
          value={fmtPct(entity.self_published_share, 0)}
          sub="Share of releases it published itself"
          info={{
            meaning: "Share of this developer's releases it published itself, without a separate publisher.",
            formula: "self-published releases ÷ releases",
          }}
        />
      )}
    </div>
  );
}

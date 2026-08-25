from __future__ import annotations

from functools import lru_cache
from typing import Literal

import duckdb
from fastapi import APIRouter, HTTPException, Query

from .. import analytics_db, signals_db
from ..schemas import (
    AspectReviewExcerpt,
    AspectReviewsResponse,
    ChannelMixRow,
    GameChannelMix,
    GameComparable,
    GameComparablesResponse,
    FollowerPoint,
    GameEvent,
    GameEventList,
    GameFollowers,
    GamePriceHistory,
    PricePoint,
    GameLaunchCurvePoint,
    GamePress,
    GameProfile,
    GameReviewsSummary,
    GameSearchList,
    GameSearchRow,
    GameTeardown,
    LanguageShare,
    PlaytimePoint,
    PressBySource,
    PressNotableArticle,
    PressTimelinePoint,
    PriceBand,
    ReviewAspect,
    ReviewTimelinePoint,
    TagSuggestion,
    TagSuggestList,
)

router = APIRouter(prefix="/api/games", tags=["games"])

# Columns a client is allowed to sort search results on (prevents SQL injection via `sort`).
SORTABLE = {
    "name", "release_year", "release_date", "price_initial", "owners_mid", "total_reviews",
    "positive_ratio", "est_rev_reviews", "rev_pct_in_genre", "reviews_pct_in_genre",
    "owners_pct_in_genre", "n_reviews_trailing_30d", "live_players", "first_seen",
    "lifetime_months", "metacritic_score",
}

@lru_cache(maxsize=1)
def _has_name_lower() -> bool:
    """Whether the current mart carries the persisted lowercased search column.

    mart_game.sql builds `name_lower` (lower(name)) so search can filter with the cheaper
    contains(name_lower, ?) instead of name ILIKE '%q%' (~2.3x faster — no per-row lower()
    over the ~170K-row full scan the leading-wildcard forces). The column only appears after
    the ETL rebuilds the mart, so we gate on its existence and fall back to ILIKE otherwise —
    the router stays correct on both the pre-column mart and the rebuilt one. Cached: the DB
    is swapped + app restarted on each nightly ETL, so the schema can't change under us."""
    rows = analytics_db.query(
        "SELECT 1 FROM information_schema.columns "
        "WHERE table_name = 'mart_game' AND column_name = 'name_lower'"
    )
    return bool(rows)


_SEARCH_COLS = (
    "appid, name, primary_genre, release_year, release_date, price_initial, is_free, owners_mid, "
    "total_reviews, positive_ratio, est_rev_reviews, live_players, first_seen, header_image, "
    "top_tags, metacritic_score"
)

_PROFILE_COLS = (
    "appid, name, release_year, release_date, price_initial, is_free, primary_genre, "
    "developers, publishers, self_published, is_indie, owners_mid, total_reviews, "
    "positive_ratio, est_rev_reviews, est_rev_owners, metacritic_score, achievements_count, "
    "avg_playtime_forever, header_image, short_description, rev_pct_in_genre, "
    "reviews_pct_in_genre, owners_pct_in_genre, top_tags, n_reviews_sampled, "
    "n_reviews_first_30d, n_reviews_first_90d, n_reviews_first_365d, n_reviews_trailing_30d, "
    "playtime_p25, playtime_p50, playtime_p75, "
    "live_players, first_seen"
)


@lru_cache(maxsize=1)
def _has_players_summary() -> bool:
    """Whether the current mart carries the daily-CCU summary columns (players_7d_avg /
    players_trend_7d_pct from mart_players.sql). Gated like _has_name_lower(): the columns
    only appear after the ETL that added them rebuilds the mart, and this app can boot
    against an older mart (e.g. the App Platform path downloads a published duckdb) — the
    profile must not 500 there. Cached for the same swap-then-restart reason."""
    rows = analytics_db.query(
        "SELECT 1 FROM information_schema.columns "
        "WHERE table_name = 'mart_game' AND column_name = 'players_7d_avg'"
    )
    return bool(rows)


@lru_cache(maxsize=1)
def _has_lifetime_game() -> bool:
    """Whether the current mart carries the game-lifetime columns (mart_players.sql
    _game_lifetime: months from the first 100+-avg-CCU month to the first full month
    under 10). Gated + cached exactly like _has_players_summary() and for the same
    reasons — the app must serve marts built before the lifetime ETL landed."""
    rows = analytics_db.query(
        "SELECT 1 FROM information_schema.columns "
        "WHERE table_name = 'mart_game' AND column_name = 'lifetime_months'"
    )
    return bool(rows)


@lru_cache(maxsize=1)
def _has_dev_socials() -> bool:
    """Whether the current mart carries dev_x_handle (mart_game.sql dev_x: the game's most
    prominent official X handle, harvested from its developer-controlled pages — store
    page + dev website — NOT from X itself). Gated + cached exactly like
    _has_players_summary() and for the same reasons — the app must serve marts built
    before the socials ETL landed. The column isn't filterable/sortable, so absence just
    omits it (schema default None); there's no 503 path."""
    rows = analytics_db.query(
        "SELECT 1 FROM information_schema.columns "
        "WHERE table_name = 'mart_game' AND column_name = 'dev_x_handle'"
    )
    return bool(rows)


@lru_cache(maxsize=1)
def _has_demo_flag() -> bool:
    """Whether the current mart carries has_demo/demo_appid (mart_game.sql: the game's
    playable demo from its own Steam appdetails `demos` field). Gated + cached exactly
    like _has_players_summary() and for the same reasons. has_demo is tri-state — NULL
    means the game's appdetails was never re-checked since demo capture landed, so the
    filter drops unknowns naturally rather than reading them as 'no demo'."""
    rows = analytics_db.query(
        "SELECT 1 FROM information_schema.columns "
        "WHERE table_name = 'mart_game' AND column_name = 'has_demo'"
    )
    return bool(rows)


@lru_cache(maxsize=1)
def _has_all_socials() -> bool:
    """Whether the mart carries the per-platform social columns (Discord/YouTube/Bluesky and
    the X profile URL) rather than only dev_x_handle. Gated + cached like the others: the
    harvest has always collected all four platforms, but until the widened dev_x CTE landed
    the mart kept only the X handle."""
    rows = analytics_db.query(
        "SELECT 1 FROM information_schema.columns "
        "WHERE table_name = 'mart_game' AND column_name = 'dev_discord_url'"
    )
    return bool(rows)


@lru_cache(maxsize=1)
def _has_metacritic_url() -> bool:
    """Whether the current mart carries metacritic_url (the Metacritic page Steam links in
    appdetails). Gated + cached like the other additive columns. The SCORE needs no gate —
    it has been in every mart — so filtering and sorting by it work regardless; only the
    outbound link is conditional."""
    rows = analytics_db.query(
        "SELECT 1 FROM information_schema.columns "
        "WHERE table_name = 'mart_game' AND column_name = 'metacritic_url'"
    )
    return bool(rows)


_LIFETIME_PROFILE_COLS = (
    ", lifetime_first_100_month, lifetime_died_month, lifetime_months, lifetime_alive"
)


def _profile_cols() -> str:
    cols = _PROFILE_COLS
    if _has_players_summary():
        cols += ", players_7d_avg, players_trend_7d_pct"
    if _has_lifetime_game():
        cols += _LIFETIME_PROFILE_COLS
    if _has_dev_socials():
        cols += ", dev_x_handle"
    if _has_demo_flag():
        cols += ", demo_appid, has_demo"
    if _has_metacritic_url():
        cols += ", metacritic_url"
    if _has_all_socials():
        cols += (
            ", dev_x_url, dev_discord_url, dev_youtube_url, dev_bluesky_handle, dev_bluesky_url"
        )
    return cols


def _search_cols() -> str:
    cols = _SEARCH_COLS
    if _has_lifetime_game():
        cols += ", lifetime_months, lifetime_alive"
    if _has_dev_socials():
        cols += ", dev_x_handle"
    if _has_demo_flag():
        cols += ", has_demo"
    return cols


@router.get("/search", response_model=GameSearchList)
def search_games(
    q: str | None = Query(None),
    tag: str | None = Query(None),
    genre: str | None = Query(None),
    min_reviews: int = Query(0, ge=0),
    released_within_days: int | None = Query(
        None, ge=1, le=3650, description="Only games released within the last N days (a 'new releases' filter)."
    ),
    price_min: float | None = Query(
        None, ge=0, description="Price floor in USD (list price). Any price filter drops NULL-priced rows."
    ),
    price_max: float | None = Query(None, ge=0, description="Price ceiling in USD (list price)."),
    min_positive: float | None = Query(
        None, ge=0, le=1, description="Floor on positive_ratio (0-1, e.g. 0.8 = at least 80% positive)."
    ),
    min_revenue: float | None = Query(None, ge=0, description="Floor on est_rev_reviews (USD)."),
    released_after: int | None = Query(
        None, ge=1970, le=2100, description="Only games with release_year >= this year (inclusive)."
    ),
    released_before: int | None = Query(
        None, ge=1970, le=2100, description="Only games with release_year <= this year (inclusive)."
    ),
    self_published: bool | None = Query(
        None, description="true = self-published only, false = publisher-backed only, omitted = both."
    ),
    indie: bool | None = Query(None, description="true = indie only, false = non-indie only, omitted = both."),
    min_lifetime_months: int | None = Query(
        None, ge=0,
        description="Floor on lifetime_months (months from the first 100+-avg-CCU month to the "
        "first full month under 10; steamcharts top-8k coverage). Drops games with unknown lifetime.",
    ),
    lifetime_alive: bool | None = Query(
        None,
        description="true = still averaging 10+ concurrent players, false = audience already died, "
        "omitted = both. Either value drops games with unknown lifetime (no steamcharts coverage).",
    ),
    has_demo: bool | None = Query(
        None,
        description="true = has a playable Steam demo, false = checked and has none, omitted = both. "
        "Either value drops games whose appdetails we haven't re-checked for a demo yet.",
    ),
    min_metacritic: int | None = Query(
        None, ge=0, le=100,
        description="Floor on the Metacritic critic score. Only ~2.6% of the catalog has one "
        "(Steam links a Metacritic page for few games), so this drops the vast majority — "
        "use it to benchmark against critically-reviewed titles, not to filter a whole niche.",
    ),
    sort: str = Query("total_reviews"),
    order: str = Query("desc", pattern="^(asc|desc)$"),
    limit: int = Query(25, ge=1, le=100),
    offset: int = Query(0, ge=0),
) -> GameSearchList:
    if sort not in SORTABLE:
        raise HTTPException(status_code=400, detail=f"sort must be one of {sorted(SORTABLE)}")
    if (sort == "lifetime_months" or min_lifetime_months is not None or lifetime_alive is not None) \
            and not _has_lifetime_game():
        raise HTTPException(
            status_code=503,
            detail="mart_game predates the lifetime columns — rebuild the marts (task etl).",
        )
    if has_demo is not None and not _has_demo_flag():
        raise HTTPException(
            status_code=503,
            detail="mart_game predates the demo columns — rebuild the marts (task etl).",
        )

    where = ["total_reviews >= ?"]
    params: list = [min_reviews]
    if q:
        # Case-insensitive substring match. Prefer the persisted lowercased column
        # (contains() treats q literally — a plain substring, no ILIKE %/_ wildcards),
        # falling back to ILIKE on marts built before name_lower existed.
        if _has_name_lower():
            where.append("contains(name_lower, ?)")
            params.append(q.lower())
        else:
            where.append("name ILIKE ?")
            params.append(f"%{q}%")
    if genre:
        where.append("primary_genre = ?")
        params.append(genre)
    if tag:
        where.append("list_contains(top_tags, ?)")
        params.append(tag)
    if released_within_days is not None:
        # "New releases": released in the recent PAST. Upper-bounded to today so upcoming/announced
        # titles — and the garbage far-future placeholder dates in the source (e.g. 9998-12-31) —
        # are excluded; NULL / unparseable release dates drop out via TRY_CAST.
        where.append(
            "TRY_CAST(release_date AS DATE) >= CURRENT_DATE - CAST(? AS INTEGER) "
            "AND TRY_CAST(release_date AS DATE) <= CURRENT_DATE"
        )
        params.append(released_within_days)
    # Price band, in USD. Comparisons on price_initial drop NULL-priced rows naturally —
    # a game with an unknown price can't be shown to satisfy a price constraint. Free games
    # (price_initial = 0, incl. is_free titles) stay in as long as the floor allows 0: a
    # researcher's "under $5" should include free titles; "$10-30" should not. We filter on
    # the actual list price rather than is_free because some F2P-flagged titles sell paid
    # editions with a real price (e.g. Rainbow Six Siege at $19.99).
    if price_min is not None:
        where.append("price_initial >= ?")
        params.append(price_min)
    if price_max is not None:
        where.append("price_initial <= ?")
        params.append(price_max)
    if min_positive is not None:
        where.append("positive_ratio >= ?")
        params.append(min_positive)
    if min_revenue is not None:
        where.append("est_rev_reviews >= ?")
        params.append(min_revenue)
    if released_after is not None:
        where.append("release_year >= ?")
        params.append(released_after)
    if released_before is not None:
        where.append("release_year <= ?")
        params.append(released_before)
    if self_published is not None:
        where.append("self_published = ?")
        params.append(1 if self_published else 0)
    if indie is not None:
        where.append("is_indie = ?")
        params.append(1 if indie else 0)
    # Lifetime filters compare against NULL-able columns, so unknown-lifetime games drop
    # out naturally — a game we can't measure can't be shown to satisfy the constraint.
    if min_lifetime_months is not None:
        where.append("lifetime_months >= ?")
        params.append(min_lifetime_months)
    if lifetime_alive is not None:
        where.append("lifetime_alive = ?")
        params.append(lifetime_alive)
    if has_demo is not None:
        # Tri-state column: NULL (never checked) fails both = comparisons, so unknowns
        # drop out naturally — same stance as the lifetime filters above.
        where.append("has_demo = ?")
        params.append(has_demo)
    if min_metacritic is not None:
        where.append("metacritic_score >= ?")
        params.append(min_metacritic)
    where_sql = "WHERE " + " AND ".join(where)

    total = analytics_db.scalar(f"SELECT COUNT(*) FROM mart_game {where_sql}", params)
    rows = analytics_db.query(
        f"SELECT {_search_cols()} FROM mart_game {where_sql} "
        f"ORDER BY {sort} {order.upper()} NULLS LAST, total_reviews DESC LIMIT ? OFFSET ?",
        params + [limit, offset],
    )
    return GameSearchList(
        items=[GameSearchRow(**r) for r in rows],
        total=int(total or 0),
        limit=limit,
        offset=offset,
    )


# In-process cache of the distinct (tag, n_games) list for /tags/suggest. Tradeoff, measured
# on the real ~170K-row data/current.duckdb: running the UNNEST(top_tags) + ILIKE aggregate
# per keystroke costs ~90ms per request (well over the 50ms budget — the scan re-unnests
# every game's tag list each time), while building the FULL distinct list once costs ~25ms
# and yields only ~460 rows, after which each suggest call is a sub-millisecond in-memory
# substring filter. Cached lazily for the process lifetime: safe because the analytics DB is
# swapped + the app restarted on each nightly ETL (the same invariant _has_name_lower()
# relies on), so the tag universe can't change under a running process.
_tag_freq_cache: list[tuple[str, int]] | None = None


def _tag_frequencies() -> list[tuple[str, int]]:
    global _tag_freq_cache
    if _tag_freq_cache is None:
        rows = analytics_db.query(
            "SELECT tag, COUNT(*) AS n_games "
            "FROM (SELECT UNNEST(top_tags) AS tag FROM mart_game) "
            "WHERE tag IS NOT NULL "
            "GROUP BY tag ORDER BY n_games DESC, tag"
        )
        _tag_freq_cache = [(r["tag"], int(r["n_games"])) for r in rows]
    return _tag_freq_cache


# NOTE: registered before the /{appid} route below — FastAPI matches in declaration order,
# so a literal "tags" path segment must come first or it would 422 as a non-integer appid.
@router.get("/tags/suggest", response_model=TagSuggestList)
def suggest_tags(
    q: str = Query("", max_length=100, description="Substring to match (case-insensitive). Empty = top tags."),
    limit: int = Query(10, ge=1, le=50),
) -> TagSuggestList:
    """Autocomplete for the search page's tag filter: distinct tags from mart_game.top_tags,
    case-insensitive substring match, ordered by catalog frequency — so users land on the
    EXACT tag string ("Rogue-like" vs "Roguelike" are different tags) instead of guessing."""
    needle = q.strip().lower()
    freqs = _tag_frequencies()
    matched = [(t, n) for t, n in freqs if needle in t.lower()] if needle else freqs
    return TagSuggestList(items=[TagSuggestion(tag=t, n_games=n) for t, n in matched[:limit]])


@router.get("/{appid}", response_model=GameProfile)
def game_profile(
    appid: int,
) -> GameProfile:
    row = analytics_db.query_one(f"SELECT {_profile_cols()} FROM mart_game WHERE appid = ?", [appid])
    if row is None:
        raise HTTPException(status_code=404, detail=f"game not found: {appid}")
    return GameProfile(**row)


@router.get("/{appid}/comparables", response_model=GameComparablesResponse)
def game_comparables(
    appid: int,
    limit: int = Query(20, ge=1, le=50),
    min_reviews: int = Query(10, ge=0),
) -> GameComparablesResponse:
    """On-demand tag-Jaccard comparables: bounded to same primary_genre + a price band
    around the target (computed at query time from mart_game.top_tags — never precomputed
    pairwise across the ~142K catalog)."""
    target = analytics_db.query_one(
        "SELECT appid, primary_genre, price_initial, top_tags FROM mart_game WHERE appid = ?",
        [appid],
    )
    if target is None:
        raise HTTPException(status_code=404, detail=f"game not found: {appid}")

    price = target["price_initial"] or 0.0
    if price <= 0:
        lo, hi = -0.01, 0.01  # free games are only comparable to other free games
    else:
        lo, hi = max(0.0, price * 0.5 - 2.0), price * 2.0 + 2.0

    rows = analytics_db.query(
        """
        WITH target AS (SELECT appid, primary_genre, top_tags FROM mart_game WHERE appid = ?),
        scored AS (
            SELECT g.appid, g.name, g.release_year, g.price_initial, g.owners_mid,
                g.total_reviews, g.positive_ratio, g.est_rev_reviews, g.header_image,
                list_intersect(g.top_tags, t.top_tags) AS shared_tags,
                len(list_intersect(g.top_tags, t.top_tags)) AS n_shared,
                len(list_distinct(list_concat(g.top_tags, t.top_tags))) AS n_union
            FROM mart_game g, target t
            WHERE g.appid != t.appid
              AND g.primary_genre = t.primary_genre
              AND g.price_initial BETWEEN ? AND ?
              AND g.total_reviews >= ?
        )
        SELECT appid, name, release_year, price_initial, owners_mid, total_reviews,
            positive_ratio, est_rev_reviews, header_image, shared_tags,
            n_shared * 1.0 / n_union AS jaccard
        FROM scored
        WHERE n_union > 0
        ORDER BY jaccard DESC, total_reviews DESC
        LIMIT ?
        """,
        [appid, lo, hi, min_reviews, limit],
    )
    items = [
        GameComparable(
            appid=r["appid"],
            name=r["name"],
            release_year=r["release_year"],
            price_initial=r["price_initial"],
            owners_mid=r["owners_mid"],
            total_reviews=r["total_reviews"],
            positive_ratio=r["positive_ratio"],
            est_rev_reviews=r["est_rev_reviews"],
            header_image=r["header_image"],
            shared_tags=list(r["shared_tags"] or []),
            jaccard=float(r["jaccard"] or 0.0),
        )
        for r in rows
    ]
    return GameComparablesResponse(
        appid=appid,
        primary_genre=target["primary_genre"],
        price_band=PriceBand(low=lo, high=hi),
        items=items,
    )


@router.get("/{appid}/reviews-summary", response_model=GameReviewsSummary)
def reviews_summary(appid: int) -> GameReviewsSummary:
    exists = analytics_db.scalar("SELECT COUNT(*) FROM mart_game WHERE appid = ?", [appid])
    if not exists:
        raise HTTPException(status_code=404, detail=f"game not found: {appid}")

    timeline = analytics_db.query(
        "SELECT period, n_reviews, n_positive, cum_reviews, cum_positive, cum_positive_share, "
        "trailing_reviews, trailing_positive_share "
        "FROM mart_game_reviews_timeline WHERE appid = ? ORDER BY period",
        [appid],
    )
    lang = analytics_db.query(
        "SELECT language, n, share FROM mart_game_reviews_lang WHERE appid = ? ORDER BY n DESC",
        [appid],
    )
    playtime = analytics_db.query(
        "SELECT pctile, value FROM mart_game_reviews_playtime WHERE appid = ? ORDER BY pctile",
        [appid],
    )
    curve = analytics_db.query(
        "SELECT day, cum_fraction, sample_first_year_reviews FROM mart_game_launch_curve "
        "WHERE appid = ? ORDER BY day",
        [appid],
    )
    return GameReviewsSummary(
        appid=appid,
        eligible=len(timeline) > 0 or len(lang) > 0 or len(playtime) > 0,
        timeline=[ReviewTimelinePoint(**t) for t in timeline],
        language_split=[LanguageShare(**l) for l in lang],
        playtime_at_review=[PlaytimePoint(**p) for p in playtime],
        launch_curve=[GameLaunchCurvePoint(**c) for c in curve],
    )


@router.get("/{appid}/events", response_model=GameEventList)
def game_events(appid: int) -> GameEventList:
    """Dated catalog events for annotating this game's lifetime charts — release, developer
    updates (patch notes), journalist coverage — from mart_game_event (capped at 40/game by
    the ETL, release always kept).

    Degrades to items=[] when the mart predates mart_game_event, via CatalogException rather
    than an information_schema probe: annotations are ADDITIVE (a chart without markers is
    complete, just less explained), so the absent-table case is an empty feed, not a 503 —
    the same convention as the radar sparklines. Not 404-guarded against mart_game either,
    mirroring teardown/aspect-reviews: the game page 404s upstream via /games/{appid} before
    this is ever fetched for a nonexistent appid."""
    try:
        rows = analytics_db.query(
            "SELECT CAST(event_date AS VARCHAR) AS event_date, kind, title, url "
            "FROM mart_game_event WHERE appid = ? ORDER BY event_date",
            [appid],
        )
    except duckdb.CatalogException:
        rows = []
    return GameEventList(appid=appid, items=[GameEvent(**r) for r in rows])


@router.get("/{appid}/followers", response_model=GameFollowers)
def game_followers(appid: int) -> GameFollowers:
    """Live follower series from signals.db — skips the nightly mart cycle entirely (see
    signals_db.py). Empty until the rotating collector first reaches this game."""
    rows = signals_db.query(
        "SELECT captured_on, member_count FROM game_followers"
        " WHERE appid = ? ORDER BY captured_on",
        (appid,),
    )
    return GameFollowers(appid=appid, items=[FollowerPoint(**r) for r in rows])


@router.get("/{appid}/price-history", response_model=GamePriceHistory)
def game_price_history(appid: int) -> GamePriceHistory:
    """Live daily price snapshots from signals.db; depth accrues from 2026-08-24."""
    rows = signals_db.query(
        "SELECT captured_on, final_cents, original_cents, COALESCE(discount_pct, 0) AS discount_pct,"
        " is_free, country FROM price_snapshots WHERE appid = ? ORDER BY captured_on",
        (appid,),
    )
    return GamePriceHistory(
        appid=appid,
        items=[PricePoint(**{**r, "is_free": bool(r["is_free"])}) for r in rows],
    )


# Must mirror etl/build_marts.py's TEARDOWN_MIN_REVIEWS — only used to word the caveat
# when a game has no review_aspects rows at all (the mart itself already applies the floor).
_TEARDOWN_MIN_REVIEWS = 20


@router.get("/{appid}/teardown", response_model=GameTeardown)
def game_teardown(appid: int) -> GameTeardown:
    """"Why it works" — review-text aspect mining (praise vs. complaint per aspect, with
    a genre-baseline differential) fused with the press/PR footprint. See
    etl/marts/mart_game_teardown.sql for how each mart is built. Both signals are
    correlational (see `caveats`): evidence toward "why it got popular," not proof.
    """
    game = analytics_db.query_one("SELECT appid, primary_genre FROM mart_game WHERE appid = ?", [appid])
    if game is None:
        raise HTTPException(status_code=404, detail=f"game not found: {appid}")

    # Genre-differential: prefer the game's own primary_genre baseline, falling back to
    # the '__all__' catalog-wide baseline when that genre didn't clear
    # TEARDOWN_MIN_GENRE_GAMES (see mart_genre_aspect_baseline). NULL-safe: if
    # primary_genre is NULL, `gb.genre = NULL` matches nothing and we fall straight to ab.
    aspect_rows = analytics_db.query(
        """
        SELECT a.aspect, a.n_pos_mentions, a.n_neg_mentions, a.total_mentions, a.pos_share,
            a.n_reviews_sampled,
            COALESCE(gb.pos_share, ab.pos_share) AS genre_pos_share,
            COALESCE(gb.genre, ab.genre) AS baseline_genre,
            COALESCE(gb.n_games, ab.n_games) AS n_games_in_baseline,
            a.pos_share - COALESCE(gb.pos_share, ab.pos_share) AS delta_vs_genre,
            -- Aspect TEXT sentiment (VADER) + its own genre-baseline differential.
            a.n_text_pos, a.n_text_neg, a.n_text_neutral, a.text_pos_share, a.mean_compound,
            COALESCE(gb.text_pos_share, ab.text_pos_share) AS genre_text_pos_share,
            a.text_pos_share - COALESCE(gb.text_pos_share, ab.text_pos_share) AS text_delta_vs_genre
        FROM mart_game_review_aspects a
        LEFT JOIN mart_genre_aspect_baseline gb ON gb.genre = ? AND gb.aspect = a.aspect
        LEFT JOIN mart_genre_aspect_baseline ab ON ab.genre = '__all__' AND ab.aspect = a.aspect
        WHERE a.appid = ?
        ORDER BY a.total_mentions DESC
        """,
        [game["primary_genre"], appid],
    )
    n_reviews_sampled = int(aspect_rows[0]["n_reviews_sampled"]) if aspect_rows else 0

    press_summary = analytics_db.query_one(
        "SELECT total_mentions, n_sources, first_seen, last_seen, "
        "n_pos_articles, n_neg_articles, n_neutral_articles, n_scored_articles, "
        "press_pos_share, mean_compound "
        "FROM mart_game_press_summary WHERE appid = ?",
        [appid],
    )
    by_source = analytics_db.query(
        "SELECT source, n_mentions FROM mart_game_press_by_source WHERE appid = ? ORDER BY n_mentions DESC",
        [appid],
    )
    timeline = analytics_db.query(
        "SELECT period, n_mentions FROM mart_game_press_timeline WHERE appid = ? ORDER BY period",
        [appid],
    )
    notable = analytics_db.query(
        "SELECT source, title, author, published_at, match_confidence, is_earliest, "
        "url, sentiment_compound, sentiment "
        "FROM mart_game_press_notable WHERE appid = ? ORDER BY published_at",
        [appid],
    )

    caveats = [
        "Review aspects are mined from a SAMPLE of English-language reviews (the `reviews` table is a "
        "per-game sample, recency-biased for older/popular titles) — not the game's full review history.",
        "Per-aspect sentiment is scored from the review TEXT around each aspect keyword with a lexicon "
        "method (VADER), not the reviewer's overall thumbs-up/down. It's deliberately lightweight and so "
        "is coarse: English-only, sarcasm-blind, and domain-blind — everyday-English valence means terms "
        "like \"hard\", \"brutal\" or \"insane\" often read as negative even where players mean them as "
        "praise (Difficulty especially). Read it as a directional signal, not a verdict; the overall-vote "
        "split is shown alongside for comparison.",
        "Press coverage is fuzzy-matched (article_game_mentions, confidence-filtered) and skews recent "
        "(~365-day scrape backfill) and English-outlet; Steam News (dev-authored posts) is excluded — "
        "this is journalist coverage only.",
        "This is a correlational teardown, not a causal one: it shows what reviewers praise/criticize and "
        "when press attention landed — evidence toward \"why it got popular,\" not proof.",
    ]
    if 0 < n_reviews_sampled < 50:
        caveats.append(f"Only {n_reviews_sampled} sampled English reviews — aspect shares are thin and noisy at this volume.")
    if not aspect_rows:
        caveats.append(
            f"This game has fewer than {_TEARDOWN_MIN_REVIEWS} sampled English reviews, so review-aspect "
            "mining isn't available for it."
        )
    if press_summary is None:
        caveats.append("No press coverage found for this game above the match-confidence floor.")
    elif press_summary["n_scored_articles"]:
        caveats.append(
            "Press coverage tone is VADER sentiment of each matched article's headline + short summary "
            "(not the full body), so it captures an outlet's framing rather than a considered verdict — "
            "and an article's overall tone only proxies its stance on this specific game."
        )

    press = GamePress(
        total_mentions=int(press_summary["total_mentions"]) if press_summary else 0,
        n_sources=int(press_summary["n_sources"]) if press_summary else 0,
        first_seen=press_summary["first_seen"] if press_summary else None,
        last_seen=press_summary["last_seen"] if press_summary else None,
        by_source=[PressBySource(**s) for s in by_source],
        timeline=[PressTimelinePoint(**t) for t in timeline],
        notable=[PressNotableArticle(**n) for n in notable],
        n_pos_articles=int(press_summary["n_pos_articles"]) if press_summary else 0,
        n_neg_articles=int(press_summary["n_neg_articles"]) if press_summary else 0,
        n_neutral_articles=int(press_summary["n_neutral_articles"]) if press_summary else 0,
        n_scored_articles=int(press_summary["n_scored_articles"]) if press_summary else 0,
        press_pos_share=press_summary["press_pos_share"] if press_summary else None,
        mean_compound=press_summary["mean_compound"] if press_summary else None,
    )

    return GameTeardown(
        appid=appid,
        eligible_reviews=len(aspect_rows) > 0,
        n_reviews_sampled=n_reviews_sampled,
        review_aspects=[ReviewAspect(**a) for a in aspect_rows],
        press=press,
        caveats=caveats,
    )


# The exact 10 aspect labels mined by both mart_game_teardown.sql and
# mart_game_aspect_reviews.sql — kept here (not derived from the mart) so an unknown/typo'd
# `aspect` query param 400s immediately instead of silently returning an empty list.
_VALID_ASPECTS = {
    "Combat & Bosses",
    "World & Exploration",
    "Art & Visuals",
    "Music & Audio",
    "Story & Writing",
    "Difficulty",
    "Controls & Performance",
    "Map & Navigation / Backtracking",
    "Content & Length",
    "Price & Value",
}


@lru_cache(maxsize=1)
def _has_aspect_full_text() -> bool:
    """Whether mart_game_aspect_reviews carries the open-the-whole-review columns
    (review_text + steam_url, added 2026-08-21).

    THE ABSENT CASE IS THE NORMAL ONE FIRST: the API deploys hours before the nightly mart
    rebuild, so for that whole window the table on disk is the old 9-column one. Selecting
    the two columns unconditionally would turn every aspect drill-down into a DuckDB
    BinderException 500 in exactly that window. Gated, the endpoint keeps returning the same
    items it does today, with review_text/steam_url null, and starts filling them in the
    moment the rebuilt mart is swapped in.

    One probe for both columns on purpose: they are written by the same CREATE TABLE in
    etl/marts/mart_game_aspect_reviews.sql, so there is no build in which one exists without
    the other. Cached like _has_name_lower() — the DB is swapped atomically and the app
    restarted on each ETL, so a per-process answer cannot go stale under a live process."""
    rows = analytics_db.query(
        "SELECT 1 FROM information_schema.columns "
        "WHERE table_name = 'mart_game_aspect_reviews' AND column_name = 'review_text'"
    )
    return bool(rows)


@router.get("/{appid}/aspect-reviews", response_model=AspectReviewsResponse)
def game_aspect_reviews(
    appid: int,
    aspect: str = Query(..., description="Exact aspect label, e.g. 'Combat & Bosses' (URL-encoded)."),
    sentiment: Literal["praise", "complaint"] = Query(...),
    limit: int = Query(4, ge=1, le=10),
) -> AspectReviewsResponse:
    """Aspect drill-down — the representative review excerpts behind one aspect bar's
    praise or complaint share in the Game Teardown. See
    etl/marts/mart_game_aspect_reviews.sql for how excerpts are selected (same eligible-
    game population, keyword lexicon, and floor as /teardown). Precomputed, so this never
    touches the raw `reviews` table at request time. A valid appid/aspect with no sampled
    reviews mentioning it (or an appid not in the mart at all) returns an empty `items`
    list rather than a 404 — only an unrecognized `aspect` label is rejected (400).

    Each item also carries the FULL review (`review_text`, capped by the mart at 2000 chars
    and ending in '…' when cut) and a `steam_url` permalink, so the drill-down can open the
    whole review instead of stopping at the one-sentence excerpt. Both are null on a mart
    built before those columns landed — see _has_aspect_full_text().
    """
    if aspect not in _VALID_ASPECTS:
        raise HTTPException(status_code=400, detail=f"aspect must be one of {sorted(_VALID_ASPECTS)}")

    # Widen the projection only when the mart actually has the columns; the narrow SELECT is
    # byte-for-byte the pre-2026-08-21 query, so the degraded path is the old behaviour exactly.
    extra_cols = ", review_text, steam_url" if _has_aspect_full_text() else ""
    rows = analytics_db.query(
        f"""
        SELECT excerpt, matched_keywords, votes_up, playtime_minutes, date, language{extra_cols}
        FROM mart_game_aspect_reviews
        WHERE appid = ? AND aspect = ? AND sentiment = ?
        ORDER BY votes_up DESC NULLS LAST
        LIMIT ?
        """,
        [appid, aspect, sentiment, limit],
    )
    items = [
        AspectReviewExcerpt(
            excerpt=r["excerpt"],
            matched_keywords=list(r["matched_keywords"] or []),
            votes_up=r["votes_up"],
            playtime_minutes=r["playtime_minutes"],
            date=r["date"],
            language=r["language"],
            # .get(), not [...]: on the pre-rebuild mart these keys are simply not in the row.
            review_text=r.get("review_text"),
            steam_url=r.get("steam_url"),
        )
        for r in rows
    ]
    return AspectReviewsResponse(appid=appid, aspect=aspect, sentiment=sentiment, items=items)


@router.get("/{appid}/channel-mix", response_model=GameChannelMix)
def game_channel_mix(appid: int) -> GameChannelMix:
    """Where this game's GENRE gets marketing attention — mart_channel_mix's per-channel
    share of mentions / reach-weighted reach (Press vs YouTube vs Reddit vs Twitch vs X)
    for the game's own primary_genre. The mix is a genre property, not a per-game one
    (per-game channel data would be too sparse to read); the genre is echoed so the UI can
    caption it honestly. Degrades to an empty `channels` list when the game has no
    primary_genre, the genre has no rows, or the mart predates the channel-mix ETL
    (CatalogException — same convention as the entities/timing routers)."""
    game = analytics_db.query_one(
        "SELECT appid, primary_genre FROM mart_game WHERE appid = ?", [appid]
    )
    if game is None:
        raise HTTPException(status_code=404, detail=f"game not found: {appid}")

    genre = game["primary_genre"]
    rows: list[dict] = []
    if genre is not None:
        try:
            rows = analytics_db.query(
                "SELECT channel, n_mentions, reach_weighted, share_mentions, "
                "share_reach_weighted FROM mart_channel_mix WHERE genre = ? "
                "ORDER BY share_reach_weighted DESC NULLS LAST",
                [genre],
            )
        except duckdb.CatalogException:
            rows = []
    return GameChannelMix(
        appid=appid, genre=genre, channels=[ChannelMixRow(**r) for r in rows]
    )

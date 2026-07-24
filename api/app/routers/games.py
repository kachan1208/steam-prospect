from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query

from .. import analytics_db
from ..auth import get_current_org
from ..models import Org
from ..schemas import (
    AspectReviewExcerpt,
    AspectReviewsResponse,
    GameComparable,
    GameComparablesResponse,
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
)

router = APIRouter(prefix="/api/games", tags=["games"])

# Columns a client is allowed to sort search results on (prevents SQL injection via `sort`).
SORTABLE = {
    "name", "release_year", "price_initial", "owners_mid", "total_reviews",
    "positive_ratio", "est_rev_reviews", "rev_pct_in_genre", "reviews_pct_in_genre",
    "owners_pct_in_genre", "n_reviews_trailing_30d", "live_players",
}

_SEARCH_COLS = (
    "appid, name, primary_genre, release_year, price_initial, is_free, owners_mid, "
    "total_reviews, positive_ratio, est_rev_reviews, live_players, header_image, top_tags"
)

_PROFILE_COLS = (
    "appid, name, release_year, release_date, price_initial, is_free, primary_genre, "
    "developers, publishers, self_published, is_indie, owners_mid, total_reviews, "
    "positive_ratio, est_rev_reviews, est_rev_owners, metacritic_score, achievements_count, "
    "avg_playtime_forever, header_image, short_description, rev_pct_in_genre, "
    "reviews_pct_in_genre, owners_pct_in_genre, top_tags, n_reviews_sampled, "
    "n_reviews_first_30d, n_reviews_first_90d, n_reviews_first_365d, n_reviews_trailing_30d, "
    "playtime_p25, playtime_p50, playtime_p75, "
    "live_players, twitch_viewers, twitch_streams"
)


@router.get("/search", response_model=GameSearchList)
def search_games(
    q: str | None = Query(None),
    tag: str | None = Query(None),
    genre: str | None = Query(None),
    min_reviews: int = Query(0, ge=0),
    sort: str = Query("total_reviews"),
    order: str = Query("desc", pattern="^(asc|desc)$"),
    limit: int = Query(25, ge=1, le=100),
    offset: int = Query(0, ge=0),
    org: Org = Depends(get_current_org),
) -> GameSearchList:
    if sort not in SORTABLE:
        raise HTTPException(status_code=400, detail=f"sort must be one of {sorted(SORTABLE)}")

    where = ["total_reviews >= ?"]
    params: list = [min_reviews]
    if q:
        where.append("name ILIKE ?")
        params.append(f"%{q}%")
    if genre:
        where.append("primary_genre = ?")
        params.append(genre)
    if tag:
        where.append("list_contains(top_tags, ?)")
        params.append(tag)
    where_sql = "WHERE " + " AND ".join(where)

    total = analytics_db.scalar(f"SELECT COUNT(*) FROM mart_game {where_sql}", params)
    rows = analytics_db.query(
        f"SELECT {_SEARCH_COLS} FROM mart_game {where_sql} "
        f"ORDER BY {sort} {order.upper()} NULLS LAST, total_reviews DESC LIMIT ? OFFSET ?",
        params + [limit, offset],
    )
    return GameSearchList(
        items=[GameSearchRow(**r) for r in rows],
        total=int(total or 0),
        limit=limit,
        offset=offset,
    )


@router.get("/{appid}", response_model=GameProfile)
def game_profile(
    appid: int,
    org: Org = Depends(get_current_org),
) -> GameProfile:
    row = analytics_db.query_one(f"SELECT {_PROFILE_COLS} FROM mart_game WHERE appid = ?", [appid])
    if row is None:
        raise HTTPException(status_code=404, detail=f"game not found: {appid}")
    return GameProfile(**row)


@router.get("/{appid}/comparables", response_model=GameComparablesResponse)
def game_comparables(
    appid: int,
    limit: int = Query(20, ge=1, le=50),
    min_reviews: int = Query(10, ge=0),
    org: Org = Depends(get_current_org),
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
def reviews_summary(appid: int, org: Org = Depends(get_current_org)) -> GameReviewsSummary:
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


# Must mirror etl/build_marts.py's TEARDOWN_MIN_REVIEWS — only used to word the caveat
# when a game has no review_aspects rows at all (the mart itself already applies the floor).
_TEARDOWN_MIN_REVIEWS = 20


@router.get("/{appid}/teardown", response_model=GameTeardown)
def game_teardown(appid: int, org: Org = Depends(get_current_org)) -> GameTeardown:
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


@router.get("/{appid}/aspect-reviews", response_model=AspectReviewsResponse)
def game_aspect_reviews(
    appid: int,
    aspect: str = Query(..., description="Exact aspect label, e.g. 'Combat & Bosses' (URL-encoded)."),
    sentiment: Literal["praise", "complaint"] = Query(...),
    limit: int = Query(4, ge=1, le=10),
    org: Org = Depends(get_current_org),
) -> AspectReviewsResponse:
    """Aspect drill-down — the representative review excerpts behind one aspect bar's
    praise or complaint share in the Game Teardown. See
    etl/marts/mart_game_aspect_reviews.sql for how excerpts are selected (same eligible-
    game population, keyword lexicon, and floor as /teardown). Precomputed, so this never
    touches the raw `reviews` table at request time. A valid appid/aspect with no sampled
    reviews mentioning it (or an appid not in the mart at all) returns an empty `items`
    list rather than a 404 — only an unrecognized `aspect` label is rejected (400).
    """
    if aspect not in _VALID_ASPECTS:
        raise HTTPException(status_code=400, detail=f"aspect must be one of {sorted(_VALID_ASPECTS)}")

    rows = analytics_db.query(
        """
        SELECT excerpt, matched_keywords, votes_up, playtime_minutes, date, language
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
        )
        for r in rows
    ]
    return AspectReviewsResponse(appid=appid, aspect=aspect, sentiment=sentiment, items=items)

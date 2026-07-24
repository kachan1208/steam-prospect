from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from .. import analytics_db
from ..auth import get_current_org
from ..models import Org
from ..schemas import (
    ChannelBuzzChannelBreakdown,
    ChannelBuzzPoint,
    ChannelBuzzResponse,
    ChannelBuzzRow,
    ChannelMixResponse,
    ChannelMixRow,
    CreatorPitchListResponse,
    CreatorPitchRow,
)

router = APIRouter(prefix="/api/marketing", tags=["marketing"])

# Creator platforms this endpoint recognizes — mirrors the `platform` values the scraper
# writes into creator/game_creator_mention (see etl/build_marts.py's create_marketing_
# staging()). Press itself stays on /api/press (unchanged) — this router is creator-
# platform only, plus the cross-channel mix/buzz views that fold press back in.
_PLATFORMS = {"youtube", "reddit", "twitch", "x"}

_CREATOR_PITCH_CAVEATS = [
    "Selection bias: these creators already chose to cover this genre — descriptive of the "
    "current landscape, not a guarantee of future coverage.",
    "reach is a SNAPSHOT (captured periodically), not live — check reach_captured_at; a "
    "creator with reach = null has no snapshot yet, which is NOT the same as zero audience.",
    "Ranked by reach x recent activity (pitch_score) — check n_mentions_recent and the "
    "example mention's date before pitching; a channel can go quiet.",
    "Coverage is fuzzy-matched to games and confidence-filtered — not proof of a correct match.",
    "Genre is Steam's own multi-label genre field; a game usually carries more than one genre, "
    "so the same mention can count toward several genre pitch lists.",
]

_CHANNEL_MIX_CAVEATS = [
    "reach_weighted uses press = 1 unit/mention (outlets have no audience-size figure in this "
    "schema) and creator mentions = reach at the time of the mention (falling back to the "
    "latest known snapshot, then 1) — a single very-large channel can dominate this measure; "
    "compare against n_mentions (raw count) too.",
    "A channel with zero rows for a genre means no confidence-filtered coverage was found for "
    "it — either no scraper has been run for that channel yet, or it genuinely has none.",
]

_CHANNEL_BUZZ_CAVEATS = [
    "Weighting: press contributes 1 unit/mention (no audience-size data available); creator "
    "mentions contribute reach at the time of the mention, falling back to the latest known "
    "snapshot, then 1 — a single very-large channel can dominate total_weighted for a term; "
    "always check total_mentions (unweighted) and by_channel alongside it.",
    "Compares the last 3 complete months to the 3 months before that; the current in-progress "
    "month is excluded.",
    "Mined from titles only (video/post/article titles), as English stopword-filtered bigrams — "
    "a coarse, cheap leading indicator, not full topic modeling or sentiment analysis.",
    "Terms are restricted to Steam's own tag/genre vocabulary (a word-level allowlist), so this "
    "reads as game concepts/mechanics/genres, not franchise names or sale events.",
]

# Display labels for the channels that can appear in mart_channel_mix.
_CHANNEL_LABELS = {"press": "Press", "youtube": "YouTube", "reddit": "Reddit", "twitch": "Twitch", "x": "X"}
# Channels that are worked as creator outreach (vs. press, which has its own pitch flow).
_CREATOR_CHANNELS = {"youtube", "reddit", "twitch", "x"}

_RECOMMENDATION_CAVEATS = [
    "Advice is derived from the same reach-weighted channel mix shown below — a single very-large "
    "channel can dominate the reach share, so weigh it against raw mention counts before reallocating "
    "your whole plan.",
    "Rising concepts are mined across ALL genres and channels (not just this one) — a cheap leading "
    "indicator to sanity-check against your own niche, not a genre-specific signal.",
]


def _channel_label(channel: str) -> str:
    return _CHANNEL_LABELS.get(channel, channel.capitalize())


def _pct(x: float | None) -> int:
    """Share (0..1) -> whole percent, clamped to [0, 100]."""
    return max(0, min(100, int(round((x or 0.0) * 100))))


class Recommendation(BaseModel):
    kind: str
    text: str
    cta_path: str | None = None
    cta_label: str | None = None


class RecommendationsResponse(BaseModel):
    genre: str
    items: list[Recommendation]
    caveats: list[str]


@router.get("/recommendations", response_model=RecommendationsResponse)
def recommendations(
    genre: str = Query(..., description="Exact genre label, e.g. 'RPG' (see /api/marketing/channel-mix for the list)."),
    org: Org = Depends(get_current_org),
) -> RecommendationsResponse:
    """Turn the channel-mix and cross-channel buzz marts into a short list of actionable,
    genre-specific recommendations — "what to do", not just "here's the data". Items about a
    press-dominant channel deep-link (cta_path) into the Press pitch list; creator-channel
    reads carry no deep link (no in-app creator-outreach surface). Honest by construction:
    before any channel scrapers have run a genre reads as ~100% press, and the endpoint says
    so rather than inventing advice.
    """
    rows = analytics_db.query(
        "SELECT channel, n_mentions, reach_weighted, share_mentions, share_reach_weighted "
        "FROM mart_channel_mix WHERE genre = ? ORDER BY share_reach_weighted DESC NULLS LAST",
        [genre],
    )

    items: list[Recommendation] = []

    if not rows:
        items.append(
            Recommendation(
                kind="channel_mix",
                text=(
                    f"No channel-mix data yet for {genre} — until the YouTube / Reddit / Twitch / X "
                    "scrapers run, every genre reads as ~100% press. Start from your press pitch list."
                ),
                cta_path="/press",
                cta_label="See press pitch list",
            )
        )
    else:
        # (1) Where attention actually is — the reach-dominant channel (rows are reach-sorted).
        top = rows[0]
        top_ch = top["channel"]
        top_share = _pct(top["share_reach_weighted"])
        if top_ch == "press":
            items.append(
                Recommendation(
                    kind="channel_focus",
                    text=(
                        f"Attention in {genre} is {top_share}% Press by reach-weighted share — lead with "
                        "your outlet/byline pitch list here before spending on creators."
                    ),
                    cta_path="/press",
                    cta_label="See press pitch list",
                )
            )
        else:
            items.append(
                Recommendation(
                    kind="channel_focus",
                    text=(
                        f"Attention in {genre} is {top_share}% {_channel_label(top_ch)} by reach — "
                        "prioritise creator outreach over press."
                    ),
                )
            )

        # (2) Mention-count vs reach mismatch — press earns coverage but not the audience.
        press = next((r for r in rows if r["channel"] == "press"), None)
        if (
            top_ch != "press"
            and press is not None
            and (press["share_mentions"] or 0.0) >= 0.15
            and (press["share_reach_weighted"] or 0.0) < 0.10
        ):
            reach_pct = _pct(press["share_reach_weighted"])
            reach_phrase = "under 1%" if reach_pct == 0 else f"{reach_pct}%"
            items.append(
                Recommendation(
                    kind="channel_balance",
                    text=(
                        f"Press is {_pct(press['share_mentions'])}% of {genre} mentions but {reach_phrase} of "
                        "reach-weighted attention — worth it for launch-day credibility, but creators are what "
                        "move the wishlist numbers here."
                    ),
                    cta_path="/press",
                    cta_label="See press pitch list",
                )
            )

        # (3) An under-used, high-reach lever — a non-dominant channel that punches above its weight.
        for r in rows[1:]:
            sm = r["share_mentions"] or 0.0
            sr = r["share_reach_weighted"] or 0.0
            if sr >= 0.05 and sm > 0.0 and sr >= 1.3 * sm:
                ch = r["channel"]
                is_creator = ch in _CREATOR_CHANNELS
                items.append(
                    Recommendation(
                        kind="channel_upside",
                        text=(
                            f"{_channel_label(ch)} punches above its weight in {genre}: {_pct(sm)}% of mentions "
                            f"but {_pct(sr)}% of reach — a shorter list of {_channel_label(ch)} accounts can "
                            "deliver outsized audience for the effort."
                        ),
                        cta_path=None if is_creator else "/press",
                        cta_label=None if is_creator else "See press pitch list",
                    )
                )
                break  # one upside nudge is enough — keep the card scannable

    # (4) Rising concepts to fold into store copy & tags — from the cross-channel buzz mart.
    buzz = analytics_db.query(
        "SELECT term FROM mart_channel_buzz_summary WHERE direction = 'rising' "
        "ORDER BY slope_weighted DESC LIMIT 5"
    )
    terms = [b["term"] for b in buzz]
    if terms:
        items.append(
            Recommendation(
                kind="buzz",
                text=(
                    "Concepts rising across every marketing channel right now: "
                    f"{', '.join(terms)} — weave the ones that genuinely fit into your Steam capsule "
                    "copy, short description, and tags."
                ),
                cta_path=f"/games?genre={genre}",
                cta_label=f"Scout {genre} games",
            )
        )

    return RecommendationsResponse(genre=genre, items=items, caveats=_RECOMMENDATION_CAVEATS)


@router.get("/creator-pitch-list", response_model=CreatorPitchListResponse)
def creator_pitch_list(
    genre: str = Query(..., description="Exact genre label, e.g. 'RPG' (see /api/press/coverage for the full list)."),
    platform: str = Query(..., description=f"One of {sorted(_PLATFORMS)}."),
    limit: int = Query(25, ge=1, le=100, description="Max creators returned."),
    org: Org = Depends(get_current_org),
) -> CreatorPitchListResponse:
    """Who to pitch on ONE creator platform for one genre — the creator-platform analogue of
    /api/press/pitch-list. Ranked by reach x recent activity (see etl/marts/
    mart_creator_pitch.sql). Empty items is a real, honest answer: either no channel scraper
    has populated this platform yet, or genuinely no confidence-filtered coverage exists for
    this genre on it — not an error either way.
    """
    if platform not in _PLATFORMS:
        raise HTTPException(status_code=400, detail=f"platform must be one of {sorted(_PLATFORMS)}")
    rows = analytics_db.query(
        "SELECT genre, platform, creator_id, handle, display_name, creator_url, n_mentions, "
        "n_mentions_recent, n_games_covered, reach, reach_captured_at, pitch_score, "
        "example_title, example_url, example_published_at "
        "FROM mart_creator_pitch WHERE genre = ? AND platform = ? ORDER BY pitch_score DESC LIMIT ?",
        [genre, platform, limit],
    )
    caveats = list(_CREATOR_PITCH_CAVEATS)
    if not rows:
        caveats.insert(
            0,
            f"No {platform} coverage found yet for genre '{genre}' — run the {platform} channel "
            "scraper to start collecting creators/mentions for this platform, or this genre may "
            "genuinely have none yet.",
        )
    return CreatorPitchListResponse(
        genre=genre,
        platform=platform,
        items=[CreatorPitchRow(**r) for r in rows],
        caveats=caveats,
    )


@router.get("/channel-mix", response_model=ChannelMixResponse)
def channel_mix(
    genre: str | None = Query(None, description="Exact genre label; omit for the full genre x channel matrix."),
    org: Org = Depends(get_current_org),
) -> ChannelMixResponse:
    """Share of marketing attention by channel (Press vs YouTube vs Reddit vs Twitch vs X)
    for one genre, or the full matrix if `genre` is omitted. See etl/marts/
    mart_channel_mix.sql for the raw-count vs. reach-weighted distinction. Before any
    channel scrapers have run, every genre's mix is 100% press — a real, honest snapshot of
    today's coverage, not an error.
    """
    where = ""
    params: list = []
    if genre:
        where = "WHERE genre = ?"
        params.append(genre)
    rows = analytics_db.query(
        f"SELECT genre, channel, n_mentions, reach_weighted, share_mentions, share_reach_weighted "
        f"FROM mart_channel_mix {where} ORDER BY genre, share_reach_weighted DESC NULLS LAST",
        params,
    )
    genres = [r["genre"] for r in analytics_db.query("SELECT DISTINCT genre FROM mart_channel_mix ORDER BY genre")]
    channels = [r["channel"] for r in analytics_db.query("SELECT DISTINCT channel FROM mart_channel_mix ORDER BY channel")]
    return ChannelMixResponse(
        genre=genre,
        items=[ChannelMixRow(**r) for r in rows],
        genres=genres,
        channels=channels,
    )


@router.get("/channel-buzz", response_model=ChannelBuzzResponse)
def channel_buzz(
    direction: Literal["rising", "cooling"] = Query(...),
    limit: int = Query(20, ge=1, le=100),
    org: Org = Depends(get_current_org),
) -> ChannelBuzzResponse:
    """Reach-weighted rising/cooling game-concept themes across EVERY marketing channel
    (press + YouTube + Reddit + Twitch + X combined) — the multi-channel sequel to
    /api/press/buzz-trends (press-title-only, unweighted). See etl/marts/
    mart_channel_buzz.sql for the weighting rule and windowing. 'rising' sorts by steepest
    positive weighted-slope first, 'cooling' by steepest negative first.
    """
    order = "DESC" if direction == "rising" else "ASC"
    rows = analytics_db.query(
        f"SELECT term, total_mentions, total_weighted, recent_avg_weighted, prior_avg_weighted, "
        f"slope_weighted, direction FROM mart_channel_buzz_summary WHERE direction = ? "
        f"ORDER BY slope_weighted {order} LIMIT ?",
        [direction, limit],
    )

    terms = [r["term"] for r in rows]
    series_by_term: dict[str, dict[str, dict]] = {t: {} for t in terms}
    breakdown_by_term: dict[str, dict[str, dict]] = {t: {} for t in terms}
    if terms:
        placeholders = ",".join("?" for _ in terms)
        detail_rows = analytics_db.query(
            f"SELECT term, channel, period, n_mentions, reach_weighted_score FROM mart_channel_buzz "
            f"WHERE term IN ({placeholders}) ORDER BY term, period",
            terms,
        )
        for r in detail_rows:
            term, channel, period = r["term"], r["channel"], r["period"]
            per = series_by_term[term].setdefault(period, {"n_mentions": 0, "reach_weighted_score": 0.0})
            per["n_mentions"] += r["n_mentions"]
            per["reach_weighted_score"] += r["reach_weighted_score"]
            ch = breakdown_by_term[term].setdefault(channel, {"n_mentions": 0, "reach_weighted_score": 0.0})
            ch["n_mentions"] += r["n_mentions"]
            ch["reach_weighted_score"] += r["reach_weighted_score"]

    items = [
        ChannelBuzzRow(
            term=r["term"],
            total_mentions=int(r["total_mentions"]),
            total_weighted=float(r["total_weighted"]),
            recent_avg_weighted=float(r["recent_avg_weighted"]),
            prior_avg_weighted=float(r["prior_avg_weighted"]),
            slope_weighted=float(r["slope_weighted"]),
            direction=r["direction"],
            by_channel=[
                ChannelBuzzChannelBreakdown(
                    channel=ch,
                    n_mentions=int(v["n_mentions"]),
                    reach_weighted_score=float(v["reach_weighted_score"]),
                )
                for ch, v in sorted(
                    breakdown_by_term[r["term"]].items(), key=lambda kv: -kv[1]["reach_weighted_score"]
                )
            ],
            series=[
                ChannelBuzzPoint(period=period, n_mentions=int(v["n_mentions"]), reach_weighted_score=float(v["reach_weighted_score"]))
                for period, v in sorted(series_by_term[r["term"]].items())
            ],
        )
        for r in rows
    ]
    return ChannelBuzzResponse(direction=direction, items=items, caveats=_CHANNEL_BUZZ_CAVEATS)

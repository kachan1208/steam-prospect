from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query

from .. import analytics_db
from ..auth import get_current_org
from ..models import Org
from ..schemas import (
    BuzzTermPoint,
    BuzzTermRow,
    BuzzTrendsResponse,
    PitchAuthor,
    PitchListResponse,
    PitchOutlet,
    PressCoverageResponse,
    PressCoverageRow,
)

router = APIRouter(prefix="/api/press", tags=["press"])

# Columns a client is allowed to select as the heatmap's `metric` (prevents SQL injection
# via the query param — same whitelist-then-interpolate pattern as niches.py's SORTABLE).
_COVERAGE_METRICS = {
    "n_articles", "n_games_covered", "median_est_rev", "median_owners", "median_positive_ratio",
}

_PITCH_CAVEATS = [
    "Selection bias: these are the outlets/journalists who already chose to cover this genre — "
    "descriptive of the current press landscape, not a guarantee any of them will cover your game.",
    "Ranked by ALL-TIME article volume (these outlets' archives run back to 1997-2005 depending on "
    "source) — a prolific past contributor can outrank a currently-active one. Check "
    "n_articles_recent_24m and the example article's date before pitching; some names here (a "
    "former editor, say) may no longer cover the beat at all.",
    "Coverage is fuzzy-matched to games (article_game_mentions, match_confidence >= 0.2) and "
    "ranks by article volume — a lower-volume specialist writer can still be a sharper pitch target.",
    "Steam News (dev-authored posts/patch notes) is excluded — this is journalist/trade-press coverage only.",
    "Genre is Steam's own multi-label genre field (not community tags like \"Roguelike\"); a game "
    "usually carries more than one genre, so the same article can count toward several genre pitch lists.",
]

# Mirrors etl/build_marts.py's BUZZ_RECENT_MONTHS (3) / BUZZ_TOTAL_MONTHS (12) — only used to
# word the caveats below; the mart itself already applies the real windowing.
_BUZZ_RECENT_MONTHS = 3
_BUZZ_CAVEATS = [
    f"'Rising'/'cooling' compares the last {_BUZZ_RECENT_MONTHS} complete months to the "
    f"{_BUZZ_RECENT_MONTHS} months before that; the current in-progress calendar month is excluded.",
    "Mined from journalist article TITLES only (not full article text), as English stopword-filtered "
    "bigrams — a coarse, cheap leading indicator, not full topic modeling or sentiment analysis.",
    "Terms below a minimum total-mention floor are dropped to avoid noise from one-off headlines.",
    "Terms are restricted to Steam's own tag/genre vocabulary (a word-level allowlist), so this reads "
    "as game concepts/mechanics/genres — not franchise names or sale events. The match is coarse "
    "(word-level, not phrase-aware NLP), so an occasional edge case can still slip through.",
]


@router.get("/coverage", response_model=PressCoverageResponse)
def press_coverage(
    genre: str | None = Query(None, description="Exact genre label; omit for the full outlet x genre matrix."),
    metric: str = Query("n_articles", description=f"One of {sorted(_COVERAGE_METRICS)}"),
    org: Org = Depends(get_current_org),
) -> PressCoverageResponse:
    """Outlet x genre coverage matrix — powers the heatmap and the coverage-vs-success
    scatter. See etl/marts/mart_press.sql (mart_press_outlet_genre) for how each cell is
    built: journalist articles only (Steam News excluded), match_confidence-filtered,
    genre is Steam's multi-label genre field. Returns the full matrix by default (bounded —
    ~100 (source, genre) cells); pass `genre` to narrow to one row per outlet.
    """
    if metric not in _COVERAGE_METRICS:
        raise HTTPException(status_code=400, detail=f"metric must be one of {sorted(_COVERAGE_METRICS)}")

    where = ""
    params: list = []
    if genre:
        where = "WHERE genre = ?"
        params.append(genre)
    rows = analytics_db.query(
        f"SELECT source, genre, n_articles, n_articles_recent_24m, n_games_covered, median_est_rev, "
        f"median_owners, median_positive_ratio, {metric} AS value "
        f"FROM mart_press_outlet_genre {where} ORDER BY genre, n_articles DESC",
        params,
    )
    genres = [r["genre"] for r in analytics_db.query("SELECT DISTINCT genre FROM mart_press_outlet_genre ORDER BY genre")]
    sources = [r["source"] for r in analytics_db.query("SELECT DISTINCT source FROM mart_press_outlet_genre ORDER BY source")]
    return PressCoverageResponse(
        genre=genre,
        metric=metric,
        items=[PressCoverageRow(**r) for r in rows],
        genres=genres,
        sources=sources,
    )


@router.get("/pitch-list", response_model=PitchListResponse)
def pitch_list(
    genre: str = Query(..., description="Exact genre label, e.g. 'RPG' (see /api/press/coverage for the full list)."),
    limit: int = Query(25, ge=1, le=100, description="Max journalists returned (outlets are always all ~6)."),
    org: Org = Depends(get_current_org),
) -> PitchListResponse:
    """The headline deliverable: for one genre, who to pitch — ranked outlets AND named
    journalists, each with an example headline/date/url. Precomputed in
    mart_press_outlet_genre / mart_press_author (etl/marts/mart_press.sql); a genre with no
    rows (e.g. it's actually a community TAG like "Roguelike", not a Steam genre, or genuinely
    has no confidence-filtered coverage) returns empty lists rather than a 404 — that's a
    real, honest answer, not an error.
    """
    outlets = analytics_db.query(
        "SELECT source, n_articles, n_articles_recent_24m, n_games_covered, median_est_rev, "
        "median_owners, median_positive_ratio, example_author, example_title, example_url, "
        "example_published_at "
        "FROM mart_press_outlet_genre WHERE genre = ? ORDER BY n_articles DESC",
        [genre],
    )
    authors = analytics_db.query(
        "SELECT author, n_articles, n_articles_recent_24m, n_distinct_games, outlets, "
        "example_source, example_title, example_url, example_published_at "
        "FROM mart_press_author WHERE genre = ? ORDER BY n_articles DESC LIMIT ?",
        [genre, limit],
    )
    caveats = list(_PITCH_CAVEATS)
    if not outlets and not authors:
        caveats.insert(
            0,
            f"No confidence-filtered journalist coverage found for genre '{genre}'. If this looks wrong, "
            "check the exact label at GET /api/press/coverage (genre is Steam's genre field, not a community tag).",
        )
    return PitchListResponse(
        genre=genre,
        outlets=[PitchOutlet(**o) for o in outlets],
        authors=[PitchAuthor(**a) for a in authors],
        caveats=caveats,
    )


@router.get("/buzz-trends", response_model=BuzzTrendsResponse)
def buzz_trends(
    direction: Literal["rising", "cooling"] = Query(...),
    limit: int = Query(20, ge=1, le=100),
    org: Org = Depends(get_current_org),
) -> BuzzTrendsResponse:
    """Rising/cooling title-bigram themes across journalist coverage — a leading indicator
    (buzz building before it shows up in releases/sales). See etl/marts/mart_press.sql
    (mart_buzz_trends / mart_buzz_trends_summary) for the windowing + floor. 'rising' sorts
    by steepest positive slope first, 'cooling' by steepest negative slope first.
    """
    order = "DESC" if direction == "rising" else "ASC"
    rows = analytics_db.query(
        f"SELECT term, total_mentions, recent_avg, prior_avg, slope, direction "
        f"FROM mart_buzz_trends_summary WHERE direction = ? ORDER BY slope {order} LIMIT ?",
        [direction, limit],
    )

    series_by_term: dict[str, list[dict]] = {r["term"]: [] for r in rows}
    if rows:
        terms = list(series_by_term.keys())
        placeholders = ",".join("?" for _ in terms)
        series_rows = analytics_db.query(
            f"SELECT term, period, n_mentions FROM mart_buzz_trends "
            f"WHERE term IN ({placeholders}) ORDER BY term, period",
            terms,
        )
        for sr in series_rows:
            series_by_term[sr["term"]].append({"period": sr["period"], "n_mentions": sr["n_mentions"]})

    items = [
        BuzzTermRow(
            term=r["term"],
            total_mentions=int(r["total_mentions"]),
            recent_avg=float(r["recent_avg"]),
            prior_avg=float(r["prior_avg"]),
            slope=float(r["slope"]),
            direction=r["direction"],
            series=[BuzzTermPoint(**p) for p in series_by_term[r["term"]]],
        )
        for r in rows
    ]
    return BuzzTrendsResponse(direction=direction, items=items, caveats=_BUZZ_CAVEATS)

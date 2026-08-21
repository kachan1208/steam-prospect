"""GET /api/games/{appid}/aspect-reviews — the aspect drill-down, in BOTH mart states.

The drill-down gained two columns (mart_game_aspect_reviews.review_text / .steam_url) so a
reader can open the whole review instead of stopping at the one-sentence excerpt. The API
ships hours before the nightly rebuild that creates them, so production runs the OLD mart
first, for hours — the state a naive `SELECT review_text, steam_url` turns into a
BinderException 500 on every drill-down click.

Both states are therefore fixtures here, over two purpose-built DuckDBs seeded with the SAME
excerpt rows and differing only in whether the two columns exist:

  new_mart_client  the rebuilt mart -> the columns come through, truncation and the null
                   permalink included.
  old_mart_client  the pre-rebuild mart -> 200 with the SAME items, review_text/steam_url
                   null. Never a 500, never an empty list.

conftest's shared fixture mart has no mart_game_aspect_reviews at all, so (like
test_niches_games_mart.py) each fixture swaps analytics_db onto its own DB and restores
afterwards. The swap is per-TEST, not per-module: two module-scoped swaps would fight over
which DB is mounted depending on test order. games._has_aspect_full_text is lru_cached per
process, so every swap clears it.
"""
from __future__ import annotations

import tempfile
from contextlib import contextmanager
from pathlib import Path

import duckdb
import pytest

from app import analytics_db
from app.config import settings
from app.routers import games

APPID = 4242
STEAMID_A = "76561198000000001"
STEAMID_B = "76561198000000002"

CAP = 2000  # etl/marts/mart_game_aspect_reviews.sql's inline truncation cap.

# A review the mart had to cut: exactly CAP characters, last one an ellipsis. The API must pass
# it through byte-for-byte — truncation is the ETL's job, not the router's.
TRUNCATED_TEXT = "T" * (CAP - 1) + "…"


def _url(steamid: str) -> str:
    return f"https://steamcommunity.com/profiles/{steamid}/recommended/{APPID}/"


# appid, aspect, sentiment, excerpt, matched_keywords, votes_up, playtime_minutes, date,
# language, review_text, steam_url. votes_up is deliberately NOT in insert order, so the
# router's ORDER BY votes_up DESC is observable. The third row has a NULL steam_url (a review
# whose author_steamid is NULL) while keeping its review_text — the two columns are
# independently nullable and the UI must handle "text but no link".
ROWS = [
    (APPID, "Combat & Bosses", "praise", "…parry timing is generous…", ["parry"], 10, 60,
     "2025-04-02", "english", "Honestly the parry timing is generous.", None),
    (APPID, "Combat & Bosses", "praise", "…the combat is superb…", ["combat"], 120, 900,
     "2025-06-15", "english", "Fifty hours in and the combat is superb. No notes.",
     _url(STEAMID_A)),
    (APPID, "Combat & Bosses", "praise", "…bosses hit hard but fair…", ["bosses", "boss"], 80,
     400, "2025-05-01", "english", TRUNCATED_TEXT, _url(STEAMID_B)),
    (APPID, "Combat & Bosses", "complaint", "…the combat gets repetitive…", ["combat"], 55, 300,
     "2025-03-03", "english", "By act three the combat gets repetitive.", _url(STEAMID_A)),
    (APPID, "Art & Visuals", "praise", "…the art is lovely…", ["art"], 33, 120,
     "2025-02-04", "english", "Every screenshot is a wallpaper; the art is lovely.",
     _url(STEAMID_B)),
]

_NEW_COLS = (
    "appid INTEGER, aspect VARCHAR, sentiment VARCHAR, excerpt VARCHAR, "
    "matched_keywords VARCHAR[], votes_up INTEGER, playtime_minutes INTEGER, date VARCHAR, "
    "language VARCHAR, review_text VARCHAR, steam_url VARCHAR"
)
# Exactly the schema that shipped before 2026-08-21 — the two columns simply do not exist.
_OLD_COLS = _NEW_COLS.rsplit(", review_text", 1)[0]


def _build(path: Path, *, with_full_text: bool) -> None:
    con = duckdb.connect(str(path))
    try:
        cols = _NEW_COLS if with_full_text else _OLD_COLS
        con.execute(f"CREATE TABLE mart_game_aspect_reviews ({cols})")
        n = 11 if with_full_text else 9
        con.executemany(
            f"INSERT INTO mart_game_aspect_reviews VALUES ({', '.join(['?'] * n)})",
            [r[:n] for r in ROWS],
        )
        con.execute("CREATE TABLE mart_meta (key VARCHAR, value VARCHAR)")
        con.execute(
            "INSERT INTO mart_meta VALUES ('mart_version', ?), "
            "('built_at', '2026-01-01T00:00:00+00:00')",
            ["aspect-reviews-fixture-" + ("new" if with_full_text else "old")],
        )
    finally:
        con.close()  # must be closed before analytics_db opens it read_only


@pytest.fixture(scope="module")
def mart_paths() -> dict[str, Path]:
    tmp = Path(tempfile.mkdtemp(prefix="prospect_aspect_reviews_"))
    paths = {"new": tmp / "new_mart.duckdb", "old": tmp / "old_mart.duckdb"}
    _build(paths["new"], with_full_text=True)
    _build(paths["old"], with_full_text=False)
    return paths


@contextmanager
def _swapped(path: Path):
    """Mount `path` as the analytics DB for one test, then put the shared fixture mart back.

    _has_aspect_full_text() answers per process, so it is cleared on the way in AND on the way
    out — otherwise the first test to run would pin its answer for every test after it, and the
    two states would silently become one."""
    analytics_db.close()
    analytics_db.init(str(path), 2)
    games._has_aspect_full_text.cache_clear()
    try:
        yield
    finally:
        analytics_db.close()
        analytics_db.init(settings.analytics_db_path, settings.analytics_pool_size)
        games._has_aspect_full_text.cache_clear()


@pytest.fixture
def new_mart_client(client, mart_paths):
    """Depends on `client` so the app's lifespan has already run its own analytics_db.init()
    before the swap — otherwise it would overwrite it."""
    with _swapped(mart_paths["new"]):
        yield client


@pytest.fixture
def old_mart_client(client, mart_paths):
    with _swapped(mart_paths["old"]):
        yield client


def _get(c, **params):
    p = {"aspect": "Combat & Bosses", "sentiment": "praise"}
    p.update(params)
    return c.get(f"/api/games/{APPID}/aspect-reviews", params=p)


# ---- the rebuilt mart: the columns come through ------------------------------------------
def test_probe_sees_the_columns_on_the_rebuilt_mart(new_mart_client):
    assert games._has_aspect_full_text() is True


def test_full_text_and_permalink_are_served(new_mart_client):
    r = _get(new_mart_client)
    assert r.status_code == 200
    items = r.json()["items"]
    # praise only (the complaint row and the Art & Visuals row are filtered out), votes desc.
    assert [i["votes_up"] for i in items] == [120, 80, 10]
    top = items[0]
    assert top["excerpt"] == "…the combat is superb…"
    assert top["review_text"] == "Fifty hours in and the combat is superb. No notes."
    assert top["steam_url"] == _url(STEAMID_A)
    # The excerpt is still the short keyword window, not a duplicate of the full review.
    assert top["excerpt"] != top["review_text"]


def test_truncated_review_passes_through_untouched(new_mart_client):
    """The 2000-char cap is the mart's; the router must not re-cut, re-pad, or strip the '…'
    that tells the UI the review was cut."""
    item = _get(new_mart_client).json()["items"][1]
    assert item["review_text"] == TRUNCATED_TEXT
    assert len(item["review_text"]) == CAP
    assert item["review_text"].endswith("…")


def test_null_permalink_does_not_take_the_text_with_it(new_mart_client):
    """A review with no author_steamid has no link — but it still has a review to read."""
    item = _get(new_mart_client).json()["items"][2]
    assert item["steam_url"] is None
    assert item["review_text"] == "Honestly the parry timing is generous."


def test_sentiment_and_aspect_still_filter(new_mart_client):
    complaint = _get(new_mart_client, sentiment="complaint").json()["items"]
    assert [i["excerpt"] for i in complaint] == ["…the combat gets repetitive…"]
    assert complaint[0]["steam_url"] == _url(STEAMID_A)

    art = _get(new_mart_client, aspect="Art & Visuals").json()["items"]
    assert [i["review_text"] for i in art] == [
        "Every screenshot is a wallpaper; the art is lovely."
    ]


def test_limit_still_caps_the_item_count(new_mart_client):
    items = _get(new_mart_client, limit=2).json()["items"]
    assert [i["votes_up"] for i in items] == [120, 80]


# ---- the pre-rebuild mart: the state production is in FIRST -------------------------------
def test_probe_reports_the_columns_missing(old_mart_client):
    assert games._has_aspect_full_text() is False


def test_old_mart_still_serves_every_item(old_mart_client):
    """The whole point of the gate: no 500, no empty list — the same drill-down as yesterday."""
    r = _get(old_mart_client)
    assert r.status_code == 200
    items = r.json()["items"]
    assert [i["votes_up"] for i in items] == [120, 80, 10]
    assert [i["excerpt"] for i in items] == [
        "…the combat is superb…", "…bosses hit hard but fair…", "…parry timing is generous…",
    ]
    assert items[1]["matched_keywords"] == ["bosses", "boss"]
    assert items[0]["playtime_minutes"] == 900
    assert items[0]["date"] == "2025-06-15"
    assert items[0]["language"] == "english"


def test_old_mart_returns_the_new_fields_as_null(old_mart_client):
    """Present in the response shape (so the web can code against one contract), just null —
    rather than absent, which would make the client branch on key existence."""
    items = _get(old_mart_client).json()["items"]
    for item in items:
        assert "review_text" in item and item["review_text"] is None
        assert "steam_url" in item and item["steam_url"] is None


def test_old_mart_other_cuts_are_unaffected(old_mart_client):
    complaint = _get(old_mart_client, sentiment="complaint").json()["items"]
    assert [i["excerpt"] for i in complaint] == ["…the combat gets repetitive…"]
    assert complaint[0]["review_text"] is None

    empty = _get(old_mart_client, aspect="Music & Audio").json()["items"]
    assert empty == []  # a real "no reviews for this aspect", not a degraded path


# ---- validation runs ahead of the mart, in both states ------------------------------------
@pytest.mark.parametrize("fixture_name", ["new_mart_client", "old_mart_client"])
def test_unknown_aspect_is_a_400_in_both_states(request, fixture_name):
    c = request.getfixturevalue(fixture_name)
    r = _get(c, aspect="Vibes")
    assert r.status_code == 400
    assert "aspect must be one of" in r.json()["detail"]


@pytest.mark.parametrize("fixture_name", ["new_mart_client", "old_mart_client"])
def test_unknown_sentiment_is_a_422_in_both_states(request, fixture_name):
    c = request.getfixturevalue(fixture_name)
    assert _get(c, sentiment="neutral").status_code == 422


@pytest.mark.parametrize("fixture_name", ["new_mart_client", "old_mart_client"])
def test_unknown_appid_is_an_empty_list_not_a_404(request, fixture_name):
    c = request.getfixturevalue(fixture_name)
    r = c.get("/api/games/999999/aspect-reviews",
              params={"aspect": "Combat & Bosses", "sentiment": "praise"})
    assert r.status_code == 200
    assert r.json()["items"] == []

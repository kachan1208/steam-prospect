"""LIMIT/OFFSET paging must visit every row exactly once, even when the sort key ties.

With ties, DuckDB may return tied rows in a different order on every execution — parallel
scans over several row groups make that the norm on a real-sized table — so page 2 can
repeat rows from page 1 and skip others entirely. Measured on the real mart (2026-09-21):
the "new releases" query (released_within_days=30, sort=release_date desc) returned three
different page-1 sets in six calls, and walking 8 pages of 25 gave 38 duplicates, i.e. 38
games the user could never reach. Every paginated ORDER BY now ends in the table's unique
key (app/paging.py).

The fixture is deliberately tie-heavy AND bigger than one DuckDB row group (122,880 rows),
because below that a single-threaded scan hands ties back in a stable order and the bug
hides: 260K games, of which a spread-out 600 share every sort-relevant value.
"""
from __future__ import annotations

import tempfile
from pathlib import Path

import duckdb
import pytest

from app import paging
from conftest import serving

N_GAMES = 260_000
TIED = 600  # games that tie on EVERYTHING the search can sort by, spread across row groups


def _build(path: Path) -> None:
    con = duckdb.connect(str(path))
    try:
        # Every column the /api/games/search projection selects. The TIED games (every
        # step-th appid) share release_year/date, price, reviews, revenue — only appid tells
        # them apart.
        step = N_GAMES // TIED
        tied = f"(range % {step} = 0 AND range < {step * TIED})"
        con.execute(f"""
            CREATE TABLE mart_game AS
            SELECT
                range AS appid,
                'Game ' || range AS name,
                'Indie' AS primary_genre,
                CASE WHEN {tied} THEN 2026 ELSE 2000 + range % 20 END AS release_year,
                CASE WHEN {tied} THEN '2026-09-01' ELSE '2010-01-01' END AS release_date,
                CASE WHEN {tied} THEN 9.99 ELSE (range % 50) + 0.99 END AS price_initial,
                0 AS is_free,
                1000.0 AS owners_mid,
                CAST(CASE WHEN {tied} THEN 100 ELSE range % 5000 END AS INTEGER) AS total_reviews,
                0.9 AS positive_ratio,
                CASE WHEN {tied} THEN 30000.0 ELSE (range % 5000) * 30.0 END AS est_rev_reviews,
                NULL::INTEGER AS live_players,
                '2026-01-01' AS first_seen,
                NULL::VARCHAR AS header_image,
                ['Tag'] AS top_tags,
                NULL::INTEGER AS metacritic_score,
                1 AS self_published,
                1 AS is_indie
            FROM range({N_GAMES})
        """)
        con.execute("CREATE TABLE mart_meta (key VARCHAR, value VARCHAR)")
        con.execute(
            "INSERT INTO mart_meta VALUES ('mart_version', 'paging-fixture'), "
            "('built_at', '2026-09-21T22:00:00+00:00')"
        )
    finally:
        con.close()


@pytest.fixture(scope="module")
def tie_heavy_client(client):
    tmp = Path(tempfile.mkdtemp(prefix="prospect_paging_"))
    db = tmp / "paging.duckdb"
    _build(db)
    with serving(db, pool_size=4):
        yield client


def _walk(c, params: dict, page: int = 25) -> list[int]:
    seen: list[int] = []
    offset = 0
    while True:
        body = c.get("/api/games/search", params={**params, "limit": page, "offset": offset}).json()
        ids = [g["appid"] for g in body["items"]]
        if not ids:
            return seen
        seen.extend(ids)
        offset += page


@pytest.mark.parametrize(
    "sort,order",
    [
        ("release_date", "desc"),
        ("release_year", "desc"),
        ("price_initial", "asc"),
        ("total_reviews", "desc"),
        ("est_rev_reviews", "desc"),
    ],
)
def test_walking_every_page_of_a_tie_heavy_sort_returns_each_game_once(tie_heavy_client, sort, order):
    params = {"released_after": 2026, "sort": sort, "order": order}
    total = tie_heavy_client.get("/api/games/search", params={**params, "limit": 1}).json()["total"]
    assert total == TIED
    for _ in range(2):  # and the same walk twice gives the same sequence
        seen = _walk(tie_heavy_client, params)
        assert len(seen) == TIED, f"{len(seen)} rows fetched for total={TIED}"
        assert len(set(seen)) == TIED, f"{len(seen) - len(set(seen))} duplicates across pages"
    # The tie is broken by the unique key, ascending.
    assert seen == sorted(seen)


def _build_niches(path: Path, n: int) -> None:
    """A mart_niche cut of `n` niches in a handful of TIE GROUPS on n_games and
    opportunity_v2 — on the real mart the n_games sort paged two niches twice at only 2.4K
    rows: DuckDB's top-N breaks ties differently for different LIMIT/OFFSET, so one row
    group is enough. (All-equal keys do NOT reproduce it; interleaved tie groups do — 17-24
    duplicates over these 150 rows with the old `n_games DESC` tail.)"""
    from app.routers import niches

    con = duckdb.connect(str(path))
    try:
        decls = []
        for c in niches._BASE_COLS:
            if c in ("dimension", "key", "win", "tier"):
                decls.append(f'"{c}" VARCHAR')
            elif c in ("min_reviews", "n_games", "n_recent", "n_recent_year", "n_prior_year"):
                decls.append(f'"{c}" INTEGER')
            else:
                decls.append(f'"{c}" DOUBLE')
        con.execute(f"CREATE TABLE mart_niche ({', '.join(decls)})")
        con.execute(
            "INSERT INTO mart_niche (dimension, key, win, min_reviews, n_games, n_recent, tier, "
            "opportunity_v2) SELECT 'tag', 'Niche ' || lpad(CAST(range AS VARCHAR), 4, '0'), "
            f"'24m', 50, 20 + CAST(hash(range) % 7 AS INTEGER), 3, 'micro', "
            f"50.0 + CAST(hash(range + 1) % 5 AS DOUBLE) FROM range({n})"
        )
        con.execute("CREATE TABLE mart_meta (key VARCHAR, value VARCHAR)")
        con.execute("INSERT INTO mart_meta VALUES ('mart_version', 'niche-paging-fixture')")
    finally:
        con.close()


@pytest.mark.parametrize("sort", ["n_games", "opportunity_v2"])
def test_walking_the_niche_list_returns_each_niche_once(client, tmp_path, sort):
    db = tmp_path / "niche_paging.duckdb"
    _build_niches(db, 150)
    with serving(db):
        rows: list[dict] = []
        for offset in range(0, 150, 20):
            body = client.get(
                "/api/niches", params={"sort": sort, "limit": 20, "offset": offset}
            ).json()
            assert body["total"] == 150
            rows.extend(body["items"])
    seen = [r["key"] for r in rows]
    assert len(seen) == 150
    assert len(set(seen)) == 150, f"{len(seen) - len(set(seen))} duplicates across pages"
    # A total order: (sort desc, n_games desc, key asc) — ties broken by the cut's key.
    expected = sorted(rows, key=lambda r: (-r[sort], -r["n_games"], r["key"]))
    assert seen == [r["key"] for r in expected]


def test_order_by_always_ends_in_the_unique_key():
    assert paging.order_by("x DESC NULLS LAST", "y DESC", unique=("appid",)) == (
        "ORDER BY x DESC NULLS LAST, y DESC, appid ASC"
    )
    assert paging.order_by("x ASC", unique=("dimension", "key", "win", "min_reviews")) == (
        "ORDER BY x ASC, dimension ASC, key ASC, win ASC, min_reviews ASC"
    )
    with pytest.raises(ValueError):
        paging.order_by("x ASC", unique=())

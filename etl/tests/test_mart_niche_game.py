"""Population parity between mart_niche and mart_niche_game — enforced, not remembered.

mart_niche publishes n_games; the niche drill-down charts the games behind that number. If the two
populations ever differ, the chart contradicts the headline directly above it — plausible, wrong,
and invisible to everyone. Both marts now read one shared _niche_pop table so that cannot happen by
divergent predicates, but a wrong JOIN key or a stray filter still could, which is what this guards.

Runs on a synthetic staging layer in an in-memory DuckDB and renders the REAL .sql files through
build_marts.render()/build_params(), so it fails on the files that actually ship rather than on a
copy of them. No source database and no network needed.
"""
from __future__ import annotations

import sys
from datetime import date, timedelta
from pathlib import Path

REPO = Path("/Users/maximbaginskiy/hobby/prospect")
ETL = REPO / "etl"
sys.path.insert(0, str(ETL))

import duckdb  # noqa: E402
import build_marts as bm  # noqa: E402

TODAY = date.today()


def months_ago(n: int) -> date:
    """Approximate month arithmetic (30.44d) — good enough for fixture recency buckets."""
    return TODAY - timedelta(days=int(round(n * 30.44)))


# --------------------------------------------------------------------------------------
# Fixture catalog. 200 games, deterministic index-based attributes chosen so that the
# review floors (0/50/100) and the 24m window each split the population, and so that some
# (dimension, key, win, min_reviews) cuts land above MIN_NICHE_GAMES (published by
# mart_niche) and some below (never published).
# --------------------------------------------------------------------------------------
REVIEW_LADDER = [0, 3, 25, 49, 50, 51, 75, 99, 100, 101, 300, 2000]
PRICE_LADDER = [0.0, 4.99, 9.99, 19.99, 29.99]

games = []
tag_rows = []
genre_rows = []

for i in range(200):
    appid = 1000 + i
    total_reviews = REVIEW_LADDER[i % 12]
    price = PRICE_LADDER[i % 5]

    # est_rev_reviews IS NULL for ~6% of games -> exercises mart_niche's NOT NULL filter.
    est_rev = None if i % 17 == 0 else float(total_reviews) * 30.0 * price

    # Release dates: a recent bucket (inside 24m), an old bucket, plus two invalid shapes
    # (NULL date, future date) that release_valid must reject.
    if i % 29 == 0:
        release_date = None
    elif i % 31 == 0:
        release_date = TODAY + timedelta(days=30)          # unreleased -> release_valid False
    elif i % 3 != 2:
        release_date = months_ago(i % 23)                   # 0..22 months ago -> recent
    else:
        release_date = months_ago(30 + (i % 100))           # 30..129 months ago -> not recent

    release_valid = (
        release_date is not None
        and release_date <= TODAY
        and release_date >= date(1997, 1, 1)
    )
    release_year = release_date.year if release_date is not None else None

    games.append(
        dict(
            appid=appid,
            name=f"Fixture Game {i}",
            release_year=release_year,
            release_date=release_date,
            release_valid=release_valid,
            price_initial=price,
            positive_ratio=0.5 + (i % 50) / 100.0,
            owners_mid=float(total_reviews * 30),
            total_reviews=total_reviews,
            est_rev_reviews=est_rev,
            self_published=bool(i % 4 == 0),
            is_singleplayer=bool(i % 7 != 0),
            review_count_source="steamspy",
        )
    )

    # --- tag membership (DISTINCT (appid, tag), like stg_tag_membership) ---
    if i % 2 == 0:
        tag_rows.append((appid, "Colony Sim"))     # 100 games
    if i % 3 == 0:
        tag_rows.append((appid, "Cozy"))           # 67 games
    if i < 12:
        tag_rows.append((appid, "Naval"))          # 12 games -> below MIN_NICHE_GAMES
    if i % 5 == 0:
        tag_rows.append((appid, "Deckbuilding"))   # 40 games
    if i % 11 == 0:
        tag_rows.append((appid, "Sokoban"))        # 19 games -> below MIN_NICHE_GAMES

    # --- genre membership ---
    genre_rows.append((appid, "Indie"))            # 200 games
    if i % 4 == 0:
        genre_rows.append((appid, "Strategy"))     # 50 games
    if i < 5:
        genre_rows.append((appid, "Racing"))       # 5 games -> below MIN_NICHE_GAMES


def main() -> int:
    con = duckdb.connect(":memory:")

    # `src` is the attached SQLite source in the real ETL; mart_niche_top LEFT JOINs
    # src.games for header_image, so the fixture needs it to exist.
    con.execute("CREATE SCHEMA src")
    con.execute("CREATE TABLE src.games(appid INTEGER, header_image VARCHAR)")
    con.executemany(
        "INSERT INTO src.games VALUES (?, ?)",
        [(g["appid"], f"http://img/{g['appid']}.jpg") for g in games],
    )

    # ---- staging tables the two marts read (TEMP, exactly as create_staging() makes them)
    con.execute("CREATE TEMP TABLE stg_tag_membership(appid INTEGER, tag VARCHAR)")
    con.executemany("INSERT INTO stg_tag_membership VALUES (?, ?)", tag_rows)

    con.execute("CREATE TEMP TABLE stg_genre_membership(appid INTEGER, genre VARCHAR)")
    con.executemany("INSERT INTO stg_genre_membership VALUES (?, ?)", genre_rows)

    con.execute(
        """
        CREATE TEMP TABLE stg_game(
            appid INTEGER, name VARCHAR, release_year INTEGER, release_date DATE,
            release_valid BOOLEAN, price_initial DOUBLE, positive_ratio DOUBLE,
            owners_mid DOUBLE, total_reviews BIGINT, est_rev_reviews DOUBLE,
            self_published BOOLEAN, is_singleplayer BOOLEAN, review_count_source VARCHAR)
        """
    )
    con.executemany(
        "INSERT INTO stg_game VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
        [
            (
                g["appid"], g["name"], g["release_year"], g["release_date"],
                g["release_valid"], g["price_initial"], g["positive_ratio"],
                g["owners_mid"], g["total_reviews"], g["est_rev_reviews"],
                g["self_published"], g["is_singleplayer"], g["review_count_source"],
            )
            for g in games
        ],
    )

    con.execute("CREATE TEMP TABLE tag_tier(tag VARCHAR, tier VARCHAR)")
    con.executemany("INSERT INTO tag_tier VALUES (?, ?)", list(bm.TAG_TIER.items()))

    # TEMPs mart_players.sql normally supplies; mart_niche LEFT JOINs them, so empty is fine.
    con.execute(
        """
        CREATE TEMP TABLE _niche_players_now(
            dimension VARCHAR, key VARCHAR, total_players_now BIGINT,
            players_coverage DOUBLE, players_trend_7d_pct DOUBLE,
            median_players_now DOUBLE, players_top5_share DOUBLE)
        """
    )
    con.execute(
        """
        CREATE TEMP TABLE _niche_lifetime(
            dimension VARCHAR, key VARCHAR, lifetime_n_games BIGINT,
            lifetime_survival_12m DOUBLE, lifetime_median_dead_months DOUBLE)
        """
    )

    # ---- render + execute through the REAL renderer -----------------------------------
    params = bm.build_params()
    for fname in ("mart_niche.sql", "mart_niche_game.sql"):
        sql = bm.render((ETL / "marts" / fname).read_text(), params)
        con.execute(sql)
        print(f"[fixture] executed {fname}")

    print()
    print(f"[fixture] games={len(games)}  tag_rows={len(tag_rows)}  genre_rows={len(genre_rows)}")
    print(f"[fixture] MIN_NICHE_GAMES={bm.MIN_NICHE_GAMES}  "
          f"MIN_REVIEWS_LEVELS={bm.MIN_REVIEWS_LEVELS}  RECENT_MONTHS={bm.RECENT_MONTHS}")

    # ---- 1. contract: exact columns, exact types --------------------------------------
    schema = con.execute(
        "SELECT column_name, data_type FROM information_schema.columns "
        "WHERE table_name = 'mart_niche_game' ORDER BY ordinal_position"
    ).fetchall()
    print("\n[schema] mart_niche_game")
    for name, dtype in schema:
        print(f"           {name:<12} {dtype}")
    expected = [
        ("dimension", "VARCHAR"), ("key", "VARCHAR"), ("win", "VARCHAR"),
        ("min_reviews", "INTEGER"), ("appid", "INTEGER"),
    ]
    assert schema == expected, f"schema mismatch: {schema} != {expected}"
    print("[ok] schema matches the contract exactly")

    n_rows = con.execute("SELECT COUNT(*) FROM mart_niche_game").fetchone()[0]
    n_niche = con.execute("SELECT COUNT(*) FROM mart_niche").fetchone()[0]
    print(f"\n[rows] mart_niche      = {n_niche:,} groups")
    print(f"[rows] mart_niche_game = {n_rows:,} membership rows")

    # ---- 2. HARD INVARIANT: per-group count == mart_niche.n_games ---------------------
    mismatches = con.execute(
        """
        SELECT n.dimension, n.key, n.win, n.min_reviews,
               n.n_games, COALESCE(g.c, 0) AS mart_niche_game_count
        FROM mart_niche n
        LEFT JOIN (
            SELECT dimension, key, win, min_reviews, COUNT(*) AS c
            FROM mart_niche_game GROUP BY 1,2,3,4
        ) g ON g.dimension = n.dimension AND g.key = n.key
           AND g.win = n.win AND g.min_reviews = n.min_reviews
        WHERE COALESCE(g.c, 0) <> n.n_games
        """
    ).fetchall()
    print(f"\n[INVARIANT] groups in mart_niche whose count(*) != n_games: {len(mismatches)}")
    for row in mismatches[:20]:
        print("            MISMATCH", row)
    assert not mismatches, "HARD INVARIANT VIOLATED"
    print("[ok] every mart_niche group's membership count equals its n_games")

    # ---- 3. reverse direction: no unpublished group leaks in --------------------------
    orphans = con.execute(
        """
        SELECT g.dimension, g.key, g.win, g.min_reviews, COUNT(*)
        FROM mart_niche_game g
        LEFT JOIN mart_niche n
               ON n.dimension = g.dimension AND n.key = g.key
              AND n.win = g.win AND n.min_reviews = g.min_reviews
        WHERE n.key IS NULL
        GROUP BY 1,2,3,4
        """
    ).fetchall()
    print(f"[INVARIANT] groups in mart_niche_game absent from mart_niche: {len(orphans)}")
    for row in orphans[:20]:
        print("            ORPHAN", row)
    assert not orphans, "mart_niche_game published a cut mart_niche did not"
    print("[ok] group sets are identical in both directions")

    # ---- 4. uniqueness of (group, appid) ----------------------------------------------
    dupes = con.execute(
        "SELECT COUNT(*) FROM (SELECT dimension, key, win, min_reviews, appid "
        "FROM mart_niche_game GROUP BY 1,2,3,4,5 HAVING COUNT(*) > 1)"
    ).fetchone()[0]
    print(f"[INVARIANT] duplicate (dimension,key,win,min_reviews,appid) rows: {dupes}")
    assert dupes == 0
    print("[ok] one row per (group, appid)")

    # ---- 5. the fixture actually exercises the interesting cases ----------------------
    cuts = con.execute(
        "SELECT win, min_reviews, COUNT(*) AS n_groups, SUM(n_games) AS sum_n_games "
        "FROM mart_niche GROUP BY 1,2 ORDER BY 1,2"
    ).fetchall()
    print("\n[cuts published by mart_niche]  win / min_reviews / groups / sum(n_games)")
    for row in cuts:
        print(f"           {row[0]:<4} {row[1]:>4}   {row[2]:>3}   {row[3]:>6}")
    wins_seen = {r[0] for r in cuts}
    mrs_seen = {r[1] for r in cuts}
    assert wins_seen == {"all", "24m"}, f"fixture never exercised both windows: {wins_seen}"
    assert mrs_seen == set(bm.MIN_REVIEWS_LEVELS), f"fixture missed a review floor: {mrs_seen}"
    print("[ok] fixture spans both windows and all three min_reviews floors")

    below_floor = con.execute(
        "SELECT DISTINCT key FROM mart_niche_game WHERE key IN ('Naval','Sokoban','Racing')"
    ).fetchall()
    print(f"\n[gate] below-MIN_NICHE_GAMES niches present in mart_niche_game: {below_floor}")
    assert not below_floor, "a niche under MIN_NICHE_GAMES leaked into mart_niche_game"
    print("[ok] niches under MIN_NICHE_GAMES (Naval=12, Sokoban=19, Racing=5) are absent")

    # ---- 6. per-group detail, so the parity is visible, not just asserted -------------
    detail = con.execute(
        """
        SELECT n.dimension, n.key, n.win, n.min_reviews, n.n_games, COUNT(g.appid) AS members
        FROM mart_niche n
        JOIN mart_niche_game g
          ON g.dimension = n.dimension AND g.key = n.key
         AND g.win = n.win AND g.min_reviews = n.min_reviews
        GROUP BY 1,2,3,4,5
        ORDER BY n.dimension, n.key, n.win, n.min_reviews
        """
    ).fetchall()
    print("\n[detail] dimension / key / win / min_reviews / n_games / members")
    for row in detail:
        flag = "OK " if row[4] == row[5] else "BAD"
        print(f"           {flag} {row[0]:<6} {row[1]:<13} {row[2]:<4} {row[3]:>4} "
              f"{row[4]:>6} {row[5]:>8}")

    # ---- 7. contrast: the top_tags-style shortcut this mart replaces ------------------
    # (mart_game.top_tags is capped at TOP_TAGS_PER_GAME; here we show the *unfiltered*
    #  membership count, i.e. what "filter games by tag" gives without the eligibility
    #  filters mart_niche applies — proving the two are not interchangeable.)
    naive = con.execute(
        """
        SELECT n.key, n.n_games AS niche_n_games,
               (SELECT COUNT(*) FROM stg_tag_membership t WHERE t.tag = n.key) AS naive_tag_count
        FROM mart_niche n
        WHERE n.dimension = 'tag' AND n.win = 'all' AND n.min_reviews = ?
        ORDER BY n.key
        """,
        [bm.MIN_REVIEWS_DEFAULT],
    ).fetchall()
    print("\n[contrast] tag / mart_niche.n_games (all,%d) / naive tag-filter count"
          % bm.MIN_REVIEWS_DEFAULT)
    for key, n_games, naive_n in naive:
        print(f"           {key:<13} {n_games:>6} {naive_n:>8}   "
              f"coverage={naive_n / n_games:.1%}")

    print("\n[PASS] mart_niche_game satisfies the population-parity contract.")
    con.close()
    return 0


def test_mart_niche_game_population_parity():
    """pytest entry point; main() asserts internally and returns 0 only when every check passed."""
    assert main() == 0


if __name__ == "__main__":
    raise SystemExit(main())

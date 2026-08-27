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

# Derived from this file's own location (tests/ lives inside etl/) — a hardcoded absolute
# path here passed locally and failed every CI run with FileNotFoundError.
ETL = Path(__file__).resolve().parents[1]
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
            # Solo-evidence inputs (mart_niche's evidence trio). Both carry NULLs on
            # deliberately different cycles so the NULL-honest AVG/median paths are
            # exercised (NULL must be skipped, never counted as 0).
            is_indie=(None if i % 19 == 0 else bool(i % 3 != 0)),
            playtime_p50=(None if i % 13 == 0 else float(30 + (i % 40) * 17)),  # minutes
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
    if i % 3 == 0 and i % 29 != 0 and i % 31 != 0:
        # "Organizing": the young-tag shape (~62 games, ALL on the recent release branch —
        # i%3==0 lands in months_ago(0..22), and the %29/%31 invalid-date shapes are kept
        # out). Every review lands in reviews_24m_new_share's numerator -> share = 1.0 ->
        # demand_emerging fires via the new-mass tell ALONE (its prev-window base, 60 per
        # member game, is well above DEMAND_MIN_BASE) — see check 1d.
        tag_rows.append((appid, "Organizing"))

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
    # mart_niche.sql's 24-month demand windows read stg_review_histogram (Steam's true
    # monthly counts — see the mart's SOURCE note: the sampled stg_review inflated the
    # trend ~10-350x per game). Shape mirrors create_timing_staging().
    con.execute(
        "CREATE TEMP TABLE stg_review_histogram("
        "appid INTEGER, period_month DATE, n_reviews BIGINT, n_positive BIGINT)"
    )
    con.executemany("INSERT INTO stg_tag_membership VALUES (?, ?)", tag_rows)

    con.execute("CREATE TEMP TABLE stg_genre_membership(appid INTEGER, genre VARCHAR)")
    con.executemany("INSERT INTO stg_genre_membership VALUES (?, ?)", genre_rows)

    con.execute(
        """
        CREATE TEMP TABLE stg_game(
            appid INTEGER, name VARCHAR, release_year INTEGER, release_date DATE,
            release_valid BOOLEAN, price_initial DOUBLE, positive_ratio DOUBLE,
            owners_mid DOUBLE, total_reviews BIGINT, est_rev_reviews DOUBLE,
            self_published BOOLEAN, is_singleplayer BOOLEAN, is_indie BOOLEAN,
            review_count_source VARCHAR)
        """
    )
    con.executemany(
        "INSERT INTO stg_game VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        [
            (
                g["appid"], g["name"], g["release_year"], g["release_date"],
                g["release_valid"], g["price_initial"], g["positive_ratio"],
                g["owners_mid"], g["total_reviews"], g["est_rev_reviews"],
                g["self_published"], g["is_singleplayer"], g["is_indie"],
                g["review_count_source"],
            )
            for g in games
        ],
    )

    # mart_game stand-in: in the real run mart_game.sql builds BEFORE mart_niche.sql
    # (MART_FILES order) and mart_niche LEFT JOINs it for playtime_p50 (the solo-evidence
    # med_playtime_h input). Only the joined columns are needed here.
    con.execute("CREATE TABLE mart_game(appid INTEGER, playtime_p50 DOUBLE)")
    con.executemany(
        "INSERT INTO mart_game VALUES (?, ?)",
        [(g["appid"], g["playtime_p50"]) for g in games],
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

    # Six histogram rows per game, chosen to pin every edge of the two 24-month windows on
    # paper (anchor = base - 1 month, where base = the global max period month):
    #   base month       999 reviews -> EXCLUDED (the truncated-at-fetch anchor+1 month)
    #   base - 1          30 reviews -> inside now  (anchor-24 .. anchor], newest month
    #   base - 24         60 reviews -> inside now, OLDEST now month (the boundary)
    #   base - 25         45 reviews -> inside prev (anchor-48 .. anchor-24], newest month
    #   base - 48         15 reviews -> inside prev, OLDEST prev month (the boundary)
    #   base - 49        777 reviews -> EXCLUDED (older than the prev window)
    # => per niche: reviews_24m = 90 * n, reviews_prev_24m = 60 * n, trend = +50.0,
    #    where n = the (dimension, key) FULL membership count (see check 1b).
    con.execute("""INSERT INTO stg_review_histogram
        SELECT appid, date_trunc('month', CURRENT_DATE), 999, 500 FROM stg_game
        UNION ALL
        SELECT appid, date_trunc('month', CURRENT_DATE) - INTERVAL 1 MONTH, 30, 20 FROM stg_game
        UNION ALL
        SELECT appid, date_trunc('month', CURRENT_DATE) - INTERVAL 24 MONTH, 60, 40 FROM stg_game
        UNION ALL
        SELECT appid, date_trunc('month', CURRENT_DATE) - INTERVAL 25 MONTH, 45, 30 FROM stg_game
        UNION ALL
        SELECT appid, date_trunc('month', CURRENT_DATE) - INTERVAL 48 MONTH, 15, 10 FROM stg_game
        UNION ALL
        SELECT appid, date_trunc('month', CURRENT_DATE) - INTERVAL 49 MONTH, 777, 500 FROM stg_game""")

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

    # ---- 1b. demand windows read the histogram with the documented anchor -------------
    # The fixture put 999 reviews in the anchor-excluded truncated month and 777 in the
    # month just past the prev window's far edge; if either leaks into a window the month
    # arithmetic regressed. The 24m demand columns are CUT-INDEPENDENT (see
    # _niche_demand24m's header in mart_niche.sql): every (win, min_reviews) cut of a
    # (dimension, key) carries the same numbers, computed over the FULL membership — the
    # (win='all', min_reviews=0) superset population — so the expected value is 90/60 per
    # game of that cut's n_games, on EVERY cut, and trend is +50.0 everywhere.
    n_niche_rows = con.execute("SELECT COUNT(*) FROM mart_niche").fetchone()[0]
    joined = con.execute("""
        WITH n0 AS (
            SELECT dimension, key, n_games FROM mart_niche
            WHERE win = 'all' AND min_reviews = 0
        )
        SELECT COUNT(*),
               COUNT(*) FILTER (
                   WHERE n.reviews_24m != 90 * n0.n_games
                      OR n.reviews_prev_24m != 60 * n0.n_games
                      OR n.demand_trend_24m_pct != 50.0
               )
        FROM mart_niche n
        JOIN n0 ON n0.dimension = n.dimension AND n0.key = n.key
    """).fetchone()
    # The JOIN itself is part of the check: every published cut must have a published
    # (all, 0) sibling (its population is a superset of every cut), so nothing may drop out.
    assert joined[0] == n_niche_rows, (
        f"{n_niche_rows - joined[0]} cut(s) have no published (win='all', min_reviews=0) sibling"
    )
    assert joined[1] == 0, f"{joined[1]} niche cut(s) have demand windows off the histogram fixture"
    print("[ok] demand_24m: histogram-sourced, both window edges exact, full-membership population, trend = +50.0")

    # ---- 1c. cut independence: neither the floor NOR the window may move demand -------
    # Two Radar-board regressions this pins down. Floor: a min_reviews toggle used to
    # shrink "demand" (a different population summed), which could flip a niche's
    # client-side verdict ring. Window: the win='24m' population holds only games
    # released in the last 24 months, so NO member can have inflow in the prior-24m
    # window — a per-win join would NULL out the board's pinned 24m cut entirely.
    # Demand is a property of (dimension, key), full stop.
    multi_cut = con.execute("""
        SELECT COUNT(*) FROM (
            SELECT dimension, key FROM mart_niche
            GROUP BY 1, 2 HAVING COUNT(*) > 1
        )
    """).fetchone()[0]
    assert multi_cut > 0, "fixture lost its teeth: no (dimension, key) spans several cuts"
    varying = con.execute("""
        SELECT dimension, key FROM mart_niche
        GROUP BY 1, 2
        HAVING COUNT(DISTINCT COALESCE(reviews_24m, -1)) > 1
            OR COUNT(DISTINCT COALESCE(reviews_prev_24m, -1)) > 1
            OR COUNT(DISTINCT COALESCE(demand_trend_24m_pct, -1e18)) > 1
            OR COUNT(DISTINCT COALESCE(reviews_24m_new_share, -1)) > 1
            OR COUNT(DISTINCT COALESCE(CAST(demand_emerging AS INTEGER), -1)) > 1
    """).fetchall()
    for row in varying[:10]:
        print("            CUT-DEPENDENT DEMAND", row)
    assert not varying, f"{len(varying)} (dimension, key) group(s) vary demand by cut"
    print(f"[ok] demand identical across every (win, min_reviews) cut for every niche ({multi_cut} multi-cut groups checked)")

    # ---- 1d. emerging pair: self-consistent, and both tells behave --------------------
    # demand_emerging must be exactly the documented two-tell rule REPLAYED OVER THE
    # MART'S OWN PUBLISHED COLUMNS (never NULL, share in [0,1]) — so a drive-by edit to
    # the SQL can't quietly decouple the flag from the numbers it claims to summarise.
    bad_emerging = con.execute(f"""
        SELECT COUNT(*) FROM mart_niche
        WHERE demand_emerging IS NULL
           OR (reviews_24m_new_share IS NOT NULL
               AND (reviews_24m_new_share < 0 OR reviews_24m_new_share > 1))
           OR demand_emerging != (
                  reviews_prev_24m < {bm.DEMAND_MIN_BASE}
                  OR COALESCE(reviews_24m_new_share >= {bm.DEMAND_NEW_MASS_SHARE}, FALSE)
              )
    """).fetchone()[0]
    assert bad_emerging == 0, f"{bad_emerging} row(s) break the demand_emerging two-tell rule"
    # "Organizing" is the young-tag fixture: every member on the recent release branch, so
    # the new-mass tell fires ALONE (share = 1.0) while its prev base clears the floor —
    # proving the OR is real, not just the small-base clause. "Colony Sim" spans old and
    # new releases (share ~0.63) with a big base: emerging must stay FALSE, and its trend
    # must stay COMPUTED (the flag never suppresses the raw columns).
    org = con.execute(f"""
        SELECT demand_emerging, reviews_24m_new_share, reviews_prev_24m >= {bm.DEMAND_MIN_BASE}
        FROM mart_niche WHERE dimension = 'tag' AND key = 'Organizing' LIMIT 1
    """).fetchone()
    assert org is not None, "'Organizing' (the emerging fixture tag) was not published"
    assert org == (True, 1.0, True), f"Organizing emerging tell broke: {org}"
    colony = con.execute("""
        SELECT demand_emerging, demand_trend_24m_pct
        FROM mart_niche WHERE dimension = 'tag' AND key = 'Colony Sim' LIMIT 1
    """).fetchone()
    assert colony == (False, 50.0), f"Colony Sim must be non-emerging with a computed trend: {colony}"
    print("[ok] demand_emerging: two-tell rule replayed exactly; new-mass tell fires alone on 'Organizing'")

    # ---- 1e. solo-evidence trio: same population as the cut, NULL-honest, hours --------
    # self_published_share / indie_share / med_playtime_h claim to describe the SAME
    # per-cut population solo_viability is computed over. Replay them over mart_niche_game
    # (the published membership — exactly that population, by the parity invariant below)
    # joined back to the inputs, and compare per cut. Tolerance because the replay's
    # aggregation order can differ; NULL-vs-value mismatches are exact.
    bad_evidence = con.execute("""
        WITH replay AS (
            SELECT g.dimension, g.key, g.win, g.min_reviews,
                   AVG(CAST(sg.self_published AS DOUBLE)) AS sp,
                   AVG(CAST(sg.is_indie AS DOUBLE)) AS ind,
                   round(median(mg.playtime_p50) / 60.0, 1) AS mph
            FROM mart_niche_game g
            JOIN stg_game sg ON sg.appid = g.appid
            LEFT JOIN mart_game mg ON mg.appid = g.appid
            GROUP BY 1, 2, 3, 4
        )
        SELECT COUNT(*) FROM mart_niche n
        JOIN replay r ON r.dimension = n.dimension AND r.key = n.key
                     AND r.win = n.win AND r.min_reviews = n.min_reviews
        WHERE (n.self_published_share IS NULL) != (r.sp IS NULL)
           OR ABS(COALESCE(n.self_published_share, 0) - COALESCE(r.sp, 0)) > 1e-9
           OR (n.indie_share IS NULL) != (r.ind IS NULL)
           OR ABS(COALESCE(n.indie_share, 0) - COALESCE(r.ind, 0)) > 1e-9
           OR (n.med_playtime_h IS NULL) != (r.mph IS NULL)
           OR ABS(COALESCE(n.med_playtime_h, 0) - COALESCE(r.mph, 0)) > 1e-9
    """).fetchone()[0]
    assert bad_evidence == 0, f"{bad_evidence} cut(s) have solo-evidence columns off their own membership"
    # The alias contract: self_published_share is self_pub_share under the evidence name —
    # one computation in the SQL, so the two columns must be bit-identical everywhere.
    alias_drift = con.execute(
        "SELECT COUNT(*) FROM mart_niche WHERE self_published_share IS DISTINCT FROM self_pub_share"
    ).fetchone()[0]
    assert alias_drift == 0, f"{alias_drift} row(s) drift between self_published_share and self_pub_share"
    # NULL-honesty has teeth: the fixture carries NULL is_indie / playtime_p50 rows, and
    # every published cut still aggregates over enough non-NULL members to publish a
    # value — while the units check pins hours (round(min/60, 1)), not raw minutes.
    ev = con.execute("""
        SELECT COUNT(*),
               COUNT(*) FILTER (WHERE indie_share IS NULL OR med_playtime_h IS NULL),
               MAX(med_playtime_h)
        FROM mart_niche
    """).fetchone()
    assert ev[1] == 0, f"{ev[1]} cut(s) unexpectedly NULLed an evidence column (fixture has non-NULL members everywhere)"
    max_minutes = 30 + 39 * 17  # the fixture's largest playtime_p50, in minutes
    assert ev[2] is not None and ev[2] <= round(max_minutes / 60.0, 1), (
        f"med_playtime_h {ev[2]} exceeds the fixture's max possible HOURS value — minutes leaked through"
    )
    print("[ok] solo-evidence trio: membership-replayed exactly, alias in lockstep, hours not minutes")

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

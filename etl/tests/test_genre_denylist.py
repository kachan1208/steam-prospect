"""Genre denylist invariant — release-state/monetization labels are not genres.

Steam's appdetails `genres` field ships 'Early Access' and 'Free To Play' alongside real
genres; the niche radar surfaced "Early Access" as a genre in the verdict rail
(user-reported 2026-08-28). The fix lives at the STAGING source (DENYLIST_GENRE ->
stg_genre_membership / stg_primary_genre in build_marts.py's create_staging()), so every
consumer benefits at once. This test runs the REAL create_staging() over a synthetic src
schema that deliberately carries the denylisted labels ABOVE the publish floor, then the
real mart_niche.sql on top, and asserts:

  1. stg_genre_membership never contains a denylisted label (case-insensitive).
  2. stg_primary_genre never yields one, AND excluding them never DROPS a game: a mixed
     game keeps its best remaining real genre, a game whose ONLY genre was 'Early Access'
     is still in stg_game with no primary-genre row (-> honest NULL downstream, every
     consumer LEFT JOINs stg_primary_genre or filters IS NOT NULL).
  3. The built mart_niche has no dimension='genre' rows for denylisted labels — with
     teeth: the fixture gives each label >= MIN_NICHE_GAMES qualifying members, so before
     the denylist landed these niches WOULD have published.

No source database and no network needed (same pattern as test_mart_niche_game.py).
"""
from __future__ import annotations

import sys
from datetime import date, timedelta
from pathlib import Path

# Derived from this file's own location (tests/ lives inside etl/).
ETL = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ETL))

import duckdb  # noqa: E402
import build_marts as bm  # noqa: E402

TODAY = date.today()

# The labels this change denylists (exact source spellings: the genres field says
# 'Early Access' / 'Free To Play'; 'Free to Play' is the defensive cross-field variant).
NON_GENRE_LABELS = ["Early Access", "Free To Play", "Free to Play"]

# Fixture appids ------------------------------------------------------------------------
BASE_APPIDS = list(range(5000, 5080))     # 80 games, Indie + rotating genre mix
EA_ONLY_APPIDS = [5100, 5101, 5102, 5103, 5104]  # ONLY genre = 'Early Access'
MIXED_A = 5200   # Early Access + Free To Play + Action  -> primary must be 'Action'
MIXED_B = 5201   # Early Access + Indie                  -> primary must be 'Indie'
MIXED_C = 5202   # Early Access + Indie + Action         -> primary must be 'Action'


def build_genre_rows() -> list[tuple[int, str]]:
    rows: list[tuple[int, str]] = []
    for i, appid in enumerate(BASE_APPIDS):
        rows.append((appid, "Indie"))
        if i % 2 == 0:
            rows.append((appid, "Strategy"))       # 40 games -> publishes in mart_niche
        if i % 4 != 3:
            rows.append((appid, "Early Access"))   # 60 games -> would publish w/o denylist
        if i % 2 == 1:
            rows.append((appid, "Free To Play"))   # 40 games (source spelling)
        if i % 2 == 0:
            rows.append((appid, "Free to Play"))   # 40 games (case-variant spelling)
    for appid in EA_ONLY_APPIDS:
        rows.append((appid, "Early Access"))
    rows += [
        (MIXED_A, "Early Access"), (MIXED_A, "Free To Play"), (MIXED_A, "Action"),
        (MIXED_B, "Early Access"), (MIXED_B, "Indie"),
        (MIXED_C, "Early Access"), (MIXED_C, "Indie"), (MIXED_C, "Action"),
    ]
    return rows


def main() -> int:
    all_appids = BASE_APPIDS + EA_ONLY_APPIDS + [MIXED_A, MIXED_B, MIXED_C]
    release = TODAY - timedelta(days=200)  # recent -> both 'all' and '24m' windows

    con = duckdb.connect(":memory:")
    con.execute("CREATE SCHEMA src")

    # ---- the six src tables create_staging() reads ------------------------------------
    con.execute(
        "CREATE TABLE src.games(appid INTEGER, name VARCHAR, type VARCHAR,"
        " release_date VARCHAR, price_initial INTEGER, is_free BOOLEAN,"
        " developers VARCHAR, publishers VARCHAR, metacritic_score INTEGER,"
        " achievements_count INTEGER, categories VARCHAR, header_image VARCHAR)"
    )
    con.executemany(
        "INSERT INTO src.games VALUES (?, ?, 'game', NULL, 999, FALSE,"
        " 'FixtureDev', 'FixtureDev', NULL, NULL, 'Single-player', ?)",
        [(a, f"Fixture Game {a}", f"http://img/{a}.jpg") for a in all_appids],
    )
    con.execute(
        "CREATE TABLE src.analysis_games(appid INTEGER, name VARCHAR, release_year INTEGER,"
        " release_date_iso VARCHAR, price_initial DOUBLE, is_free BOOLEAN,"
        " developers VARCHAR, publishers VARCHAR, self_published BOOLEAN,"
        " dev_game_count INTEGER, is_indie BOOLEAN, metacritic_score INTEGER,"
        " achievements_count INTEGER, owners_mid DOUBLE, est_rev_owners DOUBLE,"
        " avg_playtime_forever DOUBLE, ccu INTEGER, tag_count INTEGER,"
        " total_reviews INTEGER, positive_reviews INTEGER, negative_reviews INTEGER,"
        " positive_ratio DOUBLE)"
    )
    con.executemany(
        "INSERT INTO src.analysis_games VALUES (?, ?, ?, ?, 9.99, FALSE,"
        " 'FixtureDev', 'FixtureDev', TRUE, 1, TRUE, NULL, NULL, 50000.0, 0.0,"
        " 60.0, 5, 3, 200, 150, 50, 0.75)",
        [(a, f"Fixture Game {a}", release.year, release.isoformat()) for a in all_appids],
    )
    con.execute("CREATE TABLE src.game_genres(appid INTEGER, genre VARCHAR)")
    con.executemany("INSERT INTO src.game_genres VALUES (?, ?)", build_genre_rows())
    con.execute("CREATE TABLE src.game_tags(appid INTEGER, tag VARCHAR, votes INTEGER)")
    con.execute(
        "CREATE TABLE src.reviews(appid INTEGER, recommendationid VARCHAR,"
        " voted_up INTEGER, timestamp_created BIGINT, language VARCHAR,"
        " playtime_at_review INTEGER, playtime_forever INTEGER, review_text VARCHAR)"
    )
    con.execute(
        "CREATE TABLE src.review_summary(appid INTEGER, total_reviews INTEGER,"
        " total_positive INTEGER, total_negative INTEGER)"
    )

    # ---- run the REAL staging (this is where the denylist lives) ----------------------
    params = bm.build_params()
    bm.create_staging(con, params)
    print("[fixture] create_staging() executed over synthetic src schema")

    denylisted_lower = {g.lower() for g in bm.DENYLIST_GENRE}

    # ---- teeth: each non-genre label sits ABOVE the publish floor in the SOURCE -------
    for label in NON_GENRE_LABELS:
        assert label in bm.DENYLIST_GENRE, f"{label!r} missing from DENYLIST_GENRE"
        n = con.execute(
            "SELECT COUNT(DISTINCT appid) FROM src.game_genres WHERE genre = ?", [label]
        ).fetchone()[0]
        assert n >= bm.MIN_NICHE_GAMES, (
            f"fixture lost its teeth: only {n} src games carry {label!r} "
            f"(< MIN_NICHE_GAMES={bm.MIN_NICHE_GAMES}) — a leak would not publish anyway"
        )
    print(f"[ok] fixture teeth: every denylisted label has >= {bm.MIN_NICHE_GAMES} source games")

    # ---- 1. stg_genre_membership carries no denylisted label (case-insensitive) -------
    leaked = con.execute(
        "SELECT DISTINCT genre FROM stg_genre_membership WHERE lower(genre) IN "
        "(SELECT lower(genre) FROM denylist_genre) ORDER BY 1"
    ).fetchall()
    assert not leaked, f"denylisted label(s) leaked into stg_genre_membership: {leaked}"
    kept = {r[0] for r in con.execute("SELECT DISTINCT genre FROM stg_genre_membership").fetchall()}
    assert {"Indie", "Strategy", "Action"} <= kept, f"real genres went missing: {sorted(kept)}"
    print(f"[ok] stg_genre_membership: no denylisted labels; real genres kept ({sorted(kept)})")

    # ---- 2. stg_primary_genre: never a denylisted label, never a dropped game ---------
    bad_primary = con.execute(
        "SELECT * FROM stg_primary_genre WHERE lower(primary_genre) IN "
        "(SELECT lower(genre) FROM denylist_genre)"
    ).fetchall()
    assert not bad_primary, f"stg_primary_genre yielded denylisted label(s): {bad_primary}"

    picks = dict(con.execute(
        "SELECT appid, primary_genre FROM stg_primary_genre WHERE appid IN (?, ?, ?)",
        [MIXED_A, MIXED_B, MIXED_C],
    ).fetchall())
    assert picks.get(MIXED_A) == "Action", f"MIXED_A best remaining genre wrong: {picks.get(MIXED_A)}"
    assert picks.get(MIXED_B) == "Indie", f"MIXED_B best remaining genre wrong: {picks.get(MIXED_B)}"
    assert picks.get(MIXED_C) == "Action", f"MIXED_C deprioritization broke: {picks.get(MIXED_C)}"
    print("[ok] stg_primary_genre picks the best REMAINING real genre "
          "(Action over EA/FTP; Indie when it is all that remains; Indie still deprioritized)")

    # EA-only games: no primary-genre row (honest NULL downstream), but NOT dropped —
    # still full members of stg_game.
    ea_only = ",".join(str(a) for a in EA_ONLY_APPIDS)
    n_pg = con.execute(
        f"SELECT COUNT(*) FROM stg_primary_genre WHERE appid IN ({ea_only})"
    ).fetchone()[0]
    assert n_pg == 0, f"{n_pg} Early-Access-only game(s) still got a primary genre"
    n_sg = con.execute(
        f"SELECT COUNT(*) FROM stg_game WHERE appid IN ({ea_only})"
    ).fetchone()[0]
    assert n_sg == len(EA_ONLY_APPIDS), (
        f"excluding 'Early Access' DROPPED games from stg_game: {n_sg}/{len(EA_ONLY_APPIDS)} remain"
    )
    print(f"[ok] {len(EA_ONLY_APPIDS)} Early-Access-only games: in stg_game, no primary genre (NULL downstream)")

    # Completeness: every stg_game game with >= 1 real (non-denylisted) genre has a
    # primary-genre row — the filter removes labels, never games.
    missing = con.execute(
        """
        SELECT COUNT(*) FROM stg_game g
        WHERE EXISTS (
            SELECT 1 FROM src.game_genres gg
            WHERE gg.appid = g.appid
              AND gg.genre NOT IN (SELECT genre FROM denylist_genre)
        )
          AND NOT EXISTS (SELECT 1 FROM stg_primary_genre pg WHERE pg.appid = g.appid)
        """
    ).fetchone()[0]
    assert missing == 0, f"{missing} game(s) with a real genre lack a primary-genre row"
    print("[ok] every game with a real genre kept a primary-genre row")

    # ---- 3. the built mart_niche publishes no denylisted genre niche ------------------
    # Stand-ins mart_niche.sql expects from earlier MART_FILES (same as test_mart_niche_game).
    bm.create_timing_staging(con)  # src.review_histogram absent -> empty typed temp
    con.execute("""INSERT INTO stg_review_histogram
        SELECT appid, date_trunc('month', CURRENT_DATE) - INTERVAL 2 MONTH, 30, 20 FROM stg_game
        UNION ALL
        SELECT appid, date_trunc('month', CURRENT_DATE) - INTERVAL 30 MONTH, 20, 10 FROM stg_game""")
    con.execute("CREATE TABLE mart_game(appid INTEGER, playtime_p50 DOUBLE)")
    con.execute("INSERT INTO mart_game SELECT appid, 120.0 FROM stg_game")
    con.execute(
        "CREATE TEMP TABLE _niche_players_now(dimension VARCHAR, key VARCHAR,"
        " total_players_now BIGINT, players_coverage DOUBLE, players_trend_7d_pct DOUBLE,"
        " median_players_now DOUBLE, players_top5_share DOUBLE)"
    )
    con.execute(
        "CREATE TEMP TABLE _niche_lifetime(dimension VARCHAR, key VARCHAR,"
        " lifetime_n_games BIGINT, lifetime_survival_12m DOUBLE,"
        " lifetime_median_dead_months DOUBLE)"
    )

    sql = bm.render((ETL / "marts" / "mart_niche.sql").read_text(), params)
    con.execute(sql)
    print("[fixture] executed mart_niche.sql over the real staging")

    published = con.execute(
        "SELECT DISTINCT key FROM mart_niche WHERE dimension = 'genre' ORDER BY 1"
    ).fetchall()
    published_keys = {r[0] for r in published}
    print(f"[mart_niche] genre niches published: {sorted(published_keys)}")

    bad_niche = {k for k in published_keys if k.lower() in denylisted_lower}
    assert not bad_niche, f"mart_niche published denylisted genre niche(s): {sorted(bad_niche)}"
    # Positive control — real genres DO publish, so the empty-leak assert cannot pass vacuously.
    assert {"Indie", "Strategy"} <= published_keys, (
        f"positive control failed: real genre niches missing from mart_niche: {sorted(published_keys)}"
    )
    print("[ok] mart_niche: no dimension='genre' rows for denylisted labels; real genres published")

    print("\n[PASS] genre denylist holds at staging and in the built mart_niche.")
    con.close()
    return 0


def test_genre_denylist():
    """pytest entry point; main() asserts internally and returns 0 only when every check passed."""
    assert main() == 0


if __name__ == "__main__":
    raise SystemExit(main())

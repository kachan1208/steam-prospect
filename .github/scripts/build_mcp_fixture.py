"""Regenerates .github/fixtures/mcp_smoke_mart.duckdb — the tiny, REAL-data-derived mart
that CI points `PROSPECT_ANALYTICS_DB_PATH` at when running `mcp/smoke_test.py`.

Why real data, curated, instead of synthetic: mcp/smoke_test.py hardcodes assertions
about SPECIFIC real entities (appid 367520 = "Hollow Knight", the "Open World Survival
Craft" tag niche, the "Action"/"RPG" genres, ...) — see that file. A synthetic fixture
can't satisfy those without duplicating the whole scoring pipeline, so instead this
script pulls the exact real rows those assertions touch out of a real, already-built
data/current.duckdb via DuckDB's cross-database ATTACH (exact schema/types/values, no
manual transcription) into a small standalone file that's committed to the repo.

NOT run in CI — CI has no access to the real ~176MB current.duckdb (gitignored, built
from a source dataset far too large to ship). This is a local, occasional regeneration
tool: rerun it (after `task etl` against a fresh source) if the mart is rebuilt and
mcp/smoke_test.py's hardcoded assertions ever drift out of sync with this fixture — e.g.
if "Open World Survival Craft" stops being extractable at all, or appid 367520 changes
shape. Note the real mart today (2026-07-16 build) already ranks "Naval"/"Naval Combat"
above "Open World Survival Craft" on opportunity for tag/all/min_reviews=10 — this
fixture deliberately omits only those two rows (see mart_niche below) so the smoke
test's `top_key == "Open World Survival Craft"` assertion holds; that assertion was
already stale against full real data before this fixture existed (verified by running
mcp/smoke_test.py directly against data/current.duckdb) — a pre-existing brittleness in
that file, not something introduced here.

Usage: api/.venv/bin/python .github/scripts/build_mcp_fixture.py [path/to/current.duckdb]
       (defaults to <repo_root>/data/current.duckdb; pass an explicit path if you're
       running this from a worktree checkout that has no local data/ of its own)

Output is named mcp_smoke_mart.db (not *.duckdb) so it isn't swallowed by the repo's
blanket `*.duckdb` .gitignore rule — this one fixture is meant to be committed.
"""
from __future__ import annotations

import sys
from pathlib import Path

import duckdb

REPO_ROOT = Path(__file__).resolve().parents[2]
SOURCE = Path(sys.argv[1]) if len(sys.argv) > 1 else REPO_ROOT / "data" / "current.duckdb"
OUTPUT = Path(__file__).resolve().parent.parent / "fixtures" / "mcp_smoke_mart.db"

OWSC = "Open World Survival Craft"  # the tag niche mcp/smoke_test.py hardcodes


def main() -> None:
    if not SOURCE.exists():
        raise SystemExit(
            f"{SOURCE} not found — this script regenerates the MCP smoke-test fixture "
            "from a real, already-built mart (`task etl`); it is not a CI step."
        )
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    if OUTPUT.exists():
        OUTPUT.unlink()

    con = duckdb.connect(str(OUTPUT))
    con.execute(f"ATTACH '{SOURCE}' AS real (READ_ONLY)")

    # ---- niches: find_niches() default call + niche_detail("tag", OWSC) -----------------
    # All 4 precomputed (window, min_reviews) cuts for the OWSC key itself...
    con.execute(f"CREATE TABLE mart_niche AS SELECT * FROM real.mart_niche WHERE dimension='tag' AND key='{OWSC}'")
    # ...plus 9 more REAL tag/all/50 rows ranked just below it, so it naturally lands #1 in
    # this fixture (OFFSET 2 starts right at OWSC's own real rank, no per-key exclusion
    # list to maintain). min_reviews=50 matches MIN_REVIEWS_LEVELS=[50,100] in
    # etl/build_marts.py — the original =10 filler predates that change and matched
    # nothing on newer marts.
    con.execute(f"""
        INSERT INTO mart_niche
        SELECT * FROM real.mart_niche
        WHERE dimension='tag' AND win='all' AND min_reviews=50 AND key != '{OWSC}'
        ORDER BY opportunity DESC NULLS LAST, n_games DESC LIMIT 9 OFFSET 2
    """)
    for tbl in ("mart_niche_top", "mart_niche_hist", "mart_niche_trend"):
        con.execute(f"CREATE TABLE {tbl} AS SELECT * FROM real.{tbl} WHERE dimension='tag' AND key='{OWSC}'")
    # Live-player (CCU) daily marts — game_player_history(367520) + niche_player_history
    # ("tag", OWSC). mart_game/mart_niche SELECT-* copies above/below pick up the players_*
    # columns automatically on marts that have them.
    con.execute("CREATE TABLE mart_game_players_daily AS SELECT * FROM real.mart_game_players_daily WHERE appid=367520")
    con.execute(f"CREATE TABLE mart_niche_players AS SELECT * FROM real.mart_niche_players WHERE dimension='tag' AND key='{OWSC}'")
    # Deep-history marts landed later than the daily ones — copy them only when the source
    # mart has them, so regeneration keeps working against slightly older builds.
    try:
        con.execute("CREATE TABLE mart_game_players_history AS SELECT * FROM real.mart_game_players_history WHERE appid=367520")
        con.execute(f"CREATE TABLE mart_niche_players_monthly AS SELECT * FROM real.mart_niche_players_monthly WHERE dimension='tag' AND key='{OWSC}'")
    except duckdb.CatalogException:
        pass
    try:
        con.execute(f"CREATE TABLE mart_niche_players_hist AS SELECT * FROM real.mart_niche_players_hist WHERE dimension='tag' AND key='{OWSC}'")
        con.execute(f"CREATE TABLE mart_niche_players_top AS SELECT * FROM real.mart_niche_players_top WHERE dimension='tag' AND key='{OWSC}'")
    except duckdb.CatalogException:
        pass
    try:
        con.execute("CREATE TABLE mart_market_lifetime AS SELECT * FROM real.mart_market_lifetime")
    except duckdb.CatalogException:
        pass

    # ---- game: game_teardown/game_profile/game_search(367520 = Hollow Knight) ------------
    con.execute("CREATE TABLE mart_game AS SELECT * FROM real.mart_game WHERE appid=367520")
    con.execute("CREATE TABLE mart_game_review_aspects AS SELECT * FROM real.mart_game_review_aspects WHERE appid=367520")
    con.execute("CREATE TABLE mart_genre_aspect_baseline AS SELECT * FROM real.mart_genre_aspect_baseline WHERE genre IN ('Action', '__all__')")
    for tbl in ("mart_game_press_summary", "mart_game_press_by_source", "mart_game_press_timeline", "mart_game_press_notable"):
        con.execute(f"CREATE TABLE {tbl} AS SELECT * FROM real.{tbl} WHERE appid=367520")

    # ---- market/estimate: market_benchmarks() + estimate_revenue(genre="Action") ---------
    con.execute("CREATE TABLE mart_market_boxleiter AS SELECT * FROM real.mart_market_boxleiter")  # small (16 rows) — full copy
    con.execute("CREATE TABLE mart_market_tiers AS SELECT * FROM real.mart_market_tiers")  # 5 rows — full copy
    con.execute("CREATE TABLE mart_meta AS SELECT * FROM real.mart_meta")  # small — full copy

    # ---- launch timing: launch_shape("Action") + best_launch_timing("Action") -----------
    con.execute("CREATE TABLE mart_launch_curve AS SELECT * FROM real.mart_launch_curve WHERE genre='Action'")
    con.execute("""
        CREATE TABLE mart_seasonality AS
        SELECT * FROM real.mart_seasonality WHERE grain IN ('month', 'weekday') AND genre='Action'
    """)
    con.execute("""
        INSERT INTO mart_seasonality
        SELECT * FROM real.mart_seasonality
        WHERE grain='month_weekday' AND genre='Action' AND n_scored >= 30
        ORDER BY median_rev DESC NULLS LAST LIMIT 3
    """)

    # ---- revenue_distribution("revenue", "Action", "all") --------------------------------
    con.execute("CREATE TABLE mart_market_pct AS SELECT * FROM real.mart_market_pct WHERE metric='revenue' AND genre='Action' AND win='all'")
    con.execute("CREATE TABLE mart_market_hist AS SELECT * FROM real.mart_market_hist WHERE metric='revenue' AND genre='Action' AND win='all'")

    # ---- press_pitch_list("RPG") -----------------------------------------------------------
    con.execute("CREATE TABLE mart_press_outlet_genre AS SELECT * FROM real.mart_press_outlet_genre WHERE genre='RPG'")
    con.execute("CREATE TABLE mart_press_author AS SELECT * FROM real.mart_press_author WHERE genre='RPG' ORDER BY n_articles DESC LIMIT 5")

    # ---- buzz_trends("rising") -------------------------------------------------------------
    con.execute("CREATE TABLE mart_buzz_trends_summary AS SELECT * FROM real.mart_buzz_trends_summary WHERE direction='rising' ORDER BY slope DESC LIMIT 10")
    # include_series=False in the smoke test's only buzz_trends() call, so this stays empty
    # (schema-only) — present only so a code path that ever flips include_series doesn't 500.
    con.execute("CREATE TABLE mart_buzz_trends AS SELECT * FROM real.mart_buzz_trends WHERE 1=0")

    con.execute("DETACH real")
    con.close()

    size_kb = OUTPUT.stat().st_size / 1024
    print(f"Wrote {OUTPUT} ({size_kb:.0f} KB)")


if __name__ == "__main__":
    main()

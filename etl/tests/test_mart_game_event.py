"""mart_game_event: the right events survive, the cap bites only where it should.

Renders the real .sql through build_marts.render()/build_params() over a synthetic staging layer,
so it fails on the file that ships rather than on a copy of it. No source database needed.

What is actually worth asserting here is the SELECTION, not the plumbing: a release always
survives the cap (a game's own launch is the one event whose absence makes the rest unreadable),
undated and future-dated rows are dropped rather than plotted at the origin, and the channels that
would double-mark or drown the chart stay out.
"""
import sys
from pathlib import Path

import duckdb

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import build_marts as bm  # noqa: E402


def build() -> duckdb.DuckDBPyConnection:
    con = duckdb.connect(":memory:")
    con.execute("CREATE SCHEMA src")
    con.execute(
        "CREATE TABLE src.articles(id INTEGER, appid INTEGER, channel VARCHAR, title VARCHAR,"
        " url VARCHAR, published_at VARCHAR)"
    )
    con.execute(
        "CREATE TEMP TABLE stg_game(appid INTEGER, release_date DATE, release_valid BOOLEAN)"
    )
    con.execute("INSERT INTO stg_game VALUES (1, DATE '2024-05-01', true), (2, DATE '2023-01-01', true)")

    rows = [
        # appid 1: one of each kind that should survive
        (1, 1, "patch_notes", "Patch 1.4", "u1", "2024-06-01T00:00:00Z"),
        (2, 1, "press", "PC Gamer review", "u2", "2024-05-10T00:00:00Z"),
        (3, 1, "trade_press", "GDC coverage", "u3", "2024-07-01T00:00:00Z"),
        # excluded channels: high-volume marketing, and the same story reprinted
        (4, 1, "dev_post", "Wishlist us!", "u4", "2024-06-02T00:00:00Z"),
        (5, 1, "press_syndicated", "PC Gamer review (reprint)", "u5", "2024-05-11T00:00:00Z"),
        # unusable rows: no title, no date, dated in the future
        (6, 1, "patch_notes", "   ", "u6", "2024-06-03T00:00:00Z"),
        (7, 1, "patch_notes", "No date", "u7", None),
        (8, 1, "patch_notes", "From the future", "u8", "2999-01-01T00:00:00Z"),
    ]
    # appid 2: far more than the cap, all NEWER than its release — the release must still survive
    rows += [
        (100 + i, 2, "patch_notes", f"Patch {i}", f"p{i}", f"2024-01-{(i % 28) + 1:02d}T00:00:00Z")
        for i in range(bm.GAME_EVENT_CAP + 25)
    ]
    con.executemany("INSERT INTO src.articles VALUES (?,?,?,?,?,?)", rows)

    con.execute(bm.render(
        (Path(__file__).resolve().parents[1] / "marts" / "mart_game_event.sql").read_text(),
        bm.build_params(),
    ))
    return con


def test_selection_and_cap():
    con = build()

    kinds = {k for (k,) in con.execute("SELECT DISTINCT kind FROM mart_game_event").fetchall()}
    assert kinds == {"release", "update", "press"}, kinds

    titles = {t for (t,) in con.execute("SELECT title FROM mart_game_event WHERE appid = 1").fetchall()}
    assert "Patch 1.4" in titles and "PC Gamer review" in titles and "GDC coverage" in titles
    # noise that must never reach a chart
    for junk in ("Wishlist us!", "PC Gamer review (reprint)", "No date", "From the future", "   "):
        assert junk not in titles, junk

    n2 = con.execute("SELECT count(*) FROM mart_game_event WHERE appid = 2").fetchone()[0]
    assert n2 == bm.GAME_EVENT_CAP, n2
    # the release is older than every patch note, so a naive "most recent N" would drop it
    assert con.execute(
        "SELECT count(*) FROM mart_game_event WHERE appid = 2 AND kind = 'release'"
    ).fetchone()[0] == 1

    print(f"[ok] kinds={sorted(kinds)}  appid1={len(titles)} events  appid2={n2} (cap {bm.GAME_EVENT_CAP}, release kept)")


if __name__ == "__main__":
    test_selection_and_cap()
    print("[PASS] mart_game_event selection + cap")

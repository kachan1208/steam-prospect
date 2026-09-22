"""Review text by primary key must be the SAME text the streaming join returned.

_fetch_review_text replaced `keys JOIN src.reviews r ON r.recommendationid = k.recommendationid`
— a full stream of the 44.7GB source per scoring bucket, because DuckDB's sqlite scanner has no
filter pushdown — with IN-list lookups SQLite answers from the TEXT PRIMARY KEY (see REVIEW TEXT
BY PRIMARY KEY in build_marts.py). Nothing downstream may be able to tell: the windows are cut
from this text and their scores are cached forever.

Everything here runs against a REAL SQLite file ATTACHed the way main() attaches the source (the
lookup only exists for an attached SQLite database), seeded with the keys and texts most likely
to diverge between two read paths: ids that differ only by case, by a trailing space or by a
leading zero, a quote inside an id, CRLF and non-ASCII text, a 100K-character review, NULL and
empty text, keys absent from the source, and a duplicated key.
"""
from __future__ import annotations

import random
import sqlite3
import sys
from pathlib import Path

import duckdb
import pytest

ETL = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ETL))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import build_marts as bm  # noqa: E402

TRICKY = [
    ("123456789", 1, "plain"),
    ("0123456789", 1, "leading zero is a different key"),
    ("abc", 2, "lower"),
    ("ABC", 2, "UPPER — BINARY collation keeps it apart from 'abc'"),
    ("123 ", 2, "trailing space is part of the key"),
    ("x'y", 3, "a quote inside the id"),
    ("crlf", 3, "Great game — café\r\n\r\nThe combat is tight.\r\n"),
    ("long", 4, "word " * 20_000),
    ("empty", 4, ""),
    ("nulltext", 4, None),
    ("emoji", 5, "👨‍👩‍👧 story ✅ price 漢字 ї"),
]


def _source(path: Path, n_random: int = 3000) -> None:
    c = sqlite3.connect(path)
    c.execute("CREATE TABLE reviews(recommendationid TEXT PRIMARY KEY, appid INTEGER NOT NULL, "
              "language TEXT, review_text TEXT)")
    rows = [(rid, appid, "english", text) for rid, appid, text in TRICKY]
    rng = random.Random(7)
    for i in range(n_random):
        rid = str(rng.choice([10_000_000, 100_000_000]) + i)
        text = " ".join(rng.choice(["good", "bad", "combat", "story", "ünïcode", "\r\n", "."])
                        for _ in range(rng.randrange(1, 60)))
        rows.append((rid, 10 + i % 40, "english", text))
    c.executemany("INSERT INTO reviews VALUES (?, ?, ?, ?)", rows)
    c.commit()
    c.close()


@pytest.fixture
def con(tmp_path):
    src = tmp_path / "src.db"
    _source(src)
    c = bm._connect(str(tmp_path / "scratch.duckdb"))
    c.execute("INSTALL sqlite; LOAD sqlite;")
    c.execute(f"ATTACH '{src}' AS src (TYPE sqlite, READ_ONLY)")
    yield c
    c.close()


def _keys(con) -> str:
    """A key set like a scoring bucket's: most random ids, every tricky id, ids the source does
    not have, and one duplicated key (the join must fan it out identically either way)."""
    con.execute("CREATE OR REPLACE TABLE keys(appid INTEGER, recommendationid VARCHAR)")
    con.execute("INSERT INTO keys SELECT appid, recommendationid FROM src.reviews "
                "WHERE hash(recommendationid) % 3 <> 0 OR recommendationid IN (SELECT unnest(?))",
                [[rid for rid, _a, _t in TRICKY]])
    con.execute("INSERT INTO keys VALUES (99, 'missing-1'), (99, '1234567890123'), (99, 'abc ')")
    con.execute("INSERT INTO keys SELECT appid, recommendationid FROM keys WHERE recommendationid = 'crlf'")
    return "SELECT appid, recommendationid FROM keys"


def _rows(con, table: str) -> list[tuple]:
    return sorted(con.execute(f"SELECT appid, recommendationid, review_text FROM {table}").fetchall(),
                  key=lambda r: (r[1], r[0], r[2] or ""))


def test_the_key_lookup_returns_exactly_what_the_stream_returned(con, monkeypatch):
    keys_sql = _keys(con)
    cursors = []
    real_cursor = bm._cursor
    monkeypatch.setattr(bm, "_cursor", lambda c: cursors.append(1) or real_cursor(c))
    monkeypatch.setattr(bm, "REVIEW_TEXT_FETCH_CHUNK", 97)     # many chunks, many threads
    bm._fetch_review_text(con, keys_sql, "by_key")
    assert cursors, "the primary-key path never ran — the comparison below would be stream vs stream"

    con.execute(f"""CREATE TEMP TABLE streamed AS
        SELECT k.appid, k.recommendationid, r.review_text
        FROM ({keys_sql}) k JOIN src.reviews r ON r.recommendationid = k.recommendationid""")
    by_key, streamed = _rows(con, "by_key"), _rows(con, "streamed")
    assert by_key == streamed
    n_keys = con.execute("SELECT count(*) FROM keys").fetchone()[0]
    assert len(streamed) == n_keys - 3, "the fixture's three absent keys must drop, nothing else"
    got = {rid: text for _a, rid, text in by_key}
    for rid, _appid, text in TRICKY:
        assert got[rid] == text, rid
    assert "abc " not in got and "missing-1" not in got
    assert sum(1 for _a, rid, _t in by_key if rid == "crlf") == 2, "a duplicated key fans out"
    # the landing table the lookup threads write into is gone again
    assert not con.execute("SELECT count(*) FROM duckdb_tables() "
                           "WHERE table_name LIKE '%__by_key'").fetchone()[0]


def test_large_key_sets_and_unkeyed_sources_still_stream(con, tmp_path, monkeypatch):
    """Past REVIEW_TEXT_PK_FETCH_MAX a sequential pass is cheaper than random lookups, and a
    source without an index on recommendationid would turn each IN-list into a full scan — both
    must take the old join, with the same result."""
    keys_sql = _keys(con)
    bm._fetch_review_text(con, keys_sql, "by_key")
    expected = _rows(con, "by_key")

    cursors = []
    real_cursor = bm._cursor
    monkeypatch.setattr(bm, "_cursor", lambda c: cursors.append(1) or real_cursor(c))
    monkeypatch.setattr(bm, "REVIEW_TEXT_PK_FETCH_MAX", 10)
    bm._fetch_review_text(con, keys_sql, "streamed")
    assert not cursors and _rows(con, "streamed") == expected

    unkeyed = tmp_path / "unkeyed.db"
    c = sqlite3.connect(unkeyed)
    c.execute("CREATE TABLE reviews(recommendationid TEXT, appid INTEGER, review_text TEXT)")
    c.execute("INSERT INTO reviews VALUES ('1', 1, 'a')")
    c.commit()
    c.close()
    other = bm._connect()
    other.execute("INSTALL sqlite; LOAD sqlite;")
    other.execute(f"ATTACH '{unkeyed}' AS src (TYPE sqlite, READ_ONLY)")
    assert not bm._src_reviews_keyed(other)
    assert bm._src_reviews_keyed(con)
    mem = bm._connect()
    mem.execute("CREATE SCHEMA src; CREATE TABLE src.reviews(recommendationid VARCHAR, review_text VARCHAR)")
    assert not bm._src_reviews_keyed(mem), "an in-memory src schema has no key to look up"


def test_the_cache_a_rescore_fills_is_identical_either_way(tmp_path, monkeypatch):
    """End to end through main(): --rescore-only over a real SQLite source with varied text,
    once fetching by key and once streaming — the two caches must hold the same rows."""
    from test_full_build_smoke import _run, build_source

    monkeypatch.setenv("PROSPECT_SENTIMENT_CACHE", "on")
    monkeypatch.setenv("PROSPECT_RESCORE_BUCKET_REVIEWS", "300")
    monkeypatch.delenv("PROSPECT_SENTIMENT_DEADLINE_SECONDS", raising=False)
    src = tmp_path / "steam_games.db"
    build_source(src)
    rng = random.Random(3)
    words = ["the combat is great", "boss fights feel unfair", "story", "café", "\r\n", ". ",
             "soundtrack", "worth the price", "map is confusing", "ünïcode", "too short", "!"]
    c = sqlite3.connect(src)
    ids = [r[0] for r in c.execute("SELECT recommendationid FROM reviews").fetchall()]
    c.executemany("UPDATE reviews SET review_text = ? WHERE recommendationid = ?",
                  [(" ".join(rng.choice(words) for _ in range(rng.randrange(3, 40))), rid)
                   for rid in ids])
    # The smoke fixture's reviews table has no key; the real source's recommendationid is its
    # TEXT PRIMARY KEY. Give it the equivalent so the lookup path is actually available.
    c.execute("CREATE UNIQUE INDEX reviews_pk ON reviews(recommendationid)")
    c.commit()
    c.close()

    caches, paths = {}, {}
    real_fetch = bm._fetch_review_text
    for mode, pk_max in (("by key", bm.REVIEW_TEXT_PK_FETCH_MAX), ("streamed", 0)):
        data = tmp_path / f"data_{mode.replace(' ', '_')}"
        data.mkdir()
        taken: list[str] = []
        with pytest.MonkeyPatch.context() as mp:
            mp.setattr(bm, "REVIEW_TEXT_PK_FETCH_MAX", pk_max)
            mp.setattr(bm, "_fetch_review_text",
                       lambda *a, **kw: taken.append(real_fetch(*a, **kw)) or taken[-1])
            assert _run(["--source", str(src), "--data-dir", str(data), "--rescore-only"]) == 0
        caches[mode], paths[mode] = data / bm.SENTIMENT_CACHE_DB_NAME, set(taken)
    assert paths == {"by key": {"by key"}, "streamed": {"streamed"}}, paths

    con = duckdb.connect()
    con.execute(f"ATTACH '{caches['by key']}' AS a (READ_ONLY)")
    con.execute(f"ATTACH '{caches['streamed']}' AS b (READ_ONLY)")
    for table in ("aspect_mention", "scored_review"):
        n = con.execute(f"SELECT count(*) FROM a.{table}").fetchone()[0]
        diff = con.execute(f"""SELECT count(*) FROM (
            (SELECT * FROM a.{table} EXCEPT ALL SELECT * FROM b.{table})
            UNION ALL (SELECT * FROM b.{table} EXCEPT ALL SELECT * FROM a.{table}))""").fetchone()[0]
        assert n > 0 and diff == 0, (table, n, diff)

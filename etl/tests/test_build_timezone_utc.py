"""One clock: every date the ETL derives is a UTC date, whatever zone the host runs in.

DuckDB's TimeZone setting defaults to the HOST's zone. Before 2026-09-22 nothing pinned it, so on
a UTC+3 laptop a review written at 22:30 UTC was dated the next day by staging's
`CAST(to_timestamp(timestamp_created) AS DATE)`, CURRENT_DATE was the local date, and date.today()
named the mart and set CUR_YEAR — while mart_game_trends' make_timestamp() and every *_at column
are UTC. The same source then built different marts on a UTC server and a laptop.

The process zone has to be set BEFORE DuckDB starts, so every check here runs in a child process
with TZ set. Each first proves its own premise (a plain duckdb.connect() in that child really does
report the foreign zone) — without that control a pass would prove nothing.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import textwrap
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

ETL = Path(__file__).resolve().parents[1]
TESTS = Path(__file__).resolve().parent

# 2026-06-15 22:30:00 UTC — the next calendar day in every zone east of UTC+1:30.
TS_2230_UTC = int(datetime(2026, 6, 15, 22, 30, tzinfo=timezone.utc).timestamp())


def _run_child(code: str, tz: str, tmp_path: Path) -> dict:
    env = {**os.environ, "TZ": tz, "PYTHONPATH": os.pathsep.join([str(ETL), str(TESTS)])}
    env.pop("PROSPECT_SENTIMENT_DEADLINE_SECONDS", None)
    proc = subprocess.run([sys.executable, "-c", textwrap.dedent(code)], cwd=tmp_path, env=env,
                          capture_output=True, text=True, timeout=600)
    assert proc.returncode == 0, f"child failed under TZ={tz}:\n{proc.stdout[-3000:]}\n{proc.stderr[-3000:]}"
    return json.loads(proc.stdout.strip().splitlines()[-1])


UNIT_CHILD = f"""
    import json
    from datetime import datetime, timezone
    import duckdb
    import build_marts as bm

    ts = {TS_2230_UTC}
    plain = duckdb.connect()
    con = bm._connect()
    cur = bm._cursor(con)
    q = f"SELECT current_setting('TimeZone'), CAST(CAST(to_timestamp({{ts}}) AS DATE) AS VARCHAR), CAST(current_date AS VARCHAR)"
    before = datetime.now(timezone.utc).date().isoformat()
    p, c, k = plain.execute(q).fetchone(), con.execute(q).fetchone(), cur.execute(q).fetchone()
    after = datetime.now(timezone.utc).date().isoformat()
    print(json.dumps({{"plain": p, "con": c, "cursor": k, "utc_today": [before, after],
                      "bm_today": bm._utc_today().isoformat(),
                      "cur_year": bm.build_params()["CUR_YEAR"]}}))
"""


@pytest.mark.parametrize("tz", ["Pacific/Kiritimati", "Pacific/Pago_Pago", "Europe/Kyiv"])
def test_every_connection_and_python_date_is_utc(tz, tmp_path):
    """UTC+14 and UTC-11 between them disagree with UTC about today's date at EVERY hour, so the
    CURRENT_DATE / _utc_today() half of this is never vacuous; Europe/Kyiv is the owner's zone."""
    out = _run_child(UNIT_CHILD, tz, tmp_path)
    plain_zone, plain_day, _ = out["plain"]
    if plain_zone in ("UTC", "Etc/UTC", "GMT"):
        pytest.skip(f"this platform's DuckDB ignored TZ={tz}; the premise cannot be set up")
    # ICU may canonicalise the name (Europe/Kyiv vs Europe/Kiev); any non-UTC zone is the premise.
    if tz != "Pacific/Pago_Pago":   # west of UTC, 22:30 UTC is still the same calendar day
        assert plain_day == "2026-06-16", f"control: the host zone should move 22:30 UTC to 06-16: {out}"

    for side in ("con", "cursor"):
        zone, day, today = out[side]
        assert zone == "UTC", f"{side} is not pinned to UTC: {out}"
        assert day == "2026-06-15", f"{side}: a 22:30 UTC review must keep its UTC date: {out}"
        assert today in out["utc_today"], f"{side}: CURRENT_DATE must be the UTC date: {out}"
    assert out["bm_today"] in out["utc_today"], out
    assert out["cur_year"] in {int(d[:4]) for d in out["utc_today"]}, out


BUILD_CHILD = f"""
    import json, sqlite3, sys
    from pathlib import Path
    import duckdb
    import build_marts as bm
    from test_full_build_smoke import build_source

    ts = {TS_2230_UTC}
    src, data = Path("steam_games.db"), Path("data")
    data.mkdir()
    build_source(src)
    c = sqlite3.connect(src)
    # Game 1's reviews all written at 22:30 UTC, one day apart; the newest four are the ones
    # mart_game_aspect_reviews publishes (votes tie, recency breaks it).
    for i, (rid,) in enumerate(c.execute(
            "SELECT recommendationid FROM reviews WHERE appid = 1 ORDER BY recommendationid").fetchall()):
        c.execute("UPDATE reviews SET timestamp_created = ? WHERE recommendationid = ?",
                  (ts - 86400 * i, rid))
    c.commit()
    c.close()
    bm.VALIDATE_MIN_ROWS = {{}}
    sys.argv = ["build_marts.py", "--source", str(src), "--data-dir", str(data)]
    rc = bm.main()
    mart = (data / "current.duckdb").resolve()
    con = duckdb.connect(str(mart), read_only=True)
    rows = con.execute("SELECT DISTINCT date FROM mart_game_aspect_reviews WHERE appid = 1 "
                       "ORDER BY date").fetchall()
    print(json.dumps({{"rc": rc, "mart": mart.name, "dates": [r[0] for r in rows],
                      "zone": duckdb.connect().execute("SELECT current_setting('TimeZone')").fetchone()[0]}}))
"""


def test_a_2230_utc_review_keeps_its_utc_date_through_a_real_build(tmp_path):
    """End to end through main(): the published excerpt date of a review written at 22:30 UTC is
    its UTC date, and the mart is named after the UTC day, under a UTC+14 host."""
    before = datetime.now(timezone.utc).date()
    out = _run_child(BUILD_CHILD, "Pacific/Kiritimati", tmp_path / "")
    after = datetime.now(timezone.utc).date()
    if out["zone"] == "UTC":
        pytest.skip("this platform's DuckDB ignored TZ; the premise cannot be set up")
    assert out["rc"] == 0, out
    assert out["mart"] in {f"prospect_{d:%Y%m%d}.duckdb" for d in (before, after)}, (
        f"the mart must be named after the UTC date, not the host's: {out}")
    assert out["dates"], f"the fixture published no excerpt for game 1: {out}"
    utc_days = {(datetime(2026, 6, 15, tzinfo=timezone.utc) - timedelta(days=i)).date().isoformat()
                for i in range(30)}
    assert set(out["dates"]) <= utc_days, (
        f"excerpt dates shifted to the host zone (UTC+14 would read each as the next day): {out}")
    assert "2026-06-15" in out["dates"], out

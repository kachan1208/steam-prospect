"""Nightly follower counts — the pre-release demand signal Prospect has never had.

Every Steam game has a community group whose member count IS the "followers" figure SteamDB
charts (their FAQ: all data comes from Steam; this is the public source). Wishlist counts are
developer-private; followers are the standard proxy (community heuristic: wishlists ~ 8-12x
followers). The value is the TIME SERIES — it cannot be backfilled, so every day this runs is
a day of history the product gains.

Cohort: unreleased/undated games plus releases in the last COHORT_DAYS (default 180) — the
window where follower momentum answers "is anyone waiting for this?". ~10-25K games.

Writes signals.db (its own SQLite file, WAL) — DELIBERATELY not steam_games.db: that file's
write lock is contended by the scraper lanes (the "database is locked" disease of 2026-08;
three steps had to be rescheduled around it). A separate DB has exactly one writer — us —
and the ETL just ATTACHes a second source.

Endpoint: https://steamcommunity.com/games/{appid}/memberslistxml/?xml=1&p=1 (keyless).
memberCount sits in the page-1 header; games without a group 404 and are skipped.

Env: STEAM_DB (source of the cohort), SIGNALS_DB, WORKERS, RATE_PER_SEC, COHORT_DAYS.
"""
from __future__ import annotations

import datetime as dt
import os
import re
import sqlite3
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed

import requests

STEAM_DB = os.environ.get("STEAM_DB", "/root/steam-scraper/steam_games.db")
SIGNALS_DB = os.environ.get("SIGNALS_DB", "/root/steam-scraper/signals.db")
WORKERS = int(os.environ.get("WORKERS", "6"))
RATE_PER_SEC = float(os.environ.get("RATE_PER_SEC", "5.0"))
COHORT_DAYS = int(os.environ.get("COHORT_DAYS", "180"))

_RX_COUNT = re.compile(rb"<memberCount>(\d+)</memberCount>")
# Steam release_date is display text in a handful of shapes; anything unparseable is treated
# as unreleased (TBA/"Coming soon"/"Q4 2026" all mean "the follower curve matters").
_DATE_FORMATS = ("%d %b, %Y", "%b %d, %Y", "%b %Y", "%Y")

_rate_lock = threading.Lock()
_next_slot = [0.0]


def _throttle() -> None:
    with _rate_lock:
        now = time.monotonic()
        _next_slot[0] = max(_next_slot[0] + 1.0 / RATE_PER_SEC, now)
        wait = _next_slot[0] - now
    if wait > 0:
        time.sleep(wait)


def _parse_release(txt: str | None) -> dt.date | None:
    if not txt:
        return None
    t = txt.strip()
    for fmt in _DATE_FORMATS:
        try:
            return dt.datetime.strptime(t, fmt).date()
        except ValueError:
            continue
    return None


def cohort() -> list[int]:
    con = sqlite3.connect(f"file:{STEAM_DB}?mode=ro", uri=True, timeout=60)
    cutoff = dt.date.today() - dt.timedelta(days=COHORT_DAYS)
    out = []
    for appid, rel in con.execute(
        "SELECT appid, release_date FROM games WHERE type IN ('game','') OR type IS NULL"
    ):
        d = _parse_release(rel)
        if d is None or d >= cutoff:
            out.append(appid)
    con.close()
    return out


def fetch_one(session: requests.Session, appid: int) -> tuple[int, int | None]:
    _throttle()
    r = session.get(
        f"https://steamcommunity.com/games/{appid}/memberslistxml/?xml=1&p=1",
        timeout=25,
    )
    if r.status_code != 200:
        return appid, None
    m = _RX_COUNT.search(r.content)
    return appid, int(m.group(1)) if m else None


def main() -> int:
    sig = sqlite3.connect(SIGNALS_DB, timeout=120)
    sig.execute("PRAGMA journal_mode=WAL")
    sig.execute("PRAGMA busy_timeout=120000")
    sig.execute(
        "CREATE TABLE IF NOT EXISTS game_followers("
        "appid INTEGER, captured_on TEXT, member_count INTEGER,"
        " PRIMARY KEY(appid, captured_on))"
    )
    today = dt.date.today().isoformat()
    apps = cohort()
    # Idempotent re-run: skip what today already has, so a crashed run resumes for free.
    done = {r[0] for r in sig.execute(
        "SELECT appid FROM game_followers WHERE captured_on = ?", (today,))}
    todo = [a for a in apps if a not in done]
    print(f"[followers] cohort={len(apps):,} already_done={len(done):,} todo={len(todo):,}",
          flush=True)

    session = requests.Session()
    session.headers["User-Agent"] = "Prospect/1.0 (market research; kachan1208@gmail.com)"
    n_ok = n_skip = 0
    t0 = time.time()
    last_log = t0
    batch: list[tuple[int, str, int]] = []
    with ThreadPoolExecutor(max_workers=WORKERS) as ex:
        futs = [ex.submit(fetch_one, session, a) for a in todo]
        for f in as_completed(futs):
            appid, count = f.result()
            if count is None:
                n_skip += 1
            else:
                batch.append((appid, today, count))
                n_ok += 1
            # Commit every 200 rows: bounded loss on crash, and (being signals.db's only
            # writer) no lock pressure to be polite about.
            if len(batch) >= 200:
                sig.executemany(
                    "INSERT OR REPLACE INTO game_followers VALUES (?,?,?)", batch)
                sig.commit()
                batch.clear()
            if time.time() - last_log >= 30:
                done_n = n_ok + n_skip
                rate = done_n / max(time.time() - t0, 1)
                print(f"[followers] {done_n:,}/{len(todo):,} ok={n_ok:,} "
                      f"no-group={n_skip:,} ({rate:.1f}/s)", flush=True)
                last_log = time.time()
    if batch:
        sig.executemany("INSERT OR REPLACE INTO game_followers VALUES (?,?,?)", batch)
        sig.commit()
    total = sig.execute(
        "SELECT COUNT(*), COALESCE(SUM(member_count),0) FROM game_followers"
        " WHERE captured_on = ?", (today,)).fetchone()
    print(f"[followers] DONE ok={n_ok:,} no-group={n_skip:,} "
          f"rows_today={total[0]:,} members_sum={total[1]:,} in {time.time()-t0:.0f}s",
          flush=True)
    sig.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

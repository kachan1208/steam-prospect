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

DIRECT and polite, with a rotating window (2026-08-25, after two dead ends the same day):
- 5-8 rps direct earned the droplet a blanket community 403 ban (which v1 then dutifully
  recorded as "97% of games have no group"). The ban lifts within hours.
- The scraper's proxy pool — fine for the store — is nearly blind to steamcommunity.com:
  1.4% success. Public proxies are already banned there en masse.
So: direct requests at a rate that never triggers the ban (default 1.2 rps), and instead of
trying to sweep all ~58K games nightly, the cohort ROTATES — never-measured and
longest-unmeasured games first, dated-future/coming-soon before the TBA tail. A nightly
2h slot covers ~8-9K games, the full cohort every ~7 days, and the hottest curve segments
(games people are actually waiting for) refresh most often.

A 403/429 is treated as "blocked, stop being greedy" — NEVER as "no group": only a
definitive 404/absent count enters the miss cache, or a day of bans would poison a week.

Env: STEAM_DB (cohort source), SIGNALS_DB, WORKERS, RATE_PER_SEC, COHORT_DAYS.
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
SIGNALS_DB = os.environ.get("SIGNALS_DB", "/root/prospect/data/signals.db")
WORKERS = int(os.environ.get("WORKERS", "3"))
RATE_PER_SEC = float(os.environ.get("RATE_PER_SEC", "0.8"))
# One 429 pauses EVERYTHING this long. Retrying a 429 immediately just multiplies the
# pressure that caused it — measured 2026-08-25, when 3x-retries at 1.2 rps kept the limiter
# tripped indefinitely while a lone probe minutes later got a clean 200.
COOLDOWN_S = float(os.environ.get("COOLDOWN_S", "90"))
COHORT_DAYS = int(os.environ.get("COHORT_DAYS", "180"))
# No-group games are re-probed this often, not nightly. Measured on the first sweep
# (2026-08-24): ~97% of a naive cohort has no community group — mostly the dead undated
# tail — and re-fetching 50K misses every night is what blew the step's 2h timeout.
MISS_RETRY_DAYS = int(os.environ.get("MISS_RETRY_DAYS", "7"))

_RX_COUNT = re.compile(rb"<memberCount>(\d+)</memberCount>")
# Steam release_date is display text in a handful of shapes; anything unparseable is treated
# as unreleased (TBA/"Coming soon"/"Q4 2026" all mean "the follower curve matters").
_DATE_FORMATS = ("%d %b, %Y", "%b %d, %Y", "%b %Y", "%Y")

_rate_lock = threading.Lock()
_next_slot = [0.0]
_cooldown_until = [0.0]


def _throttle() -> None:
    with _rate_lock:
        now = time.monotonic()
        base = max(_next_slot[0] + 1.0 / RATE_PER_SEC, now, _cooldown_until[0])
        _next_slot[0] = base
        wait = base - now
    if wait > 0:
        time.sleep(wait)


def _trip_cooldown() -> None:
    with _rate_lock:
        _cooldown_until[0] = time.monotonic() + COOLDOWN_S


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


def cohort() -> list[tuple[int, int]]:
    """(appid, priority) for games whose follower curve answers a question. Priority orders
    the nightly rotation, not membership: 0 = dated future release (the countdown crowd),
    1 = 'Coming soon' text, 2 = released within COHORT_DAYS, 3 = TBA/undated tail."""
    con = sqlite3.connect(f"file:{STEAM_DB}?mode=ro", uri=True, timeout=60)
    today = dt.date.today()
    cutoff = today - dt.timedelta(days=COHORT_DAYS)
    out = []
    for appid, rel in con.execute(
        "SELECT appid, release_date FROM games WHERE type IN ('game','') OR type IS NULL"
    ):
        d = _parse_release(rel)
        if d is not None:
            if d > today:
                out.append((appid, 0))
            elif d >= cutoff:
                out.append((appid, 2))
        elif rel and rel.strip().lower() == "coming soon":
            out.append((appid, 1))
        else:
            out.append((appid, 3))
    con.close()
    return out


def fetch_one(session: requests.Session, appid: int) -> tuple[int, int | None, bool]:
    """-> (appid, member_count | None, definitive_miss).

    definitive_miss is True ONLY for a clean 404 / a 200 without a count — the states that
    mean "this game has no community group". Blocks (403/429) and transport failures return
    (None, False): unknown, try again another day, never cache."""
    url = f"https://steamcommunity.com/games/{appid}/memberslistxml/?xml=1&p=1"
    _throttle()
    try:
        r = session.get(url, timeout=25)
    except requests.RequestException:
        return appid, None, False
    if r.status_code == 200:
        m = _RX_COUNT.search(r.content)
        return (appid, int(m.group(1)), False) if m else (appid, None, True)
    if r.status_code == 404:
        return appid, None, True
    if r.status_code in (403, 429):
        _trip_cooldown()  # no retry — retrying IS what keeps the limiter tripped
    return appid, None, False


def main() -> int:
    sig = sqlite3.connect(SIGNALS_DB, timeout=120)
    sig.execute("PRAGMA journal_mode=WAL")
    sig.execute("PRAGMA busy_timeout=120000")
    sig.execute(
        "CREATE TABLE IF NOT EXISTS game_followers("
        "appid INTEGER, captured_on TEXT, member_count INTEGER,"
        " PRIMARY KEY(appid, captured_on))"
    )
    sig.execute(
        "CREATE TABLE IF NOT EXISTS followers_miss("
        "appid INTEGER PRIMARY KEY, last_checked TEXT)"
    )
    today = dt.date.today().isoformat()
    apps = cohort()
    # Idempotent re-run: skip what today already has, so a crashed run resumes for free.
    done = {r[0] for r in sig.execute(
        "SELECT appid FROM game_followers WHERE captured_on = ?", (today,))}
    # ...and skip recently-confirmed no-group games (see MISS_RETRY_DAYS).
    miss_floor = (dt.date.today() - dt.timedelta(days=MISS_RETRY_DAYS)).isoformat()
    missed = {r[0] for r in sig.execute(
        "SELECT appid FROM followers_miss WHERE last_checked >= ?", (miss_floor,))}
    # ROTATION ORDER: the nightly timeout is the budget, and this sort decides what it buys.
    # Never-measured first, then longest-unmeasured; priority group breaks ties. A polite
    # 1.2 rps covers ~8-9K games in the 2h slot, so the whole cohort refreshes on a ~7-day
    # wheel while dated-future games get the freshest curves.
    last = {r[0]: r[1] for r in sig.execute(
        "SELECT appid, MAX(captured_on) FROM game_followers GROUP BY appid")}
    todo_pairs = [(a, pr) for a, pr in apps if a not in done and a not in missed]
    todo_pairs.sort(key=lambda ap: (last.get(ap[0], ""), ap[1]))
    todo = [a for a, _pr in todo_pairs]
    print(f"[followers] cohort={len(apps):,} done_today={len(done):,} "
          f"miss_cached={len(missed):,} todo={len(todo):,} "
          f"(never_measured={sum(1 for a in todo if a not in last):,})", flush=True)

    session = requests.Session()
    session.headers["User-Agent"] = "Prospect/1.0 (market research; kachan1208@gmail.com)"
    n_ok = n_skip = n_unknown = 0
    t0 = time.time()
    last_log = t0
    batch: list[tuple[int, str, int]] = []
    miss_batch: list[tuple[int, str]] = []

    def _flush() -> None:
        if batch:
            sig.executemany("INSERT OR REPLACE INTO game_followers VALUES (?,?,?)", batch)
            batch.clear()
        if miss_batch:
            sig.executemany("INSERT OR REPLACE INTO followers_miss VALUES (?,?)", miss_batch)
            miss_batch.clear()
        sig.commit()

    with ThreadPoolExecutor(max_workers=WORKERS) as ex:
        futs = [ex.submit(fetch_one, session, a) for a in todo]
        for f in as_completed(futs):
            appid, count, definitive_miss = f.result()
            if count is not None:
                batch.append((appid, today, count))
                n_ok += 1
            elif definitive_miss:
                miss_batch.append((appid, today))
                n_skip += 1
            else:
                n_unknown += 1  # blocked/unreachable — retried on the next run, never cached
            # Commit every 200 rows: bounded loss on crash, and (being signals.db's only
            # writer) no lock pressure to be polite about.
            if len(batch) + len(miss_batch) >= 200:
                _flush()
            if time.time() - last_log >= 30:
                done_n = n_ok + n_skip + n_unknown
                rate = done_n / max(time.time() - t0, 1)
                print(f"[followers] {done_n:,}/{len(todo):,} ok={n_ok:,} "
                      f"no-group={n_skip:,} unknown={n_unknown:,} ({rate:.1f}/s)", flush=True)
                last_log = time.time()
    _flush()
    total = sig.execute(
        "SELECT COUNT(*), COALESCE(SUM(member_count),0) FROM game_followers"
        " WHERE captured_on = ?", (today,)).fetchone()
    print(f"[followers] DONE ok={n_ok:,} no-group={n_skip:,} unknown={n_unknown:,} "
          f"rows_today={total[0]:,} members_sum={total[1]:,} in {time.time()-t0:.0f}s",
          flush=True)
    sig.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

#!/usr/bin/env python3
"""One-off: backfill history for the corpus metrics whose past is HONESTLY reconstructable
from real timestamps in steam_games.db — daily samples for the trailing window so the
Corpus dashboard's growth panels start with context instead of a single dot.

Only metrics with true per-row timestamps are backfilled:
  - prospect_corpus_games_total / games_released  (games.first_seen — real stamps since the
    2026-07-07 mass-backfill; earlier days are skipped rather than faked)
  - prospect_corpus_articles_total                (articles.fetched_at)
Everything else (coverage, socials, players…) has no reconstructable past and correctly
starts at its first nightly export. Run once with any python3; VM accepts timestamped lines.
"""
import sqlite3
import sys
import urllib.request
from datetime import datetime, timedelta, timezone

SQLITE = sys.argv[1] if len(sys.argv) > 1 else "/root/steam-scraper/steam_games.db"
VM = "http://localhost:8428/api/v1/import/prometheus"
DAYS = 42
FLOOR = "2026-07-08"  # first day AFTER the first_seen mass-backfill — earlier cumulative
                      # counts would be an artifact, so the series starts here.

s = sqlite3.connect(f"file:{SQLITE}?mode=ro", uri=True)
lines = []
today = datetime.now(timezone.utc).date()
for i in range(DAYS, 0, -1):
    day = today - timedelta(days=i)
    iso = day.isoformat()
    if iso < FLOOR:
        continue
    ts_ms = int(datetime(day.year, day.month, day.day, 21, 0, tzinfo=timezone.utc).timestamp() * 1000)
    g_total = s.execute("SELECT count(*) FROM games WHERE substr(first_seen,1,10) <= ?", (iso,)).fetchone()[0]
    g_rel = s.execute(
        "SELECT count(*) FROM games WHERE substr(first_seen,1,10) <= ? AND (type='game' OR type IS NULL)", (iso,)
    ).fetchone()[0]
    a_total = s.execute("SELECT count(*) FROM articles WHERE substr(fetched_at,1,10) <= ?", (iso,)).fetchone()[0]
    lines.append(f"prospect_corpus_games_total {g_total} {ts_ms}")
    lines.append(f"prospect_corpus_games_released {g_rel} {ts_ms}")
    lines.append(f"prospect_corpus_articles_total {a_total} {ts_ms}")

urllib.request.urlopen(urllib.request.Request(VM, data="\n".join(lines).encode()), timeout=30)
print(f"backfilled {len(lines)} samples across {DAYS} days (floor {FLOOR})")

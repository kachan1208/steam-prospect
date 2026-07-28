#!/usr/bin/env bash
# Prospect daily data refresh (runs on the Droplet via cron). Scrapes Steam (keyless, works
# from a datacenter), rebuilds the DuckDB marts on local disk, restarts the app so it serves
# fresh data, and appends one JSON record (with data deltas) to refresh_history.json — which
# the app reads for its in-app "Data log" page. Everything local: no upload, no redeploy, no tokens.
#
# NOTE: steam-scraper is NOT a git repo on the box — it's kept in sync by scp from the dev
# machine. This file IS version-controlled (prospect/deploy/prospect-refresh.sh) and scp'd to
# /root/prospect-refresh.sh on the Droplet; keep the two in sync.
set -uo pipefail
export PATH=/root/steam-scraper/.venv/bin:/root/.local/bin:$PATH
export PROSPECT_DUCKDB_MEMORY_LIMIT=2500MB   # cap DuckDB on the 4GB box, leaving room for VADER + the app container

LOG=/var/log/prospect-refresh.log
START=$(date -u +%s)
RESULT="FAILED"   # flipped to OK only after a clean ETL; a crash leaves it FAILED
STEP="starting"

record_run() {
    local dur=$(( $(date -u +%s) - START ))
    /root/steam-scraper/.venv/bin/python - "$RESULT" "$dur" "$STEP" <<'PY'
import json, sqlite3, os, sys, glob, datetime
result, duration, step = sys.argv[1], int(sys.argv[2]), sys.argv[3]
hist = "/root/prospect/data/refresh_history.json"
con = sqlite3.connect("/root/steam-scraper/steam_games.db")
def n(t):
    try: return con.execute("SELECT count(*) FROM " + t).fetchone()[0]
    except Exception: return None
# Count the tables the nightly actually grows: raw `games` (was the stale, one-off
# `analysis_games` table, frozen since a genre-research run), plus articles (news) and
# creator mentions (twitch) and player_counts (CCU) — so the Data log's deltas reflect real
# work instead of perpetually reading "No changes".
counts = {
    "games": n("games"),
    "reviews": n("reviews"),
    "articles": n("articles"),
    "mentions": n("game_creator_mention"),
    "players": n("player_counts"),
}
marts = sorted(glob.glob("/root/prospect/data/prospect_*.duckdb"))
mart_version = marts[-1].split("prospect_")[-1].replace(".duckdb", "") if marts else None
prev = {}
if os.path.exists(hist):
    lines = [l for l in open(hist).read().splitlines() if l.strip()]
    if lines:
        try: prev = json.loads(lines[-1]).get("counts") or {}
        except Exception: prev = {}
deltas = {k: counts[k] - prev[k] for k in counts if isinstance(counts[k], int) and isinstance(prev.get(k), int)}
rec = {
    "finished_at": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
    "result": result, "duration_s": duration, "step": step,
    "mart_version": mart_version, "counts": counts, "deltas": deltas,
}
with open(hist, "a") as f:
    f.write(json.dumps(rec) + "\n")
print("recorded:", rec["finished_at"], result, deltas)
PY
}
trap record_run EXIT

exec >>"$LOG" 2>&1
echo "=================== refresh start: $(date -u) ==================="

cd /root/steam-scraper || exit 1
# [1/8] Discover NEW releases: SteamSpy's 'all' pagination dead-ends at page ~87, so walk
# Steam's storefront catalog to find appids we don't have yet and enrich them. Heavier (sticky
# proxy, full catalog), hence the generous timeout; a WARN just means we keep last night's set.
STEP="new-game discovery"; echo "[1/8] $STEP $(date -u)"; timeout 5400 python3 -m steam_scraper.scraper --db steam_games.db backfill-missing --workers 16 --rate 8.0 || echo "WARN: backfill-missing -> $?"
STEP="steam scrape";    echo "[2/8] $STEP $(date -u)"; ./run_full.sh || echo "WARN: run_full.sh -> $?"
# [3/8] Refresh review TOTALS (drives revenue est.). --refresh-older-than-days re-fetches
# summaries not touched in a week (biggest games first, capped) so totals don't drift stale;
# over ~a week it rolls through the whole catalog.
STEP="review refresh";  echo "[3/8] $STEP $(date -u)"; timeout 2700 python3 -m steam_scraper.scraper --db steam_games.db review-summary --workers 16 --rate 12.0 --refresh-older-than-days 7 --limit 25000 || echo "WARN: review-summary -> $?"
STEP="review histogram"; echo "[4/8] $STEP $(date -u)"; python3 -m steam_scraper.scraper --db steam_games.db review-histogram --min-reviews 50 --workers 16 --rate 10.0 || echo "WARN: histogram -> $?"
# [5/8] Live concurrent players (CCU) — keyless GetNumberOfCurrentPlayers, datacenter-friendly
# like twitch. One snapshot per run into player_counts; the time series builds over nights.
STEP="live players (CCU)"; echo "[5/8] $STEP $(date -u)"; STEAM_DB=/root/steam-scraper/steam_games.db WORKERS=16 RATE_PER_WORKER=3.0 MIN_REVIEWS=50 timeout 3600 python3 steam_players_bulk.py || echo "WARN: ccu -> $?"
STEP="news/press";      echo "[6/8] $STEP $(date -u)"; ./run_news.sh || echo "WARN: run_news.sh -> $?"
STEP="twitch";          echo "[7/8] $STEP $(date -u)"; STEAM_DB=/root/steam-scraper/steam_games.db WORKERS=10 RATE_PER_WORKER=1.5 MIN_REVIEWS=50 timeout 3600 python3 twitch_bulk.py || echo "WARN: twitch -> $?"

STEP="ETL"; echo "[8/8] $STEP $(date -u)"
cd /root/prospect/etl || exit 1
if /root/prospect/etl/.venv/bin/python build_marts.py --source /root/steam-scraper/steam_games.db --data-dir /root/prospect/data; then
    docker restart prospect
    ls -t /root/prospect/data/prospect_*.duckdb 2>/dev/null | tail -n +4 | xargs -r rm -f
    rm -rf /root/prospect/data/*.duckdb.tmp /root/prospect/data/*.duckdb.wal 2>/dev/null || true
    RESULT="OK"; STEP="done"
    echo "ETL OK — app restarted"
else
    echo "ERROR: ETL failed — keeping previous data, app not restarted"
fi
echo "=================== refresh done: $(date -u) · $RESULT ==================="

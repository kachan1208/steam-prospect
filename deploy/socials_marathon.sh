#!/bin/bash
# Socials marathon (2026-08-19): run dev-socials chunk after chunk — evenings and early
# mornings included — until the whole catalog has been checked, instead of stopping at the
# 06:15 keeper's single daily window. Holds /root/.prospect-socials.lock for its whole life
# so that keeper cron no-ops meanwhile. Exits when no never-fetched game remains; the keeper
# then owns the 90-day refresh rotation again.
#
# SAFETY (all three learned the hard way on 2026-08-18):
#  1. Never fetch while the nightly refresh runs. Its pre-ETL `pkill -f steam_scraper.scraper`
#     kills our inner python but NOT this parent, and build_marts.py only appears in the
#     process table ~5s later — so a naive loop re-checked "is the ETL running?" during that
#     gap, saw nothing, and launched a fresh 8-worker job that straddled the ETL's 1.5-2h
#     >2GB peak on a 3.9GB box. That is precisely the rc=137 OOM that killed the mart. The
#     COOLDOWN below outlasts the gap, and the gate matches the whole refresh, not just the ETL.
#  2. Re-check headroom often. Inner runs are capped at 1h (not 6h) so a run started in a
#     quiet moment cannot keep going once the box gets busy.
#  3. Peer writers must not starve. Fixed in the scraper itself (commit per game); before that
#     a long socials run held SQLite's writer slot ~100% of the time and the 2026-08-18 nightly
#     lost twitch/ccu/tags_refresh/news/dev_socials to "database is locked".
cd /root/steam-scraper || exit 1
exec 9>/root/.prospect-socials.lock
flock -n 9 || { echo "another socials job holds the lock, exiting"; exit 0; }
LOG=/root/dev_socials_marathon.log
CHUNK=3600      # inner run cap: headroom is re-evaluated at least this often
COOLDOWN=180    # must exceed the refresh's pkill->build_marts gap (5s) by a wide margin
MIN_FREE_MB=900

log() { echo "[marathon $(date -u '+%F %T')] $*" >>"$LOG"; }
log "=== start ==="

wait_for_headroom() {
    # Blocks while the nightly refresh is anywhere in its run (its own scraper lanes AND the
    # ETL), or while memory is tight. Deliberately NOT `flock /root/.prospect-refresh.lock`:
    # the 06:00 review keeper holds that lock 13h/day (would gut the marathon), and merely
    # probing it could make the 21:00 cron's own `flock -n` no-op for a whole night.
    while pgrep -f 'prospect-refresh\.sh' >/dev/null \
          || pgrep -f 'build_marts' >/dev/null \
          || [ "$(awk '/MemAvailable/{print int($2/1024)}' /proc/meminfo)" -lt "$MIN_FREE_MB" ]; do
        sleep 180
    done
}

count_left() {
    .venv/bin/python - <<'PY' 2>/dev/null
import sqlite3
s = sqlite3.connect('file:steam_games.db?mode=ro', uri=True)
s.execute('PRAGMA busy_timeout=60000')
print(s.execute(
    "SELECT count(*) FROM games WHERE (type='game' OR type IS NULL) AND socials_fetched_at IS NULL"
).fetchone()[0])
PY
}

# One-time: drain the check-demos backlog (games the socials pass visited before demo capture
# existed — the 90-day rotation won't revisit them for months). ~1 request/game, resumable.
wait_for_headroom
log "check-demos backlog pass"
timeout "$CHUNK" .venv/bin/python -m steam_scraper.scraper --db steam_games.db check-demos \
  --limit 20000 --workers 3 --rate 1.0 >>"$LOG" 2>&1
log "check-demos pass returned rc=$?"

stall=0
prev=-1
while :; do
    wait_for_headroom
    left=$(count_left)
    case "$left" in
        ''|*[!0-9]*) log "count failed (got '${left}') — retrying after cooldown"; sleep "$COOLDOWN"; continue ;;
    esac
    log "never-fetched remaining: $left"
    [ "$left" -eq 0 ] && break
    # Stall guard: a class of games that can never be stamped would otherwise loop forever
    # burning the proxy pool. Marker writes are unconditional per game, so no such class is
    # known — this only bounds the unknown.
    if [ "$left" -ge "$prev" ] && [ "$prev" -ge 0 ]; then
        stall=$((stall + 1))
        log "no progress since last pass (stall $stall/3)"
        [ "$stall" -ge 3 ] && { log "=== ABORT: 3 passes with no progress, $left left ==="; exit 1; }
    else
        stall=0
    fi
    prev="$left"
    timeout "$CHUNK" .venv/bin/python -m steam_scraper.scraper --db steam_games.db dev-socials \
      --min-reviews 0 --refresh-days 90 --limit 30000 --workers 8 --rate 2.0 >>"$LOG" 2>&1
    log "dev-socials chunk returned rc=$? — cooling down ${COOLDOWN}s"
    sleep "$COOLDOWN"
done
log "=== DONE: whole catalog checked ==="

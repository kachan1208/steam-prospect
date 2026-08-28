#!/usr/bin/env bash
# deploy/backup.sh — protect the data that cannot be regenerated. Cron: 19:30 UTC daily
# (deploy/crontab.txt); log: /var/log/prospect-backup.log (cron-line redirect).
#
# WHY THESE FILES:
#   /root/steam-scraper/signals.db          DAILY. Forward-only follower/price time series —
#                                           a lost day is lost FOREVER (no endpoint replays
#                                           history). The one truly unrecoverable file.
#   /root/prospect/data/refresh_history.json DAILY. Small; the pipeline's run ledger.
#   /root/steam-scraper/steam_games.db      WEEKLY (Sunday). 5.2GB. Recoverable in principle
#                                           by re-scraping, but that is months of proxy-pool
#                                           wall clock — weekly is the cost/loss balance.
#
# WHY 19:30 UTC: signals.db's only writers (followers/prices collectors) run in the
# nightly's Lane B, 21:00+ — at 19:30 it is idle, so the sqlite3 .backup gets a clean,
# uncontended snapshot. The 19:15 quiet-window jobs write steam_games.db only; on Sundays
# the big .backup may overlap them — the SQLite online-backup API restarts on writer
# interruption, and disk-to-disk it has until 21:00, which is plenty. 19:30 also avoids
# the 21:00-05:00 pipeline window (RAM + the ETL's disk-spill ceiling) and the 06:00-19:00
# review-keeper window (RAM pinned).
#
# REMOTE: rclone remote named "prospect-backups:" — NEEDS-SETUP (one-time `rclone config`
# on the droplet, any S3/B2/Drive backend; see DEPLOY.md "Backups"). Until it exists this
# script stages locally, logs loudly, and does NOT push the success metric — so
# alert_check.py's backup-staleness alert doubles as the setup nag.
# Prune: remote dailies >30 days, weeklies >8 weeks (56d).
#
# METRIC: prospect_backup_last_success_timestamp pushed only when EVERYTHING (dump + upload
# + prune) succeeded; alert_check.py fires when it is >50h old.
#
# Version-controlled at prospect/deploy/backup.sh; scp'd to /root/backup.sh.
set -uo pipefail

# shellcheck source=deploy/lib.sh
if [ -f "$(dirname "$0")/lib.sh" ]; then
    . "$(dirname "$0")/lib.sh"
else
    echo "WARN: $(dirname "$0")/lib.sh missing — metric push disabled for this run" >&2
    prospect_push_metrics() { :; }
fi

STAGE=${PROSPECT_BACKUP_STAGE:-/root/backups}
REMOTE=${PROSPECT_BACKUP_REMOTE:-prospect-backups:prospect}
SIGNALS_DB=/root/steam-scraper/signals.db
GAMES_DB=/root/steam-scraper/steam_games.db
HISTORY=/root/prospect/data/refresh_history.json
DATE=$(date -u +%Y%m%d)
FAIL=0

log() { echo "[backup $(date -u '+%F %T')] $*"; }
mkdir -p "$STAGE"

if ! command -v sqlite3 >/dev/null 2>&1; then
    # NEEDS-VERIFICATION: the sqlite3 CLI is assumed present on the droplet (the scrapers
    # only use Python's sqlite3 module). `apt-get install -y sqlite3` if this trips.
    log "ERROR: sqlite3 CLI not installed — cannot take consistent snapshots"
    exit 1
fi

# ---- daily: signals.db (online .backup — consistent even against a live writer) ----
if [ -f "$SIGNALS_DB" ]; then
    if sqlite3 "$SIGNALS_DB" ".backup '$STAGE/signals-$DATE.db'"; then
        log "signals.db -> $STAGE/signals-$DATE.db ($(du -h "$STAGE/signals-$DATE.db" | cut -f1))"
    else
        log "ERROR: sqlite3 .backup of signals.db failed"
        FAIL=1
    fi
else
    log "ERROR: $SIGNALS_DB missing"
    FAIL=1
fi

# ---- daily: refresh_history.json (plain copy; append-only JSONL, cp is fine) ----
if cp "$HISTORY" "$STAGE/refresh_history-$DATE.json" 2>/dev/null; then
    log "refresh_history.json -> $STAGE/refresh_history-$DATE.json"
else
    log "ERROR: copy of $HISTORY failed"
    FAIL=1
fi

# ---- weekly (Sunday): steam_games.db ----
WEEKLY=0
if [ "$(date -u +%u)" = "7" ]; then
    WEEKLY=1
    if sqlite3 "$GAMES_DB" ".backup '$STAGE/steam_games-$DATE.db'"; then
        log "steam_games.db -> $STAGE/steam_games-$DATE.db ($(du -h "$STAGE/steam_games-$DATE.db" | cut -f1))"
    else
        log "ERROR: sqlite3 .backup of steam_games.db failed"
        FAIL=1
    fi
fi

# ---- sync to the rclone remote + prune old remote copies ----
if command -v rclone >/dev/null 2>&1 && rclone listremotes 2>/dev/null | grep -q '^prospect-backups:'; then
    for f in "$STAGE/signals-$DATE.db" "$STAGE/refresh_history-$DATE.json"; do
        [ -f "$f" ] || continue
        if rclone copy "$f" "$REMOTE/daily/" 2>&1; then
            log "uploaded $(basename "$f") -> $REMOTE/daily/"
        else
            log "ERROR: rclone upload of $(basename "$f") failed"
            FAIL=1
        fi
    done
    if [ "$WEEKLY" = 1 ] && [ -f "$STAGE/steam_games-$DATE.db" ]; then
        if rclone copy "$STAGE/steam_games-$DATE.db" "$REMOTE/weekly/" 2>&1; then
            log "uploaded steam_games-$DATE.db -> $REMOTE/weekly/"
        else
            log "ERROR: rclone upload of steam_games-$DATE.db failed"
            FAIL=1
        fi
    fi
    # Prune remote: dailies older than 30d, weeklies older than 8 weeks.
    rclone delete --min-age 30d "$REMOTE/daily/" 2>&1 || { log "WARN: daily prune failed"; FAIL=1; }
    rclone delete --min-age 56d "$REMOTE/weekly/" 2>&1 || { log "WARN: weekly prune failed"; FAIL=1; }
else
    log "NEEDS-SETUP: rclone remote 'prospect-backups:' not configured — staged locally only." \
        "One-time: install rclone + 'rclone config' to create the remote (DEPLOY.md 'Backups')."
    FAIL=1
fi

# ---- local staging hygiene ----
# The weekly 5.2GB staging copy is deleted IMMEDIATELY (uploaded or not): free disk on this
# box is the ETL's spill ceiling at 21:00, and a kept copy would sit exactly in that window.
# If its upload failed, the missing success metric raises the alert; next Sunday retries.
if [ "$WEEKLY" = 1 ]; then
    rm -f "$STAGE/steam_games-$DATE.db"
fi
# Keep 2 days of the small dailies locally for instant restores; older ones live remote.
find "$STAGE" -maxdepth 1 -name 'signals-*.db' -mtime +2 -delete 2>/dev/null || true
find "$STAGE" -maxdepth 1 -name 'refresh_history-*.json' -mtime +2 -delete 2>/dev/null || true

if [ "$FAIL" = 0 ]; then
    prospect_push_metrics "prospect_backup_last_success_timestamp $(date -u +%s)"
    log "OK — all backups completed"
    exit 0
fi
log "FAILED — at least one backup step failed (success metric NOT pushed; alert will fire)"
exit 1

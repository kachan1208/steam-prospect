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
# METRIC: prospect_backup_last_success_timestamp pushed when the BACKUP succeeded (dump +
# upload); alert_check.py fires when it is >50h old. Deliberately NOT gated on the remote
# prune: a prune failure means old copies linger, which is a housekeeping problem, and using
# it to withhold the success metric turned a perfectly healthy backup into a "backup is
# stale" page — a false alarm on the one channel that has to stay trustworthy. Prune
# failures are logged and set the exit code instead.
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
# Bound the weekly 5.2GB .backup: it is the only step here that can run long, it shares the
# 19:15-20:55 window with the quiet-window writers, and an unbounded one could still be
# copying when the 21:00 nightly wants the disk it is filling.
WEEKLY_TIMEOUT=${PROSPECT_BACKUP_TIMEOUT:-5400}
# Refuse the weekly copy unless the staging filesystem has the DB's size plus this much
# headroom. The disk is ~75% full and free space IS the ETL's spill ceiling.
HEADROOM_PCT=${PROSPECT_BACKUP_HEADROOM_PCT:-15}
FAIL=0          # gates the success metric (dump/upload)
PRUNE_FAIL=0    # does NOT gate the metric — see the header
UPLOAD_FAIL=0

log() { echo "[backup $(date -u '+%F %T')] $*"; }
mkdir -p "$STAGE"

# The weekly staging copy is 5.2GB on a disk that is ~75% full, so it must not survive this
# script under ANY exit path — not a failed .backup, not a timeout, not a SIGTERM from a cron
# runner. A trap, not a line at the bottom: the bottom is not reached when we are killed.
WEEKLY_STAGE=""
BACKUP_PID=""
# shellcheck disable=SC2329  # invoked indirectly, from the traps below
cleanup() {
    if [ -n "$BACKUP_PID" ] && kill -0 "$BACKUP_PID" 2>/dev/null; then
        kill -TERM -- "-$BACKUP_PID" 2>/dev/null || kill -TERM "$BACKUP_PID" 2>/dev/null || true
        sleep 2
        kill -KILL -- "-$BACKUP_PID" 2>/dev/null || kill -KILL "$BACKUP_PID" 2>/dev/null || true
    fi
    if [ -n "$WEEKLY_STAGE" ] && [ -f "$WEEKLY_STAGE" ]; then
        log "removing weekly staging copy $WEEKLY_STAGE ($(du -h "$WEEKLY_STAGE" 2>/dev/null | cut -f1))"
        rm -f "$WEEKLY_STAGE"
    fi
}
trap cleanup EXIT
trap 'exit 143' TERM INT HUP

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
    if [ ! -f "$GAMES_DB" ]; then
        log "ERROR: $GAMES_DB missing"
        FAIL=1
    else
        # Free-space precheck. Filling the disk here does not just fail the backup: free
        # space is what the 21:00 ETL spills into, so it would take the nightly down too.
        need_kb=$(du -k "$GAMES_DB" 2>/dev/null | cut -f1)
        free_kb=$(df -Pk "$STAGE" 2>/dev/null | awk 'NR==2 {print $4}')
        want_kb=$(( need_kb + need_kb * HEADROOM_PCT / 100 ))
        if [ -z "$need_kb" ] || [ -z "$free_kb" ]; then
            log "ERROR: could not measure free space for $STAGE — skipping the weekly copy"
            FAIL=1
        elif [ "$free_kb" -lt "$want_kb" ]; then
            log "ERROR: not enough free space for the weekly steam_games.db copy:" \
                "need $(( want_kb / 1024 ))MB (db $(( need_kb / 1024 ))MB + ${HEADROOM_PCT}%)," \
                "have $(( free_kb / 1024 ))MB on $(df -Pk "$STAGE" | awk 'NR==2 {print $6}')"
            FAIL=1
        else
            WEEKLY_STAGE="$STAGE/steam_games-$DATE.db"
            # Backgrounded + `wait` so a SIGTERM is acted on straight away. bash only runs a
            # trap between commands, so with a multi-minute .backup in the FOREGROUND the
            # cleanup would not fire until the 5.2GB copy finished — exactly the case where
            # leaving the file behind hurts.
            timeout "$WEEKLY_TIMEOUT" sqlite3 "$GAMES_DB" ".backup '$WEEKLY_STAGE'" &
            BACKUP_PID=$!
            wait "$BACKUP_PID"; rc=$?
            while kill -0 "$BACKUP_PID" 2>/dev/null; do wait "$BACKUP_PID"; rc=$?; done
            BACKUP_PID=""
            if [ "$rc" -eq 0 ]; then
                log "steam_games.db -> $WEEKLY_STAGE ($(du -h "$WEEKLY_STAGE" | cut -f1))"
            else
                log "ERROR: sqlite3 .backup of steam_games.db failed (rc=$rc$([ "$rc" -eq 124 ] \
                    && echo ", hit the ${WEEKLY_TIMEOUT}s timeout"))"
                FAIL=1
            fi
        fi
    fi
fi

# ---- sync to the rclone remote + prune old remote copies ----
# The guard tests the remote NAME derived from $REMOTE ("prospect-backups:prospect" ->
# "prospect-backups:"). It used to test a hardcoded 'prospect-backups:' while every action
# used $REMOTE, so overriding PROSPECT_BACKUP_REMOTE checked one remote and wrote to another.
REMOTE_NAME="${REMOTE%%:*}:"
if command -v rclone >/dev/null 2>&1 && rclone listremotes 2>/dev/null | grep -qx -- "$REMOTE_NAME"; then
    for f in "$STAGE/signals-$DATE.db" "$STAGE/refresh_history-$DATE.json"; do
        [ -f "$f" ] || continue
        if rclone copy "$f" "$REMOTE/daily/" 2>&1; then
            log "uploaded $(basename "$f") -> $REMOTE/daily/"
        else
            log "ERROR: rclone upload of $(basename "$f") failed"
            FAIL=1; UPLOAD_FAIL=1
        fi
    done
    if [ "$WEEKLY" = 1 ] && [ -n "$WEEKLY_STAGE" ] && [ -f "$WEEKLY_STAGE" ]; then
        if rclone copy "$WEEKLY_STAGE" "$REMOTE/weekly/" 2>&1; then
            log "uploaded $(basename "$WEEKLY_STAGE") -> $REMOTE/weekly/"
        else
            log "ERROR: rclone upload of $(basename "$WEEKLY_STAGE") failed"
            FAIL=1; UPLOAD_FAIL=1
        fi
    fi
    # Prune remote: dailies older than 30d, weeklies older than 8 weeks — ONLY when this
    # run's uploads all succeeded. Pruning after a failed upload deletes old copies to make
    # room for a new one that never arrived, which is how a backup system quietly turns into
    # no backup system at all.
    if [ "$UPLOAD_FAIL" = 0 ]; then
        rclone delete --min-age 30d "$REMOTE/daily/" 2>&1 || { log "WARN: daily prune failed"; PRUNE_FAIL=1; }
        rclone delete --min-age 56d "$REMOTE/weekly/" 2>&1 || { log "WARN: weekly prune failed"; PRUNE_FAIL=1; }
    else
        log "SKIPPING remote prune: an upload failed this run, so old remote copies are the" \
            "only copies left — they stay until a run uploads cleanly."
    fi
else
    log "NEEDS-SETUP: rclone remote '$REMOTE_NAME' not configured — staged locally only." \
        "One-time: install rclone + 'rclone config' to create the remote (DEPLOY.md 'Backups')."
    FAIL=1
fi

# ---- local staging hygiene ----
# The weekly 5.2GB staging copy is removed by the EXIT trap (uploaded or not): free disk on
# this box is the ETL's spill ceiling at 21:00, and a kept copy would sit exactly in that
# window. If its upload failed, the missing success metric raises the alert; next Sunday
# retries.
# Keep 2 days of the small dailies locally for instant restores; older ones live remote.
find "$STAGE" -maxdepth 1 -name 'signals-*.db' -mtime +2 -delete 2>/dev/null || true
find "$STAGE" -maxdepth 1 -name 'refresh_history-*.json' -mtime +2 -delete 2>/dev/null || true

if [ "$FAIL" = 0 ]; then
    # The backup itself is good, so the success clock advances even if the prune stumbled —
    # otherwise a housekeeping hiccup pages as "backup is stale", which is exactly the kind
    # of false alarm that teaches an operator to ignore the channel.
    prospect_push_metrics "prospect_backup_last_success_timestamp $(date -u +%s)"
    if [ "$PRUNE_FAIL" = 0 ]; then
        log "OK — all backups completed"
        exit 0
    fi
    log "OK (backup) but the remote PRUNE failed — success metric pushed, old remote copies" \
        "were not deleted; check the rclone output above"
    exit 1
fi
log "FAILED — at least one backup step failed (success metric NOT pushed; alert will fire)"
exit 1

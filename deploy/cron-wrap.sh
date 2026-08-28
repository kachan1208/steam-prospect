#!/usr/bin/env bash
# deploy/cron-wrap.sh — run a cron job under a nonblocking flock and make SKIPS VISIBLE.
#
# The problem this fixes: the crontab entries used a bare
#     flock -n /root/.prospect-refresh.lock <job>
# and the jobs redirect their own logs INSIDE the script (prospect-refresh.sh does its
# `exec >>$LOG` after startup), so when flock -n lost the race the job simply didn't run
# and NOTHING recorded that anywhere — no log line, no metric. A nightly that silently
# skipped looks identical to one that was never scheduled.
#
# Usage: cron-wrap.sh [-l LOCKFILE] JOB_NAME COMMAND [ARG...]
#   -l LOCKFILE   lock to take nonblocking (default /root/.prospect-refresh.lock)
#
# On lock held:    logs the skip to /var/log/prospect-cron-wrap.log, pushes
#                  prospect_cron_skipped{job="JOB_NAME"} 1 to the droplet-local
#                  VictoriaMetrics (deploy/observability/alert_check.py alerts on it),
#                  and exits 0 — a skip is a deliberate outcome, not a cron error.
# On lock free:    pushes the same series as 0 (so "ran" is distinguishable from "no
#                  data") and execs COMMAND, which inherits the lock fd and therefore
#                  holds the lock for its whole life.
#
# Version-controlled at prospect/deploy/cron-wrap.sh; scp'd to /root/cron-wrap.sh.
set -uo pipefail

LOCK=/root/.prospect-refresh.lock
WRAP_LOG=${CRON_WRAP_LOG:-/var/log/prospect-cron-wrap.log}
VM_IMPORT=${PROSPECT_VM_IMPORT:-http://localhost:8428/api/v1/import/prometheus}

usage() { echo "usage: $0 [-l LOCKFILE] JOB_NAME COMMAND [ARG...]" >&2; exit 2; }
while getopts "l:" opt; do
    case "$opt" in
        l) LOCK="$OPTARG" ;;
        *) usage ;;
    esac
done
shift $((OPTIND - 1))
[ "$#" -ge 2 ] || usage
JOB="$1"; shift

log() { echo "[cron-wrap $(date -u '+%F %T')] [$JOB] $*" >> "$WRAP_LOG"; }

# Mirrors the push() helper in prospect-refresh.sh EXCEPT that errors are not swallowed:
# the skip metric is this wrapper's entire reason to exist, so a push that fails earns a
# log line. It still never fails the wrapped job — telemetry must not take down the
# pipeline it watches.
push() {
    local out
    if ! out=$(curl -sS -m 8 -X POST "$VM_IMPORT" --data-binary "$1" 2>&1); then
        log "WARN: metric push failed: $out"
    fi
    return 0
}

exec 9>"$LOCK" || { log "ERROR: cannot open lock file $LOCK"; exit 1; }
if ! flock -n 9; then
    log "SKIPPED: $LOCK is held — did not run: $*"
    push "prospect_cron_skipped{job=\"$JOB\"} 1"
    exit 0
fi
push "prospect_cron_skipped{job=\"$JOB\"} 0"
log "lock acquired — exec: $*"
exec "$@"

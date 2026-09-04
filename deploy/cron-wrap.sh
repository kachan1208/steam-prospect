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
# Usage: cron-wrap.sh [-l LOCKFILE] [-x] JOB_NAME COMMAND [ARG...]
#   -l LOCKFILE   lock to take nonblocking (default /root/.prospect-refresh.lock)
#   -x            "expected deadline" job: rc 124 (GNU timeout expired) and rc 143 (SIGTERM)
#                 count as SUCCESS for the outcome push, and the log line says so. For a job
#                 whose own `timeout` IS its schedule: the 06:00 review keeper is a bounded
#                 slice of an open-ended backlog and has ended EVERY run at rc=124 since its
#                 7h bound landed (2026-09-02), so without this the wrapper pushed
#                 step_success=0 each morning and alert_check's check (a) breached daily.
#                 rc 137 stays a failure — that is the cgroup OOM kill, a real signal.
#
# On lock held:    logs the skip to /var/log/prospect-cron-wrap.log, pushes
#                  prospect_cron_skipped{job="JOB_NAME"} 1 to the droplet-local
#                  VictoriaMetrics (deploy/observability/alert_check.py evaluates it),
#                  and exits 0 — a skip is a deliberate outcome, not a cron error.
# On lock free:    pushes the same series as 0 (so "ran" is distinguishable from "no
#                  data"), runs COMMAND — which inherits the lock fd and therefore holds
#                  the lock for its whole life — and then pushes COMMAND's OUTCOME.
#
# WHY THE OUTCOME PUSH (2026-08-29): alert_check.py's headline check is "any
# prospect_pipeline_step_success == 0 in the last 24h", and only prospect-refresh.sh and
# light-build-cron.sh ever pushed that series. Everything else on the schedule — the twitch
# collector, the 19:15 quiet-window steps, the review/socials keepers, the backup — pushed
# NOTHING, so a repeat of the "22 of 26 nightlies failed silently" incident on exactly those
# jobs would still have been silent. Wrapping is now what makes a job monitored. Same metric
# names and labels prospect-refresh.sh's run_step uses (step="<JOB_NAME>"), so the existing
# check covers every wrapped job with no special-casing. Jobs that ALSO push the series
# themselves (light_build) just write the same value twice — harmless for min_over_time.
#
# COMMAND is run, not exec'd, so this wrapper survives to push that outcome. It forwards
# SIGTERM/SIGINT to COMMAND so `kill <cron-wrap pid>` still stops the job.
#
# Version-controlled at prospect/deploy/cron-wrap.sh; runs from the git checkout at
# /root/prospect/deploy/cron-wrap.sh (the flat /root/ copy it used to be scp'd to is
# retired — `git pull` in /root/prospect is the whole deploy for shell changes).
set -uo pipefail

LOCK=/root/.prospect-refresh.lock
WRAP_LOG=${CRON_WRAP_LOG:-/var/log/prospect-cron-wrap.log}
VM_IMPORT=${PROSPECT_VM_IMPORT:-http://localhost:8428/api/v1/import/prometheus}
STEP_LOG_DIR=${PROSPECT_STEP_LOG_DIR:-/var/log/prospect-steps}

# /var/log/prospect-steps used to be created only by the 21:00 nightly, yet earlier jobs log
# into it. Create it here, in the outermost wrapper, so it exists from the first job of the
# day. NOTE: this does NOT cover a crontab line's own `>> /var/log/prospect-steps/x.log`
# redirect — cron's shell performs that BEFORE exec'ing this script — which is why those
# entries in deploy/crontab.txt carry their own `mkdir -p … &&` prefix.
mkdir -p "$STEP_LOG_DIR" 2>/dev/null || true

EXPECT_DEADLINE=0
usage() { echo "usage: $0 [-l LOCKFILE] [-x] JOB_NAME COMMAND [ARG...]" >&2; exit 2; }
while getopts "l:x" opt; do
    case "$opt" in
        l) LOCK="$OPTARG" ;;
        x) EXPECT_DEADLINE=1 ;;
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
log "lock acquired — running: $*"

T0=$(date -u +%s)
"$@" &
CHILD=$!
# shellcheck disable=SC2329  # invoked indirectly, from the trap below
forward() { kill -TERM "$CHILD" 2>/dev/null || true; }
trap forward TERM INT HUP
wait "$CHILD"; RC=$?
# `wait` returns 128+N when a trapped signal interrupted it, with the child still running;
# wait again for its real status so the metric below is not a lie.
while kill -0 "$CHILD" 2>/dev/null; do wait "$CHILD"; RC=$?; done
trap - TERM INT HUP

DUR=$(( $(date -u +%s) - T0 ))
NOW=$(date -u +%s)
OK=1; NOTE=""
if [ "$RC" -ne 0 ]; then
    # -x: 124 is timeout's "deadline reached"; 143 is SIGTERM (an operator kill, or a timeout
    # landing on the `bash -c` around the job). Never 137 — the cgroup OOM kill is a failure.
    if [ "$EXPECT_DEADLINE" -eq 1 ] && { [ "$RC" -eq 124 ] || [ "$RC" -eq 143 ]; }; then
        NOTE=" (expected deadline)"
    else
        OK=0
    fi
fi
log "finished rc=$RC$NOTE after ${DUR}s"
push "prospect_pipeline_step_success{step=\"$JOB\"} $OK
prospect_pipeline_step_duration_seconds{step=\"$JOB\"} $DUR
prospect_pipeline_step_last_run_timestamp{step=\"$JOB\"} $NOW"
# A per-job success clock, so alert_check can tell "skipped once, ran fine yesterday" (normal,
# and the design explicitly calls some skips expected) from "has not completed in days".
[ "$OK" -eq 1 ] && push "prospect_cron_last_success_timestamp{job=\"$JOB\"} $NOW"
exit "$RC"

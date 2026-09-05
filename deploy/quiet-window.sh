#!/usr/bin/env bash
# deploy/quiet-window.sh — the 19:15 UTC quiet-window scraper steps (tags_refresh,
# refresh_released, review_histogram), run serially under ONE hard deadline.
#
# WHY THIS IS A SCRIPT AND NOT A CRONTAB ONE-LINER
# ------------------------------------------------
# The crontab entry used to be:
#     cron-wrap.sh quiet1915 timeout 6000 bash -c 'timeout 3600 A; timeout 2700 B; timeout 1800 C'
# and the outer `timeout 6000` could NOT enforce its own deadline, because of how GNU timeout
# and flock interact:
#
#   * cron-wrap.sh takes the refresh lock with `exec 9>LOCK; flock -n 9` and then execs the
#     command. fd 9 has no FD_CLOEXEC, so EVERY descendant — the outer timeout, the bash -c,
#     each inner timeout, each python — inherits a duplicate of that open file description.
#     An flock is released only when the LAST descriptor referring to that description is
#     closed. One surviving grandchild therefore keeps holding the lock.
#   * GNU timeout, unless given --foreground, puts itself in a NEW process group before
#     forking, and on expiry signals both its direct child and that process group ("in this
#     mode, children of COMMAND will not be timed out" is the --foreground man page's way of
#     saying the default DOES signal them). But each INNER `timeout` does the same thing, so
#     it moves itself and its python out of the outer timeout's group. The outer's group kill
#     cannot reach them.
#   * All the outer timeout can do is SIGTERM the `bash -c`. A non-interactive bash does not
#     forward signals to the child it is waiting on, so bash dies and the running inner
#     `timeout 3600 python …` is orphaned — still holding fd 9, for up to another hour.
#
# So a quiet-window overrun at 20:55 could hold the refresh lock past 21:00, and cron-wrap
# would then SKIP THE ENTIRE NIGHTLY — the single most expensive failure on this box.
#
# The structure here removes the whole class instead of patching it:
#   * ONE absolute deadline computed at start. Each step's budget is min(its own budget,
#     time left), so the steps cannot sum past the window no matter how they run.
#   * Each step is a DIRECT child of this script — no wrapping `bash -c`, no nested timeout
#     inside another timeout. Every `timeout` here is the outermost one for its own subtree,
#     so its process-group kill works as designed, and --kill-after escalates to SIGKILL for
#     anything that ignores SIGTERM.
#   * A trap kills the running step's process group if this script is itself terminated, so
#     the lock is released when this script exits and not a moment later.
#
# Also fixes the metrics gap: these three steps used to run with NO
# prospect_pipeline_step_success at all (they were moved out of the nightly, which pushes it
# for everything it runs), so a repeat of the "22 of 26 nights failed silently" incident on
# exactly the steps most prone to it would still have been silent. Same metric names and
# labels the nightly's run_step uses, so alert_check.py's step-failure check covers them
# with no special-casing.
#
# Version-controlled at prospect/deploy/quiet-window.sh; runs from the git checkout at
# /root/prospect/deploy/quiet-window.sh (the flat /root/ copy it used to be scp'd to is
# retired — `git pull` in /root/prospect is the whole deploy for shell changes).
# Launched by cron through cron-wrap.sh (see deploy/crontab.txt) — it must NOT be run
# unlocked while the nightly or a keeper backlog drain is writing steam_games.db.
set -uo pipefail

SCRAPER_DIR=${PROSPECT_SCRAPER_DIR:-/root/steam-scraper}
PY=${PROSPECT_SCRAPER_PY:-$SCRAPER_DIR/.venv/bin/python3}
LOG_DIR=${PROSPECT_STEP_LOG_DIR:-/var/log/prospect-steps}
# 6000s ≈ 20:55 for a 19:15 start: comfortably before the 21:00 nightly even after the
# SIGTERM/SIGKILL grace below.
WINDOW=${PROSPECT_QUIET_WINDOW_SECONDS:-6000}
# Never start a step with less than this left — a 30-second scrape run is pure lock
# contention with no useful output.
MIN_STEP=${PROSPECT_QUIET_MIN_STEP_SECONDS:-120}
GRACE=${PROSPECT_QUIET_KILL_GRACE:-60}

# shellcheck source=deploy/lib.sh
if [ -f "$(dirname "$0")/lib.sh" ]; then
    . "$(dirname "$0")/lib.sh"
else
    echo "WARN: $(dirname "$0")/lib.sh missing — metric push disabled for this run" >&2
    prospect_push_metrics() { :; }
    NICE=()   # un-niced rather than not at all
fi

mkdir -p "$LOG_DIR"
RUN_TS=$(date -u +%Y%m%d-%H%M%S)
DEADLINE=$(( $(date -u +%s) + WINDOW ))
FAILED=0
STEP_PID=""

log() { echo "[quiet-window $(date -u '+%F %T')] $*"; }

# Kill the step's whole process group if we are terminated. `timeout` made itself a process
# group leader before forking, so its PID is that group's PGID and `kill -- -PID` reaches the
# python and anything it spawned. The `|| kill PID` is the belt for the (not expected) case
# where no separate group exists; it can never hit our own group, whose PGID is not a live
# child's PID.
# shellcheck disable=SC2329  # invoked indirectly, from the traps below
cleanup() {
    if [ -n "$STEP_PID" ] && kill -0 "$STEP_PID" 2>/dev/null; then
        log "terminating in-flight step (pid $STEP_PID) so the refresh lock is not held on"
        kill -TERM -- "-$STEP_PID" 2>/dev/null || kill -TERM "$STEP_PID" 2>/dev/null || true
        sleep 5
        kill -KILL -- "-$STEP_PID" 2>/dev/null || kill -KILL "$STEP_PID" 2>/dev/null || true
    fi
}
trap cleanup EXIT
trap 'cleanup; exit 143' TERM INT HUP

if ! command -v timeout >/dev/null 2>&1; then
    log "ERROR: coreutils \`timeout\` not found — refusing to run unbounded inside the window"
    exit 1
fi

# run_step LABEL BUDGET_SECONDS COMMAND [ARG...]
run_step() {
    local label="$1" budget="$2"; shift 2
    local slog="$LOG_DIR/${label}.${RUN_TS}.log"
    local now left rc=0 t0 dur ok

    now=$(date -u +%s)
    left=$(( DEADLINE - now ))
    if [ "$left" -lt "$MIN_STEP" ]; then
        log "SKIPPED $label — only ${left}s left of the quiet window (need ${MIN_STEP}s)"
        # Reported as a FAILED step on purpose: the step did not run, so its data is as stale
        # as if it had crashed, and a window that routinely runs out is a scheduling bug that
        # should be visible rather than quietly absorbed.
        prospect_push_metrics "prospect_pipeline_step_success{step=\"$label\"} 0
prospect_pipeline_step_duration_seconds{step=\"$label\"} 0
prospect_pipeline_step_last_run_timestamp{step=\"$label\"} $now"
        FAILED=$((FAILED + 1))
        return 0
    fi
    [ "$budget" -gt "$left" ] && budget="$left"

    t0=$now
    log "start $label (budget ${budget}s, ${left}s left in window) -> $slog"
    # Backgrounded + `wait` so the traps above can fire while a step is running; bash only
    # runs a trap between commands otherwise, which would be after the whole step.
    # "${NICE[@]}" (lib.sh) sits between timeout and the step: nice/ionice exec straight into
    # the python, so `timeout` is still the group leader the cleanup trap kills by PGID.
    timeout --kill-after="$GRACE" "$budget" "${NICE[@]}" "$@" >"$slog" 2>&1 &
    STEP_PID=$!
    wait "$STEP_PID"; rc=$?
    # `wait` returns 128+N when a trapped signal interrupted it, with the child still alive.
    while kill -0 "$STEP_PID" 2>/dev/null; do wait "$STEP_PID"; rc=$?; done
    STEP_PID=""

    dur=$(( $(date -u +%s) - t0 ))
    ok=1
    if [ "$rc" -ne 0 ]; then
        ok=0
        FAILED=$((FAILED + 1))
        log "WARN: $label exited rc=$rc after ${dur}s$([ "$rc" -eq 124 ] && echo ' (hit its timeout)')"
        # Put the reason in THIS log, next to the WARN — chasing a per-step log by hand is how
        # the chronic twitch breakage stayed invisible for weeks.
        tail -25 "$slog" 2>/dev/null | sed 's/^/    | /'
    else
        log "done $label ${dur}s"
    fi
    prospect_push_metrics "prospect_pipeline_step_success{step=\"$label\"} $ok
prospect_pipeline_step_duration_seconds{step=\"$label\"} $dur
prospect_pipeline_step_last_run_timestamp{step=\"$label\"} $(date -u +%s)"
}

cd "$SCRAPER_DIR" || { log "ERROR: cannot cd $SCRAPER_DIR"; exit 1; }
log "quiet window start — deadline $(date -u -d "@$DEADLINE" '+%F %T' 2>/dev/null || echo "+${WINDOW}s")"

# Budgets carried over from the old run_step lines these three came from. Their SUM (8100s)
# deliberately exceeds the window; the deadline arithmetic above is what makes that safe.
run_step tags_refresh     3600 "$PY" -m steam_scraper.scraper --db steam_games.db \
    refresh-stale-tags --workers 12 --rate 3.0 --limit 4000
run_step refresh_released 2700 "$PY" -m steam_scraper.scraper --db steam_games.db \
    enrich --refresh-unreleased --limit 6000 --workers 12 --rate 6.0
run_step review_histogram 1800 "$PY" -m steam_scraper.scraper --db steam_games.db \
    review-histogram --min-reviews 50 --workers 16 --rate 10.0

if [ "$FAILED" -eq 0 ]; then
    log "OK — all 3 steps completed inside the window"
    exit 0
fi
log "FAILED — $FAILED of 3 steps failed or were skipped (metrics pushed; alert_check sees them)"
exit 1

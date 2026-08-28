# shellcheck shell=bash
# deploy/lib.sh — tiny shared helpers for the droplet ops scripts (prospect-refresh.sh,
# light-build-cron.sh, rollback.sh, backup.sh). scp'd to /root/lib.sh next to them by
# deploy/deploy-scripts.sh; every consumer sources it as "$(dirname "$0")/lib.sh" so the
# same line works both in the repo (deploy/) and on the box (/root/).
#
# Deliberately NOT sourced by cron-wrap.sh: the wrapper is the outermost guard for every
# cron job, and it must not gain a file dependency that could turn "lib.sh missing after a
# partial scp" into "no cron job on the box runs at all".

PROSPECT_VM_IMPORT="${PROSPECT_VM_IMPORT:-http://localhost:8428/api/v1/import/prometheus}"

# prospect_push_metrics "<prometheus-format lines>" — push to the droplet-local
# VictoriaMetrics. Unlike prospect-refresh.sh's own push(), a failure is LOGGED (stderr) —
# but still never fails the caller: metrics are how problems become visible, so a silently
# dropped push is itself a problem worth a line, while a hard failure would kill a data job
# over telemetry.
prospect_push_metrics() {
    local out
    if ! out=$(curl -sS -m 8 -X POST "$PROSPECT_VM_IMPORT" --data-binary "$1" 2>&1); then
        echo "WARN: [lib] metric push to $PROSPECT_VM_IMPORT failed: $out" >&2
    fi
    return 0
}

# prospect_health_wait [TIMEOUT_S] — poll the app's /api/health until it answers or the
# budget (default 120s) runs out. Probes INSIDE the container first (docker exec + the
# image's own curl against the container port 8080 — immune to whatever host port mapping
# `docker run` used, which is not recorded in this repo), then falls back to the host port.
# NEEDS-VERIFICATION: the host-port fallback assumes -p 8080:8080; confirm with
# `docker port prospect` on the droplet and export PROSPECT_HEALTH_HOST_PORT if different.
prospect_health_wait() {
    local budget="${1:-120}" deadline
    deadline=$(( $(date -u +%s) + budget ))
    while :; do
        if docker exec prospect curl -sf -m 5 "http://localhost:8080/api/health" >/dev/null 2>&1 \
           || curl -sf -m 5 "http://localhost:${PROSPECT_HEALTH_HOST_PORT:-8080}/api/health" >/dev/null 2>&1; then
            return 0
        fi
        [ "$(date -u +%s)" -ge "$deadline" ] && return 1
        sleep 5
    done
}

# prospect_restart_verify [TIMEOUT_S] — docker restart + health poll. Nonzero if the restart
# command failed OR the app never answered /api/health. `docker restart` exiting 0 only
# means dockerd accepted the request — a container that crash-loops on boot still
# "restarted" successfully as far as that exit code is concerned, which is exactly how a
# failed nightly restart used to report OK.
prospect_restart_verify() {
    docker restart prospect || return 1
    prospect_health_wait "${1:-120}"
}

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

# prospect_http_code PATH — echo the HTTP status of PATH ("000" if nothing answered).
# Probes INSIDE the container first (docker exec + the image's own curl against the container
# port 8080 — immune to whatever host port mapping `docker run` used, which is not recorded in
# this repo), then falls back to the host port.
# NEEDS-VERIFICATION: the host-port fallback assumes -p 8080:8080; confirm with
# `docker port prospect` on the droplet and export PROSPECT_HEALTH_HOST_PORT if different.
prospect_http_code() {
    local path="$1" code=""
    code=$(docker exec prospect curl -s -o /dev/null -m 5 -w '%{http_code}' \
               "http://localhost:8080${path}" 2>/dev/null) || code=""
    if [ -z "$code" ] || [ "$code" = "000" ]; then
        code=$(curl -s -o /dev/null -m 5 -w '%{http_code}' \
                   "http://localhost:${PROSPECT_HEALTH_HOST_PORT:-8080}${path}" 2>/dev/null) || code=""
    fi
    echo "${code:-000}"
}

# prospect_health_body_ok — the legacy path, for an image that predates /api/health/ready.
# /api/health is LIVENESS: it returns 200 even when the mart failed to load, with a body of
# {"status":"degraded"}. So parse the status field instead of trusting the 200 — otherwise a
# restart that comes back serving NO DATA is reported as verified, which is exactly the
# failure the restart verification was added to catch.
prospect_health_body_ok() {
    local body=""
    body=$(docker exec prospect curl -s -m 5 "http://localhost:8080/api/health" 2>/dev/null) || body=""
    if [ -z "$body" ]; then
        body=$(curl -s -m 5 "http://localhost:${PROSPECT_HEALTH_HOST_PORT:-8080}/api/health" 2>/dev/null) || body=""
    fi
    case "$body" in
        *'"status":"ok"'*|*'"status": "ok"'*) return 0 ;;
    esac
    return 1
}

# prospect_health_wait [TIMEOUT_S] — poll until the app is READY to serve data, or the budget
# (default 120s) runs out.
#
# READY, not merely answering: the probe is /api/health/ready, which is 200 only once the
# analytics DB is open and 503 until then. /api/health is a liveness probe that returns 200
# with status "degraded" when the mart failed to load — polling that reported "verified" for
# a restart that serves nothing.
#
# 404 means the running image predates /api/health/ready (it ships with the API branch that
# adds it), NOT that the app is unhealthy — fall back to parsing /api/health's status field,
# which is the same question asked of an older contract. Anything else (503 not-ready, 000
# nothing listening) keeps polling until the deadline.
prospect_health_wait() {
    local budget="${1:-120}" deadline code legacy_noted=0
    deadline=$(( $(date -u +%s) + budget ))
    while :; do
        code=$(prospect_http_code /api/health/ready)
        case "$code" in
            200) return 0 ;;
            404)
                if [ "$legacy_noted" -eq 0 ]; then
                    echo "note: [lib] /api/health/ready is absent (pre-readiness image) —" \
                         "verifying via /api/health's status field instead" >&2
                    legacy_noted=1
                fi
                prospect_health_body_ok && return 0
                ;;
        esac
        [ "$(date -u +%s)" -ge "$deadline" ] && return 1
        sleep 5
    done
}

# prospect_restart_verify [TIMEOUT_S] — docker restart + readiness poll. Nonzero if the
# restart command failed OR the app never became ready. `docker restart` exiting 0 only
# means dockerd accepted the request — a container that crash-loops on boot still
# "restarted" successfully as far as that exit code is concerned, which is exactly how a
# failed nightly restart used to report OK.
prospect_restart_verify() {
    docker restart prospect || return 1
    prospect_health_wait "${1:-120}"
}

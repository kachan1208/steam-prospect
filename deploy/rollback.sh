#!/usr/bin/env bash
# deploy/rollback.sh — repoint the app at a previous mart version and restart it, verified.
#
# Usage:
#   rollback.sh              # roll back to the newest mart that is NOT the current one
#   rollback.sh 20260827     # roll back to a specific version (prospect_20260827.duckdb)
#   rollback.sh --list       # just show what's available and which one is live
#
# The app reads $DATA_DIR/current.duckdb — a RELATIVE symlink to a prospect_YYYYMMDD.duckdb
# in the same directory (relative so it also resolves inside the container, where the same
# directory is mounted at /app/data). Retention is build_marts.py --keep (2 = current + one
# rollback), so in steady state there is exactly one version to roll back to.
# NEEDS-VERIFICATION: confirm the live symlink is relative (`readlink
# /root/prospect/data/current.duckdb` should print a bare filename, no leading /).
#
# Version-controlled at prospect/deploy/rollback.sh; scp'd to /root/rollback.sh.
set -euo pipefail

DATA_DIR=${PROSPECT_DATA_DIR:-/root/prospect/data}
LINK="$DATA_DIR/current.duckdb"

# shellcheck source=deploy/lib.sh
if [ -f "$(dirname "$0")/lib.sh" ]; then
    . "$(dirname "$0")/lib.sh"
else
    echo "WARN: $(dirname "$0")/lib.sh missing — restart verification degraded to a blind restart" >&2
    prospect_restart_verify() { docker restart prospect && sleep 15; }
fi

shopt -s nullglob
marts=("$DATA_DIR"/prospect_*.duckdb)   # glob sort = chronological (YYYYMMDD names)
shopt -u nullglob

current=$(readlink "$LINK" 2>/dev/null || true)
current=${current##*/}

if [ "${1:-}" = "--list" ]; then
    echo "marts in $DATA_DIR (current -> ${current:-NONE}):"
    for m in "${marts[@]}"; do
        base=${m##*/}
        [ "$base" = "$current" ] && echo "  * $base  (current)" || echo "    $base"
    done
    exit 0
fi

if [ "${#marts[@]}" -lt 2 ]; then
    echo "REFUSING to roll back: ${#marts[@]} mart(s) in $DATA_DIR — need at least 2" >&2
    echo "(current -> ${current:-NONE}; there is nothing to roll back to)" >&2
    exit 1
fi

if [ -n "${1:-}" ]; then
    want=${1#prospect_}; want=${want%.duckdb}
    target="prospect_${want}.duckdb"
    if [ ! -f "$DATA_DIR/$target" ]; then
        echo "ERROR: $DATA_DIR/$target does not exist. Available:" >&2
        for m in "${marts[@]}"; do echo "  ${m##*/}" >&2; done
        exit 1
    fi
else
    target=""
    for (( i=${#marts[@]}-1; i>=0; i-- )); do        # newest first
        base=${marts[$i]##*/}
        if [ "$base" != "$current" ]; then target="$base"; break; fi
    done
    if [ -z "$target" ]; then
        echo "ERROR: could not find a mart other than the current one ($current)" >&2
        exit 1
    fi
fi

if [ "$target" = "$current" ]; then
    echo "ERROR: $target is already the current mart — nothing to do" >&2
    exit 1
fi

echo "rollback: current.duckdb  ${current:-NONE}  ->  $target"
ln -sfn "$target" "$LINK"

echo "restarting the app and waiting for /api/health (up to 120s) ..."
if prospect_restart_verify 120; then
    echo "OK: app is healthy and serving $target (was: ${current:-NONE})"
    exit 0
fi

echo "ERROR: app failed /api/health on $target" >&2
if [ -n "$current" ] && [ -f "$DATA_DIR/$current" ]; then
    echo "reverting symlink to $current and restarting again ..." >&2
    ln -sfn "$current" "$LINK"
    if prospect_restart_verify 120; then
        echo "reverted: app is healthy again on $current — rollback ABORTED" >&2
    else
        echo "CRITICAL: app is unhealthy on BOTH marts — check 'docker logs prospect'" >&2
    fi
fi
exit 1

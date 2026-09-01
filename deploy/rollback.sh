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
# Version-controlled at prospect/deploy/rollback.sh; runs from the git checkout at
# /root/prospect/deploy/rollback.sh (the flat /root/ copy it used to be scp'd to is
# retired — `git pull` in /root/prospect is the whole deploy for shell changes).
set -euo pipefail

DATA_DIR=${PROSPECT_DATA_DIR:-/root/prospect/data}
LINK="$DATA_DIR/current.duckdb"
HOLD_FILE=${PROSPECT_BUILD_HOLD:-/root/.prospect-build-hold}
HOLD_HOURS=${PROSPECT_BUILD_HOLD_HOURS:-48}

# lib.sh is a HARD requirement here, unlike in the nightly (which degrades loudly rather than
# lose a whole night over a helper file). This script's entire value is "the app is verified
# healthy on the old mart"; the fallback it used to define — `docker restart && sleep 15` —
# reported health that was never checked, which is precisely the bug the verification exists
# to prevent, in the one script an operator runs while production is already broken.
if [ ! -f "$(dirname "$0")/lib.sh" ]; then
    echo "ERROR: $(dirname "$0")/lib.sh is missing — refusing to run." >&2
    echo "       Without it this script cannot verify the app came back, and a rollback that" >&2
    echo "       reports success without checking is worse than no rollback." >&2
    echo "       Fix: cd /root/prospect && git pull  (lib.sh lives next to this script in the" >&2
    echo "       checkout; deploy/deploy-scripts.sh verifies the checkout is complete)." >&2
    exit 1
fi
# shellcheck source=deploy/lib.sh
. "$(dirname "$0")/lib.sh"

# Atomic symlink swap. `ln -sfn` unlinks the existing symlink and then creates the new one, so
# between those two syscalls $LINK DOES NOT EXIST — and both uvicorn workers, a concurrent
# build and any operator command can look exactly then and find nothing. Create the link under
# a temp name in the same directory and rename(2) it over the target instead: a reader sees
# either the old mart or the new one, never a missing file.
atomic_relink() {
    local target="$1" link="$2" tmp
    tmp="${link}.rollback.$$"
    ln -sn "$target" "$tmp" || return 1
    mv -Tf "$tmp" "$link" || { rm -f "$tmp"; return 1; }
}

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
atomic_relink "$target" "$LINK" || { echo "ERROR: could not repoint $LINK" >&2; exit 1; }

echo "restarting the app and waiting for readiness (up to 120s) ..."
if prospect_restart_verify 120; then
    echo "OK: app is healthy and serving $target (was: ${current:-NONE})"
    # A rollback only moves a symlink. The next scheduled build (nightly 21:00, light build
    # 13:00) writes a NEW mart and repoints current.duckdb at it — silently undoing this,
    # usually before anyone looks. Leave a hold that every build checks first.
    {
        echo "held_at=$(date -u '+%F %T')Z"
        echo "reason=rollback.sh repointed current.duckdb ${current:-NONE} -> $target"
        echo "expires_after_hours=$HOLD_HOURS"
    } > "$HOLD_FILE"
    echo
    echo "BUILD HOLD placed at $HOLD_FILE — the nightly and the midday light build will SKIP"
    echo "  (and push prospect_build_hold_active, which alert_check.py pages on) until you"
    echo "  release it. It AUTO-EXPIRES after ${HOLD_HOURS}h so a forgotten hold cannot freeze"
    echo "  the pipeline; a hold is not a fix, it is time to find one."
    echo "  Release with:  rm -f $HOLD_FILE"
    exit 0
fi

echo "ERROR: app is not ready on $target" >&2
if [ -n "$current" ] && [ -f "$DATA_DIR/$current" ]; then
    echo "reverting symlink to $current and restarting again ..." >&2
    atomic_relink "$current" "$LINK" || echo "ERROR: could not revert $LINK" >&2
    if prospect_restart_verify 120; then
        echo "reverted: app is healthy again on $current — rollback ABORTED" >&2
    else
        echo "CRITICAL: app is unhealthy on BOTH marts — check 'docker logs prospect'" >&2
    fi
fi
exit 1

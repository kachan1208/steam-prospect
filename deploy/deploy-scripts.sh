#!/usr/bin/env bash
# deploy/deploy-scripts.sh — wire the droplet's git checkout into the box's system services.
#
# HISTORY: this script used to scp every ops script flat into /root/, and cron ran those
# copies. That ended 2026-09-01: the crontab runs everything FROM THE CHECKOUT at
# /root/prospect/deploy, so `git pull` in /root/prospect is the whole deploy for shell
# changes and the flat /root/*.sh copies could only drift from the repo (they are unused;
# delete them after one clean nightly). This script now does only what git cannot: make the
# checkout's scripts executable, install the logrotate config, print the schedule install,
# and prove the box's checkout matches this repo hash-for-hash.
#
# PREREQUISITE (both modes): the box checkout is current —
#   ssh -i $KEY $HOST 'cd /root/prospect && git pull --ff-only'
# The hash check at the bottom is the guard against forgetting it: it compares every file
# the box executes against THIS checkout and fails on any drift (missed pull, stray box-side
# edit, interrupted fetch). For a clean comparison, run this script from a local checkout
# of the same commit the box has.
#
# Default mode PRINTS the exact ssh commands instead of running them (an operator session
# may lack ssh permission — copy-paste them by hand). With --execute it runs them itself
# and then sha256-verifies, because a checkout on the box that silently differs from the
# repo is a nightly running code nobody reviewed.
#
# Usage:
#   deploy/deploy-scripts.sh              # print the commands only
#   deploy/deploy-scripts.sh --execute    # run them + sha256-verify the box checkout
#
# The crontab is NEVER installed automatically (not even under --execute) — the install
# command is printed at the end, same as before the checkout move. The one-time
# reconciliation of deploy/crontab.txt against the live box happened 2026-08-29 and is
# recorded in that file's header; re-check the same way if the schedule ever diverges again.
set -euo pipefail

HOST=${PROSPECT_DROPLET:-root@142.93.49.69}
KEY=${PROSPECT_SSH_KEY:-$HOME/.ssh/prospect_droplet}
SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
CHECKOUT=/root/prospect          # the box-side clone; cron runs $CHECKOUT/deploy/* directly

# Repo-relative (to deploy/) paths of everything the box EXECUTES or INSTALLS from the
# checkout — the set the hash check holds the box accountable for. entrypoint.sh is
# deliberately NOT in it: it is baked into the image, never run from the checkout.
FILES=(
    "prospect-refresh.sh"
    "light-build-cron.sh"
    "cron-wrap.sh"
    "quiet-window.sh"
    "lib.sh"
    "backup.sh"
    "rollback.sh"
    "run-prospect.sh"
    # Not on any cron schedule — a one-shot backlog drain the operator launches by hand
    # (per ops notes, under systemd-run with a MemoryMax). Verified so the box matches the
    # repo; verifying it does not start it.
    "socials_marathon.sh"
    "deploy-scripts.sh"
    "observability/alert_check.py"
    "crontab.txt"
    "logrotate.d/prospect"
)

# Names (relative to deploy/) that are NOT executed directly — everything else gets an
# explicit `chmod +x` in the box checkout.
#
# This is not belt-and-braces, it is load-bearing: git preserves exec bits, but a fresh
# clone on a filesystem without them (or an operator's `cp` from a zip) loses them, and a
# cron line that execs a mode-less script fails with "Permission denied" at 21:00. This is
# the same class of outage the old scp flow's chmod guarded against — several of these
# files were once committed 100644, and `scp -p` then chmod'd the +x bit AWAY on the live
# box. The git modes are fixed; the chmod keeps the deploy correct regardless of what mode
# the box's checkout happens to have.
NO_EXEC=(
    "crontab.txt"           # data, installed with `crontab <file>`
    "lib.sh"                # sourced with `.`, never executed
    "logrotate.d/prospect"  # data, installed into /etc/logrotate.d/
)

EXECUTE=0
[ "${1:-}" = "--execute" ] && EXECUTE=1

sha_local() {
    if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1"; else shasum -a 256 "$1"; fi
}

echo "# target: $HOST (key: $KEY)"
echo "# checkout on the box: $CHECKOUT (scripts live under $CHECKOUT/deploy/)"
echo "# first make sure it is current: ssh -i $KEY $HOST 'cd $CHECKOUT && git pull --ff-only'"
echo

EXEC_TARGETS=()
for path in "${FILES[@]}"; do
    if [ ! -f "$SCRIPT_DIR/$path" ]; then
        echo "ERROR: missing $SCRIPT_DIR/$path" >&2
        exit 1
    fi
    skip_exec=0
    for n in "${NO_EXEC[@]}"; do [ "$path" = "$n" ] && skip_exec=1; done
    [ "$skip_exec" = 0 ] && EXEC_TARGETS+=("$CHECKOUT/deploy/$path")
done

CHMOD_CMD="chmod +x ${EXEC_TARGETS[*]}"
LOGROTATE_CMD="install -m 0644 $CHECKOUT/deploy/logrotate.d/prospect /etc/logrotate.d/prospect"
CRONTAB_CMD="crontab $CHECKOUT/deploy/crontab.txt && crontab -l | diff - $CHECKOUT/deploy/crontab.txt && echo in-sync"

if [ "$EXECUTE" = 1 ]; then
    echo "+ ssh ... '$CHMOD_CMD'"
    ssh -i "$KEY" "$HOST" "$CHMOD_CMD"
    echo
    echo "+ ssh ... '$LOGROTATE_CMD'"
    ssh -i "$KEY" "$HOST" "$LOGROTATE_CMD"
else
    echo "# make the checkout's scripts executable (see NO_EXEC above for why this matters):"
    echo "ssh -i $KEY $HOST '$CHMOD_CMD'"
    echo
    echo "# install the logrotate config for the cron-redirected logs (root, which the ops"
    echo "# model already is; verify with: logrotate -d /etc/logrotate.d/prospect):"
    echo "ssh -i $KEY $HOST '$LOGROTATE_CMD'"
fi

if [ "$EXECUTE" = 1 ]; then
    echo
    echo "# verifying the box checkout against this one (sha256) ..."
    remote_hashes=$(ssh -i "$KEY" "$HOST" "cd $CHECKOUT/deploy && sha256sum ${FILES[*]}")
    fail=0
    for path in "${FILES[@]}"; do
        want=$(sha_local "$SCRIPT_DIR/$path" | awk '{print $1}')
        got=$(printf '%s\n' "$remote_hashes" | awk -v f="$path" '$2 == f {print $1}')
        if [ "$want" = "$got" ] && [ -n "$want" ]; then
            echo "  OK   $path"
        else
            echo "  FAIL $path (local $want, box ${got:-<missing>}) — did the box git pull run?"
            fail=1
        fi
    done
    [ "$fail" = 1 ] && { echo "ERROR: box checkout differs from this repo — fix the FAIL lines above" >&2; exit 1; }
else
    echo
    echo "# after pulling on the box, verify its checkout matches this one:"
    echo "ssh -i $KEY $HOST 'cd $CHECKOUT/deploy && sha256sum ${FILES[*]}'"
    echo "# compare locally with: (cd $SCRIPT_DIR && shasum -a 256 ${FILES[*]})"
fi

echo
echo "# install the schedule (NEVER automatic — run this after a last look at the diff"
echo "# between deploy/crontab.txt and 'crontab -l' on the box; the file's header records"
echo "# the reconciliation discipline):"
echo "ssh -i $KEY $HOST '$CRONTAB_CMD'"
echo
echo "# if this install RE-ENABLES the 19:30 backup (it is enabled in this crontab since"
echo "# 2026-09-01): also remove ALERT_CHECK_BACKUPS=0 from /root/.prospect-alerts.env,"
echo "# or the backup-staleness alert stays blind while the job runs (see crontab.txt)."

#!/usr/bin/env bash
# deploy/deploy-scripts.sh — ship the droplet ops scripts to /root/ on the box.
#
# Default mode PRINTS the exact scp/ssh commands instead of running them (an operator
# session may lack ssh permission — copy-paste them by hand). With --execute it runs them
# itself and then sha256-compares every file against the remote copy, because a truncated
# scp of prospect-refresh.sh is a broken nightly.
#
# Usage:
#   deploy/deploy-scripts.sh              # print the commands only
#   deploy/deploy-scripts.sh --execute    # actually scp + verify hashes
#
# The crontab is NEVER installed automatically — the install command is printed at the
# end; run it after reconciling deploy/crontab.txt's NEEDS-VERIFICATION entries against
# `crontab -l` on the box (see the header of that file).
set -euo pipefail

HOST=${PROSPECT_DROPLET:-root@142.93.49.69}
KEY=${PROSPECT_SSH_KEY:-$HOME/.ssh/prospect_droplet}
SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)

# "repo-relative-source[:name-on-the-box]" — everything lands flat in /root/, which is
# where the crontab and the scripts' own `dirname $0`/lib.sh sourcing expect them.
FILES=(
    "prospect-refresh.sh"
    "light-build-cron.sh"
    "cron-wrap.sh"
    "quiet-window.sh"
    "lib.sh"
    "backup.sh"
    "rollback.sh"
    # Not on any cron schedule — a one-shot backlog drain the operator launches by hand
    # (per ops notes, under systemd-run with a MemoryMax). Shipped so /root/ matches the
    # repo; copying it does not start it.
    "socials_marathon.sh"
    "observability/alert_check.py:alert_check.py"
    "crontab.txt"
)

# Names (as they land in /root/) that are NOT executed directly — everything else gets an
# explicit `chmod +x` on the box after the copy.
#
# This is not belt-and-braces, it is load-bearing: `scp -p` PRESERVES the local mode, and
# several of these files were committed 100644 (deploy/prospect-refresh.sh and
# deploy/light-build-cron.sh among them — the nightly itself and the midday build). Copying
# them would have chmod'd the +x bit AWAY on the live box and left cron entries that exec
# them directly failing with "Permission denied" every night. The git modes are corrected in
# the same commit as this; the chmod makes the deploy correct regardless of what mode the
# local checkout happens to have (a fresh clone on a filesystem without exec bits, an
# operator's `cp` from a zip, …).
NO_EXEC=(
    "crontab.txt"   # data, installed with `crontab <file>`
    "lib.sh"        # sourced with `.`, never executed
)

EXECUTE=0
[ "${1:-}" = "--execute" ] && EXECUTE=1

sha_local() {
    if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1"; else shasum -a 256 "$1"; fi
}

echo "# target: $HOST (key: $KEY)"
echo "# sources: $SCRIPT_DIR"
echo

REMOTE_HASH_CMD="sha256sum"
DESTS=()
EXEC_DESTS=()
for spec in "${FILES[@]}"; do
    src="${spec%%:*}"
    dest="${spec#*:}"; [ "$dest" = "$spec" ] && dest="$(basename "$src")"
    if [ ! -f "$SCRIPT_DIR/$src" ]; then
        echo "ERROR: missing $SCRIPT_DIR/$src" >&2
        exit 1
    fi
    DESTS+=("/root/$dest")
    skip_exec=0
    for n in "${NO_EXEC[@]}"; do [ "$dest" = "$n" ] && skip_exec=1; done
    [ "$skip_exec" = 0 ] && EXEC_DESTS+=("/root/$dest")
    cmd=(scp -p -i "$KEY" "$SCRIPT_DIR/$src" "$HOST:/root/$dest")
    if [ "$EXECUTE" = 1 ]; then
        echo "+ ${cmd[*]}"
        "${cmd[@]}"
    else
        echo "${cmd[*]}"
    fi
done

CHMOD_CMD="chmod +x ${EXEC_DESTS[*]}"
if [ "$EXECUTE" = 1 ]; then
    echo
    echo "+ ssh ... '$CHMOD_CMD'"
    ssh -i "$KEY" "$HOST" "$CHMOD_CMD"
else
    echo
    echo "# make the scripts executable (scp -p preserves the LOCAL mode — see NO_EXEC above):"
    echo "ssh -i $KEY $HOST '$CHMOD_CMD'"
fi

if [ "$EXECUTE" = 1 ]; then
    echo
    echo "# verifying sha256 of every copied file ..."
    remote_hashes=$(ssh -i "$KEY" "$HOST" "$REMOTE_HASH_CMD ${DESTS[*]}")
    fail=0
    i=0
    for spec in "${FILES[@]}"; do
        src="${spec%%:*}"
        dest="${DESTS[$i]}"; i=$((i + 1))
        want=$(sha_local "$SCRIPT_DIR/$src" | awk '{print $1}')
        got=$(printf '%s\n' "$remote_hashes" | awk -v f="$dest" '$2 == f {print $1}')
        if [ "$want" = "$got" ] && [ -n "$want" ]; then
            echo "  OK   $dest"
        else
            echo "  FAIL $dest (local $want, remote ${got:-<missing>})"
            fail=1
        fi
    done
    [ "$fail" = 1 ] && { echo "ERROR: hash mismatch — re-run the scp for the FAIL lines" >&2; exit 1; }
else
    echo
    echo "# after copying, verify the hashes match:"
    echo "ssh -i $KEY $HOST '$REMOTE_HASH_CMD ${DESTS[*]}'"
    echo "# compare locally with: (cd $SCRIPT_DIR && shasum -a 256 ${FILES[*]%%:*})"
fi

echo
echo "# install the schedule (AFTER reconciling deploy/crontab.txt's NEEDS-VERIFICATION"
echo "# entries against the live 'crontab -l' — see that file's header):"
echo "ssh -i $KEY $HOST 'crontab /root/crontab.txt && crontab -l'"

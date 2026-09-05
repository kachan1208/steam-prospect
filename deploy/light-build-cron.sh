#!/bin/bash
# Midday light mart build: every mart except the two full-text monsters (those are
# copied from the published mart — see LIGHT_COPY in etl/build_marts.py). Restarts
# the app only after a successful build+swap, and only reports success if the app
# actually answers /api/health afterwards.
#
# Lives as a script ON PURPOSE: as an inline cron command the pgrep guard shared
# one /bin/sh cmdline with the launch command's literal "build_marts.py", so the
# bracketed pattern matched the cron shell itself and the build silently skipped
# every day. As a script, cron's cmdline is just this file's path.
#
# LOCKING (2026-08-28): must be launched through cron-wrap.sh (the crontab entry does):
#     /root/prospect/deploy/cron-wrap.sh light_build /root/prospect/deploy/light-build-cron.sh
# cron-wrap takes /root/.prospect-refresh.lock nonblocking, so a held lock (nightly
# overrun, the 06:00 review keeper mid-backlog-drain, a manual full build under the lock)
# SKIPS this run with a pushed prospect_cron_skipped metric instead of stacking a second
# DuckDB build onto the 3.9GB box. Skipping while the keeper drains is EXPECTED — the
# light build is an opportunistic freshness bonus, not a dependency.
# The pgrep below stays as a second guard for builds launched OUTSIDE the lock (a manual
# `build_marts.py` in an interactive shell) — but it is advisory only (TOCTOU), which is
# why the scratch sweep no longer trusts it blindly.
set -uo pipefail

# shellcheck source=deploy/lib.sh
if [ -f "$(dirname "$0")/lib.sh" ]; then
    . "$(dirname "$0")/lib.sh"
else
    echo "WARN: $(dirname "$0")/lib.sh missing — restart verification degraded to a blind" \
         "restart and metric pushes disabled" >&2
    prospect_restart_verify() { docker restart prospect && sleep 15; }
    prospect_push_metrics() { :; }
    NICE=()   # un-niced rather than not at all
fi

# Every redirect below writes here. cron-wrap.sh also creates it, but this script is run by
# hand often enough that it should not depend on its launcher.
mkdir -p /var/log/prospect-steps 2>/dev/null || true

# Build hold (deploy/rollback.sh) — same contract as the nightly's, see prospect-refresh.sh:
# a rollback is undone by the next build unless a build checks for the hold first. Auto-expires
# so it cannot freeze the pipeline; prospect_build_hold_active feeds alert_check.py.
HOLD_FILE=${PROSPECT_BUILD_HOLD:-/root/.prospect-build-hold}
HOLD_HOURS=${PROSPECT_BUILD_HOLD_HOURS:-48}
if [ -f "$HOLD_FILE" ] && [ -z "$(find "$HOLD_FILE" -mmin +$(( HOLD_HOURS * 60 )) 2>/dev/null)" ]; then
    {
        echo "[light build $(date -u '+%F %T')] SKIPPED — build hold active ($HOLD_FILE):"
        sed 's/^/    /' "$HOLD_FILE"
        echo "    release with: rm -f $HOLD_FILE (expires on its own after ${HOLD_HOURS}h)"
    } >> /var/log/prospect-steps/light-build.cron.log
    prospect_push_metrics "prospect_build_hold_active 1"
    exit 0
fi

# Skip if a mart build is already running — but a `--rescore-only` run is NOT a mart build.
# It writes only the sentiment cache, never a mart and never the swap, and it holds the cache
# for ~3s per ~16-minute bucket (measured; see _attach_sentiment_cache's lock notes). Treating
# it as a competing build froze the published mart for the whole multi-day rescore, which is
# precisely what --rescore-only exists to avoid: on 2026-09-02 the 13:30 light build logged
# `finished rc=0 after 0s` while a rescore ran, because this line matched it.
#
# `grep -v` over `pgrep -af`, not a second pgrep pattern: the check must be "is any build_marts
# running that is NOT a rescore", and a bare pattern cannot express the negative. The `-n` test
# keeps an empty pgrep (no builds at all) from reading as a match.
_builds="$(pgrep -af "[b]uild_marts" || true)"
if [ -n "$_builds" ] && printf '%s' "$_builds" | grep -qv -- "--rescore-only"; then
    exit 0
fi

# Stale-scratch sweep. The old bare
#     rm -rf /root/prospect/data/*.duckdb.building*
# trusted the pgrep above, but pgrep-then-rm is a TOCTOU: a build that starts between the
# check and the rm (or one whose cmdline doesn't match) would have its ~18GB spill deleted
# mid-build. So the sweep only removes artifacts that cannot belong to a LIVE build.
#
# Excluding "today's version" alone was not that test (2026-08-29): this runs at 13:00, and
# the build most likely to still be running is the NIGHTLY that started at 21:00 — whose
# scratch is named for YESTERDAY once it crosses midnight. The old exclusion protected the
# one date that was never at risk and swept the one that was.
#
# Three conditions now, any one of which spares a file:
#   * named for today's version   — a manual/midday build started since 00:00 UTC
#   * named for yesterday's       — an overrunning nightly
#   * touched in the last 2h      — the real liveness test; a running DuckDB build writes to
#                                   its spill constantly, an orphan from a killed run does not
find /root/prospect/data -maxdepth 1 -name 'prospect_*.duckdb.building*' \
     ! -name "prospect_$(date -u +%Y%m%d).duckdb.building*" \
     ! -name "prospect_$(date -u -d yesterday +%Y%m%d).duckdb.building*" \
     -mmin +120 -exec rm -rf {} + 2>/dev/null || true

cd /root/prospect/etl || exit 1
# Memory (2026-09-04): the same systemd-run cgroup cap the keepers and the nightly ETL run
# under. 2400M rather than the nightly's 3000M because the 06:15 socials keeper (own lock,
# capped at 1500M) can still be running at 13:30: 2400M + 1500M + ~900M app/OS is the whole
# 3.9 GB box only if BOTH peak at once, and then the cgroup kills this opportunistic build
# instead of letting the box thrash. DuckDB gets 1800MB of the 2400M; the rest is the Python
# heap. Move the two numbers together.
if PROSPECT_DUCKDB_MEMORY_LIMIT=1800MB PYTHONUNBUFFERED=1 \
    timeout 14400 systemd-run --scope --quiet -p MemoryMax=2400M -p MemorySwapMax=0 "${NICE[@]}" \
      /root/prospect/etl/.venv/bin/python -u build_marts.py \
      --source /root/steam-scraper/steam_games.db \
      --data-dir /root/prospect/data --light \
      >> /var/log/prospect-steps/light-build.cron.log 2>&1; then
    # Same fix as the nightly (2026-08-28): a bare `docker restart` that exits 0 says
    # nothing about whether the app came back. Verify /api/health for up to 120s and make
    # a failed comeback loud + metric-visible instead of silently serving nothing.
    if prospect_restart_verify 120; then
        prospect_push_metrics "prospect_pipeline_step_success{step=\"light_build\"} 1
prospect_pipeline_step_last_run_timestamp{step=\"light_build\"} $(date -u +%s)"
    else
        echo "ERROR: light build swapped the mart but the app failed /api/health within 120s" \
             >> /var/log/prospect-steps/light-build.cron.log
        prospect_push_metrics "prospect_pipeline_step_success{step=\"light_build\"} 0
prospect_pipeline_step_last_run_timestamp{step=\"light_build\"} $(date -u +%s)"
        exit 1
    fi
else
    # Build failed/timed out: build_marts keeps the previous mart, app untouched. Push the
    # failure so alert_check.py (step_success == 0) sees it — the old one-liner exited with
    # the build's rc and nothing anywhere recorded that the midday build had died.
    echo "ERROR: light build failed or timed out — previous mart kept, app not restarted" \
         >> /var/log/prospect-steps/light-build.cron.log
    prospect_push_metrics "prospect_pipeline_step_success{step=\"light_build\"} 0
prospect_pipeline_step_last_run_timestamp{step=\"light_build\"} $(date -u +%s)"
    exit 1
fi

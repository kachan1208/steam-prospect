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
#     /root/cron-wrap.sh light_build /root/light-build-cron.sh
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
    echo "WARN: $(dirname "$0")/lib.sh missing — restart verification degraded to a blind restart" >&2
    prospect_restart_verify() { docker restart prospect && sleep 15; }
fi

pgrep -f "[b]uild_marts" >/dev/null && exit 0

# Stale-scratch sweep, scoped to EXCLUDE today's version (2026-08-28). The old bare
#     rm -rf /root/prospect/data/*.duckdb.building*
# trusted the pgrep above, but pgrep-then-rm is a TOCTOU: a build that starts between the
# check and the rm (or one whose cmdline doesn't match) would have its ~18GB spill deleted
# mid-build. Mirror the nightly's careful pattern instead: only sweep artifacts that do NOT
# belong to a build started today — those are orphans from a killed/OOMed run by definition.
find /root/prospect/data -maxdepth 1 -name 'prospect_*.duckdb.building*' \
     ! -name "prospect_$(date -u +%Y%m%d).duckdb.building*" -exec rm -rf {} + 2>/dev/null || true

cd /root/prospect/etl || exit 1
if PROSPECT_DUCKDB_MEMORY_LIMIT=1700MB PYTHONUNBUFFERED=1 \
    timeout 14400 .venv/bin/python -u build_marts.py \
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

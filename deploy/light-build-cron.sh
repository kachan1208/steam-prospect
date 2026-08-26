#!/bin/bash
# Midday light mart build: every mart except the two full-text monsters (those are
# copied from the published mart — see LIGHT_COPY in etl/build_marts.py). Restarts
# the app only after a successful build+swap.
#
# Lives as a script ON PURPOSE: as an inline cron command the pgrep guard shared
# one /bin/sh cmdline with the launch command's literal "build_marts.py", so the
# bracketed pattern matched the cron shell itself and the build silently skipped
# every day. As a script, cron's cmdline is just this file's path.
set -u
pgrep -f "[b]uild_marts" >/dev/null && exit 0
# Guard just confirmed no build is running, so a leftover .building.tmp is an
# orphan from a killed/OOMed run — clear it or today's build refuses the name.
rm -rf /root/prospect/data/*.duckdb.building*
cd /root/prospect/etl || exit 1
PROSPECT_DUCKDB_MEMORY_LIMIT=1700MB PYTHONUNBUFFERED=1 \
  timeout 14400 .venv/bin/python -u build_marts.py \
    --source /root/steam-scraper/steam_games.db \
    --data-dir /root/prospect/data --light \
    >> /var/log/prospect-steps/light-build.cron.log 2>&1 \
  && docker restart prospect >/dev/null

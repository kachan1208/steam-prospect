# Prospect alerting (droplet-local, no extra containers)

The pipeline has pushed health metrics to the droplet's VictoriaMetrics
(`localhost:8428`) since day one — `prospect_pipeline_step_success`,
`prospect_pipeline_last_success_timestamp`, `prospect_data_freshness_hours` — but nothing
ever *evaluated* them: a step once failed 22 of 26 nights while a Grafana panel charted it
faithfully to nobody. `alert_check.py` is the missing evaluator. It is a 30-minute cron
job (see `deploy/crontab.txt`), Python stdlib only. Deliberately **not**
vmalert + alertmanager: the box has 3.9GB RAM and the 06:00–19:00 review keeper already
pins it — two more always-on containers is exactly the wrong trade.

## What it checks

| # | Condition | Threshold |
|---|-----------|-----------|
| a | any `prospect_pipeline_step_success == 0` | in the last 24h, per step |
| b | age of `max(prospect_pipeline_last_success_timestamp)` | > 30h (nightly runs 21:00 UTC, so >30h = a whole night lost) |
| c | `prospect_data_freshness_hours` | > 48h, per source |
| d | age of `prospect_cron_last_success_timestamp` (pushed by `cron-wrap.sh` on a clean run) | > 36h, per job (`ALERT_JOB_STALE_HOURS`) |
| e | age of `prospect_backup_last_success_timestamp` (pushed by `backup.sh`) | > 50h |
| f | VictoriaMetrics itself unreachable | immediate |
| g | `prospect_build_hold_active` (a `rollback.sh` hold nobody released) | latest sample is 1 |
| h | free disk on the filesystem holding `/root` (pushes `prospect_disk_free_pct`; evaluated even when VM is down) | < `DISK_MIN_FREE_PCT` (default 30%, so it pages before the nightly's own 25 GB gate refuses to build) |

**Every wrapped cron job is covered by (a).** `cron-wrap.sh` pushes
`prospect_pipeline_step_success{step="<job>"}` for whatever it runs, so the twitch
collector, the 19:15 quiet-window steps (which also push per-step metrics of their own),
the keepers and the backup are all evaluated. That is the point: before this, the four
steps most prone to the "database is locked" failure — the very incident that motivated
this script — pushed nothing at all, so a repeat would have been just as silent. **Putting
a new job behind `cron-wrap.sh` is what puts it under alerting.** A job whose own `timeout`
is its schedule (the 06:00 review keeper, a bounded slice of an open-ended backlog) is
wrapped with `cron-wrap.sh -x`: rc 124/143 then push success instead of breaching (a) every
day; rc 137 (cgroup OOM kill) still fails.

**(d) deliberately does not page on skips.** Skips are a designed outcome — the midday
light build is *supposed* to skip while the review keeper holds the refresh lock — and
paging on each one would have made this channel noise from day one, which is how an alert
channel stops being read. What matters is a job that stops *completing*, so the check is on
the per-job success clock: >36h without a clean run (a daily job missing more than one full
day) pages, a routine skip does not. A job that is skipping and has never completed at all
pages too, since it has no clock to age.

One consolidated notification per run; each condition re-alerts at most once per 12h
(state in `/root/.prospect-alert-state.json`). A condition that resolves is forgotten, so
a later re-fire alerts immediately.

## The dead man's switch (the one alert that survives the box)

Everything above runs **on the droplet**: this script, the VictoriaMetrics it queries, the
Grafana that draws it. If the box is down, the disk is full, cron was wiped or this script
was never installed, none of it can fire — and that silence is indistinguishable from
health. So set `DEADMAN_URL` to a free external heartbeat check (healthchecks.io, Cronitor,
Better Stack, UptimeRobot — any URL that expects a periodic GET). `alert_check.py` pings it
after every run that completed **and** got its alerts out, so a dead box, a dead cron *and*
a broken notification channel all show up as a missed heartbeat, raised from outside.

Unset it and the feature is simply off (a `WARN` on a failed ping, never a failed run).

Set the service's period to ~1h with a ~30 min grace: the check runs every 30 min, so one
missed run is normal jitter and two in a row is not.

## Setup (one-time, on the droplet)

1. The script runs from the git checkout at `/root/prospect/deploy/observability/`
   (`git pull` in `/root/prospect` keeps it current), and `deploy/crontab.txt` carries
   the `*/30` entry — install with `crontab /root/prospect/deploy/crontab.txt`.
2. Create `/root/.prospect-alerts.env` (chmod 600, never in git):

   ```sh
   # Zero-setup default: pick a long random topic name (the topic IS the secret),
   # then subscribe in the ntfy mobile/desktop app or at https://ntfy.sh/<topic>.
   NTFY_TOPIC=prospect-alerts-<long-random-suffix>

   # And/or a generic JSON webhook (Slack-compatible: POSTs {"text": "<message>"}).
   #WEBHOOK_URL=https://hooks.slack.com/services/T000/B000/XXXX

   # STRONGLY RECOMMENDED — outbound heartbeat to an external dead-man service. Without it
   # a dead droplet alerts nobody, because every other check lives on the droplet.
   #DEADMAN_URL=https://hc-ping.com/<uuid>

   # Optional knobs (defaults shown):
   #NTFY_SERVER=https://ntfy.sh
   #ALERT_SUPPRESS_HOURS=12
   # A job that has not completed successfully in this many hours is a breach. 36h = a daily
   # job missed more than one whole day.
   #ALERT_JOB_STALE_HOURS=36
   # Jobs excluded from the per-job health check entirely. The midday light_build is the
   # candidate: it is an opportunistic freshness bonus, and it legitimately skips for as long
   # as the 06:00 review keeper's backlog drain holds the refresh lock. Exclude it only if a
   # multi-day drain is normal for you — otherwise leave it monitored.
   # (ALERT_IGNORE_SKIPPED_JOBS is accepted as an alias for this.)
   #ALERT_IGNORE_JOBS=light_build
   # Breach when the filesystem holding /root has less than this percent free. 30 pages
   # before the nightly's own disk gate (PROSPECT_DISK_MIN_FREE_GB=25 in prospect-refresh.sh:
   # an 18 GB spill + a 2.3 GB mart) refuses to build.
   #DISK_MIN_FREE_PCT=30
   # When the 19:30 backup job is deliberately NOT scheduled, silence its staleness check
   # with this (otherwise remove it — see the history block in deploy/crontab.txt).
   #ALERT_CHECK_BACKUPS=0
   ```

3. Test end-to-end without waiting for a real failure:

   ```sh
   /root/prospect/deploy/observability/alert_check.py     # prints ok / breaches; exit 0-1
   # force a send: point it at a bogus VM so 'vm_unreachable' fires
   PROSPECT_VM_URL=http://127.0.0.1:1 PROSPECT_ALERT_STATE=/tmp/s.json \
       /root/prospect/deploy/observability/alert_check.py
   ```

Cron output lands in `/var/log/prospect-alerts.log` (see the crontab entry).

## Related metrics written elsewhere

- `prospect_cron_skipped{job=...}` — `deploy/cron-wrap.sh` (1 on skip, 0 on run).
- `prospect_pipeline_step_success{step="<job>"}`, `..._duration_seconds`,
  `..._last_run_timestamp` and `prospect_cron_last_success_timestamp{job=...}` —
  `deploy/cron-wrap.sh`, for every job it wraps. Same names/labels the nightly's `run_step`
  uses, which is why checks (a) and (d) need no per-job configuration.
- `prospect_build_hold_active` — `deploy/prospect-refresh.sh` and
  `deploy/light-build-cron.sh` (1 = a `rollback.sh` hold is stopping builds, 0 = building).
- `prospect_backup_last_success_timestamp` — `deploy/backup.sh` (19:30 UTC daily; weekly
  `steam_games.db` copy on Sundays). Backup design + rclone remote setup: `DEPLOY.md`,
  "Backups" section.
- `prospect_pipeline_step_success{step="restart"}` — pushed by `prospect-refresh.sh` after
  the post-ETL `docker restart` health verification, and `{step="light_build"}` by
  `light-build-cron.sh`; both feed check (a) automatically.
- `prospect_alert_check_last_run_timestamp` — the checker's own heartbeat. If it flatlines
  on the pipeline dashboard, the watcher itself is dead (cron removed, python broken).
- `prospect_disk_free_pct` — pushed by `alert_check.py` itself on every run (check h), so
  the dashboard shows disk headroom approaching the ETL's spill ceiling before it arrives.

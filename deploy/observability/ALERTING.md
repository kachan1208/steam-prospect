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
| d | `prospect_cron_skipped` (pushed by `cron-wrap.sh` on a lost `flock -n`) | any skip in the last 24h, per job |
| e | age of `prospect_backup_last_success_timestamp` (pushed by `backup.sh`) | > 50h |
| f | VictoriaMetrics itself unreachable | immediate |

One consolidated notification per run; each condition re-alerts at most once per 12h
(state in `/root/.prospect-alert-state.json`). A condition that resolves is forgotten, so
a later re-fire alerts immediately.

## Setup (one-time, on the droplet)

1. `deploy/deploy-scripts.sh` copies `alert_check.py` to `/root/alert_check.py` and
   `deploy/crontab.txt` carries the `*/30` entry — install with `crontab /root/crontab.txt`.
2. Create `/root/.prospect-alerts.env` (chmod 600, never in git):

   ```sh
   # Zero-setup default: pick a long random topic name (the topic IS the secret),
   # then subscribe in the ntfy mobile/desktop app or at https://ntfy.sh/<topic>.
   NTFY_TOPIC=prospect-alerts-<long-random-suffix>

   # And/or a generic JSON webhook (Slack-compatible: POSTs {"text": "<message>"}).
   #WEBHOOK_URL=https://hooks.slack.com/services/T000/B000/XXXX

   # Optional knobs (defaults shown):
   #NTFY_SERVER=https://ntfy.sh
   #ALERT_SUPPRESS_HOURS=12
   # light_build skips are EXPECTED whenever the 06:00 review keeper is mid-backlog-drain
   # (it holds the refresh lock all day); uncomment to silence just those:
   #ALERT_IGNORE_SKIPPED_JOBS=light_build
   ```

3. Test end-to-end without waiting for a real failure:

   ```sh
   /root/alert_check.py                     # prints ok / breaches; exit 0-1
   # force a send: point it at a bogus VM so 'vm_unreachable' fires
   PROSPECT_VM_URL=http://127.0.0.1:1 PROSPECT_ALERT_STATE=/tmp/s.json /root/alert_check.py
   ```

Cron output lands in `/var/log/prospect-alerts.log` (see the crontab entry).

## Related metrics written elsewhere

- `prospect_cron_skipped{job=...}` — `deploy/cron-wrap.sh` (1 on skip, 0 on run).
- `prospect_backup_last_success_timestamp` — `deploy/backup.sh` (19:30 UTC daily; weekly
  `steam_games.db` copy on Sundays). Backup design + rclone remote setup: `DEPLOY.md`,
  "Backups" section.
- `prospect_pipeline_step_success{step="restart"}` — pushed by `prospect-refresh.sh` after
  the post-ETL `docker restart` health verification, and `{step="light_build"}` by
  `light-build-cron.sh`; both feed check (a) automatically.
- `prospect_alert_check_last_run_timestamp` — the checker's own heartbeat. If it flatlines
  on the pipeline dashboard, the watcher itself is dead (cron removed, python broken).

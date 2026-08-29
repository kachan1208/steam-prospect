# Deploying Prospect

Production is **one DigitalOcean droplet** — `142.93.49.69`, reachable at
<https://142-93-49-69.nip.io>. 3.9GB RAM, 2 vCPU, 77GB disk (~75% full: free disk is the
ETL's spill ceiling — treat it as a shared resource, not slack). There is **no staging**;
the App Platform app described at the bottom is a **legacy leftover**, not the deployment.

```
┌─ droplet 142.93.49.69 ──────────────────────────────────────────────────────────┐
│                                                                                 │
│  /root/steam-scraper/            scraper code + venv                            │
│      steam_games.db  (5.2GB)     source-of-truth SQLite (games/reviews/…)       │
│      signals.db                  forward-only follower/price series —           │
│                                  CAN NEVER BE BACKFILLED (see Backups)          │
│  /root/prospect/                 this repo (git clone; deploys pull here)       │
│      data/prospect_YYYYMMDD.duckdb   nightly marts (build_marts.py --keep 2)    │
│      data/current.duckdb         RELATIVE symlink -> the live mart              │
│      data/refresh_history.json   nightly run ledger                             │
│  /root/*.sh, /root/alert_check.py    ops scripts, scp'd flat from deploy/       │
│                                  (deploy/deploy-scripts.sh does the copying)    │
│                                                                                 │
│  docker container `prospect`     built from the repo Dockerfile; serves SPA +   │
│                                  /api + /mcp from the mart, port 8080 inside    │
│  VictoriaMetrics :8428           local-only; every job pushes metrics here     │
│  Grafana                         reads the local VM (dashboards in              │
│                                  deploy/observability/grafana/)                 │
└─────────────────────────────────────────────────────────────────────────────────┘
```

Daily schedule (UTC) — the full, installable crontab lives in `deploy/crontab.txt`:
21:00 nightly refresh (scrape → ETL → verified restart) · ~05:00 done · 06:00–19:00
daytime review/socials keepers (**pin the RAM**) · 13:00 light mart build (skips if the
lock is held) · 19:15 quiet-window scraper jobs · 19:30 backups · every 30 min alert
check.

---

## Deploying code (the actual flow)

Deploys are manual: merge to `main`, then rebuild on the box.

> **NEVER `docker build` between 06:00 and 19:00 UTC.** The daytime review keeper pins
> the box's RAM for that whole window; a build on top of it swap-thrashes the droplet
> into unreachability. Deploy before 06:00 or after 19:00 UTC (19:00–21:00 is the
> comfortable slot; the nightly owns 21:00 onward).

```bash
ssh -i ~/.ssh/prospect_droplet root@142.93.49.69
cd /root/prospect && git pull
docker build -t prospect .
# Recreate the container from the new image. `docker restart` alone would keep running
# the OLD image. NEEDS-VERIFICATION: the live `docker run` flags (port mapping, the
# /root/prospect/data -> /app/data mount, restart policy) are not recorded in this repo —
# read them once with `docker inspect prospect` and save them as /root/run-prospect.sh:
docker stop prospect && docker rm prospect
/root/run-prospect.sh        # the saved `docker run --name prospect ...` line
curl -sf https://142-93-49-69.nip.io/api/health && echo OK
```

### Shipping the ops scripts + schedule

The shell scripts are **not** run from the git clone — they are scp'd flat to `/root/`
(`/root/prospect-refresh.sh` etc.). After changing anything under `deploy/`:

```bash
deploy/deploy-scripts.sh            # prints the scp commands + hash check + crontab install
deploy/deploy-scripts.sh --execute  # or run them for you, sha256-verifying every copy
```

The schedule itself is `deploy/crontab.txt` — the deployed artifact, installed with
`crontab /root/crontab.txt` (the file's header explains the one-time reconciliation
against `crontab -l` before first install).

---

## Mart data flow

1. Scraper jobs (nightly Lane A/B + daytime keepers + 19:15 quiet window) write
   `/root/steam-scraper/steam_games.db` (WAL; every writer sets a busy_timeout).
2. The nightly ETL (`build_marts.py`, inside `prospect-refresh.sh`) reads that SQLite and
   builds `/root/prospect/data/prospect_YYYYMMDD.duckdb`, spilling up to ~18GB of scratch
   while it runs; on success it atomically repoints the `current.duckdb` symlink and
   prunes old versions (`--keep 2` = current + one rollback).
3. `docker restart prospect` makes the app reopen the mart; the restart is **verified** —
   the script polls `/api/health` for 120s and the night reports FAILED if the app never
   comes back.
4. A midday `--light` build (everything except the two full-text monster marts, ~30min)
   gives same-day freshness when it can take the lock.
5. `signals.db` (followers/prices collectors, Lane B) is served **live** by the API — it
   bypasses the mart entirely.

The container sees the mart because `/root/prospect/data` is mounted at `/app/data`
(`PROSPECT_ANALYTICS_DB_PATH=/app/data/current.duckdb`; the symlink is relative so it
resolves on both sides of the mount).

## Rollback

```bash
/root/rollback.sh --list      # show versions + which is live
/root/rollback.sh             # repoint current.duckdb at the previous mart, restart,
                              # verify readiness; auto-reverts if the app comes up sick
/root/rollback.sh 20260827    # or a specific version
```

Refuses to run when only one mart exists. Source: `deploy/rollback.sh`.

**A rollback is temporary.** It only moves the `current.duckdb` symlink; the next scheduled
build (nightly 21:00, light build 13:00) writes a new mart and repoints the symlink at it,
silently undoing the rollback. So a successful rollback drops a **build hold** at
`/root/.prospect-build-hold`, which both build scripts check before doing any work:

```bash
cat /root/.prospect-build-hold        # who placed it, when, and why
rm -f /root/.prospect-build-hold      # release it — do this as soon as the fix is in
```

While the hold is on, the nightly and the light build log a "HELD" line and exit without
building, and push `prospect_build_hold_active 1` so the alert check pages about it — a hold
that stops the pipeline must never be quiet. It **auto-expires after 48 h**
(`PROSPECT_BUILD_HOLD_HOURS`), because a forgotten hold would be a new way to lose a week of
data silently. A hold buys time to find the fix; it is not the fix.

## Backups

`deploy/backup.sh` (cron 19:30 UTC daily — after the quiet-window jobs, before the
nightly; justification in the script header):

- **daily**: sqlite3 online `.backup` of `signals.db` (**the forward-only series — a lost
  day is unrecoverable, this file is the whole reason backups exist**) + a copy of
  `refresh_history.json`;
- **weekly** (Sunday): `.backup` of the 5.2GB `steam_games.db`, refused unless the disk has
  its size + 15 % free, bounded by a timeout, and the staged copy is deleted on **every**
  exit path — free disk is the ETL's spill ceiling;
- sync to the rclone remote `prospect-backups:`, pruning remote dailies >30d and
  weeklies >8w — the prune is **skipped** when an upload failed, so a bad run can never
  delete the copies it failed to replace;
- pushes `prospect_backup_last_success_timestamp` when the **backup** succeeded (a failed
  prune is logged and sets the exit code, but does not withhold the metric — that produced
  false "backup is stale" pages); the alert check fires when it goes >50h stale, so an
  unconfigured remote nags you by itself.

**NEEDS-SETUP (one-time, on the droplet):** install rclone and create the remote —
`apt-get install -y rclone && rclone config` → name it exactly `prospect-backups`, any
backend you like (B2/S3/R2/Drive). Nothing else to configure.

**Restore:** `rclone copy prospect-backups:prospect/daily/signals-YYYYMMDD.db /root/` →
verify with `sqlite3 signals-… 'PRAGMA integrity_check'` → stop writers (collectors run
21:00+), move into place, restart.

## Alerting

`deploy/observability/alert_check.py` runs every 30 min from cron and evaluates the
pipeline-health metrics in the local VictoriaMetrics (step failures — including every job
run through `cron-wrap.sh` — stale runs, stale data, cron jobs falling behind, stale
backups, an unreleased build hold). One-time setup = create `/root/.prospect-alerts.env`
with an ntfy topic or webhook URL, **plus a `DEADMAN_URL`**: every other check runs on the
droplet, so only an outbound heartbeat to an external service can tell you the box itself
died. Full instructions in `deploy/observability/ALERTING.md`.

---

## Legacy appendix: DigitalOcean App Platform (NOT the deployment)

An App Platform app was created early on and **may still exist and bill**:

- URL <https://prospect-vkqdh.ondigitalocean.app> · App ID
  `f069bc96-4278-4765-aef7-fb967bd9aafa` · plan `basic-xxs` · region `nyc` · created from
  `.do/app.git.yaml`.
- **Operator action: delete it manually** if it's still there —
  `doctl apps delete f069bc96-4278-4765-aef7-fb967bd9aafa` (or DO panel → Apps). It serves
  a months-stale mart at best and costs ~$5/mo for nothing.

The `.do/*.yaml` specs are kept only in case a throwaway public demo is ever wanted
again: single Docker image, mart downloaded at boot from `PROSPECT_DUCKDB_URL` (a GitHub
Release asset named `current.duckdb`), health check on `/api/health/ready`,
`WEB_CONCURRENCY=1` (512MB instance cannot fit two DuckDB-loaded workers). Ephemeral
state, no login, no Analytics Chat. If you resurrect it: push the repo, upload the mart
as a release asset (`gh release upload data-latest … --clobber`), `doctl apps create
--spec .do/app.yaml`, and redeploy after every data refresh — it has no other way to see
new marts.

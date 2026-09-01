#!/usr/bin/env python3
"""Prospect alert check — evaluate the pipeline-health metrics nobody was watching.

The nightly refresh has pushed prospect_pipeline_step_success /
prospect_pipeline_last_success_timestamp / prospect_data_freshness_hours to the
droplet-local VictoriaMetrics for months (deploy/prospect-refresh.sh, .../export_metrics.py)
— and NOTHING evaluated them: a step once failed 22 of 26 nights with a dashboard panel
faithfully charting the carnage. This script is the missing evaluator. It is a plain cron
script (every 30 min, see deploy/crontab.txt), stdlib-only, because the box has 3.9GB RAM
and ~no headroom for vmalert+alertmanager containers.

Checks (all against http://localhost:8428):
  a) any prospect_pipeline_step_success == 0 within the last 24h        (per step)
  b) time() - max(prospect_pipeline_last_success_timestamp) > 30h      (nightly is 21:00,
     so >30h means a whole night produced no successful run)
  c) prospect_data_freshness_hours > 48                                (per source)
  d) a cron job that is FALLING BEHIND — see below                     (per job)
  e) time() - prospect_backup_last_success_timestamp > 50h             (deploy/backup.sh)
  f) VictoriaMetrics itself unreachable (evaluated implicitly — it is a breach)
  g) a build hold is still active (deploy/rollback.sh left one and nobody released it)
  h) free disk on the filesystem holding /root below DISK_MIN_FREE_PCT (default 15%)

(a) covers far more than it used to: cron-wrap.sh now pushes
prospect_pipeline_step_success{step="<job>"} for EVERY job it wraps, so the twitch
collector, the 19:15 quiet-window steps, the keepers and the backup are all evaluated here.
Before that, the four steps most prone to the "database is locked" failure — the very
incident this script was written for, 22 silent failures in 26 nights — pushed nothing at
all, and a repeat would have been just as silent.

(d) is deliberately NOT "any skip in 24h". Skips are a designed outcome: the midday light
build is supposed to skip while the review keeper holds the refresh lock, and paging on that
would have made this channel noise from day one — an alert channel nobody trusts is worse
than no alert channel. What matters is whether a job is falling behind, so the check is on
prospect_cron_last_success_timestamp{job=...} (pushed by cron-wrap on a successful run):
breach when a known job has not COMPLETED in ALERT_JOB_STALE_HOURS (default 36h, i.e. a
daily job missed more than one whole day), or when a job that is skipping has never
completed at all. Persistent skipping therefore pages; a routine one does not.

(h) is deliberately evaluated OUTSIDE the VictoriaMetrics queries: a full disk is one of
the few things that can take VM itself down, so the check must survive exactly the
condition it exists to catch. Free disk on this box is not slack — it is the ETL's spill
ceiling (the 2026-08-30 nightly spilled 20.6GB onto a ~75%-full volume and died), and it
has already killed builds; 15% headroom is what backup.sh's weekly copy also demands.
The check pushes prospect_disk_free_pct every run so the approach is charted, not just
the arrival.

On any breach: ONE consolidated notification. Channels, configured in
/root/.prospect-alerts.env (chmod 600, never in git — see ALERTING.md):
  NTFY_TOPIC   — zero-setup default: plain POST to https://ntfy.sh/<topic>
  WEBHOOK_URL  — generic JSON webhook: POST {"text": "<message>"} (Slack-compatible)
  DEADMAN_URL  — outbound heartbeat, pinged after a run that completed AND got its alerts
                 out. This is the ONLY check that survives the box dying: VictoriaMetrics,
                 Grafana and this script all run ON the droplet, so a dead box or a wiped
                 crontab silences the entire alerting stack and nobody hears anything. An
                 external dead-man service notices the missing ping instead. Unset = off.
Repeat suppression: each breach key re-alerts at most once per 12h (state in
/root/.prospect-alert-state.json); a resolved breach is forgotten, so a re-fire after
recovery alerts immediately.

Version-controlled at prospect/deploy/observability/alert_check.py; runs from the git
checkout at /root/prospect/deploy/observability/alert_check.py (the flat
/root/alert_check.py copy deploy-scripts.sh used to ship is retired — `git pull` in
/root/prospect is the whole deploy for script changes).
"""
from __future__ import annotations

import json
import os
import shutil
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

VM = os.environ.get("PROSPECT_VM_URL", "http://localhost:8428")
ENV_FILE = os.environ.get("PROSPECT_ALERTS_ENV", "/root/.prospect-alerts.env")
STATE_FILE = os.environ.get("PROSPECT_ALERT_STATE", "/root/.prospect-alert-state.json")

HOUR = 3600.0


def load_env(path: str) -> dict[str, str]:
    cfg: dict[str, str] = {}
    try:
        with open(path, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                if line.startswith("export "):
                    line = line[len("export "):]
                k, _, v = line.partition("=")
                cfg[k.strip()] = v.strip().strip("'\"")
    except FileNotFoundError:
        pass
    return cfg


def vm_query(expr: str) -> list[dict]:
    """Instant query -> list of {metric: {...}, value: [ts, "v"]}. Raises on transport error."""
    url = f"{VM}/api/v1/query?" + urllib.parse.urlencode({"query": expr})
    with urllib.request.urlopen(url, timeout=10) as resp:
        payload = json.load(resp)
    if payload.get("status") != "success":
        raise RuntimeError(f"query failed: {expr}: {payload}")
    return payload["data"]["result"]


def disk_free_pct(path: str = "/root") -> float | None:
    """Free space of the filesystem holding `path`, as a percentage. None if unmeasurable
    (path missing, exotic filesystem) — a check that cannot measure must not guess."""
    try:
        usage = shutil.disk_usage(path)
    except OSError:
        return None
    if usage.total <= 0:
        return None
    return usage.free / usage.total * 100.0


def push_disk_metric(pct: float) -> None:
    """Best-effort free-disk gauge for the pipeline dashboard — same pattern as
    push_heartbeat: telemetry must never take down the checker that reports it."""
    try:
        req = urllib.request.Request(
            f"{VM}/api/v1/import/prometheus",
            data=f"prospect_disk_free_pct {pct:.1f}".encode(),
        )
        with urllib.request.urlopen(req, timeout=8):
            pass
    except (urllib.error.URLError, OSError) as exc:
        print(f"WARN: disk metric push failed: {exc}", file=sys.stderr)


def collect_breaches(cfg: dict[str, str]) -> dict[str, str]:
    """Return {stable_condition_key: human_description}."""
    breaches: dict[str, str] = {}
    now = time.time()

    # ALERT_IGNORE_SKIPPED_JOBS is the old name, kept working for an env file written
    # against the previous behaviour; both mean "do not evaluate this job's health at all".
    ignore_jobs = {
        j.strip()
        for key in ("ALERT_IGNORE_JOBS", "ALERT_IGNORE_SKIPPED_JOBS")
        for j in cfg.get(key, "").split(",")
        if j.strip()
    }
    job_stale_h = float(cfg.get("ALERT_JOB_STALE_HOURS", "36"))

    try:
        # (a) any step failure in the last 24h. min_over_time == 0 means at least one
        # pushed sample was a failure; a step that pushed nothing at all is covered by (b).
        for r in vm_query("min_over_time(prospect_pipeline_step_success[24h])"):
            if float(r["value"][1]) < 1:
                step = r["metric"].get("step", "?")
                breaches[f"step_failed:{step}"] = (
                    f"pipeline step '{step}' failed at least once in the last 24h"
                )

        # (b) no successful nightly for >30h. last_over_time[7d] because the gauge is
        # pushed once per night — a bare instant query would return empty between pushes.
        res = vm_query("max(last_over_time(prospect_pipeline_last_success_timestamp[7d]))")
        if not res:
            breaches["pipeline_stale"] = (
                "no successful pipeline run recorded in the last 7 days (metric absent)"
            )
        else:
            age_h = (now - float(res[0]["value"][1])) / HOUR
            if age_h > 30:
                breaches["pipeline_stale"] = (
                    f"last successful pipeline run was {age_h:.1f}h ago (threshold 30h)"
                )

        # (c) stale source data. The value is hours-at-push-time; a pipeline that stopped
        # pushing entirely is (b)'s job, so reading the last pushed value is the intent.
        for r in vm_query("last_over_time(prospect_data_freshness_hours[48h])"):
            v = float(r["value"][1])
            if v > 48:
                src = r["metric"].get("source", "?")
                breaches[f"freshness:{src}"] = (
                    f"data source '{src}' freshness is {v:.0f}h (threshold 48h)"
                )

        # (d) cron jobs falling behind. Both series come from cron-wrap.sh: _skipped is
        # pushed on every wrapped run (1 when flock -n lost the race, 0 when it ran) and
        # _last_success_timestamp only on a clean exit. A single skip is not a breach — see
        # the module docstring; what matters is a job that stops COMPLETING.
        last_success = {
            r["metric"].get("job", "?"): float(r["value"][1])
            for r in vm_query("last_over_time(prospect_cron_last_success_timestamp[14d])")
        }
        for job, ts in sorted(last_success.items()):
            if job in ignore_jobs:
                continue
            age_h = (now - ts) / HOUR
            if age_h > job_stale_h:
                breaches[f"cron_behind:{job}"] = (
                    f"cron job '{job}' has not completed successfully in {age_h:.1f}h "
                    f"(threshold {job_stale_h:.0f}h) — skipping, failing, or unscheduled"
                )
        # A job that is being skipped and has NEVER completed has no timestamp to age, so it
        # would be invisible to the loop above — e.g. a job whose lock is permanently held.
        for r in vm_query("max_over_time(prospect_cron_skipped[24h])"):
            job = r["metric"].get("job", "?")
            if float(r["value"][1]) > 0 and job not in ignore_jobs and job not in last_success:
                breaches[f"cron_never_completed:{job}"] = (
                    f"cron job '{job}' was skipped (lock held) and has never completed a run"
                )

        # (e) backups (pushed by deploy/backup.sh). 50h = one missed daily + slack.
        # ALERT_CHECK_BACKUPS=0 turns this off for an installation that deliberately runs no
        # backup job. Without the switch the only ways to silence it were to leave a permanent
        # false alarm or to delete the check — and a channel that always has one red line in it
        # is a channel people stop reading, which is the failure this whole script exists to
        # avoid. Turning it off is a real decision with a real consequence (signals.db holds
        # forward-only follower/price history that no endpoint can replay), so it is opt-out,
        # not a default.
        if cfg.get("ALERT_CHECK_BACKUPS", "1").strip().lower() not in ("0", "false", "no", "off"):
            res = vm_query("max(last_over_time(prospect_backup_last_success_timestamp[14d]))")
            if not res:
                breaches["backup_never"] = (
                    "no successful backup recorded in 14 days — backup.sh not running "
                    "or rclone remote not configured (see DEPLOY.md 'Backups'). "
                    "Set ALERT_CHECK_BACKUPS=0 if this box deliberately keeps no backups."
                )
            else:
                age_h = (now - float(res[0]["value"][1])) / HOUR
                if age_h > 50:
                    breaches["backup_stale"] = (
                        f"last successful backup was {age_h:.1f}h ago (threshold 50h)"
                    )

        # (g) a build hold left by deploy/rollback.sh. Both build scripts push this on every
        # run (1 = held and skipping, 0 = building normally), so the latest sample is the
        # current state. A hold stops the pipeline, so it must never be quiet — it expires by
        # itself after 48h, but "we lost two days of data because nobody removed a file" is
        # exactly the class of silence this script exists to end.
        res = vm_query("last_over_time(prospect_build_hold_active[7d])")
        if res and float(res[0]["value"][1]) > 0:
            breaches["build_hold"] = (
                "a build hold is active (/root/.prospect-build-hold) — the nightly and the "
                "midday light build are SKIPPING. Release it with `rm -f "
                "/root/.prospect-build-hold` once the underlying fix is in."
            )
    except (urllib.error.URLError, OSError, RuntimeError, ValueError) as exc:
        # (f) if VM is down we cannot evaluate anything — that is itself an alert, and the
        # notification channels don't depend on VM, so we can still send it.
        breaches["vm_unreachable"] = f"VictoriaMetrics at {VM} unreachable/unqueryable: {exc}"

    # (h) disk headroom on the filesystem holding /root. Deliberately OUTSIDE the VM query
    # block above: this must still evaluate (and still try to push its gauge) when VM is
    # down, because a full disk is a prime suspect for VM being down.
    try:
        min_free_pct = float(cfg.get("DISK_MIN_FREE_PCT", "15"))
    except ValueError:
        min_free_pct = 15.0
    free_pct = disk_free_pct("/root")
    if free_pct is not None:
        push_disk_metric(free_pct)
        if free_pct < min_free_pct:
            breaches["disk_low"] = (
                f"filesystem holding /root has {free_pct:.1f}% free "
                f"(threshold {min_free_pct:.0f}%) — the ETL's spill ceiling is in sight; "
                "free disk before the next nightly build"
            )

    return breaches


def load_state() -> dict[str, float]:
    try:
        with open(STATE_FILE, encoding="utf-8") as f:
            data = json.load(f)
        return {str(k): float(v) for k, v in data.items()}
    except (FileNotFoundError, ValueError, TypeError):
        return {}


def save_state(state: dict[str, float]) -> None:
    tmp = STATE_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(state, f, indent=1, sort_keys=True)
    os.replace(tmp, STATE_FILE)


def notify(cfg: dict[str, str], message: str) -> bool:
    """Send via every configured channel; True if at least one accepted it."""
    sent = False
    topic = cfg.get("NTFY_TOPIC")
    if topic:
        server = cfg.get("NTFY_SERVER", "https://ntfy.sh").rstrip("/")
        req = urllib.request.Request(
            f"{server}/{topic}",
            data=message.encode(),
            headers={"Title": "Prospect alerts", "Priority": "high", "Tags": "rotating_light"},
        )
        try:
            with urllib.request.urlopen(req, timeout=15):
                sent = True
        except (urllib.error.URLError, OSError) as exc:
            print(f"ERROR: ntfy send failed: {exc}", file=sys.stderr)
    url = cfg.get("WEBHOOK_URL")
    if url:
        req = urllib.request.Request(
            url,
            data=json.dumps({"text": message}).encode(),
            headers={"Content-Type": "application/json"},
        )
        try:
            with urllib.request.urlopen(req, timeout=15):
                sent = True
        except (urllib.error.URLError, OSError) as exc:
            print(f"ERROR: webhook send failed: {exc}", file=sys.stderr)
    return sent


def ping_deadman(cfg: dict[str, str]) -> None:
    """Outbound heartbeat to an EXTERNAL dead-man service (healthchecks.io, Cronitor, Better
    Stack, …) — a plain GET of a URL that expects to be called on a schedule.

    Every other check in this file is evaluated ON the droplet, against a VictoriaMetrics
    that runs ON the droplet, by a cron entry ON the droplet. If the box is down, the disk is
    full, cron is broken or this script was never installed, nothing here can fire and the
    silence is indistinguishable from health. This ping is the only signal that inverts that:
    the alert comes from the absence of a message, so it survives the box.

    Called only after a run that both completed AND delivered whatever it had to deliver, so
    "alerts cannot get out" (misconfigured or dead channels) also stops the heartbeat.
    Unset DEADMAN_URL = feature off; never fails the run.
    """
    url = cfg.get("DEADMAN_URL")
    if not url:
        return
    try:
        with urllib.request.urlopen(url, timeout=10):
            pass
    except (urllib.error.URLError, OSError) as exc:
        print(f"WARN: dead-man ping to {url} failed: {exc}", file=sys.stderr)


def push_heartbeat() -> None:
    """Best-effort: the checker's own liveness, visible on the pipeline dashboard."""
    try:
        req = urllib.request.Request(
            f"{VM}/api/v1/import/prometheus",
            data=f"prospect_alert_check_last_run_timestamp {int(time.time())}".encode(),
        )
        with urllib.request.urlopen(req, timeout=8):
            pass
    except (urllib.error.URLError, OSError) as exc:
        print(f"WARN: heartbeat push failed: {exc}", file=sys.stderr)


def main() -> int:
    cfg = load_env(ENV_FILE)
    suppress_s = float(cfg.get("ALERT_SUPPRESS_HOURS", "12")) * HOUR
    now = time.time()

    breaches = collect_breaches(cfg)
    push_heartbeat()

    state = load_state()
    # Forget resolved conditions so a recovery followed by a re-fire alerts immediately.
    state = {k: v for k, v in state.items() if k in breaches}

    if not breaches:
        save_state(state)
        ping_deadman(cfg)
        print(f"{time.strftime('%F %T')} ok — no breaches")
        return 0

    due = {k for k in breaches if now - state.get(k, 0.0) > suppress_s}
    stamp = time.strftime("%F %TZ", time.gmtime(now))
    for key in sorted(breaches):
        marker = "DUE" if key in due else "suppressed"
        print(f"{stamp} BREACH [{marker}] {key}: {breaches[key]}")

    if not due:
        save_state(state)
        ping_deadman(cfg)
        print("all current breaches were already notified within the suppression window")
        return 0

    lines = [f"Prospect droplet alerts ({stamp}) — {len(breaches)} condition(s):"]
    for key in sorted(breaches):
        suffix = "" if key in due else "  [repeat, already notified]"
        lines.append(f"- {breaches[key]}{suffix}")
    message = "\n".join(lines)

    if not cfg.get("NTFY_TOPIC") and not cfg.get("WEBHOOK_URL"):
        print(
            "ERROR: breaches found but no channel configured — create "
            f"{ENV_FILE} with NTFY_TOPIC or WEBHOOK_URL (see ALERTING.md)\n{message}",
            file=sys.stderr,
        )
        return 1

    if notify(cfg, message):
        for key in due:
            state[key] = now
        save_state(state)
        ping_deadman(cfg)
        print(f"notified {len(due)} due condition(s)")
        return 0
    # Every channel failed: keep state untouched so the next run (30 min) retries.
    save_state(state)
    print("ERROR: all notification channels failed — will retry next run", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())

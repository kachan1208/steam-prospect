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
  d) prospect_cron_skipped fired within the last 24h                   (per job)
  e) time() - prospect_backup_last_success_timestamp > 50h             (deploy/backup.sh)
  f) VictoriaMetrics itself unreachable (evaluated implicitly — it is a breach)

On any breach: ONE consolidated notification. Channels, configured in
/root/.prospect-alerts.env (chmod 600, never in git — see ALERTING.md):
  NTFY_TOPIC   — zero-setup default: plain POST to https://ntfy.sh/<topic>
  WEBHOOK_URL  — generic JSON webhook: POST {"text": "<message>"} (Slack-compatible)
Repeat suppression: each breach key re-alerts at most once per 12h (state in
/root/.prospect-alert-state.json); a resolved breach is forgotten, so a re-fire after
recovery alerts immediately.

Version-controlled at prospect/deploy/observability/alert_check.py; scp'd to
/root/alert_check.py by deploy/deploy-scripts.sh.
"""
from __future__ import annotations

import json
import os
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


def collect_breaches(cfg: dict[str, str]) -> dict[str, str]:
    """Return {stable_condition_key: human_description}."""
    breaches: dict[str, str] = {}
    now = time.time()

    ignore_skips = {
        j.strip() for j in cfg.get("ALERT_IGNORE_SKIPPED_JOBS", "").split(",") if j.strip()
    }

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

        # (d) cron skips (pushed by cron-wrap.sh when flock -n loses the race).
        for r in vm_query("max_over_time(prospect_cron_skipped[24h])"):
            if float(r["value"][1]) > 0:
                job = r["metric"].get("job", "?")
                if job in ignore_skips:
                    continue
                breaches[f"cron_skipped:{job}"] = (
                    f"cron job '{job}' was skipped (lock held) within the last 24h"
                )

        # (e) backups (pushed by deploy/backup.sh). 50h = one missed daily + slack.
        res = vm_query("max(last_over_time(prospect_backup_last_success_timestamp[14d]))")
        if not res:
            breaches["backup_never"] = (
                "no successful backup recorded in 14 days — backup.sh not running "
                "or rclone remote not configured (see DEPLOY.md 'Backups')"
            )
        else:
            age_h = (now - float(res[0]["value"][1])) / HOUR
            if age_h > 50:
                breaches["backup_stale"] = (
                    f"last successful backup was {age_h:.1f}h ago (threshold 50h)"
                )
    except (urllib.error.URLError, OSError, RuntimeError, ValueError) as exc:
        # (f) if VM is down we cannot evaluate anything — that is itself an alert, and the
        # notification channels don't depend on VM, so we can still send it.
        breaches["vm_unreachable"] = f"VictoriaMetrics at {VM} unreachable/unqueryable: {exc}"

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
        print(f"{time.strftime('%F %T')} ok — no breaches")
        return 0

    due = {k for k in breaches if now - state.get(k, 0.0) > suppress_s}
    stamp = time.strftime("%F %TZ", time.gmtime(now))
    for key in sorted(breaches):
        marker = "DUE" if key in due else "suppressed"
        print(f"{stamp} BREACH [{marker}] {key}: {breaches[key]}")

    if not due:
        save_state(state)
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
        print(f"notified {len(due)} due condition(s)")
        return 0
    # Every channel failed: keep state untouched so the next run (30 min) retries.
    save_state(state)
    print("ERROR: all notification channels failed — will retry next run", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())

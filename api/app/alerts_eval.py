"""Post-ETL alert evaluator — checks each org's active Alert rows against the current
analytics marts and emails a per-org digest of anything that matched.

Invoke after every mart refresh (O1's refresh entrypoint), from the `api/` directory so the
`app` package resolves:

    cd api && ./.venv/bin/python -m app.alerts_eval

Idempotent: each alert's last-evaluated state (the set of appids already seen, whether a
threshold was already crossed, the last trailing-review count, ...) is persisted keyed by
alert id in a small `alert_run_state` table this module creates in the control DB (see
_ensure_state_table — deliberately NOT added to models.py's shared Base/metadata, to keep
this track's file ownership self-contained). Re-running against an unchanged mart is a
no-op; a genuine change fires exactly once, on the run where it actually happens.

Supported Alert.kind values (Alert.target / Alert.threshold meaning below — see
validate_alert_fields, used by routers/alerts.py to reject a malformed alert at creation
time instead of letting it silently no-op forever at eval time):

  - "new_in_niche"       target = "tag:<key>" or "genre:<key>". Fires once per NEW appid
                          that enters that tag/genre since the alert's last run.
  - "niche_median_rev"   target = "tag:<key>" or "genre:<key>"; threshold = "<dollars>".
                          Fires when the niche's median est. revenue (mart_niche, win=all,
                          min_reviews=10 — the niches page's own default) crosses the
                          threshold, in either direction, since the last run.
  - "watchlist_velocity" target = "<appid>", or "" / "*" (= every game on the org's
                         watchlist); threshold = "<multiplier>" (default 2.0x). Fires when
                         a game's trailing-30d review count spikes >= multiplier vs. the
                         last run (or goes from 0 to >= a small noise floor).

All three establish a baseline on an alert's first evaluation (no matches fire yet) and
only report changes/crossings/new entries from then on — otherwise every alert would fire
in full on the run right after it's created.

Caveat on "new_in_niche" for dimension=genre: mart_game only carries one `primary_genre`
per game, so that's what we match on (same as routers/games.py's `genre=` search filter —
there's no per-appid multi-label genre membership exposed outside the ETL's staging
tables, which aren't in the published marts). mart_niche's own genre aggregates are built
from the fuller multi-label membership, so its `n_games` for a genre will run higher than
what this alert scans — "new game whose PRIMARY genre is X", not "new game carrying X
among its genres". dimension=tag doesn't have this gap: it matches mart_game.top_tags via
list_contains, identical to games.py's `tag=` filter.
"""
from __future__ import annotations

import argparse
import json
import logging
from dataclasses import dataclass
from datetime import datetime, timezone

from sqlalchemy import select, text
from sqlalchemy.orm import Session

from . import analytics_db
from .config import settings
from .control_db import SessionLocal, engine, init_db
from .email import (
    AlertDigestItem,
    ConsoleEmailProvider,
    EmailMessage,
    EmailProvider,
    get_email_provider,
    render_alert_digest,
)
from .models import Alert, Membership, Org, User, Watchlist

logger = logging.getLogger("prospect.alerts_eval")

ALERT_KINDS = ("new_in_niche", "niche_median_rev", "watchlist_velocity")

_DEFAULT_WINDOW = "all"
_DEFAULT_MIN_REVIEWS = 10          # mirrors routers/niches.py's own default (MIN_REVIEWS_DEFAULT)
_DEFAULT_VELOCITY_MULTIPLIER = 2.0
_MIN_VELOCITY_FLOOR = 5            # ignore noise on tiny trailing-review counts


# ---- run-state (idempotency) ------------------------------------------------------------
# A single small table, created here rather than in models.py so this track doesn't touch
# the shared control-plane schema file. Portable CREATE-TABLE/UPSERT SQL (SQLite + Postgres
# both accept this exact syntax), keyed by alert id.

_STATE_TABLE_DDL = """
CREATE TABLE IF NOT EXISTS alert_run_state (
    alert_id INTEGER PRIMARY KEY,
    last_run_at VARCHAR(40),
    state_json TEXT
)
"""


def _ensure_state_table() -> None:
    with engine.begin() as conn:
        conn.execute(text(_STATE_TABLE_DDL))


def _load_state(alert_id: int) -> dict:
    with engine.begin() as conn:
        row = conn.execute(
            text("SELECT state_json FROM alert_run_state WHERE alert_id = :aid"),
            {"aid": alert_id},
        ).fetchone()
    if not row or not row[0]:
        return {}
    try:
        return json.loads(row[0])
    except (json.JSONDecodeError, TypeError):
        return {}


def _save_state(alert_id: int, state: dict) -> None:
    with engine.begin() as conn:
        conn.execute(
            text(
                "INSERT INTO alert_run_state (alert_id, last_run_at, state_json) "
                "VALUES (:aid, :ts, :sj) "
                "ON CONFLICT (alert_id) DO UPDATE SET last_run_at = :ts, state_json = :sj"
            ),
            {
                "aid": alert_id,
                "ts": datetime.now(timezone.utc).isoformat(),
                "sj": json.dumps(state),
            },
        )


# ---- field parsing / validation (shared with routers/alerts.py) ------------------------

def parse_niche_target(target: str) -> tuple[str, str]:
    """Parse a "new_in_niche" / "niche_median_rev" alert's `target`: "tag:<key>" or
    "genre:<key>". Raises ValueError if malformed."""
    if not target or ":" not in target:
        raise ValueError(f"target must be 'tag:<key>' or 'genre:<key>', got {target!r}")
    dim, _, key = target.partition(":")
    dim = dim.strip().lower()
    key = key.strip()
    if dim not in ("tag", "genre"):
        raise ValueError(f"target dimension must be 'tag' or 'genre', got {dim!r}")
    if not key:
        raise ValueError("target key must not be empty")
    return dim, key


def validate_alert_fields(kind: str, target: str, threshold: str | None) -> None:
    """Fail fast at alert-creation time rather than silently no-op-ing forever at eval
    time. Mirrors exactly what each _eval_* function below requires."""
    if kind not in ALERT_KINDS:
        raise ValueError(f"unknown alert kind {kind!r}; expected one of {ALERT_KINDS}")
    if kind in ("new_in_niche", "niche_median_rev"):
        parse_niche_target(target)
    if kind == "niche_median_rev":
        if not threshold:
            raise ValueError("kind='niche_median_rev' requires threshold to be a numeric $ amount")
        try:
            float(threshold)
        except ValueError as exc:
            raise ValueError(f"threshold must be numeric, got {threshold!r}") from exc
    if kind == "watchlist_velocity" and threshold:
        try:
            float(threshold)
        except ValueError as exc:
            raise ValueError(f"threshold must be numeric (a multiplier), got {threshold!r}") from exc


# ---- evaluation --------------------------------------------------------------------------

@dataclass(frozen=True)
class AlertMatch:
    alert_id: int
    headline: str
    detail: str = ""
    url: str | None = None


def _eval_new_in_niche(alert: Alert, state: dict) -> tuple[list[AlertMatch], dict]:
    dim, key = parse_niche_target(alert.target)
    if dim == "genre":
        # primary_genre only (module docstring's "Caveat" above) — narrower than
        # mart_niche's own multi-label genre population, but it's the only per-appid
        # genre field the marts expose, and matches routers/games.py's `genre=` filter.
        rows = analytics_db.query(
            "SELECT appid, name, est_rev_reviews FROM mart_game WHERE primary_genre = ?",
            [key],
        )
    else:
        rows = analytics_db.query(
            "SELECT appid, name, est_rev_reviews FROM mart_game WHERE list_contains(top_tags, ?)",
            [key],
        )

    by_id = {int(r["appid"]): r for r in rows}
    current_ids = set(by_id)
    seen_before = "seen_appids" in state
    previously_seen = set(state.get("seen_appids", []))

    matches: list[AlertMatch] = []
    if seen_before:
        for appid in sorted(current_ids - previously_seen):
            r = by_id[appid]
            rev = r.get("est_rev_reviews")
            detail = f"est. revenue ${rev:,.0f}" if rev is not None else ""
            matches.append(
                AlertMatch(
                    alert_id=alert.id,
                    headline=f"New game in {dim} '{key}': {r.get('name') or f'appid {appid}'}",
                    detail=detail,
                    url=f"/games/{appid}",
                )
            )

    return matches, {"seen_appids": sorted(current_ids)}


def _eval_niche_median_rev(alert: Alert, state: dict) -> tuple[list[AlertMatch], dict]:
    dim, key = parse_niche_target(alert.target)
    if not alert.threshold:
        raise ValueError(f"alert {alert.id}: kind='niche_median_rev' requires a numeric threshold")
    threshold_value = float(alert.threshold)

    row = analytics_db.query_one(
        "SELECT median_rev FROM mart_niche WHERE dimension = ? AND key = ? "
        "AND win = ? AND min_reviews = ?",
        [dim, key, _DEFAULT_WINDOW, _DEFAULT_MIN_REVIEWS],
    )
    median_rev = row.get("median_rev") if row else None
    if median_rev is None:
        # Niche absent this run (e.g. below MIN_NICHE_GAMES) — nothing to compare; keep
        # whatever baseline we already had rather than erasing it.
        return [], state

    is_above = median_rev >= threshold_value
    was_above = state.get("is_above")  # None on the alert's first evaluation

    matches: list[AlertMatch] = []
    if was_above is not None and is_above != was_above:
        direction = "crossed above" if is_above else "dropped below"
        matches.append(
            AlertMatch(
                alert_id=alert.id,
                headline=f"Median revenue in {dim} '{key}' {direction} ${threshold_value:,.0f}",
                detail=f"current median est. revenue ${median_rev:,.0f}",
                url="/niches",
            )
        )

    return matches, {"is_above": is_above, "median_rev": median_rev}


def _eval_watchlist_velocity(db: Session, alert: Alert, state: dict) -> tuple[list[AlertMatch], dict]:
    multiplier = float(alert.threshold) if alert.threshold else _DEFAULT_VELOCITY_MULTIPLIER

    target = (alert.target or "").strip()
    if target and target not in ("*", "all"):
        try:
            appids = [int(target)]
        except ValueError as exc:
            raise ValueError(
                f"alert {alert.id}: kind='watchlist_velocity' target must be an appid, '*', or empty"
            ) from exc
    else:
        appids = [
            int(k)
            for k in db.scalars(
                select(Watchlist.key).where(Watchlist.org_id == alert.org_id, Watchlist.kind == "game")
            ).all()
        ]

    if not appids:
        return [], state

    placeholders = ",".join("?" for _ in appids)
    rows = analytics_db.query(
        f"SELECT appid, name, n_reviews_trailing_30d FROM mart_game WHERE appid IN ({placeholders})",
        appids,
    )
    by_id = {int(r["appid"]): r for r in rows}

    prior: dict = dict(state.get("trailing_30d", {}))
    current: dict[str, int] = {}
    matches: list[AlertMatch] = []

    for appid in appids:
        r = by_id.get(appid)
        if r is None:
            continue
        now_v = int(r.get("n_reviews_trailing_30d") or 0)
        current[str(appid)] = now_v
        prev_v = prior.get(str(appid))

        if prev_v is None:
            continue  # first time we've seen this game on this alert: record baseline only

        spiked = (prev_v > 0 and now_v >= prev_v * multiplier and now_v >= _MIN_VELOCITY_FLOOR) or (
            prev_v == 0 and now_v >= _MIN_VELOCITY_FLOOR
        )
        if spiked:
            matches.append(
                AlertMatch(
                    alert_id=alert.id,
                    headline=f"Review velocity spike: {r.get('name') or f'appid {appid}'}",
                    detail=f"trailing-30d reviews {prev_v} -> {now_v}",
                    url=f"/games/{appid}",
                )
            )

    return matches, {"trailing_30d": current}


def _send_digest(db: Session, provider: EmailProvider, org: Org, matches: list[AlertMatch]) -> None:
    recipients = db.scalars(
        select(User.email)
        .join(Membership, Membership.user_id == User.id)
        .where(Membership.org_id == org.id)
    ).all()
    if not recipients:
        logger.warning(
            "org %s (%s) has %d alert match(es) but no member emails; skipping digest",
            org.id, org.slug, len(matches),
        )
        return

    items = [AlertDigestItem(headline=m.headline, detail=m.detail, url=m.url) for m in matches]
    subject, text_body, html_body = render_alert_digest(org.name, items)
    for to in recipients:
        ok = provider.send(EmailMessage(to=to, subject=subject, text_body=text_body, html_body=html_body))
        logger.info(
            "alert digest -> org=%s to=%s via %s: %s",
            org.id, to, provider.name, "sent" if ok else "FAILED",
        )


def _evaluate_alert(db: Session, alert: Alert, state: dict) -> tuple[list[AlertMatch], dict]:
    if alert.kind == "new_in_niche":
        return _eval_new_in_niche(alert, state)
    if alert.kind == "niche_median_rev":
        return _eval_niche_median_rev(alert, state)
    if alert.kind == "watchlist_velocity":
        return _eval_watchlist_velocity(db, alert, state)
    raise ValueError(f"unknown alert kind {alert.kind!r}")


# ---- entrypoint ---------------------------------------------------------------------------

def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Evaluate active alerts against the current marts; email matches per org."
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Evaluate and log matches without persisting run-state or sending real email "
        "(always uses the console provider, regardless of PROSPECT_EMAIL_PROVIDER).",
    )
    parser.add_argument(
        "--org-id",
        type=int,
        default=None,
        help="Only evaluate alerts belonging to this org id (debugging a single tenant).",
    )
    args = parser.parse_args(argv)

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")

    init_db()  # control-plane schema + solo-org seed; safe to call standalone, no API needed
    try:
        analytics_db.init(settings.analytics_db_path)
    except FileNotFoundError as exc:
        logger.error("alerts_eval: %s", exc)
        return 1
    _ensure_state_table()

    provider: EmailProvider = ConsoleEmailProvider() if args.dry_run else get_email_provider()
    logger.info("alerts_eval starting (provider=%s dry_run=%s)", provider.name, args.dry_run)

    orgs_evaluated = 0
    total_matches = 0
    try:
        with SessionLocal() as db:
            org_stmt = select(Org)
            if args.org_id is not None:
                org_stmt = org_stmt.where(Org.id == args.org_id)
            orgs = db.scalars(org_stmt).all()

            for org in orgs:
                alerts = db.scalars(
                    select(Alert).where(Alert.org_id == org.id, Alert.active.is_(True))
                ).all()
                if not alerts:
                    continue
                orgs_evaluated += 1

                org_matches: list[AlertMatch] = []
                for alert in alerts:
                    state = _load_state(alert.id)
                    try:
                        matches, new_state = _evaluate_alert(db, alert, state)
                    except Exception:
                        logger.exception(
                            "alert %s failed to evaluate (org=%s kind=%s target=%r)",
                            alert.id, org.id, alert.kind, alert.target,
                        )
                        continue

                    if not args.dry_run:
                        _save_state(alert.id, new_state)
                    org_matches.extend(matches)

                total_matches += len(org_matches)
                if org_matches:
                    logger.info("org %s (%s): %d alert match(es)", org.id, org.slug, len(org_matches))
                    _send_digest(db, provider, org, org_matches)
    finally:
        analytics_db.close()

    logger.info(
        "alerts_eval done: %d org(s) with active alerts evaluated, %d total match(es)",
        orgs_evaluated, total_matches,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

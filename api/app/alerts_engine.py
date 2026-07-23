"""Read-only evaluation of alert rules.

Pure functions: each ``eval_*`` takes a control-plane ``Session`` (to read the org's
Watchlist), an ``org_id`` and the rule's already-parsed ``params`` dict, reads the analytics
marts read-only, and returns a list of *candidate* AlertEvent dicts::

    {"kind": str, "title": str, "body": str, "appid": int | None}

The *point-in-time* evaluators (``eval_*`` below, dispatched via ``evaluate_rule``) persist
nothing: the router (``POST /api/alerts/evaluate``) dedupes their candidates against
already-stored events and writes the genuinely new ones. Because they are stateless, each
candidate describes a *current* signal (a snapshot); dedup on (kind, title, appid) is what
keeps a standing condition from being recorded twice.

The *edge-triggered* evaluators (``eval_edge_*``, dispatched via ``evaluate_rule_edge``) are
the deeper alerts: they compare the current metric against the value observed on the *previous*
run — read from and written back to ``AlertState`` — and fire only on a genuine change (a
threshold crossing or a delta beyond a configured %/points). They carry ``"edge": True`` on
each candidate so the router skips the standing-condition dedup (the state machine already
guarantees one fire per change), and they always write the fresh value back to ``AlertState``
so the next run compares against the latest reading. The delta is baked into the event body
(e.g. "−42% vs last check"). ``evaluate_rule_edge`` takes the owning ``rule_id`` so each rule
keeps independent history.

Every mart read is defensive: a missing table/column, un-initialised analytics DB, or bad
row yields ``[]`` (or is skipped) rather than raising — evaluation must never 500 the
endpoint even right after a fresh checkout with no marts built.

Supported point-in-time ``kind`` values (params are all optional; sensible defaults below):

  - ``watchlist_velocity`` — for each watchlisted game, compare its trailing-30d review
        count against ``high``/``low`` thresholds. Fires "surging" when >= ``high``; fires
        "stalled" when <= ``low`` on a game that already has a real review base.
        params: ``{"high": int=100, "low": int=3}``.
  - ``new_in_niche`` — a game released this calendar year whose ``primary_genre`` matches a
        genre the user watches (the genre of any watchlisted game), with a decent review
        base. params: ``{"min_reviews": int=200, "min_positive": float=0.80, "limit": int=5}``
        (limit is per watched genre, best-reviewed first).
  - ``niche_median_rev`` — a watched game's ``primary_genre`` niche median est. revenue
        (``mart_niche``) sits on the far side of a dollar threshold. params:
        ``{"threshold": float=10000, "direction": "above"|"below"="above",
           "win": "all"|"24m"="all", "min_reviews": int=10}``.

Supported edge-triggered ``kind`` values (each tracks one metric per watched game vs. the
previous run's stored value; params optional):

  - ``velocity_change`` — trailing-30d review pace moved sharply vs. last check. Fires
        "accelerating" when it jumps >= ``jump_pct`` and "cooling" when it drops >= ``drop_pct``.
        params: ``{"jump_pct": float=50, "drop_pct": float=25, "min_base": float=10}``
        (``min_base`` suppresses noisy %s off tiny counts).
  - ``comp_launch`` — a watched game just crossed a lifetime-review milestone (prior < T <=
        current), i.e. a competitor gaining real traction / launching.
        params: ``{"threshold": float=1000}``.
  - ``sentiment_drop`` — a watched game's ``positive_ratio`` fell by >= ``drop_pp`` percentage
        points vs. last check. params: ``{"drop_pp": float=5}``.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Callable

from sqlalchemy import select
from sqlalchemy.orm import Session

from . import analytics_db
from .alert_models import AlertState
from .models import Watchlist

# ---- defaults ---------------------------------------------------------------------------
_VELOCITY_HIGH = 100
_VELOCITY_LOW = 3
_VELOCITY_LOW_MIN_LIFETIME = 200   # only flag "stalled" on games with a real review base

_NEW_MIN_REVIEWS = 200
_NEW_MIN_POSITIVE = 0.80
_NEW_LIMIT_PER_GENRE = 5

_NICHE_REV_THRESHOLD = 10_000.0
_NICHE_WIN = "all"
_NICHE_MIN_REVIEWS = 10            # mirrors the niches page's own default variant

# Edge-trigger defaults.
_EDGE_JUMP_PCT = 50.0     # velocity_change: fire "accelerating" at >= +this %
_EDGE_DROP_PCT = 25.0     # velocity_change: fire "cooling" at <= -this %
_EDGE_MIN_BASE = 10.0     # velocity_change: ignore %s unless max(prior,current) >= this
_LAUNCH_THRESHOLD = 1000.0  # comp_launch: lifetime-review milestone to cross
_SENTIMENT_DROP_PP = 5.0    # sentiment_drop: fire when positive_ratio falls >= this many points


# ---- defensive mart helpers -------------------------------------------------------------

def _safe_query(sql: str, params: list[Any] | None = None) -> list[dict]:
    try:
        if not analytics_db.is_ready():
            return []
        return analytics_db.query(sql, params or [])
    except Exception:
        return []


def _safe_query_one(sql: str, params: list[Any] | None = None) -> dict | None:
    rows = _safe_query(sql, params)
    return rows[0] if rows else None


def _num(value: Any, default: float) -> float:
    if value is None:
        return float(default)
    try:
        return float(value)
    except (TypeError, ValueError):
        return float(default)


def _pos_str(pos: Any) -> str:
    try:
        return f"{float(pos) * 100:.0f}% positive" if pos is not None else "n/a positive"
    except (TypeError, ValueError):
        return "n/a positive"


def _pct_str(pct: float) -> str:
    """Signed percentage with a real unicode minus for the drop case, e.g. '+50%' / '−42%'."""
    return f"{pct:+.0f}%".replace("-", "−")


# ---- edge state (last-observed value per metric) ----------------------------------------

def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _observe(db: Session, org_id: int, rule_id: int | None, metric_key: str, value: float) -> float | None:
    """Upsert the last-observed value for ``metric_key`` and return the *prior* value.

    Returns ``None`` on the first observation (nothing to compare against yet — a seed run),
    otherwise the previously stored value. Always writes the new value so the next run compares
    against the latest reading. Writes go through the passed control-plane session; the caller
    (the router) owns the commit.
    """
    row = db.scalar(
        select(AlertState).where(
            AlertState.org_id == org_id,
            AlertState.rule_id == rule_id,
            AlertState.metric_key == metric_key,
        )
    )
    if row is None:
        db.add(
            AlertState(org_id=org_id, rule_id=rule_id, metric_key=metric_key, value=float(value))
        )
        return None
    prior = float(row.value) if row.value is not None else None
    row.value = float(value)
    row.updated_at = _utcnow()
    return prior


# ---- watchlist introspection ------------------------------------------------------------

def _watched_appids(db: Session, org_id: int) -> list[int]:
    try:
        keys = db.scalars(
            select(Watchlist.key).where(Watchlist.org_id == org_id, Watchlist.kind == "game")
        ).all()
    except Exception:
        return []
    out: list[int] = []
    for k in keys:
        try:
            out.append(int(k))
        except (TypeError, ValueError):
            continue
    return out


def _watched_genres(db: Session, org_id: int) -> list[str]:
    appids = _watched_appids(db, org_id)
    if not appids:
        return []
    placeholders = ",".join("?" for _ in appids)
    rows = _safe_query(
        f"SELECT DISTINCT primary_genre FROM mart_game "
        f"WHERE appid IN ({placeholders}) AND primary_genre IS NOT NULL",
        appids,
    )
    return [r["primary_genre"] for r in rows if r.get("primary_genre")]


# ---- rule evaluators --------------------------------------------------------------------

def eval_watchlist_velocity(db: Session, org_id: int, params: dict) -> list[dict]:
    high = int(_num(params.get("high"), _VELOCITY_HIGH))
    low = int(_num(params.get("low"), _VELOCITY_LOW))
    appids = _watched_appids(db, org_id)
    if not appids:
        return []

    placeholders = ",".join("?" for _ in appids)
    rows = _safe_query(
        f"SELECT appid, name, n_reviews_trailing_30d, live_players, positive_ratio, total_reviews "
        f"FROM mart_game WHERE appid IN ({placeholders})",
        appids,
    )

    events: list[dict] = []
    for r in rows:
        appid = int(r["appid"]) if r.get("appid") is not None else None
        name = r.get("name") or (f"App {appid}" if appid is not None else "Unknown game")
        n = int(r.get("n_reviews_trailing_30d") or 0)
        lifetime = int(r.get("total_reviews") or 0)
        pos_s = _pos_str(r.get("positive_ratio"))
        live = r.get("live_players")
        live_s = f", {int(live):,} live players" if live not in (None, 0) else ""

        if n >= high:
            events.append(
                {
                    "kind": "watchlist_velocity",
                    "title": f"{name}: review velocity surging",
                    "body": (
                        f"{n:,} new reviews in the trailing 30 days ({pos_s}{live_s}). "
                        f"Above your surge threshold of {high}/30d."
                    ),
                    "appid": appid,
                }
            )
        elif n <= low and lifetime >= _VELOCITY_LOW_MIN_LIFETIME:
            events.append(
                {
                    "kind": "watchlist_velocity",
                    "title": f"{name}: review velocity stalled",
                    "body": (
                        f"Only {n} new reviews in the trailing 30 days on a game with "
                        f"{lifetime:,} lifetime reviews ({pos_s}). Below your floor of {low}/30d."
                    ),
                    "appid": appid,
                }
            )
    return events


def eval_new_in_niche(db: Session, org_id: int, params: dict) -> list[dict]:
    min_reviews = int(_num(params.get("min_reviews"), _NEW_MIN_REVIEWS))
    min_positive = _num(params.get("min_positive"), _NEW_MIN_POSITIVE)
    limit = max(1, int(_num(params.get("limit"), _NEW_LIMIT_PER_GENRE)))
    year = datetime.now(timezone.utc).year

    events: list[dict] = []
    for genre in _watched_genres(db, org_id):
        rows = _safe_query(
            "SELECT appid, name, total_reviews, positive_ratio, est_rev_reviews "
            "FROM mart_game "
            "WHERE release_year = ? AND primary_genre = ? "
            "AND total_reviews >= ? AND positive_ratio >= ? "
            "ORDER BY total_reviews DESC LIMIT ?",
            [year, genre, min_reviews, min_positive, limit],
        )
        for r in rows:
            appid = int(r["appid"]) if r.get("appid") is not None else None
            name = r.get("name") or (f"App {appid}" if appid is not None else "Unknown game")
            reviews = int(r.get("total_reviews") or 0)
            rev = r.get("est_rev_reviews")
            rev_s = f", ~${float(rev):,.0f} est. revenue" if rev is not None else ""
            events.append(
                {
                    "kind": "new_in_niche",
                    "title": f"New in {genre}: {name}",
                    "body": (
                        f"Released this year in {genre}, a genre you watch. "
                        f"{reviews:,} reviews at {_pos_str(r.get('positive_ratio'))}{rev_s}."
                    ),
                    "appid": appid,
                }
            )
    return events


def eval_niche_median_rev(db: Session, org_id: int, params: dict) -> list[dict]:
    threshold = _num(params.get("threshold"), _NICHE_REV_THRESHOLD)
    direction = str(params.get("direction") or "above").lower()
    if direction not in ("above", "below"):
        direction = "above"
    win = str(params.get("win") or _NICHE_WIN)
    min_reviews = int(_num(params.get("min_reviews"), _NICHE_MIN_REVIEWS))

    events: list[dict] = []
    for genre in _watched_genres(db, org_id):
        row = _safe_query_one(
            "SELECT median_rev FROM mart_niche "
            "WHERE dimension = 'genre' AND key = ? AND win = ? AND min_reviews = ?",
            [genre, win, min_reviews],
        )
        if not row:
            continue
        median_rev = row.get("median_rev")
        if median_rev is None:
            continue
        hit = median_rev >= threshold if direction == "above" else median_rev <= threshold
        if not hit:
            continue
        arrow = "at or above" if direction == "above" else "at or below"
        events.append(
            {
                "kind": "niche_median_rev",
                "title": f"{genre} niche median revenue {arrow} ${threshold:,.0f}",
                "body": (
                    f"Median est. revenue across scored {genre} games is now "
                    f"~${float(median_rev):,.0f} (window={win}, min_reviews={min_reviews})."
                ),
                "appid": None,
            }
        )
    return events


# ---- edge-triggered rule evaluators -----------------------------------------------------
# These read a per-game metric, compare it against the value stored on the previous run
# (AlertState), fire only on a real change, and write the fresh value back. Candidates carry
# "edge": True so the router persists them without the standing-condition dedup.

def _watched_game_rows(db: Session, org_id: int, columns: str) -> list[dict]:
    appids = _watched_appids(db, org_id)
    if not appids:
        return []
    placeholders = ",".join("?" for _ in appids)
    return _safe_query(
        f"SELECT {columns} FROM mart_game WHERE appid IN ({placeholders})", appids
    )


def eval_edge_velocity_change(db: Session, org_id: int, rule_id: int | None, params: dict) -> list[dict]:
    jump_pct = _num(params.get("jump_pct"), _EDGE_JUMP_PCT)
    drop_pct = _num(params.get("drop_pct"), _EDGE_DROP_PCT)
    min_base = _num(params.get("min_base"), _EDGE_MIN_BASE)

    events: list[dict] = []
    for r in _watched_game_rows(
        db, org_id, "appid, name, n_reviews_trailing_30d, positive_ratio, live_players"
    ):
        appid = int(r["appid"]) if r.get("appid") is not None else None
        if appid is None:
            continue
        name = r.get("name") or f"App {appid}"
        current = _num(r.get("n_reviews_trailing_30d"), 0.0)
        prior = _observe(db, org_id, rule_id, f"velocity:{appid}", current)
        if prior is None:
            continue  # first observation — seed only, no edge yet
        if max(prior, current) < min_base:
            continue  # both readings tiny — a % here would be noise

        pos_s = _pos_str(r.get("positive_ratio"))
        live = r.get("live_players")
        live_s = f", {int(live):,} live players" if live not in (None, 0) else ""

        if prior <= 0:
            # Came back from a dead stretch — report as a jump from zero.
            if current >= min_base:
                events.append(
                    {
                        "kind": "velocity_change",
                        "title": f"{name}: review pace accelerating",
                        "body": (
                            f"Trailing-30d reviews went 0 → {current:,.0f} vs last check "
                            f"({pos_s}{live_s})."
                        ),
                        "appid": appid,
                        "edge": True,
                    }
                )
            continue

        pct = (current - prior) / prior * 100.0
        if pct >= jump_pct:
            events.append(
                {
                    "kind": "velocity_change",
                    "title": f"{name}: review pace accelerating",
                    "body": (
                        f"Trailing-30d reviews {prior:,.0f} → {current:,.0f} "
                        f"({_pct_str(pct)} vs last check, {pos_s}{live_s})."
                    ),
                    "appid": appid,
                    "edge": True,
                }
            )
        elif pct <= -drop_pct:
            events.append(
                {
                    "kind": "velocity_change",
                    "title": f"{name}: review pace cooling",
                    "body": (
                        f"Trailing-30d reviews {prior:,.0f} → {current:,.0f} "
                        f"({_pct_str(pct)} vs last check, {pos_s}{live_s})."
                    ),
                    "appid": appid,
                    "edge": True,
                }
            )
    return events


def eval_edge_comp_launch(db: Session, org_id: int, rule_id: int | None, params: dict) -> list[dict]:
    threshold = _num(params.get("threshold"), _LAUNCH_THRESHOLD)

    events: list[dict] = []
    for r in _watched_game_rows(db, org_id, "appid, name, total_reviews, positive_ratio"):
        appid = int(r["appid"]) if r.get("appid") is not None else None
        if appid is None:
            continue
        name = r.get("name") or f"App {appid}"
        current = _num(r.get("total_reviews"), 0.0)
        prior = _observe(db, org_id, rule_id, f"reviews:{appid}", current)
        if prior is None:
            continue  # first observation — seed only
        if prior < threshold <= current:
            gained = current - prior
            events.append(
                {
                    "kind": "comp_launch",
                    "title": f"{name}: crossed {threshold:,.0f} reviews",
                    "body": (
                        f"Now at {current:,.0f} lifetime reviews ({_pos_str(r.get('positive_ratio'))}) "
                        f"— up {gained:,.0f} since last check, past the {threshold:,.0f}-review mark."
                    ),
                    "appid": appid,
                    "edge": True,
                }
            )
    return events


def eval_edge_sentiment_drop(db: Session, org_id: int, rule_id: int | None, params: dict) -> list[dict]:
    drop_pp = _num(params.get("drop_pp"), _SENTIMENT_DROP_PP)

    events: list[dict] = []
    for r in _watched_game_rows(db, org_id, "appid, name, positive_ratio, total_reviews"):
        appid = int(r["appid"]) if r.get("appid") is not None else None
        if appid is None:
            continue
        pos = r.get("positive_ratio")
        if pos is None:
            continue
        name = r.get("name") or f"App {appid}"
        current = _num(pos, 0.0)
        prior = _observe(db, org_id, rule_id, f"sentiment:{appid}", current)
        if prior is None:
            continue  # first observation — seed only
        pp = (current - prior) * 100.0
        if pp <= -drop_pp:
            events.append(
                {
                    "kind": "sentiment_drop",
                    "title": f"{name}: rating slipping",
                    "body": (
                        f"Positive rating fell {abs(pp):.1f}pp vs last check "
                        f"({prior * 100:.0f}% → {current * 100:.0f}%)."
                    ),
                    "appid": appid,
                    "edge": True,
                }
            )
    return events


# ---- dispatch ---------------------------------------------------------------------------

_EVALUATORS: dict[str, Callable[[Session, int, dict], list[dict]]] = {
    "watchlist_velocity": eval_watchlist_velocity,
    "new_in_niche": eval_new_in_niche,
    "niche_median_rev": eval_niche_median_rev,
}

_EDGE_EVALUATORS: dict[str, Callable[[Session, int, int | None, dict], list[dict]]] = {
    "velocity_change": eval_edge_velocity_change,
    "comp_launch": eval_edge_comp_launch,
    "sentiment_drop": eval_edge_sentiment_drop,
}

# Public tuples of supported rule kinds — the router validates POST /rules against the union.
RULE_KINDS: tuple[str, ...] = tuple(_EVALUATORS)
EDGE_RULE_KINDS: tuple[str, ...] = tuple(_EDGE_EVALUATORS)
ALL_RULE_KINDS: tuple[str, ...] = RULE_KINDS + EDGE_RULE_KINDS


def evaluate_rule(db: Session, org_id: int, kind: str, params: dict | None) -> list[dict]:
    """Evaluate one point-in-time rule, returning candidate AlertEvent dicts. Unknown kinds and
    any internal failure yield [] so one bad rule never breaks a whole evaluation run."""
    fn = _EVALUATORS.get(kind)
    if fn is None:
        return []
    try:
        return fn(db, org_id, params or {})
    except Exception:
        return []


def evaluate_rule_edge(
    db: Session, org_id: int, rule_id: int | None, kind: str, params: dict | None
) -> list[dict]:
    """Evaluate one edge-triggered rule. Reads/writes AlertState (scoped to ``rule_id``) and
    returns only the candidates that represent a genuine change since the last run. Unknown
    kinds and any internal failure yield [] — but note state already written before a failure
    is still flushed by the router's commit, which is fine (it just seeds the next comparison)."""
    fn = _EDGE_EVALUATORS.get(kind)
    if fn is None:
        return []
    try:
        return fn(db, org_id, rule_id, params or {})
    except Exception:
        return []

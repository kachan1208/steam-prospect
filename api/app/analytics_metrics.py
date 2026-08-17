"""Frontend usage analytics as bounded Prometheus counters (scraped by VictoriaMetrics).

The SPA's routes are client-side (React Router), so the server never sees a page view when a
visitor navigates /niches -> /games/440 -> /devlog. This module lets the frontend POST those
page views + a small allowlist of interactions to /api/analytics/collect (routers/analytics.py),
where they become two Prometheus counters on the existing /metrics endpoint:

    prospect_pageview_total{route="..."}   -- one per normalized route TEMPLATE
    prospect_event_total{event="..."}      -- one per allowlisted interaction

Cardinality is the whole game with Prometheus: a raw path like /games/440 would mint a new time
series per appid and swamp VictoriaMetrics. So paths are normalized SERVER-SIDE to a fixed set of
route templates (the appid collapses to :appid), and anything off the whitelist is dropped. Event
names are likewise checked against a fixed allowlist. Both label sets are bounded and known ahead
of time, so a busted or hostile client can at worst inflate a KNOWN counter, never mint new series.

The counters live in prometheus_client's default REGISTRY — the same one
prometheus-fastapi-instrumentator exposes on /metrics (observability.py) — so no extra wiring is
needed. They reset to 0 on process restart (the nightly `docker restart prospect`); Grafana
queries use increase()/rate() over a range, which is counter-reset-aware, so the daily restart
doesn't corrupt the series.
"""
from __future__ import annotations

import re

from prometheus_client import Counter

# --- page-view route normalization -------------------------------------------------------
# Ordered (regex -> template) rules; first match wins. Only paths that resolve to a template in
# KNOWN_ROUTES are recorded. Keep this in lockstep with web/src/App.tsx's <Routes>.
_ROUTE_RULES: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"^/games/\d+$"), "/games/:appid"),
    (re.compile(r"^/docs/[^/]+$"), "/docs/:slug"),
]

KNOWN_ROUTES: frozenset[str] = frozenset(
    {
        "/", "/niches", "/benchmarks", "/timing", "/estimator", "/games", "/games/:appid",
        "/press", "/marketing", "/devlog", "/chat", "/datalog", "/welcome", "/settings",
        "/docs", "/docs/:slug", "/terms", "/privacy",
    }
)

# --- interaction event allowlist ---------------------------------------------------------
# Client-only / high-intent actions worth tracking beyond page views. API-backed actions (chat,
# estimate, CSV export, search) are ALSO visible server-side via http_requests_total{handler},
# but a few are mirrored here so the "interactions" view reads cleanly on its own.
KNOWN_EVENTS: frozenset[str] = frozenset(
    {
        "tour_start", "tour_complete", "tour_skip",
        "niche_open", "niche_export_csv", "niche_filter_apply",
        "game_search", "aspect_drilldown_open", "game_comparable_open",
        "estimator_run", "chat_send", "view_save", "view_load",
        "benchmark_metric_change", "timing_genre_change", "marketing_platform_change",
        "press_article_open", "detail_view_toggle",
    }
)


def normalize_route(path: str) -> str | None:
    """Collapse a concrete SPA path to a bounded route template, or None if unrecognized."""
    if not path:
        return None
    path = path.split("?", 1)[0].split("#", 1)[0]  # drop query/hash
    if len(path) > 1:
        path = path.rstrip("/")
    if not path:
        path = "/"
    if path in KNOWN_ROUTES:
        return path
    for pattern, template in _ROUTE_RULES:
        if pattern.match(path):
            return template
    return None


_pageviews = Counter("prospect_pageview_total", "SPA page views by normalized route", ["route"])
_events = Counter("prospect_event_total", "Frontend interaction events by name", ["event"])


def record_pageview(path: str) -> bool:
    """Increment the page-view counter for `path`'s route template. False if path is unknown."""
    route = normalize_route(path)
    if route is None:
        return False
    _pageviews.labels(route=route).inc()
    return True


def record_event(name: str) -> bool:
    """Increment the interaction counter for `name`. False if the event isn't allowlisted."""
    if name not in KNOWN_EVENTS:
        return False
    _events.labels(event=name).inc()
    return True

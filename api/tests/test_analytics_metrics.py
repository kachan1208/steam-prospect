"""analytics_metrics route normalization — the KNOWN_ROUTES/App.tsx lockstep.

The allowlist drifted badly once (missing /radar — the INDEX — /watchlist, /compare,
/entity/:role and /studios, while still carrying seven retired pages), and because misses
were silently dropped, nothing ever said so. These tests pin the live route list, the
param-collapsing rules, and the new miss behavior: unrecognized paths are counted under
the single "unknown" label instead of vanishing.
"""
from __future__ import annotations

import pytest

from app import analytics_metrics as am


@pytest.mark.parametrize(
    "path",
    [
        "/", "/radar", "/watchlist", "/niches", "/niches/combined", "/games", "/compare",
        "/studios", "/timing", "/chat", "/datalog", "/docs", "/terms", "/privacy",
    ],
)
def test_live_static_routes_normalize_to_themselves(path):
    assert am.normalize_route(path) == path


@pytest.mark.parametrize(
    ("path", "template"),
    [
        ("/games/440", "/games/:appid"),
        ("/docs/methodology", "/docs/:slug"),
        ("/entity/developer", "/entity/:role"),
        ("/entity/publisher", "/entity/:role"),
        ("/niches/tag/Roguelike", "/niches/:dimension/:key"),
        # Niche keys can contain a slash — the rule must span it, like the API's {key:path}.
        ("/niches/tag/Rogue/Lite", "/niches/:dimension/:key"),
        ("/niches/genre/Simulation", "/niches/:dimension/:key"),
    ],
)
def test_param_routes_collapse_to_templates(path, template):
    assert am.normalize_route(path) == template


@pytest.mark.parametrize(
    "path",
    ["/benchmarks", "/estimator", "/press", "/marketing", "/devlog", "/welcome", "/settings"],
)
def test_retired_routes_are_no_longer_recognized(path):
    assert am.normalize_route(path) is None


def test_query_hash_and_trailing_slash_are_stripped():
    assert am.normalize_route("/entity/developer?name=CAPCOM%20Co.") == "/entity/:role"
    assert am.normalize_route("/radar/") == "/radar"
    assert am.normalize_route("/watchlist#top") == "/watchlist"


def test_garbage_is_unrecognized():
    assert am.normalize_route("") is None
    assert am.normalize_route("/entity/developer/extra") is None
    assert am.normalize_route("/games/not-a-number") is None


def _count(route: str) -> float:
    return am._pageviews.labels(route=route)._value.get()


def test_unrecognized_path_is_counted_as_unknown_not_dropped():
    before = _count(am.UNKNOWN_ROUTE)
    assert am.record_pageview("/estimator") is False  # retired route
    assert _count(am.UNKNOWN_ROUTE) == before + 1


def test_known_path_is_counted_under_its_template():
    before = _count("/entity/:role")
    unknown_before = _count(am.UNKNOWN_ROUTE)
    assert am.record_pageview("/entity/developer?name=Studio%20B") is True
    assert _count("/entity/:role") == before + 1
    assert _count(am.UNKNOWN_ROUTE) == unknown_before

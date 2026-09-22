"""Hosted-mode cache policy for the SPA (api/app/main.py).

index.html carried ETag/Last-Modified but no Cache-Control, so browsers applied heuristic
freshness and could keep an OLD index.html after a rebuild — one that references
content-hashed /assets/*.js files the new build no longer ships: a blank page until a hard
refresh. index.html (and every client route, which is index.html) is now `no-cache`
(revalidate every load; a 304 is still cheap), and /assets/* — whose names carry a content
hash — is `public, max-age=31536000, immutable`.
"""
from __future__ import annotations

import pytest

from conftest import ASSET_CONTENT, ASSET_NAME, INDEX_HTML_CONTENT


@pytest.mark.parametrize("path", ["/", "/niches", "/docs/glossary", "/games/1001"])
def test_index_html_is_revalidated_on_every_load(client, path):
    r = client.get(path)
    assert r.status_code == 200
    assert r.text == INDEX_HTML_CONTENT
    assert r.headers["cache-control"] == "no-cache"
    assert "etag" in r.headers  # what makes "no-cache" a cheap 304, not a re-download


def test_unhashed_top_level_files_are_revalidated_too(client):
    r = client.get("/robots.txt")
    assert r.status_code == 200
    assert r.headers["cache-control"] == "no-cache"


def test_hashed_assets_are_cached_for_a_year(client):
    r = client.get(f"/assets/{ASSET_NAME}")
    assert r.status_code == 200
    assert r.text == ASSET_CONTENT
    assert r.headers["cache-control"] == "public, max-age=31536000, immutable"


def test_revalidated_asset_keeps_the_immutable_policy(client):
    etag = client.get(f"/assets/{ASSET_NAME}").headers["etag"]
    r = client.get(f"/assets/{ASSET_NAME}", headers={"If-None-Match": etag})
    assert r.status_code == 304
    assert r.headers["cache-control"] == "public, max-age=31536000, immutable"


def test_a_missing_asset_is_a_plain_404_never_cached_as_immutable(client):
    """Exactly the request an OLD cached index.html makes after a rebuild: it must 404
    without a year-long cache stamp on it."""
    r = client.get("/assets/index-deadbeef.js")
    assert r.status_code == 404
    assert "immutable" not in r.headers.get("cache-control", "")


def test_api_responses_do_not_inherit_the_spa_policy(client):
    r = client.get("/api/health")
    assert r.headers.get("cache-control") != "no-cache"

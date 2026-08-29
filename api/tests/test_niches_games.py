"""The niche drill-down surface with mart_niche_game ABSENT — i.e. exactly the state
production is in between an API deploy and the next nightly mart rebuild, for hours.

conftest's fixture mart deliberately does not create mart_niche_game (it predates the
table, like every mart currently on disk), so this whole module exercises the degraded
path for free: every endpoint must answer with the router's explicit 503 + rebuild hint,
never a DuckDB BinderException/CatalogException 500 leaking as a 500.

Two things beyond the plain 503 are pinned here because they are easy to regress:
  * input validation runs BEFORE the capability gate, so a malformed request still gets a
    422 telling the caller what is wrong with it rather than a 503 blaming the mart;
  * `metric=revenue` on the default cut keeps working, because mart_niche_hist already
    ships that histogram — the charts light up on deploy, not on rebuild.
"""

REBUILD_HINT = "mart_niche_game"


# ---- /games -----------------------------------------------------------------------------
def test_games_503_without_mart(client):
    r = client.get("/api/niches/tag/Deckbuilder/games")
    assert r.status_code == 503
    detail = r.json()["detail"]
    assert REBUILD_HINT in detail
    assert "task etl" in detail


def test_games_route_wins_over_the_greedy_detail_path(client):
    """`/{dimension}/{key:path}` is registered after these routes on purpose; if that order
    ever flips, this request lands on niche_detail with key='Deckbuilder/games'. Both return
    503 against the fixture mart, so assert on WHICH 503 came back."""
    r = client.get("/api/niches/tag/Deckbuilder/games")
    assert r.status_code == 503
    assert REBUILD_HINT in r.json()["detail"]
    # ...and the detail endpoint's own 503 is a different, distinguishable message.
    d = client.get("/api/niches/tag/Deckbuilder")
    assert d.status_code == 503
    assert "v2" in d.json()["detail"]


def test_games_rejects_bad_dimension_before_touching_the_mart(client):
    r = client.get("/api/niches/franchise/Deckbuilder/games")
    assert r.status_code == 422
    assert "dimension must be tag or genre" in r.json()["detail"]


def test_games_rejects_unknown_sort(client):
    r = client.get(
        "/api/niches/tag/Deckbuilder/games",
        params={"sort": "est_rev_reviews; DROP TABLE mart_niche--"},
    )
    assert r.status_code == 422


def test_games_caps_limit(client):
    r = client.get("/api/niches/tag/Deckbuilder/games", params={"limit": 100000})
    assert r.status_code == 422


# ---- /distribution ----------------------------------------------------------------------
def test_distribution_revenue_still_served_from_the_existing_hist_mart(client):
    """The one endpoint on this surface that does NOT need mart_niche_game: revenue on the
    (all, 50) cut is mart_niche_hist, which every mart already carries."""
    r = client.get("/api/niches/tag/Deckbuilder/distribution", params={"metric": "revenue"})
    assert r.status_code == 200
    body = r.json()
    assert body["metric"] == "revenue"
    assert body["source"] == "mart"
    assert [b["bucket_index"] for b in body["buckets"]] == [10, 11]
    assert body["n_games"] == 2


def test_distribution_revenue_off_cut_needs_the_mart(client):
    """24m is not the cut mart_niche_hist materialises, so it has to be computed — and that
    needs mart_niche_game."""
    r = client.get(
        "/api/niches/tag/Deckbuilder/distribution", params={"metric": "revenue", "win": "24m"}
    )
    assert r.status_code == 503
    assert REBUILD_HINT in r.json()["detail"]


def test_distribution_revenue_falls_through_when_hist_has_no_row(client):
    """'Card Battler' has no mart_niche_hist rows (a niche under the mart's MIN_NICHE_GAMES
    floor). That must fall through to the computed path — and 503 — not return an empty
    histogram that the UI would draw as "no games"."""
    r = client.get("/api/niches/tag/Card Battler/distribution", params={"metric": "revenue"})
    assert r.status_code == 503
    assert REBUILD_HINT in r.json()["detail"]


def test_distribution_price_503_without_mart(client):
    """Price has no precomputed mart at all — it is always the computed path."""
    r = client.get("/api/niches/tag/Deckbuilder/distribution", params={"metric": "price"})
    assert r.status_code == 503
    assert REBUILD_HINT in r.json()["detail"]


def test_distribution_requires_metric(client):
    assert client.get("/api/niches/tag/Deckbuilder/distribution").status_code == 422


def test_distribution_rejects_unknown_metric(client):
    r = client.get("/api/niches/tag/Deckbuilder/distribution", params={"metric": "owners"})
    assert r.status_code == 422


# ---- /combined --------------------------------------------------------------------------
def test_combined_503_without_mart(client):
    r = client.get(
        "/api/niches/combined",
        params={"niches": ["tag:Deckbuilder", "tag:Card Battler"]},
    )
    assert r.status_code == 503
    assert REBUILD_HINT in r.json()["detail"]


def test_combined_validates_input_before_the_capability_gate(client):
    """Every one of these is a 422 even though the mart is missing — a caller with a broken
    request must be told about the request, not about the mart."""
    cases = [
        (["tag:Deckbuilder"], "at least 2"),
        (["franchise:Blizzard", "tag:Deckbuilder"], "dimension must be tag or genre"),
        (["Deckbuilder", "tag:Card Battler"], "expected 'dimension:key'"),
        (["tag:", "tag:Card Battler"], "expected 'dimension:key'"),
        (["tag:Deckbuilder", "tag:Deckbuilder"], "duplicate"),
        ([f"tag:T{i}" for i in range(9)], "at most 8"),
    ]
    for niches, needle in cases:
        r = client.get("/api/niches/combined", params={"niches": niches})
        assert r.status_code == 422, (niches, r.status_code, r.text)
        assert needle in r.json()["detail"], (niches, r.json()["detail"])


def test_combined_requires_the_niches_param(client):
    """Omitting `niches` entirely is FastAPI's own required-field 422 (a list of error
    dicts, not our string detail) — still a 422, and still ahead of the capability gate."""
    r = client.get("/api/niches/combined")
    assert r.status_code == 422
    assert r.json()["detail"][0]["loc"][-1] == "niches"


def test_combined_is_not_swallowed_by_the_dimension_route(client):
    """/api/niches/combined must not be parsed as dimension='combined'."""
    r = client.get("/api/niches/combined", params={"niches": ["tag:A", "tag:B"]})
    assert r.status_code == 503  # reached the handler; the mart is what's missing
    assert "dimension" not in r.json()["detail"]


def test_detail_bad_dimension_is_422_like_the_drilldown(client):
    """niche_detail used to answer 400 where every other hand-validated dimension check
    answers 422 — unified on 422 (web/src treats both identically, verified 2026-08-28)."""
    r = client.get("/api/niches/bogus/Whatever")
    assert r.status_code == 422
    assert r.json()["detail"] == "dimension must be tag or genre"

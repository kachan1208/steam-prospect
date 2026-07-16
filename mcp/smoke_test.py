"""Smoke test for prospect_mcp.py — instantiates the server module (which opens the
real read-only DuckDB connection to data/current.duckdb) and calls a handful of tools
directly as plain Python functions (the @mcp.tool() decorator registers but does not
wrap/replace the function — see mcp.server.fastmcp.server.FastMCP.tool()), printing real
returned data for manual/CI verification.

Run: mcp/.venv/bin/python mcp/smoke_test.py
"""
from __future__ import annotations

import json

import prospect_mcp as srv


def show(title: str, obj) -> None:
    print(f"\n=== {title} ===")
    print(json.dumps(obj, indent=2, default=str))


def main() -> None:
    # 1. find_niches — top tag niche under default filters must be "Open World Survival Craft".
    niches = srv.find_niches()
    show("find_niches() [defaults: tag/all/min_reviews=10]", niches)
    top_key = niches["niches"][0]["key"]
    assert top_key == "Open World Survival Craft", f"expected top niche 'Open World Survival Craft', got {top_key!r}"
    print(f"\n[OK] top niche is {top_key!r}")

    # 2. niche_detail on that same niche.
    detail = srv.niche_detail("tag", "Open World Survival Craft")
    show("niche_detail('tag', 'Open World Survival Craft')", detail)
    assert "error" not in detail
    print(f"\n[OK] niche_detail returned {len(detail['representative_games'])} representative games, "
          f"{len(detail['saturation_trend'])} trend years, {len(detail['revenue_histogram'])} hist buckets")

    # 3. market_benchmarks.
    bm = srv.market_benchmarks()
    show("market_benchmarks()", bm)
    assert bm["cited"]["median_indie_gross_usd"] == 249
    print("\n[OK] market_benchmarks returned cited + computed anchors")

    # 4. estimate_revenue(reviews=500, price=19.99, genre="Action").
    est = srv.estimate_revenue(reviews=500, price=19.99, genre="Action")
    show('estimate_revenue(reviews=500, price=19.99, genre="Action")', est)
    assert est["basis"] == "reviews" and est["genre"] == "Action"
    print(f"\n[OK] estimate_revenue: owners mid={est['owners']['mid']:.0f}, "
          f"net revenue mid=${est['revenue_net_usd']['mid']:.0f}, dev_tier={est['dev_tier']!r}")

    # 5. game_teardown for Hollow Knight (appid 367520).
    teardown = srv.game_teardown(367520)
    show("game_teardown(367520)  # Hollow Knight", teardown)
    assert teardown["name"] == "Hollow Knight"
    assert teardown["eligible_reviews"] is True
    print(f"\n[OK] game_teardown: {teardown['n_reviews_sampled']} reviews sampled, "
          f"{len(teardown['review_aspects'])} aspects, {teardown['press']['total_mentions']} press mentions")

    # 6. game_profile + game_search sanity.
    profile = srv.game_profile(367520)
    show("game_profile(367520)", profile)
    assert profile["name"] == "Hollow Knight"

    search = srv.game_search(q="Hollow Knight", limit=5)
    show('game_search(q="Hollow Knight")', search)
    assert any(g["appid"] == 367520 for g in search["games"])

    # 7. launch_shape + best_launch_timing.
    shape = srv.launch_shape("Action")
    show('launch_shape("Action")', shape)
    assert "error" not in shape

    timing = srv.best_launch_timing("Action")
    show('best_launch_timing("Action")', timing)
    assert "error" not in timing

    # 8. revenue_distribution.
    dist = srv.revenue_distribution("revenue", "Action", "all")
    show('revenue_distribution("revenue", "Action", "all")', dist)
    assert dist["n"] > 0

    # 9. press_pitch_list + buzz_trends.
    pitch = srv.press_pitch_list("RPG", limit=5)
    show('press_pitch_list("RPG")', pitch)

    buzz = srv.buzz_trends("rising", limit=10)
    show('buzz_trends("rising")', buzz)

    # 10. data dictionary resource — call the underlying function directly (not through
    # the resource-read protocol, same "decorator returns fn unchanged" property as tools).
    dd = srv.data_dictionary()
    print(f"\n=== data_dictionary() resource ===\n{dd[:400]}\n... [{len(dd)} chars total]")

    print("\nALL SMOKE TESTS PASSED")


if __name__ == "__main__":
    main()

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
    # 1. find_niches — defaults are now the niche-score v2 cut (window=24m,
    # sort=opportunity_v2, include_tiers=[micro, theme]). Tolerant on purpose: the v2
    # columns only exist once the ETL that added them has rebuilt current.duckdb, and
    # their absence must yield the tool's clear "re-run ETL" error dict, never a crash
    # (post-ETL the assertions are real).
    niches = srv.find_niches()
    show("find_niches() [defaults: tag/24m/min_reviews=50/opportunity_v2/micro+theme]", niches)
    has_v2 = "error" not in niches
    if not has_v2:
        assert "opportunity_v2" in niches["error"], f"unexpected find_niches error: {niches['error']!r}"
        print("\n[OK] find_niches degraded cleanly (v2 columns not built yet — run `task etl`)")
    else:
        assert niches["niches"], "expected at least one niche row under default filters"
        top = niches["niches"][0]
        for field in ("opportunity_v2", "opportunity", "decline_gate", "entrant_ratio",
                      "solo_viability", "tier"):
            assert field in top, f"missing v2 field {field!r} in find_niches rows"
        bad_tiers = {n["tier"] for n in niches["niches"]} - {"micro", "theme"}
        assert not bad_tiers, f"default include_tiers leaked tiers: {bad_tiers}"
        assert all(n["opportunity_v2"] <= n["opportunity"] + 1e-9 for n in niches["niches"]), \
            "opportunity_v2 must never exceed opportunity (gate is <= 1)"
        print(f"\n[OK] top niche is {top['key']!r} (tier={top['tier']}, "
              f"opportunity_v2={top['opportunity_v2']}, gate={top['decline_gate']})")

    # 2. niche_detail — same tolerance: v2 columns are in its variants query too.
    detail_key = niches["niches"][0]["key"] if has_v2 else "Open World Survival Craft"
    detail = srv.niche_detail("tag", detail_key)
    show(f"niche_detail('tag', {detail_key!r})", detail)
    if not has_v2:
        assert "error" in detail and "opportunity_v2" in detail["error"], \
            f"expected the v2 re-run-ETL error, got: {detail!r}"
        print("\n[OK] niche_detail degraded cleanly (v2 columns not built yet — run `task etl`)")
    else:
        assert "error" not in detail
        assert detail["tier"] in ("micro", "umbrella", "theme", "meta", "genre")
        assert all("entrant_ratio" in v and "solo_viability" in v for v in detail["variants"])
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

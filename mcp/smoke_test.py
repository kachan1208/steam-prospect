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
    # 1. find_niches — "Open World Survival Craft" must rank among the top tag niches under
    # default filters. (Was asserted as exactly #1, but the top slot legitimately drifts as
    # nightly data lands — on the 2026-07-30 mart it's 'Extraction Shooter' — so this now
    # checks membership in the returned top list rather than the exact winner.)
    niches = srv.find_niches()
    show("find_niches() [defaults: tag/all/min_reviews=10]", niches)
    keys = [n["key"] for n in niches["niches"]]
    assert "Open World Survival Craft" in keys, f"expected 'Open World Survival Craft' in top niches, got {keys!r}"
    print(f"\n[OK] top niche is {keys[0]!r}; 'Open World Survival Craft' ranks #{keys.index('Open World Survival Craft') + 1}")

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

    # 9b. entity_profile + publisher_pitch_list — tolerant: mart_entity/mart_entity_games
    # only exist once the ETL that added them has run, and their absence must yield the
    # tools' clear "rebuild the marts" error dict, never a crash.
    ep = srv.entity_profile("Electronic Arts", "publisher")
    if "error" in ep:
        assert "mart_entity" in ep["error"], f"unexpected entity_profile error: {ep['error']!r}"
        show('entity_profile("Electronic Arts", "publisher") [degraded]', ep)
        print("\n[OK] entity tools degraded cleanly (mart_entity not built yet — run `task etl`)")
    else:
        show('entity_profile("Electronic Arts", "publisher")', ep)
        assert ep["entity"]["n_games"] >= 50, "EA should have a large publisher catalog"
        assert ep["games"] and ep["games"][0]["seq"] == 1, "games must be seq-ordered from 1"
        assert ep["trajectory"]["debut"]["seq"] == 1
        print(f"\n[OK] entity_profile: EA published {ep['entity']['n_games']} games, "
              f"{ep['entity']['n_recent_24m']} in the last 24m, {ep['entity']['n_partners']} partners")

        dev = srv.entity_profile("Gamatron AB")  # role defaults to developer
        show('entity_profile("Gamatron AB")', dev)
        assert any(g["name"] == "Songs of Syx" for g in dev["games"])
        print("\n[OK] entity_profile: Gamatron AB -> Songs of Syx")

        miss = srv.entity_profile("Zzz No Such Studio Zzz")
        assert "error" in miss and "suggestions" in miss
        near = srv.entity_profile("FromSoftware, In")  # near-miss must suggest the real entity
        assert "error" in near and any("FromSoftware" in s["name"] for s in near["suggestions"])
        print(f"\n[OK] entity_profile miss -> suggestions ({[s['name'] for s in near['suggestions']]})")

        ppl = srv.publisher_pitch_list("RPG", min_games=3, limit=10)
        show('publisher_pitch_list("RPG")', ppl)
        assert ppl["n_returned"] > 0 and all(p["n_in_genre"] >= 1 for p in ppl["publishers"])
        assert all(p["n_games"] >= 3 for p in ppl["publishers"])
        assert ppl["publishers"][0]["active"], "active publishers must rank first"
        print(f"\n[OK] publisher_pitch_list: {ppl['n_returned']} RPG publishers, top "
              f"{ppl['publishers'][0]['name']!r} ({ppl['publishers'][0]['n_in_genre']} RPG games)")

    # 10. data dictionary resource — call the underlying function directly (not through
    # the resource-read protocol, same "decorator returns fn unchanged" property as tools).
    dd = srv.data_dictionary()
    print(f"\n=== data_dictionary() resource ===\n{dd[:400]}\n... [{len(dd)} chars total]")

    print("\nALL SMOKE TESTS PASSED")


if __name__ == "__main__":
    main()

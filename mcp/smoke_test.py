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
        # Live-player columns ride along exactly when the mart carries them (values may
        # be None — e.g. a fixture whose one capture day is > 7d stale).
        if srv._has_players():
            for field in ("total_players_now", "players_trend_7d_pct", "players_coverage"):
                assert field in top, f"missing players field {field!r} in find_niches rows"
        # Lifetime columns ride along exactly when the mart carries them (values may be
        # None pre-mart — e.g. fewer than 5 steamcharts-covered games in the niche).
        if srv._has_lifetime():
            assert "lifetime_survival_12m" in top, "missing lifetime field in find_niches rows"
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
        assert "players" in detail, "niche_detail must always carry the players key (may be None)"
        print(f"\n[OK] niche_detail returned {len(detail['representative_games'])} representative games, "
              f"{len(detail['saturation_trend'])} trend years, {len(detail['revenue_histogram'])} hist buckets, "
              f"players={'yes' if detail['players'] else 'None'}")

    # 2b. tag_combos — tolerant: mart_tag_lift only exists once the ETL that added it has
    # run, and its absence must yield the tool's clear error dict, never a crash.
    combos = srv.tag_combos("Roguelike Deckbuilder", limit=5)
    show("tag_combos('Roguelike Deckbuilder', limit=5)", combos)
    if "error" in combos:
        assert "mart_tag_lift" in combos["error"], f"unexpected tag_combos error: {combos['error']!r}"
        print("\n[OK] tag_combos degraded cleanly (mart_tag_lift not built yet — run `task etl`)")
    else:
        assert combos["n_pairs"] > 0 and combos["best_combos"], "expected pairs for a popular tag"
        assert all(c["lift"] is not None for c in combos["best_combos"])
        print(f"\n[OK] tag_combos: {combos['n_pairs']} pairs, best partner "
              f"{combos['best_combos'][0]['partner']!r} at {combos['best_combos'][0]['lift']}x lift")

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

    # dev_x_handle rides along exactly when the mart carries the socials columns (value
    # may be None — official links are harvested from store pages / dev websites, and
    # not every game has one or has been fetched yet).
    if srv._has_dev_socials():
        assert "dev_x_handle" in profile, "missing dev_x_handle in game_profile"
        assert all("dev_x_handle" in g for g in search["games"]), \
            "missing dev_x_handle in game_search rows"
        print("\n[OK] dev_x_handle rides along in game_profile + game_search")

    # 6b. player-history tools — tolerant: the CCU marts only exist once the ETL that
    # added them has rebuilt current.duckdb, and their absence must yield the tools'
    # clear "re-run ETL" error dict, never a crash. Values are shape-checked only (a
    # fixture may hold a single stale capture day, making summaries None/empty).
    gph = srv.game_player_history(367520, days=365)
    show("game_player_history(367520, days=365)", gph)
    if "error" in gph:
        assert "live-player" in gph["error"], f"unexpected game_player_history error: {gph['error']!r}"
        print("\n[OK] game_player_history degraded cleanly (CCU marts not built yet — run `task etl`)")
    else:
        assert gph["name"] == "Hollow Knight"
        assert "summary" in gph and "series" in gph and isinstance(gph["series"], list)
        assert "monthly" in gph and isinstance(gph["monthly"], list)  # may be empty pre-backfill
        assert gph["caveats"], "player tools must always state the point-sample caveats"
        print(f"\n[OK] game_player_history: {gph['summary'].get('n_days_measured', 0)} measured days, "
              f"{len(gph['series'])} series rows")

    nph = srv.niche_player_history("tag", detail_key, days=365)
    show(f"niche_player_history('tag', {detail_key!r}, days=365)", nph)
    if "error" in nph:
        assert "live-player" in nph["error"] or "no niche found" in nph["error"], \
            f"unexpected niche_player_history error: {nph['error']!r}"
        print("\n[OK] niche_player_history degraded cleanly")
    else:
        assert "summary" in nph and "series" in nph and isinstance(nph["series"], list)
        assert "n_games_panel" in nph["summary"]
        assert "top_games_now" in nph and isinstance(nph["top_games_now"], list)  # may be empty pre-dist-marts
        print(f"\n[OK] niche_player_history: {len(nph['series'])} series rows, "
              f"panel={nph['summary'].get('n_games_panel')}")

    # 7. launch_shape + best_launch_timing. Timing is tolerant on purpose: the
    # mart_timing_* trio only exists once the ETL that added it (and a source DB with
    # review_histogram) has rebuilt current.duckdb — absence must yield the tool's clear
    # re-run-ETL error dict, never a crash (post-ETL the assertions are real).
    shape = srv.launch_shape("Action")
    show('launch_shape("Action")', shape)
    assert "error" not in shape

    timing = srv.best_launch_timing("Action")
    show('best_launch_timing("Action")', timing)
    if "error" in timing:
        assert "mart_timing" in timing["error"], f"unexpected best_launch_timing error: {timing['error']!r}"
        print("\n[OK] best_launch_timing degraded cleanly (mart_timing_* not built yet — run `task etl`)")
    else:
        assert len(timing["demand_by_month"]) == 12
        assert len(timing["congestion_by_month"]) == 12
        assert timing["recommendation"] and len(timing["recommendation"]["best_months"]) >= 2
        assert timing["decay"] is not None
        d = timing["decay"]["share_of_first_24m_reviews"]
        assert d["months_0_2"] > d["months_3_5"], "decay must be front-loaded"
        # clean() rounds floats to 4 decimals, so the 4 windows sum to 1 +- rounding.
        assert abs(sum(d.values()) - 1.0) < 1e-3, "decay windows must renormalize to ~1"
        print(f"\n[OK] best_launch_timing: best months {timing['recommendation']['best_months']}, "
              f"first-3-months share {d['months_0_2']:.2f}")

    # 8. revenue_distribution.
    dist = srv.revenue_distribution("revenue", "Action", "all")
    show('revenue_distribution("revenue", "Action", "all")', dist)
    assert dist["n"] > 0

    # 8b. lifetime_curve — tolerant: mart_market_lifetime only exists once the lifetime
    # ETL has rebuilt current.duckdb; absence must yield the tool's clear "re-run ETL"
    # error dict, never a crash (curve/milestones may be empty/None pre-mart).
    lc = srv.lifetime_curve()
    show("lifetime_curve()", lc)
    if "error" in lc:
        assert "game-lifetime" in lc["error"], f"unexpected lifetime_curve error: {lc['error']!r}"
        print("\n[OK] lifetime_curve degraded cleanly (mart_market_lifetime not built yet — run `task etl`)")
    else:
        assert isinstance(lc["curve"], list) and isinstance(lc["milestones"], dict)
        print(f"\n[OK] lifetime_curve: {len(lc['curve'])} points, m12={lc['milestones'].get('m12')}, "
              f"median_months={lc['median_months']}")

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
        # x_handle rides along exactly when the mart carries the socials columns (value
        # may be None — majority vote over the entity's games' dev_x_handle).
        if srv._has_dev_socials():
            assert "x_handle" in ep["entity"], "missing x_handle in entity_profile"
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

    # 11. niche_review_themes — tolerant: mart_niche_themes only exists on marts built by
    # the ETL that added it; absence must yield the tool's clear error dict, never a crash.
    themes = srv.niche_review_themes("tag", detail_key)
    show(f"niche_review_themes('tag', {detail_key!r})", themes)
    if "error" in themes:
        assert "mart_niche_themes" in themes["error"] or "no niche found" in themes["error"], \
            f"unexpected niche_review_themes error: {themes['error']!r}"
        print("\n[OK] niche_review_themes degraded cleanly")
    else:
        assert isinstance(themes["praise_themes"], list) and isinstance(themes["complaint_themes"], list)
        assert themes["caveats"], "niche_review_themes must always state its caveats"
        print(f"\n[OK] niche_review_themes: {len(themes['praise_themes'])} praise / "
              f"{len(themes['complaint_themes'])} complaint themes")

    # 12. find_comparables — computed on demand from mart_game, so it works on any mart;
    # shape-checked only (the fixture's tiny catalog may yield zero matches — a real
    # answer, flagged by `note`).
    comps = srv.find_comparables(367520, limit=5)
    show("find_comparables(367520)  # Hollow Knight", comps)
    assert "error" not in comps
    assert comps["name"] == "Hollow Knight"
    assert isinstance(comps["comparables"], list) and "price_band" in comps
    assert comps["caveats"], "find_comparables must always state its caveats"
    for c in comps["comparables"]:
        assert "jaccard" in c and "shared_tags" in c
    print(f"\n[OK] find_comparables: {comps['n_returned']} comparables "
          f"(band ${comps['price_band']['low']}-${comps['price_band']['high']})")

    miss_comp = srv.find_comparables(1)  # appid 1 never exists
    assert "error" in miss_comp
    print("\n[OK] find_comparables miss -> error dict")

    # 13. game_reviews_summary — tolerant: the mart_game_reviews_* marts are additive.
    grs = srv.game_reviews_summary(367520)
    show("game_reviews_summary(367520)", grs)
    if "error" in grs:
        assert "mart_game_reviews" in grs["error"], \
            f"unexpected game_reviews_summary error: {grs['error']!r}"
        print("\n[OK] game_reviews_summary degraded cleanly (marts not built yet — run `task etl`)")
    else:
        assert "eligible" in grs and isinstance(grs["timeline"], list)
        assert isinstance(grs["language_split"], list) and isinstance(grs["launch_curve"], list)
        print(f"\n[OK] game_reviews_summary: {len(grs['timeline'])} timeline rows, "
              f"eligible={grs['eligible']}")

    # 14. aspect_reviews — tolerant: mart_game_aspect_reviews is additive. An eligible
    # game with nothing said about an aspect returns an empty list (absence of evidence).
    ar = srv.aspect_reviews(367520, "Combat & Bosses", "praise", limit=2)
    show("aspect_reviews(367520, 'Combat & Bosses', 'praise')", ar)
    if "error" in ar:
        assert "mart_game_aspect_reviews" in ar["error"], \
            f"unexpected aspect_reviews error: {ar['error']!r}"
        print("\n[OK] aspect_reviews degraded cleanly (mart not built yet — run `task etl`)")
    else:
        assert isinstance(ar["items"], list) and ar["n_returned"] == len(ar["items"])
        print(f"\n[OK] aspect_reviews: {ar['n_returned']} excerpts")
        # Aspect validation only runs once the mart-presence gate passes.
        bad_aspect = srv.aspect_reviews(367520, "Not An Aspect", "praise")
        assert "error" in bad_aspect and "aspect must be one of" in bad_aspect["error"]
        print("\n[OK] aspect_reviews rejects unknown aspects")

    # 15. tag_suggest — works on any mart (reads mart_game.top_tags); the second call must
    # hit the in-process frequency cache and agree with the first.
    sugg = srv.tag_suggest("rogue", limit=5)
    show("tag_suggest('rogue')", sugg)
    assert isinstance(sugg["tags"], list) and sugg["n_returned"] == len(sugg["tags"])
    for t in sugg["tags"]:
        assert "tag" in t and "n_games" in t
        assert "rogue" in t["tag"].lower()
    assert srv.tag_suggest("rogue", limit=5) == sugg, "tag_suggest must be deterministic (cached)"
    top_tags = srv.tag_suggest("", limit=3)
    assert top_tags["n_returned"] <= 3
    print(f"\n[OK] tag_suggest: {sugg['n_returned']} matches for 'rogue', cache consistent")

    # 16. channel_mix + channel_buzz — tolerant: the channel marts are additive (and
    # press-only since 2026-08-25); absence must yield the tools' clear error dict.
    cm = srv.channel_mix()
    show("channel_mix()", cm)
    if "error" in cm:
        assert "mart_channel_mix" in cm["error"], f"unexpected channel_mix error: {cm['error']!r}"
        print("\n[OK] channel_mix degraded cleanly (mart not built yet — run `task etl`)")
    else:
        assert isinstance(cm["items"], list)
        print(f"\n[OK] channel_mix: {len(cm['items'])} (genre, channel) rows")

    cb = srv.channel_buzz("rising", limit=5)
    show("channel_buzz('rising')", cb)
    if "error" in cb:
        assert "mart_channel_buzz" in cb["error"], f"unexpected channel_buzz error: {cb['error']!r}"
        print("\n[OK] channel_buzz degraded cleanly (marts not built yet — run `task etl`)")
    else:
        assert isinstance(cb["terms"], list) and cb["n_returned"] == len(cb["terms"])
        for term in cb["terms"]:
            assert "by_channel" in term and "series" not in term  # series only when asked
        cb_series = srv.channel_buzz("rising", limit=2, include_series=True)
        assert all("series" in t and "by_channel" in t for t in cb_series["terms"])
        print(f"\n[OK] channel_buzz: {cb['n_returned']} terms, by_channel always attached, "
              "series only with include_series=True")

    print("\nALL SMOKE TESTS PASSED")


if __name__ == "__main__":
    main()

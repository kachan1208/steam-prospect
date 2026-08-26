#!/usr/bin/env python3
"""Corpus metrics exporter — one gauge sample per nightly run → VictoriaMetrics.

Pushed AFTER a successful ETL (prospect-refresh.sh step `metrics_export`) so the mart
side describes the mart that is actually serving. Complements the pipeline-health
metrics record_run() already pushes: those say "did the machine run", these say "how
big and how complete is the corpus" — totals, coverage, and the burn-downs (review-text
gap, socials coverage) whose slopes are the real health signal. Run with the ETL venv
(needs duckdb): /root/prospect/etl/.venv/bin/python export_metrics.py [sqlite] [mart].
"""
import sqlite3
import sys
import urllib.request

import duckdb

SQLITE = sys.argv[1] if len(sys.argv) > 1 else "/root/steam-scraper/steam_games.db"
MART = sys.argv[2] if len(sys.argv) > 2 else "/root/prospect/data/current.duckdb"
VM = "http://localhost:8428/api/v1/import/prometheus"
REVIEW_TEXT_CAP = 20000  # deepen-reviews' per-game target: "full coverage" = min(true, cap)

metrics = []


def add(name, value, labels=""):
    if value is not None:
        metrics.append(f"prospect_corpus_{name}{labels} {value}")


s = sqlite3.connect(f"file:{SQLITE}?mode=ro", uri=True)
q = lambda sql: s.execute(sql).fetchone()[0]

add("games_total", q("SELECT count(*) FROM games"))
add("games_released", q("SELECT count(*) FROM games WHERE type = 'game' OR type IS NULL"))
add("articles_total", q("SELECT count(*) FROM articles"))
add("reviews_sampled_total", q("SELECT count(*) FROM reviews"))
add("review_true_total", q(
    "SELECT COALESCE(SUM(COALESCE(total_reviews, total_positive + total_negative)), 0) FROM review_summary"
))
add("games_with_reviews", q(
    "SELECT count(*) FROM review_summary WHERE COALESCE(total_reviews, total_positive + total_negative) > 0"
))
add("games_without_reviews", q(
    """SELECT count(*) FROM games g WHERE (g.type = 'game' OR g.type IS NULL)
       AND NOT EXISTS (SELECT 1 FROM review_summary r WHERE r.appid = g.appid
                       AND COALESCE(r.total_reviews, r.total_positive + r.total_negative) > 0)"""
))

# Review-TEXT coverage vs min(true, cap) over the scored (50+ true reviews) population —
# the daytime coverage keeper's burn-down. missing → 0 is the "full coverage" goal line.
rows = s.execute(
    """WITH have AS (SELECT appid, COUNT(*) AS c FROM reviews GROUP BY appid)
       SELECT COALESCE(r.total_reviews, r.total_positive + r.total_negative), COALESCE(h.c, 0)
       FROM review_summary r LEFT JOIN have h ON h.appid = r.appid
       WHERE COALESCE(r.total_reviews, r.total_positive + r.total_negative) >= 50"""
).fetchall()
target = sum(min(t, REVIEW_TEXT_CAP) for t, _ in rows)
covered = sum(min(c, min(t, REVIEW_TEXT_CAP)) for t, c in rows)
add("games_scored_50plus", len(rows))
add("review_texts_target_total", target)
add("review_texts_covered_total", covered)
add("review_texts_missing_total", max(0, target - covered))
add("games_full_review_coverage", sum(1 for t, c in rows if c >= min(t, REVIEW_TEXT_CAP)))

add("tag_rows_total", q("SELECT count(*) FROM game_tags"))
# Demo coverage burn-down: checked climbs toward games_released as appdetails passes
# sweep the catalog; with_demo/checked is the market's true demo-adoption rate.
# Additive sqlite columns — absent before the demo migration, skip rather than crash.
try:
    add("games_demo_checked", q(
        "SELECT count(*) FROM games WHERE demos_checked_at IS NOT NULL AND (type='game' OR type IS NULL)"
    ))
    add("games_with_demo", q(
        "SELECT count(*) FROM games WHERE demo_appid IS NOT NULL AND (type='game' OR type IS NULL)"
    ))
except sqlite3.OperationalError:
    pass
add("games_with_socials", q("SELECT count(DISTINCT appid) FROM game_socials"))
add("games_with_x_handle", q("SELECT count(DISTINCT appid) FROM game_socials WHERE platform = 'x'"))

d = duckdb.connect(MART, read_only=True)
dq = lambda sql: d.execute(sql).fetchone()[0]
for role in ("developer", "publisher"):
    add(f"{role}s_total", dq(f"SELECT count(*) FROM mart_entity WHERE role = '{role}'"))
add("players_live_total", dq("SELECT COALESCE(SUM(live_players), 0) FROM mart_game"))
add("games_ccu_measured", dq("SELECT count(*) FROM mart_game WHERE live_players IS NOT NULL"))
add("niches_scored", dq("SELECT count(DISTINCT key) FROM mart_niche"))
# Additive mart columns — absent on older marts, skip rather than crash (same
# degrade-cleanly stance as the API's capability gates).
for name, sql in [
    ("games_with_dev_x_handle_mart", "SELECT count(*) FROM mart_game WHERE dev_x_handle IS NOT NULL"),
    ("games_lifetime_cohort", "SELECT count(*) FROM mart_game WHERE lifetime_months IS NOT NULL"),
]:
    try:
        add(name, dq(sql))
    except Exception:
        pass

urllib.request.urlopen(urllib.request.Request(VM, data="\n".join(metrics).encode()), timeout=15)
print(f"pushed {len(metrics)} corpus metrics")

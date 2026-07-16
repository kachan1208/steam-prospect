"""api/app/routers/explore.py — the Data Explorer's whitelist/injection defenses.

This is THE security boundary called out in the O2 plan: the only place a client-supplied
column/metric name can turn into SQL text is via a lookup into DIMENSIONS/METRICS (fixed,
developer-authored dicts) — a client string is only ever used as a dict KEY, never
concatenated. Every test below throws something at that boundary that is NOT a whitelisted
key (an unknown name, a SQL-injection-shaped string standing in for a column name, a
disallowed op for a column's kind, an out-of-shape filter value, ...) and asserts it's
rejected with 400/422 rather than reaching compile_query's SQL-building step. A couple of
happy-path / shape tests (schema endpoint, basic select, group+metric, CSV export, limit
clamping) round it out so the whitelist's ALLOW path is exercised too, not just the DENY path.
"""
from __future__ import annotations

import json

from app.routers.explore import DIMENSIONS, METRICS

# ---- happy paths -----------------------------------------------------------------------


def test_schema_endpoint_exposes_the_whitelist(client):
    r = client.get("/api/explore/schema")
    assert r.status_code == 200
    body = r.json()
    assert {d["name"] for d in body["dimensions"]} == set(DIMENSIONS)
    assert {m["name"] for m in body["metrics"]} == set(METRICS)
    assert body["max_select"] == 8
    assert body["max_group_by"] == 2


def test_basic_row_select_returns_all_fixture_games(client):
    r = client.post("/api/explore", json={"select": ["appid", "name"], "filters": [], "limit": 50})
    assert r.status_code == 200
    body = r.json()
    assert body["row_count"] == 6
    assert body["grouped"] is False
    assert set(body["columns"]) == {"appid", "name"}


def test_filter_by_whitelisted_column_narrows_results(client):
    r = client.post(
        "/api/explore",
        json={
            "select": ["appid", "name"],
            "filters": [{"col": "primary_genre", "op": "eq", "val": "Roguelike"}],
            "limit": 50,
        },
    )
    assert r.status_code == 200
    body = r.json()
    assert body["row_count"] == 3  # 1001, 1002, 1003 in the fixture


def test_group_by_with_metrics_returns_one_row_per_group(client):
    r = client.post(
        "/api/explore",
        json={
            "select": ["primary_genre", "n_games", "median_price"],
            "group_by": ["primary_genre"],
            "filters": [],
            "limit": 50,
        },
    )
    assert r.status_code == 200
    body = r.json()
    assert body["grouped"] is True
    assert {row["primary_genre"] for row in body["rows"]} == {"Roguelike", "Action", "Simulation"}


def test_export_csv_happy_path(client):
    query = json.dumps({"select": ["appid", "name"], "filters": [], "limit": 10})
    r = client.get("/api/explore/export.csv", params={"query": query})
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("text/csv")
    assert "appid,name" in r.text.splitlines()[0]


def test_limit_is_clamped_server_side_regardless_of_request(client):
    r = client.post("/api/explore", json={"select": ["appid"], "filters": [], "limit": 1000})
    assert r.status_code == 200
    # compile_query fetches limit+1 to detect truncation; 1000 is _MAX_LIMIT so this proves
    # the SQL text reflects the clamped value, not a client-supplied one above it (Pydantic's
    # own le=1000 on ExploreQuery.limit already blocks >1000 at the request-shape level —
    # see test_limit_above_pydantic_ceiling_is_422 below for that separate layer).
    assert "LIMIT 1001" in r.json()["sql_preview"]


# ---- rejection paths: unknown / off-whitelist identifiers -------------------------------


def test_unknown_column_in_select_is_rejected(client):
    r = client.post("/api/explore", json={"select": ["not_a_real_column"], "filters": [], "limit": 10})
    assert r.status_code == 400


def test_sql_injection_shaped_string_in_select_is_rejected(client):
    r = client.post(
        "/api/explore",
        json={"select": ["appid; DROP TABLE mart_explorer--", "name"], "filters": [], "limit": 10},
    )
    assert r.status_code == 400


def test_unknown_column_in_filters_is_rejected(client):
    r = client.post(
        "/api/explore",
        json={
            "select": ["appid"],
            "filters": [{"col": "not_a_real_column", "op": "eq", "val": 1}],
            "limit": 10,
        },
    )
    assert r.status_code == 400
    assert "Unknown column" in r.json()["detail"]


def test_sql_injection_shaped_string_in_filter_col_is_rejected(client):
    r = client.post(
        "/api/explore",
        json={
            "select": ["appid"],
            "filters": [{"col": "appid) OR 1=1 --", "op": "eq", "val": 1}],
            "limit": 10,
        },
    )
    assert r.status_code == 400
    assert "Unknown column" in r.json()["detail"]


def test_unknown_column_in_group_by_is_rejected(client):
    r = client.post(
        "/api/explore",
        json={"select": ["n_games"], "group_by": ["not_a_real_column"], "filters": [], "limit": 10},
    )
    assert r.status_code == 400


def test_sql_injection_shaped_string_in_group_by_is_rejected(client):
    r = client.post(
        "/api/explore",
        json={"select": ["n_games"], "group_by": ["appid; DROP TABLE mart_explorer--"], "filters": [], "limit": 10},
    )
    assert r.status_code == 400


def test_non_groupable_column_in_group_by_is_rejected(client):
    # price_initial is kind="number", groupable=False in DIMENSIONS.
    assert DIMENSIONS["price_initial"].groupable is False
    r = client.post(
        "/api/explore",
        json={"select": ["price_initial", "n_games"], "group_by": ["price_initial"], "filters": [], "limit": 10},
    )
    assert r.status_code == 400
    assert "not groupable" in r.json()["detail"]


def test_unknown_sort_column_is_rejected(client):
    r = client.post(
        "/api/explore",
        json={"select": ["appid", "name"], "filters": [], "sort": "appid; DROP TABLE mart_explorer--", "limit": 10},
    )
    assert r.status_code == 400
    assert "must be one of the selected columns" in r.json()["detail"]


def test_mixing_dims_and_metrics_without_group_by_is_rejected(client):
    r = client.post(
        "/api/explore",
        json={"select": ["appid", "n_games"], "filters": [], "limit": 10},
    )
    assert r.status_code == 400


def test_grouped_select_name_that_is_neither_group_col_nor_metric_is_rejected(client):
    r = client.post(
        "/api/explore",
        json={
            "select": ["primary_genre", "not_a_metric_or_group_col"],
            "group_by": ["primary_genre"],
            "filters": [],
            "limit": 10,
        },
    )
    assert r.status_code == 400
    assert "must be a group_by column or one of the metrics" in r.json()["detail"]


def test_duplicate_select_names_are_rejected(client):
    r = client.post("/api/explore", json={"select": ["appid", "appid"], "filters": [], "limit": 10})
    assert r.status_code == 400
    assert "duplicate" in r.json()["detail"]


# ---- rejection paths: op/kind and value-shape validation ---------------------------------


def test_op_not_valid_for_column_kind_is_rejected(client):
    # "gt" is only valid for number/integer kinds; primary_genre is kind="string".
    r = client.post(
        "/api/explore",
        json={"select": ["appid"], "filters": [{"col": "primary_genre", "op": "gt", "val": "A"}], "limit": 10},
    )
    assert r.status_code == 400
    assert "is not valid for column" in r.json()["detail"]


def test_contains_op_on_non_list_column_is_rejected(client):
    r = client.post(
        "/api/explore",
        json={"select": ["appid"], "filters": [{"col": "name", "op": "contains", "val": "x"}], "limit": 10},
    )
    assert r.status_code == 400


def test_like_op_is_rejected_before_it_ever_reaches_the_router(client):
    # NOTE: schemas.py's FilterOp Literal doesn't actually include "like" (only compile_query's
    # _OPS_BY_KIND/branch does) — so this is rejected one layer OUT, by FastAPI/Pydantic request
    # validation (422), before compile_query's own "non-empty string" check for that op could
    # ever run. Still a real defense-in-depth data point: even if the router's whitelist had a
    # gap, the outer request schema is a second, independent gate. Documented here rather than
    # "fixed" — this file doesn't touch schemas.py (see api/tests' ownership scope).
    r = client.post(
        "/api/explore",
        json={"select": ["appid"], "filters": [{"col": "name", "op": "like", "val": ""}], "limit": 10},
    )
    assert r.status_code == 422


def test_in_op_with_non_list_value_is_rejected(client):
    r = client.post(
        "/api/explore",
        json={"select": ["appid"], "filters": [{"col": "primary_genre", "op": "in", "val": "Roguelike"}], "limit": 10},
    )
    assert r.status_code == 400


def test_in_op_with_too_many_values_is_rejected(client):
    r = client.post(
        "/api/explore",
        json={
            "select": ["appid"],
            "filters": [{"col": "appid", "op": "in", "val": list(range(51))}],  # cap is 50
            "limit": 10,
        },
    )
    assert r.status_code == 400
    assert "1-50 items" in r.json()["detail"]


def test_comparison_op_with_null_value_is_rejected(client):
    r = client.post(
        "/api/explore",
        json={"select": ["appid"], "filters": [{"col": "total_reviews", "op": "gt", "val": None}], "limit": 10},
    )
    assert r.status_code == 400
    assert "non-null val" in r.json()["detail"]


# ---- rejection paths enforced by the Pydantic request shape (422, not 400) ---------------


def test_empty_select_is_422(client):
    r = client.post("/api/explore", json={"select": [], "filters": [], "limit": 10})
    assert r.status_code == 422


def test_too_many_filters_is_422(client):
    filters = [{"col": "appid", "op": "eq", "val": i} for i in range(9)]  # max_length=8
    r = client.post("/api/explore", json={"select": ["appid"], "filters": filters, "limit": 10})
    assert r.status_code == 422


def test_limit_above_pydantic_ceiling_is_422(client):
    r = client.post("/api/explore", json={"select": ["appid"], "filters": [], "limit": 1_000_000})
    assert r.status_code == 422


def test_unknown_op_literal_is_422(client):
    r = client.post(
        "/api/explore",
        json={"select": ["appid"], "filters": [{"col": "appid", "op": "not_a_real_op", "val": 1}], "limit": 10},
    )
    assert r.status_code == 422

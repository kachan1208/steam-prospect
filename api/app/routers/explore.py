"""Data Explorer — safe, whitelisted query/filter/chart builder over mart_explorer.

The one hard rule: **never run raw SQL from the client.** A request is a structured
ExploreQuery (select / filters / group_by / sort / limit) whose every column and metric
name is checked against the DIMENSIONS/METRICS whitelists below before any SQL is built.
Every identifier that lands in the compiled SQL text comes from the *value* side of these
dicts (fixed, developer-authored strings) — a client-supplied name can only ever be used as
a *lookup key* into them, never concatenated directly. Filter *values* are always bound as
`?` parameters, never interpolated. On top of the whitelist: a hard LIMIT (clamped
server-side regardless of what the client asks for) and a real statement timeout (the
query runs on its own cursor in a background thread; if it doesn't finish in time we call
DuckDB's cursor.interrupt() to actually cancel the engine-side work, not just abandon the
wait).

See etl/marts/mart_explorer.sql for the source table this compiles against.
"""
from __future__ import annotations

import csv
import io
import json
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import duckdb
from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse

from ..auth import get_current_org, get_entitlements
from ..config import settings
from ..entitlements import Entitlements
from ..models import Org
from ..schemas import (
    ExploreColumnMeta,
    ExploreMetricMeta,
    ExploreQuery,
    ExploreResult,
    ExploreSchema,
)

router = APIRouter(prefix="/api/explore", tags=["explore"])

# =========================================================================================
# Whitelists — the ONLY vocabulary a client query can reference. See module docstring.
# Mirrored (names + kinds + metric list) in web/src/lib/api.ts's Explore types — if you
# rename/add/remove an entry here, update that file too (the /schema endpoint below also
# serves this at runtime so the UI never hardcodes it, but the TS *types* are separate).
# =========================================================================================


@dataclass(frozen=True)
class Dim:
    label: str
    expr: str  # the ONLY place a column name turns into raw SQL text
    kind: str  # "string" | "number" | "integer" | "boolean" | "list"
    groupable: bool = False


DIMENSIONS: dict[str, Dim] = {
    "appid": Dim("App ID", "appid", "integer"),
    "name": Dim("Name", "name", "string"),
    "primary_genre": Dim("Genre", "primary_genre", "string", groupable=True),
    "primary_tag": Dim("Top tag", "primary_tag", "string", groupable=True),
    "release_year": Dim("Release year", "release_year", "integer", groupable=True),
    "is_recent": Dim("Released last 24mo", "is_recent", "boolean", groupable=True),
    "price_initial": Dim("Price (USD)", "price_initial", "number"),
    "price_bucket": Dim("Price band", "price_bucket", "string", groupable=True),
    "is_free": Dim("Free to play", "is_free", "boolean", groupable=True),
    "is_indie": Dim("Indie", "is_indie", "boolean", groupable=True),
    "self_published": Dim("Self-published", "self_published", "boolean", groupable=True),
    "developers": Dim("Developer", "developers", "string"),
    "publishers": Dim("Publisher", "publishers", "string"),
    "owners_mid": Dim("Owners (est.)", "owners_mid", "number"),
    "dev_tier": Dim("Dev tier", "dev_tier", "string", groupable=True),
    "total_reviews": Dim("Total reviews", "total_reviews", "integer"),
    "review_bucket": Dim("Review-count band", "review_bucket", "string", groupable=True),
    "positive_ratio": Dim("Positive rating", "positive_ratio", "number"),
    "rating_tier": Dim("Rating tier", "rating_tier", "string", groupable=True),
    "est_rev_reviews": Dim("Est. revenue (Boxleiter)", "est_rev_reviews", "number"),
    "est_rev_owners": Dim("Est. revenue (owners x price)", "est_rev_owners", "number"),
    "metacritic_score": Dim("Metacritic score", "metacritic_score", "integer"),
    "achievements_count": Dim("Achievements", "achievements_count", "integer"),
    "avg_playtime_forever": Dim("Avg playtime (min)", "avg_playtime_forever", "integer"),
    "live_players": Dim("Live players (CCU)", "live_players", "integer"),
    "live_players_bucket": Dim("Live-players band", "live_players_bucket", "string", groupable=True),
    "twitch_viewers": Dim("Twitch viewers (live)", "twitch_viewers", "integer"),
    "twitch_streams": Dim("Twitch streams (live)", "twitch_streams", "integer"),
    "n_reviews_trailing_30d": Dim("Reviews, trailing 30d", "n_reviews_trailing_30d", "integer"),
    "rev_pct_in_genre": Dim("Revenue percentile in genre", "rev_pct_in_genre", "number"),
    "top_tags": Dim("Tags", "top_tags", "list"),
    "header_image": Dim("Header image URL", "header_image", "string"),
}

# name -> aggregate SQL expression. Only usable in `select` (never `filters`/`group_by`).
METRICS: dict[str, str] = {
    "n_games": "COUNT(*)",
    "median_price": "median(price_initial)",
    "median_owners": "median(owners_mid)",
    "median_reviews": "median(total_reviews)",
    "median_positive_ratio": "median(positive_ratio)",
    "median_est_rev": "median(est_rev_reviews)",
    "avg_price": "avg(price_initial)",
    "avg_positive_ratio": "avg(positive_ratio)",
    "sum_est_rev": "sum(est_rev_reviews)",
    "max_est_rev": "max(est_rev_reviews)",
    "min_price": "min(price_initial)",
    "median_live_players": "median(live_players)",
    "sum_live_players": "sum(live_players)",
    "sum_twitch_viewers": "sum(twitch_viewers)",
}

METRIC_LABELS: dict[str, str] = {
    "n_games": "# Games",
    "median_price": "Median price",
    "median_owners": "Median owners",
    "median_reviews": "Median reviews",
    "median_positive_ratio": "Median positive rating",
    "median_est_rev": "Median est. revenue",
    "avg_price": "Average price",
    "avg_positive_ratio": "Average positive rating",
    "sum_est_rev": "Total est. revenue",
    "max_est_rev": "Max est. revenue",
    "min_price": "Min price",
    "median_live_players": "Median live players",
    "sum_live_players": "Total live players",
    "sum_twitch_viewers": "Total Twitch viewers",
}

_OPS_BY_KIND: dict[str, list[str]] = {
    "string": ["eq", "neq", "like", "in", "is_null", "not_null"],
    "number": ["eq", "neq", "gt", "gte", "lt", "lte", "in", "is_null", "not_null"],
    "integer": ["eq", "neq", "gt", "gte", "lt", "lte", "in", "is_null", "not_null"],
    "boolean": ["eq", "neq", "is_null", "not_null"],
    "list": ["contains", "is_null", "not_null"],
}
_CMP_SQL = {"eq": "=", "neq": "!=", "gt": ">", "gte": ">=", "lt": "<", "lte": "<="}

_TABLE = "mart_explorer"
_MAX_LIMIT = 1000            # forced ceiling — the request's own `limit` is clamped to this
_MAX_IN_VALUES = 50           # cap on an `in` filter's value list
_TIMEOUT_SECONDS = 5.0        # statement timeout; marts are tiny, this is generous


# =========================================================================================
# Connection — a dedicated read-only DuckDB connection, separate from ..analytics_db's
# (which other routers share behind one lock covering the whole query). Explore queries are
# client-shaped and need real per-request cancellation (see _execute), so this router owns
# its own connection and hands out one cursor per request. DuckDB supports multiple
# concurrent read_only connections to the same file (verified), so this coexists fine.
# =========================================================================================
_conn: duckdb.DuckDBPyConnection | None = None
_conn_lock = threading.Lock()


def _get_connection() -> duckdb.DuckDBPyConnection:
    global _conn
    if _conn is None:
        with _conn_lock:
            if _conn is None:
                path = settings.analytics_db_path
                if not Path(path).exists():
                    raise HTTPException(
                        status_code=503,
                        detail="Analytics DB not ready; run the ETL build first.",
                    )
                _conn = duckdb.connect(path, read_only=True)
    return _conn


@dataclass(frozen=True)
class Compiled:
    sql: str
    params: list[Any]
    columns: list[str]
    grouped: bool


def _validate_dim(name: str, *, purpose: str) -> Dim:
    dim = DIMENSIONS.get(name)
    if dim is None:
        raise HTTPException(
            status_code=400,
            detail=f"Unknown column '{name}' in {purpose}. Allowed: {sorted(DIMENSIONS)}",
        )
    return dim


def compile_query(q: ExploreQuery) -> Compiled:
    """The ONLY function that turns a client ExploreQuery into SQL text. Every branch
    either raises HTTPException(400) on anything off-whitelist/malformed, or appends a
    fragment built from a Dim/METRICS *value* (never the client's raw string)."""
    group_cols: list[tuple[str, Dim]] = []
    for name in q.group_by:
        dim = _validate_dim(name, purpose="group_by")
        if not dim.groupable:
            raise HTTPException(status_code=400, detail=f"Column '{name}' is not groupable.")
        group_cols.append((name, dim))
    group_names = {name for name, _ in group_cols}
    grouped = len(group_cols) > 0

    select_exprs: list[tuple[str, str]] = []  # (output_alias, sql_expr)
    if grouped:
        for name in q.select:
            if name in group_names:
                select_exprs.append((name, dict(group_cols)[name].expr))
            elif name in METRICS:
                select_exprs.append((name, METRICS[name]))
            else:
                raise HTTPException(
                    status_code=400,
                    detail=f"'{name}' must be a group_by column or one of the metrics {sorted(METRICS)}.",
                )
    else:
        all_dims = all(name in DIMENSIONS for name in q.select)
        all_metrics = all(name in METRICS for name in q.select)
        if all_metrics and q.select:
            # Summary mode: ungrouped aggregate(s) over the filtered set -> exactly one row.
            select_exprs = [(name, METRICS[name]) for name in q.select]
        elif all_dims:
            select_exprs = [(name, DIMENSIONS[name].expr) for name in q.select]
        else:
            raise HTTPException(
                status_code=400,
                detail="select must be either all row columns, or all metrics — add group_by "
                "to mix grouping columns with metrics.",
            )

    output_names = [name for name, _ in select_exprs]
    if len(output_names) != len(set(output_names)):
        raise HTTPException(status_code=400, detail="select contains duplicate names.")

    where_sql: list[str] = []
    params: list[Any] = []
    for f in q.filters:
        dim = _validate_dim(f.col, purpose="filters")
        allowed_ops = _OPS_BY_KIND[dim.kind]
        if f.op not in allowed_ops:
            raise HTTPException(
                status_code=400,
                detail=f"op '{f.op}' is not valid for column '{f.col}' (kind={dim.kind}); allowed: {allowed_ops}",
            )
        if f.op == "is_null":
            where_sql.append(f"{dim.expr} IS NULL")
        elif f.op == "not_null":
            where_sql.append(f"{dim.expr} IS NOT NULL")
        elif f.op == "contains":
            where_sql.append(f"list_contains({dim.expr}, ?)")
            params.append(f.val)
        elif f.op == "like":
            if not isinstance(f.val, str) or not f.val:
                raise HTTPException(status_code=400, detail=f"op 'like' on '{f.col}' requires a non-empty string val.")
            where_sql.append(f"{dim.expr} ILIKE ?")
            params.append(f"%{f.val}%")
        elif f.op == "in":
            if not isinstance(f.val, list) or not (1 <= len(f.val) <= _MAX_IN_VALUES):
                raise HTTPException(
                    status_code=400,
                    detail=f"op 'in' on '{f.col}' requires a list val with 1-{_MAX_IN_VALUES} items.",
                )
            where_sql.append(f"{dim.expr} IN ({', '.join(['?'] * len(f.val))})")
            params.extend(f.val)
        else:
            if f.val is None:
                raise HTTPException(status_code=400, detail=f"op '{f.op}' on '{f.col}' requires a non-null val.")
            where_sql.append(f"{dim.expr} {_CMP_SQL[f.op]} ?")
            params.append(f.val)

    sort = q.sort or output_names[0]
    if sort not in output_names:
        raise HTTPException(
            status_code=400,
            detail=f"sort '{sort}' must be one of the selected columns: {output_names}",
        )

    limit = min(q.limit, _MAX_LIMIT)

    select_sql = ", ".join(f"{expr} AS {name}" for name, expr in select_exprs)
    sql = f"SELECT {select_sql} FROM {_TABLE}"
    if where_sql:
        sql += " WHERE " + " AND ".join(where_sql)
    if group_cols:
        sql += " GROUP BY " + ", ".join(dim.expr for _, dim in group_cols)
    sql += f" ORDER BY {sort} {q.order.upper()}"
    # Fetch one extra row so the caller can tell "there were more rows than the limit"
    # apart from "exactly at the limit" without a second COUNT(*) round trip.
    sql += f" LIMIT {limit + 1}"

    return Compiled(sql=sql, params=params, columns=output_names, grouped=grouped)


def _execute(compiled: Compiled) -> tuple[list[dict[str, Any]], float]:
    """Run compiled SQL on its own cursor with a real statement timeout: the query runs in
    a background thread; if it's still going after _TIMEOUT_SECONDS we call
    cursor.interrupt() to cancel the DuckDB engine-side work (verified: this reliably stops
    a running query, not just the Python-side wait) and return 504."""
    conn = _get_connection()
    cur = conn.cursor()
    outcome: dict[str, Any] = {}

    def _work() -> None:
        try:
            cur.execute(compiled.sql, compiled.params)
            cols = [d[0] for d in cur.description]
            outcome["rows"] = [dict(zip(cols, row)) for row in cur.fetchall()]
        except Exception as exc:  # surfaced on the request thread below
            outcome["error"] = exc

    t0 = time.perf_counter()
    thread = threading.Thread(target=_work, daemon=True)
    thread.start()
    thread.join(_TIMEOUT_SECONDS)
    if thread.is_alive():
        cur.interrupt()
        thread.join(2.0)
        raise HTTPException(
            status_code=504,
            detail=f"Query exceeded the {_TIMEOUT_SECONDS:.0f}s statement timeout and was cancelled.",
        )
    elapsed_ms = (time.perf_counter() - t0) * 1000
    if "error" in outcome:
        raise HTTPException(status_code=400, detail=f"Query failed: {outcome['error']}")
    return outcome.get("rows", []), elapsed_ms


# =========================================================================================
# Endpoints
# =========================================================================================


@router.get("/schema", response_model=ExploreSchema)
def explore_schema(org: Org = Depends(get_current_org)) -> ExploreSchema:
    """The whitelist, served at runtime so the query-builder UI never hardcodes it."""
    dims = [
        ExploreColumnMeta(name=name, label=d.label, kind=d.kind, groupable=d.groupable, ops=_OPS_BY_KIND[d.kind])
        for name, d in DIMENSIONS.items()
    ]
    metrics = [ExploreMetricMeta(name=name, label=METRIC_LABELS.get(name, name)) for name in METRICS]
    return ExploreSchema(
        dimensions=dims,
        metrics=metrics,
        max_limit=_MAX_LIMIT,
        max_filters=8,
        max_select=8,
        max_group_by=2,
        timeout_seconds=_TIMEOUT_SECONDS,
    )


@router.post("", response_model=ExploreResult)
def run_explore(q: ExploreQuery, org: Org = Depends(get_current_org)) -> ExploreResult:
    compiled = compile_query(q)
    rows, elapsed_ms = _execute(compiled)
    limit = min(q.limit, _MAX_LIMIT)
    truncated = len(rows) > limit
    if truncated:
        rows = rows[:limit]
    return ExploreResult(
        columns=compiled.columns,
        rows=rows,
        row_count=len(rows),
        truncated=truncated,
        grouped=compiled.grouped,
        elapsed_ms=elapsed_ms,
        sql_preview=compiled.sql,
    )


@router.get("/export.csv")
def export_csv(
    query: str = Query(..., description="URL-encoded ExploreQuery JSON — same shape as the POST body."),
    org: Org = Depends(get_current_org),
    ent: Entitlements = Depends(get_entitlements),
):
    if not ent.can_export:
        raise HTTPException(status_code=402, detail="Export not included in your plan.")
    try:
        payload = json.loads(query)
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=400, detail=f"query is not valid JSON: {exc}") from exc
    try:
        q = ExploreQuery.model_validate(payload)
    except Exception as exc:  # pydantic ValidationError — keep the 400 message, drop the raw exception type
        raise HTTPException(status_code=400, detail=f"Invalid query: {exc}") from exc

    compiled = compile_query(q)
    rows, _elapsed_ms = _execute(compiled)
    limit = min(q.limit, _MAX_LIMIT)
    rows = rows[:limit]

    buf = io.StringIO()
    writer = csv.DictWriter(buf, fieldnames=compiled.columns)
    writer.writeheader()
    for r in rows:
        # Lists (top_tags) aren't native CSV cells — flatten to a readable "a; b; c".
        flat = {k: ("; ".join(v) if isinstance(v, list) else v) for k, v in r.items()}
        writer.writerow(flat)
    buf.seek(0)
    return StreamingResponse(
        iter([buf.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition": 'attachment; filename="explorer_export.csv"'},
    )

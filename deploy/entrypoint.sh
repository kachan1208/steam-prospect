#!/usr/bin/env bash
# Container entrypoint: ensure the analytics DuckDB is present, then run the API.
#
# The 384MB mart is too big for git, so it isn't baked into the image. On boot we:
#   1. use it if it's already on disk (baked in or mounted), else
#   2. download it from PROSPECT_DUCKDB_URL (e.g. a GitHub Release asset), else
#   3. boot anyway in a degraded state (API up, data endpoints return 503) with a clear log.
set -euo pipefail

DATA_DIR="${PROSPECT_DATA_DIR:-/app/data}"
DB_PATH="${PROSPECT_ANALYTICS_DB_PATH:-${DATA_DIR}/current.duckdb}"
mkdir -p "$DATA_DIR"

if [ -f "$DB_PATH" ]; then
    echo "[entrypoint] Analytics DB already present at ${DB_PATH} ($(du -h "$DB_PATH" | cut -f1))."
elif [ -n "${PROSPECT_DUCKDB_URL:-}" ]; then
    echo "[entrypoint] Fetching analytics DB from PROSPECT_DUCKDB_URL ..."
    # Download to a temp file then atomically rename, so an interrupted download never
    # leaves a half-written DB that DuckDB would fail to open.
    tmp="$(mktemp "${DATA_DIR}/duckdb.XXXXXX")"
    if curl -fSL --retry 4 --retry-delay 3 --connect-timeout 20 -o "$tmp" "$PROSPECT_DUCKDB_URL"; then
        mv "$tmp" "$DB_PATH"
        echo "[entrypoint] Downloaded $(du -h "$DB_PATH" | cut -f1) -> ${DB_PATH}."
    else
        rm -f "$tmp"
        echo "[entrypoint] WARNING: download failed. Booting without analytics data (endpoints will 503)."
    fi
else
    echo "[entrypoint] WARNING: no DB at ${DB_PATH} and PROSPECT_DUCKDB_URL is unset."
    echo "[entrypoint]          The API will boot but data endpoints will return 503."
fi

# App Platform injects $PORT (default 8080). No --reload in production.
exec uvicorn --app-dir /app/api app.main:app --host 0.0.0.0 --port "${PORT:-8080}"

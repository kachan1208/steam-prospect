#!/usr/bin/env bash
# Container entrypoint: ensure the analytics DuckDB is present, then run the API.
#
# The 384MB mart is too big for git, so it isn't baked into the image. On boot we:
#   1. use it if it's already on disk (baked in or mounted), else
#   2. download it from PROSPECT_DUCKDB_URL (e.g. a GitHub Release asset) — verified
#      against PROSPECT_DUCKDB_SHA256 when that is set, else
#   3. boot anyway in a degraded state (API up, data endpoints return 503) with a clear log.
#
# PRIVILEGES: the container starts as root (this setup work needs it — creating the data
# dir, owning the download, chown'ing a root-owned host mount), then the final exec drops
# to the unprivileged `prospect` user for uvicorn itself. Never run the server as the user
# that just proved it can write anywhere.
set -euo pipefail

DATA_DIR="${PROSPECT_DATA_DIR:-/app/data}"
DB_PATH="${PROSPECT_ANALYTICS_DB_PATH:-${DATA_DIR}/current.duckdb}"

# The app's default for PROSPECT_TRUSTED_PROXY_HOPS is 0 (plain uvicorn = trust nobody),
# but this container runs behind a TLS-terminating reverse proxy (Caddy on the droplet,
# the platform router on App Platform), so it must opt back in explicitly — otherwise
# every client looks like the proxy itself to the rate limiter. Kept env-tunable.
export PROSPECT_TRUSTED_PROXY_HOPS="${PROSPECT_TRUSTED_PROXY_HOPS:-1}"

mkdir -p "$DATA_DIR"

if [ -f "$DB_PATH" ]; then
    echo "[entrypoint] Analytics DB already present at ${DB_PATH} ($(du -h "$DB_PATH" | cut -f1))."
elif [ -n "${PROSPECT_DUCKDB_URL:-}" ]; then
    echo "[entrypoint] Fetching analytics DB from PROSPECT_DUCKDB_URL ..."
    # Download to a temp file then atomically rename, so an interrupted download never
    # leaves a half-written DB that DuckDB would fail to open.
    tmp="$(mktemp "${DATA_DIR}/duckdb.XXXXXX")"
    if curl -fSL --retry 4 --retry-delay 3 --connect-timeout 20 -o "$tmp" "$PROSPECT_DUCKDB_URL"; then
        keep=1
        if [ -n "${PROSPECT_DUCKDB_SHA256:-}" ]; then
            # Integrity mode: refuse an artifact whose hash does not match — a corrupted or
            # substituted mart must never reach DuckDB. Failure degrades to "boot without
            # data", the same path a failed download takes.
            actual="$(sha256sum "$tmp" | cut -d' ' -f1)"
            expected="$(printf '%s' "$PROSPECT_DUCKDB_SHA256" | tr '[:upper:]' '[:lower:]')"
            if [ "$actual" = "$expected" ]; then
                echo "[entrypoint] sha256 verified (${actual})."
            else
                echo "[entrypoint] ERROR: sha256 MISMATCH — expected ${expected}, got ${actual}."
                echo "[entrypoint]        Refusing the artifact; booting without analytics data (endpoints will 503)."
                rm -f "$tmp"
                keep=0
            fi
        else
            echo "[entrypoint] PROSPECT_DUCKDB_SHA256 unset — skipping integrity check (download trusted as-is)."
        fi
        if [ "$keep" = 1 ]; then
            mv "$tmp" "$DB_PATH"
            # mktemp creates 0600 root-owned, and mv preserves that. The server drops to the
            # unprivileged `prospect` user below, so without this the mart it just downloaded
            # is UNREADABLE to it: permanent degraded mode, /api/health/ready 503 forever, and
            # on App Platform (.do/app.yaml health-checks that path) a boot crash-loop. The
            # mart is world-readable public data; 0644 is the correct mode for it.
            chmod 0644 "$DB_PATH"
            echo "[entrypoint] Downloaded $(du -h "$DB_PATH" | cut -f1) -> ${DB_PATH}."
        fi
    else
        rm -f "$tmp"
        echo "[entrypoint] WARNING: download failed. Booting without analytics data (endpoints will 503)."
    fi
else
    echo "[entrypoint] WARNING: no DB at ${DB_PATH} and PROSPECT_DUCKDB_URL is unset."
    echo "[entrypoint]          The API will boot but data endpoints will return 503."
fi

# The server drops to this user below, so it needs the data dir writable for the /mcp call
# log it appends to. Chowning the DIRECTORY alone is not enough: mcp_calls.jsonl already
# exists root-owned from every previous (root) container, and appending to a root-owned file
# as `prospect` raises PermissionError — which mcp_mount.py swallows, so the log would just
# stop with no message. That is the exact silent failure this block claims to prevent, so
# chown the log itself too. Kept narrow deliberately: -R would rewrite ownership of the
# multi-GB marts on a bind mount that points INSIDE the git checkout on the droplet.
chown prospect:prospect "$DATA_DIR" || echo "[entrypoint] note: could not chown $DATA_DIR (read-only fs?) — continuing"
for _f in "$DATA_DIR/mcp_calls.jsonl" "$DATA_DIR/mcp_calls.jsonl.1"; do
    [ -e "$_f" ] && chown prospect:prospect "$_f" 2>/dev/null || true
done

# App Platform injects $PORT (default 8080). No --reload in production.
#
# Run one uvicorn worker per vCPU (the droplet has 2) so the API uses both cores — a single
# worker was pinned to 1 core in load tests and saturated at ~30-45 req/s. Each forked worker
# runs the app's lifespan independently, so each opens its OWN read-only DuckDB connection +
# cursor pool (DuckDB allows many concurrent read_only openers of one file — no shared handle).
#
# --limit-concurrency sheds overload as fast 503s instead of letting requests pile up to the
# 60s timeout: under ~90+ rps the single worker queued until it stopped responding even on
# localhost and never recovered (required `docker restart`). A short --timeout-keep-alive frees
# idle client sockets quickly so they don't hold a slot. All three are env-tunable so the box
# can be retuned without a rebuild.
#
# setpriv (util-linux, present in the slim base — verified in the image build that added it;
# if it is ever missing, fall back to runuser/su -s with the same arguments) drops uid/gid
# and re-resolves supplementary groups in one exec, with no PAM session in between.
exec setpriv --reuid=prospect --regid=prospect --init-groups \
    uvicorn --app-dir /app/api app.main:app \
    --host 0.0.0.0 --port "${PORT:-8080}" \
    --workers "${WEB_CONCURRENCY:-2}" \
    --limit-concurrency "${PROSPECT_LIMIT_CONCURRENCY:-40}" \
    --timeout-keep-alive "${PROSPECT_KEEPALIVE:-5}"

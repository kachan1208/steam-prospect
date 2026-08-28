# syntax=docker/dockerfile:1
#
# Prospect — single-image build for DigitalOcean App Platform (or any container host).
# Stage 1 builds the React/Vite frontend; stage 2 is the Python API that ALSO serves that
# built frontend from its own origin (PROSPECT_STATIC_DIR), so the whole app is one service
# with no CORS. The 384MB analytics DuckDB is NOT baked in — the entrypoint fetches it at
# boot from PROSPECT_DUCKDB_URL (e.g. a GitHub Release asset). See DEPLOY.md.

# ---------- Stage 1: build the frontend ----------
FROM node:22-slim AS web
WORKDIR /web
# Install deps first so this layer caches unless the lockfile changes.
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build           # -> /web/dist

# ---------- Stage 2: python runtime ----------
FROM python:3.14-slim AS runtime

# curl + CA certs for the boot-time DuckDB download; tini for clean signal handling.
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ca-certificates tini \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Python deps first (cached unless the lock changes).
#
# Installs from api/requirements.lock — fully pinned, uv-compiled against THIS image's
# python (3.14) and linux/amd64. requirements.txt holds the loose, human-edited ranges and
# is copied too so `uv pip compile` inputs travel with the image, but it is NOT what gets
# installed: an unpinned build resolves differently on every rebuild, which is exactly how
# `mcp>=1.2` silently became 2.0.0 on a routine rebuild, dropped the module
# prospect_mcp.py imports, and took /mcp down in production with one line in the log.
#
# Regenerate after editing requirements.txt (CI fails if they drift):
#   uv pip compile api/requirements.txt -o api/requirements.lock \
#       --python-version 3.14 --python-platform x86_64-unknown-linux-gnu
COPY api/requirements.txt api/requirements.lock ./api/
RUN pip install --no-cache-dir -r api/requirements.lock

# API source + the standalone MCP server (served at /mcp), then the built frontend.
COPY api/ ./api/
COPY mcp/ ./mcp/
COPY --from=web /web/dist ./web_dist

# Entrypoint: fetch the analytics DB (if needed) then launch uvicorn.
COPY deploy/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# Hosted defaults. REPO_ROOT resolves to /app (config.py: app -> api -> /app), so these
# match where the app expects them; the analytics DB lands in the mounted /app/data.
ENV PROSPECT_STATIC_DIR=/app/web_dist \
    PROSPECT_ANALYTICS_DB_PATH=/app/data/current.duckdb \
    PROSPECT_ENABLE_MCP=true \
    PYTHONUNBUFFERED=1 \
    PORT=8080

EXPOSE 8080
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/entrypoint.sh"]

# Prospect

Steam market-intelligence tool: a DuckDB analytics mart built from a read-only Steam
catalog snapshot, a FastAPI backend over those marts, and a React frontend for
finding under-served niches, benchmarking the market, and estimating revenue.

```
prospect/
  etl/     ETL — builds DuckDB marts from the source SQLite catalog (data/*.duckdb)
  api/     FastAPI backend, reads the marts read-only, serves /api/*
  web/     React + Vite frontend
  data/    Generated marts (gitignored) — data/current.duckdb is what the API reads
```

## Prerequisites

- **go-task**: `brew install go-task/tap/go-task`
- **Node.js** 18+ and npm
- **uv** (Python package/venv manager) with **Python 3.14** available:
  ```
  curl -LsSf https://astral.sh/uv/install.sh | sh
  uv python install 3.14
  ```

## One-time setup

```bash
# ETL virtual env
cd etl
uv venv --python 3.14
uv pip install -r requirements.txt
cd ..

# API virtual env
cd api
uv venv --python 3.14
uv pip install -r requirements.txt
cd ..

# Web dependencies
cd web
npm install
cd ..
```

Each `task` command below runs from its own subdirectory's venv/node_modules, so
this setup only needs to be repeated when a `requirements.txt` or `package.json`
changes.

## Running the app

```bash
task etl    # 1. build the DuckDB marts (writes data/current.duckdb) — rerun any
            #    time the source catalog changes; safe to rerun any time otherwise
task api    # 2. start the FastAPI backend on http://127.0.0.1:8000 (separate terminal)
task web    # 3. start the Vite dev server on http://127.0.0.1:5173 (separate terminal)
```

Then open **http://127.0.0.1:5173**. `task web`'s dev server proxies `/api/*` to
the `task api` backend on `:8000`, so the browser only ever talks to one origin.

The FastAPI process creates `prospect_control.db` (the SQLite control-plane DB —
saved views, the seeded solo org) automatically on first boot; no manual step
needed. Both databases are gitignored and local to your checkout.

`task --list` shows all three tasks with descriptions.

### Pointing the frontend at a different API

- `VITE_API_PROXY_TARGET` (env var when running `npm run dev` directly, or edit
  `web/vite.config.ts`) changes which origin the dev-server proxy forwards `/api`
  to. `task web` sets this to `http://127.0.0.1:8000` to match `task api`; running
  `npm run dev` directly (no task) defaults to `http://127.0.0.1:8001`.
- `VITE_API_BASE` (in `web/.env`) bypasses the proxy entirely and points
  `src/lib/api.ts` at an absolute URL, e.g. `VITE_API_BASE=http://127.0.0.1:8000/api`.

### Building a static bundle

```bash
cd web
npm run build      # tsc -b && vite build -> web/dist
npm run preview    # serve the built bundle locally
```

## Notes

- `etl/build_marts.py` defaults `--source` to a Steam catalog SQLite path on the
  machine this project was built on; pass `--source /path/to/steam_games.db`
  (and optionally `--data-dir`) if your source catalog lives elsewhere:
  `etl/.venv/bin/python etl/build_marts.py --source /path/to/steam_games.db`.
- The API never writes to the source catalog or the marts — it opens
  `data/current.duckdb` read-only. Only `task etl` (re)builds marts.

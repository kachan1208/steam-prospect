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
task etl    # 1. build the DuckDB marts into $PROSPECT_DATA_DIR (see "Building the marts"
            #    below: PROSPECT_SOURCE_DB and PROSPECT_DATA_DIR must be set) — rerun any
            #    time the source catalog changes; safe to rerun any time otherwise
task api    # 2. start the FastAPI backend on http://127.0.0.1:8000 (separate terminal)
task web    # 3. start the Vite dev server on http://127.0.0.1:5173 (separate terminal)
```

Then open **http://127.0.0.1:5173**. `task web`'s dev server proxies `/api/*` to
the `task api` backend on `:8000`, so the browser only ever talks to one origin.

The API keeps no database of its own: it only reads `data/current.duckdb` (the
marts, read-only) and, when present, `data/signals.db` next to it (live price
snapshots written by the collectors). Both are gitignored and local to your
checkout. (Older versions created a `prospect_control.db` control-plane DB; that
code is gone, and a leftover file can be deleted.)

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

## Building the marts (ETL)

`etl/build_marts.py` reads the scraper's SQLite catalog **read-only** and writes versioned
DuckDB marts. It has **no path defaults** — a default once pointed at a stale copy of the
source and silently built a weeks-old mart in the wrong place:

```bash
export PROSPECT_SOURCE_DB=/path/to/steam-scraper/steam_games.db   # the LIVE scraper DB
export PROSPECT_DATA_DIR=/path/to/prospect-data                   # must already exist
task etl                        # = build_marts.py --source "$PROSPECT_SOURCE_DB" --data-dir "$PROSPECT_DATA_DIR"
task etl -- --light             # extra build_marts flags go after --
```

`--source` / `--data-dir` override the env vars. The data dir holds `prospect_<YYYYMMDD>.duckdb`
(the newest `--keep`, default 2), the `current.duckdb` symlink the API serves, the incremental
`sentiment_cache.duckdb` (keep it: rebuilding it is a multi-night rescore) and two lock files.
If it is not the repo's `data/`, point the API at it: `PROSPECT_ANALYTICS_DB_PATH=$PROSPECT_DATA_DIR/current.duckdb`.

Every run logs the resolved paths and when the source was last written (the newer of the DB
file and its `-wal`, since the scraper runs in WAL mode). If that is older than
`--max-source-age-hours` (default 48; 0 = never) it **warns loudly and still builds** — a
stalled scraper or a copy of the DB instead of the live file. `mart_meta` records the source
path, its mtimes and its age as of build start (`source_db`, `source_db_mtime`,
`source_db_wal_mtime`, `source_last_write_at`, `source_age_hours`). All dates are UTC,
whatever the host's time zone.

Runs lock the data dir: one mart build (full or `--light`) at a time; `--rescore-only` has its
own lock so it can refill the sentiment cache beside the nightly; `--repair-arms` takes both.
A run that finds its lock taken exits **3** without touching anything.

| exit | meaning |
|---|---|
| 0 | built, validated, `current.duckdb` swapped |
| 1 | built, but the validation gate refused the swap — the artifact is kept as `prospect_<date>.duckdb.building` (the log prints how to inspect/ship/discard it); an unhandled crash also exits 1 |
| 2 | refused before doing any work (missing/unset paths, missing aspect model, contradictory flags, a garbled `PROSPECT_*` knob) |
| 3 | busy: another run holds this data dir's lock — nothing was touched; a scheduler can treat it as "skipped" |

## Notes

- `etl/build_marts.py` has no default `--source` / `--data-dir` (see "Building the
  marts" above); `task etl` passes `$PROSPECT_SOURCE_DB` / `$PROSPECT_DATA_DIR`.
- The API never writes to the source catalog or the marts — it opens
  `data/current.duckdb` read-only. Only `task etl` (re)builds marts.
- No restart is needed after `task etl`: every 30 s at most
  (`PROSPECT_MART_RELOAD_INTERVAL_S`, `0` disables) a request checks whether
  `current.duckdb` now points at a different file and, if so, the API opens it
  and swaps it in; in-flight requests finish on the mart they started with.
  `GET /api/health` reports the served mart (`loaded_mart_version`, `built_at`,
  `data_as_of`, `age_hours`, `loaded_file`) next to what the link points at now
  (`link_target`, `target_mart_version`, `target_differs`, `reload_error`).
- If the mart is missing, empty or unreadable the API still starts: data
  endpoints answer 503 and `/api/health` says `degraded`, with the reason in
  `detail`. It picks the mart up on its own once a usable one is published.
- Price history reads `signals.db` from the same directory as the analytics DB
  unless `PROSPECT_SIGNALS_DB` says otherwise.
- API tests: `cd api && uv pip install -r requirements.lock -r requirements-dev.txt`,
  then `python -m pytest tests/` (a synthetic mart is built on the fly; no
  `data/` needed).

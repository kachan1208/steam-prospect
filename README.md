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
| 4 | refused before doing any work: less free disk in the data dir than `PROSPECT_DISK_MIN_FREE_GB`, even after sweeping dead scratch |

### Running unattended: resource knobs

`build_marts.py` carries its own guards — no wrapper script needed on Linux or macOS: the
data-dir lock, a free-disk gate, a spill cap below free disk, UTC dates, and dead-scratch
cleanup. A scheduler (cron, launchd, systemd timer) can call it directly; every knob below is
checked before any work (a garbled value exits 2) and the DuckDB ones are logged as applied.

| env var | default | what it does |
|---|---|---|
| `PROSPECT_SOURCE_DB`, `PROSPECT_DATA_DIR` | — (required) | stand-ins for `--source` / `--data-dir` |
| `PROSPECT_DISK_MIN_FREE_GB` | `30` | refuse to start (exit 4) with less free space (GiB) in the data dir; `0` = off |
| `PROSPECT_DUCKDB_MEMORY_LIMIT` | DuckDB's: 80% of RAM (warned) | DuckDB `memory_limit`, e.g. `5000MB`; spills to disk past it |
| `PROSPECT_DUCKDB_THREADS` | DuckDB's: every core | DuckDB `threads` |
| `PROSPECT_DUCKDB_TEMP_DIR` | `<scratch>.tmp` in the data dir | an existing dir to spill into instead (a per-data-dir subdir is created and swept) |
| `PROSPECT_DUCKDB_TEMP_MAX` | min(40GiB, ½ of free disk where the spill lands) | the spill budget (`max_temp_directory_size`); a runaway query fails on it instead of filling the disk |
| `PROSPECT_SCORE_WORKERS` | min(3, cores − 1) | sentiment-scoring worker processes (~0.75 GB each); `0`/`1` = inline |
| `PROSPECT_SCORE_CONTEXT` | `fork` on Linux, `spawn` elsewhere | worker start method; `fork` is refused on macOS |
| `PROSPECT_SENTIMENT_DEADLINE_SECONDS` | unset (no deadline) | stop starting new scoring buckets this many seconds after process start — set it when an outer wall-clock limit exists, a bucket (~16 min on the droplet) under it |
| `PROSPECT_SENTIMENT_BUCKETS` / `PROSPECT_RESCORE_BUCKET_REVIEWS` / `PROSPECT_REPAIR_BUCKET_REVIEWS` | `8` / `125000` / `1000000` | sentiment bucketing (memory / time per bucket); see the constants in `build_marts.py` |
| `PROSPECT_SENTIMENT_POOL_CAP` | `5000` | newest English reviews scored per game (`0` = all) |
| `PROSPECT_SENTIMENT_CACHE` | on | `off` = rescore everything every run, cache untouched |
| `PROSPECT_FULLTEXT_MAX_AGE_HOURS` / `PROSPECT_FULLTEXT_REBUILD_DELTA` | `44` / `500000` | when a full build rebuilds the teardown/aspect marts instead of copying them (never while the sentiment pool is only partly scored) |
| `PROSPECT_VALIDATE_MAX_DROP_PCT` | `40` | the validation gate's per-table shrink limit |
| `PROSPECT_ALLOW_NO_CLASSIFIER` | unset | `1` = build without the aspect model (degraded; stamped in `mart_meta`) |

Starting points, derived from the droplet's measured settings (8 GB / 4 vCPU: DuckDB 5000MB,
3 workers, 40GiB spill cap; the earlier 3.9 GB box ran 2500MB) — not benchmarks of these exact
machines, so watch the first builds' peak memory:

| knob | 18 GB / 11-core Mac (shared with desktop apps) | 8 GB Linux box | 4 GB Linux box |
|---|---|---|---|
| `PROSPECT_DUCKDB_MEMORY_LIMIT` | `8GB` | `5000MB` (a `--light` build: `3500MB`) | `2500MB`, plus a swapfile |
| `PROSPECT_DUCKDB_THREADS` | `8` (leave cores for the workers) | unset (4) | unset (2) |
| `PROSPECT_SCORE_WORKERS` | `4` | unset (3) | `1` (inline — no RAM for a worker) |
| `PROSPECT_SCORE_CONTEXT` | unset (`spawn`) | unset (`fork`) | unset (`fork`) |
| `PROSPECT_DUCKDB_TEMP_MAX` | unset | `40GiB` or unset | unset (½ of free disk) |
| `PROSPECT_DISK_MIN_FREE_GB` | unset (30) | unset (30) | ~20, if the disk is small; the 45 GB source still has to fit |
| `PROSPECT_SENTIMENT_DEADLINE_SECONDS` | unset | total budget − ~3h when run under a timeout (the droplet: 10800 under a 6h `timeout`) | same |

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

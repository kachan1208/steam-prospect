#!/usr/bin/env bash
# Prospect daily data refresh (Droplet cron 21:00 UTC). Scrapes Steam (keyless), rebuilds the
# DuckDB marts, restarts the app, appends a JSON history record, AND pushes pipeline-health metrics
# to VictoriaMetrics so the "Prospect — Data Pipeline" Grafana dashboard shows step timings,
# success/failure, data freshness, and row counts — no SSH needed to know it's healthy.
#
# Reliability rules:
#  - EVERY step is bounded by `timeout` (a hung step can never stall the whole run — the pre-timeout
#    ETL once ran 406min and failed the night).
#  - A step that fails/times out logs a WARN, pushes success=0, and the run CONTINUES; the ETL keeps
#    the previous mart on failure so the app never serves a half-built one.
#  - Discovery runs WEEKLY (Sundays) not nightly — enumerating the whole storefront + enriching
#    thousands of obscure games every night made nightlies 5h+.
#
# Version-controlled at prospect/deploy/prospect-refresh.sh; scp'd to /root/prospect-refresh.sh.
set -uo pipefail
export PATH=/root/steam-scraper/.venv/bin:/root/.local/bin:$PATH
export PROSPECT_DUCKDB_MEMORY_LIMIT=2500MB   # cap DuckDB on the 4GB box

LOG=/var/log/prospect-refresh.log
VM_IMPORT="http://localhost:8428/api/v1/import/prometheus"
START=$(date -u +%s)
RESULT="FAILED"   # flipped to OK only after a clean ETL
STEP="starting"

# Best-effort push of Prometheus-format metric lines to VictoriaMetrics (never fails the run).
push() { curl -s -m 8 -X POST "$VM_IMPORT" --data-binary "$1" >/dev/null 2>&1 || true; }

# run_step LABEL TIMEOUT_SECS "shell command" — time it, bound it with `timeout`, push per-step
# duration + success(1/0) + last-run timestamp. Never aborts the run on a step failure.
run_step() {
    local label="$1" tmo="$2" cmd="$3"
    STEP="$label"
    local t0 dur rc=0
    t0=$(date -u +%s)
    echo "[$label] start $(date -u)"
    timeout "$tmo" bash -c "$cmd" || rc=$?
    dur=$(( $(date -u +%s) - t0 ))
    local ok=1; [ "$rc" -ne 0 ] && { ok=0; echo "WARN: [$label] exited rc=$rc after ${dur}s"; }
    echo "[$label] done ${dur}s (rc=$rc)"
    push "prospect_pipeline_step_duration_seconds{step=\"$label\"} $dur
prospect_pipeline_step_success{step=\"$label\"} $ok
prospect_pipeline_step_last_run_timestamp{step=\"$label\"} $(date -u +%s)"
}

# run_step_bg — same contract as run_step, but runs the step in a BACKGROUND subshell so
# independent-service steps (news/twitch/ccu — different endpoints + different tables) can
# overlap the serial Steam-review lane. Safe because steam_games.db is WAL and every writer
# sets a busy_timeout (get_connection=30s; steam_players_bulk/twitch_bulk=120s, explicitly
# built to coexist), so concurrent writers QUEUE instead of erroring. Does NOT touch the
# global STEP (that tracks the critical Lane-A path for the failure record). PIDs collected
# in BG_PIDS; wait_bg() is the barrier (called before review_deepen — memory safety, see below).
BG_PIDS=()
run_step_bg() {
    local label="$1" tmo="$2" cmd="$3"
    (
        local t0 dur rc=0
        t0=$(date -u +%s)
        echo "[$label] start $(date -u) (parallel lane)"
        timeout "$tmo" bash -c "$cmd" || rc=$?
        dur=$(( $(date -u +%s) - t0 ))
        local ok=1; [ "$rc" -ne 0 ] && { ok=0; echo "WARN: [$label] exited rc=$rc after ${dur}s"; }
        echo "[$label] done ${dur}s (rc=$rc)"
        push "prospect_pipeline_step_duration_seconds{step=\"$label\"} $dur
prospect_pipeline_step_success{step=\"$label\"} $ok
prospect_pipeline_step_last_run_timestamp{step=\"$label\"} $(date -u +%s)"
    ) &
    BG_PIDS+=("$!")
    echo "[$label] launched in background (pid $!)"
}

# Barrier: block until every background (Lane B) step has finished. Called before the ETL,
# which needs a consistent, fully-written DB snapshot.
wait_bg() {
    local pid
    for pid in "${BG_PIDS[@]}"; do wait "$pid"; done
    BG_PIDS=()
}

record_run() {
    local dur=$(( $(date -u +%s) - START ))
    /root/steam-scraper/.venv/bin/python - "$RESULT" "$dur" "$STEP" <<'PY'
import json, sqlite3, os, sys, glob, datetime, urllib.request
result, duration, step = sys.argv[1], int(sys.argv[2]), sys.argv[3]
hist = "/root/prospect/data/refresh_history.json"
con = sqlite3.connect("/root/steam-scraper/steam_games.db")
def n(t):
    try: return con.execute("SELECT count(*) FROM " + t).fetchone()[0]
    except Exception: return None
counts = {"games": n("games"), "reviews": n("reviews"), "articles": n("articles"),
          "mentions": n("game_creator_mention"), "players": n("player_counts")}
def fresh_hours(sql):  # hours since the newest row of a source (data freshness)
    try:
        v = con.execute(sql).fetchone()[0]
        if v is None: return None
        s = str(v)
        ts = (datetime.datetime.fromisoformat(s.replace("Z", "+00:00")) if "-" in s
              else datetime.datetime.fromtimestamp(int(float(s)), datetime.timezone.utc))
        if ts.tzinfo is None: ts = ts.replace(tzinfo=datetime.timezone.utc)
        return round((datetime.datetime.now(datetime.timezone.utc) - ts).total_seconds() / 3600, 2)
    except Exception:
        return None
freshness = {
    "reviews":  fresh_hours("SELECT max(timestamp_created) FROM reviews"),
    "articles": fresh_hours("SELECT max(fetched_at) FROM articles"),
    "twitch":   fresh_hours("SELECT max(published_at) FROM game_creator_mention WHERE platform='twitch'"),
    "players":  fresh_hours("SELECT max(captured_at) FROM player_counts"),
    "games":    fresh_hours("SELECT max(updated_at) FROM games"),
}
marts = sorted(glob.glob("/root/prospect/data/prospect_*.duckdb"))
mart_version = marts[-1].split("prospect_")[-1].replace(".duckdb", "") if marts else None
prev = {}
if os.path.exists(hist):
    lines = [l for l in open(hist).read().splitlines() if l.strip()]
    if lines:
        try: prev = json.loads(lines[-1]).get("counts") or {}
        except Exception: prev = {}
deltas = {k: counts[k] - prev[k] for k in counts if isinstance(counts[k], int) and isinstance(prev.get(k), int)}
now = int(datetime.datetime.now(datetime.timezone.utc).timestamp())
rec = {"finished_at": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
       "result": result, "duration_s": duration, "step": step, "mart_version": mart_version,
       "counts": counts, "deltas": deltas, "freshness_hours": freshness}
with open(hist, "a") as f:
    f.write(json.dumps(rec) + "\n")
# Push run-level + data metrics to VictoriaMetrics for the Data Pipeline dashboard.
m = [f"prospect_pipeline_run_duration_seconds {duration}",
     f"prospect_pipeline_last_run_timestamp {now}",
     f"prospect_pipeline_run_ok {1 if result == 'OK' else 0}",
     "prospect_pipeline_running 0"]
if result == "OK":
    m.append(f"prospect_pipeline_last_success_timestamp {now}")
for k, v in counts.items():
    if isinstance(v, int): m.append(f'prospect_data_rows{{table="{k}"}} {v}')
for k, v in freshness.items():
    if v is not None: m.append(f'prospect_data_freshness_hours{{source="{k}"}} {v}')
try:
    urllib.request.urlopen(urllib.request.Request(
        "http://localhost:8428/api/v1/import/prometheus", data="\n".join(m).encode()), timeout=8)
except Exception:
    pass
print("recorded:", rec["finished_at"], result, "deltas", deltas, "freshness", freshness)
PY
}
trap record_run EXIT

exec >>"$LOG" 2>&1
echo "=================== refresh start: $(date -u) ==================="
push "prospect_pipeline_running 1
prospect_pipeline_start_timestamp $START"

cd /root/steam-scraper || exit 1

# ── Lane B (independent services) — launched in PARALLEL up front so they overlap the serial
# Steam-review lane below. Each hits a DIFFERENT external service and writes a DIFFERENT table
# (news→articles, twitch→game_creator_mention, ccu→player_counts). steam_games.db is WAL and
# every writer sets a busy_timeout (get_connection=30s; steam_players_bulk/twitch_bulk=120s,
# explicitly built to coexist), so these queue rather than error against each other and Lane A.
# MEMORY SAFETY (4GB box): Lane B worker counts are kept modest AND wait_bg (below, BEFORE
# review_deepen) ensures Lane B finishes before the heavy 16-worker review_deepen starts, so the
# two big concurrent-worker phases never STACK. On 2026-08-01 the original design (all of Lane B
# concurrent WITH review_deepen + 2 app workers) peaked past 4GB and swap-thrashed the box into an
# unreachable state. Lane B (~40min) is hidden under steam_scrape/review_refresh, so the barrier
# costs ~no wall time; it only caps peak memory.
run_step_bg "news"   2400 "./run_news.sh"
run_step_bg "twitch" 3600 "STEAM_DB=/root/steam-scraper/steam_games.db WORKERS=6 RATE_PER_WORKER=1.5 MIN_REVIEWS=50 python3 twitch_bulk.py"
run_step_bg "ccu"    3600 "STEAM_DB=/root/steam-scraper/steam_games.db WORKERS=8 RATE_PER_WORKER=3.0 MIN_REVIEWS=50 python3 steam_players_bulk.py"
# Rotating tag refresh (SteamSpy + store-page fallback — its own endpoints, so Lane B):
# community tags evolve after release, and a one-time fetch drifts ~2%/month from the
# storefront. 4000/night ≈ the whole 50+-review head every ~10 nights.
run_step_bg "tags_refresh" 3600 "python3 -m steam_scraper.scraper --db steam_games.db refresh-stale-tags --workers 12 --rate 3.0 --limit 4000"

# ── Lane A (Steam review endpoint + shared proxy pool) — SEQUENTIAL by necessity: these all hit
# store.steampowered.com/appreviews through the ONE shared proxy pool, so parallelising them
# would multiply proxy/rate contention, not throughput. This lane is the critical path.

# [1] Discovery — WEEKLY (Sundays). backfill-missing walks Steam's whole storefront; SteamSpy's
# 'all' pagination dead-ends ~page 87 so this is the real new-game path, but it's heavy and the
# games it finds are mostly sub-threshold — nightly re-discovery just made nightlies 5h+.
if [ "$(date -u +%u)" = "7" ]; then
    run_step "discovery" 7200 "python3 -m steam_scraper.scraper --db steam_games.db backfill-missing --workers 16 --rate 8.0"
else
    echo "[discovery] skipped (weekly — Sundays only)"
    push "prospect_pipeline_step_success{step=\"discovery\"} 1
prospect_pipeline_step_duration_seconds{step=\"discovery\"} 0"
fi

run_step "steam_scrape"     3600 "./run_full.sh"
run_step "review_refresh"   2700 "python3 -m steam_scraper.scraper --db steam_games.db review-summary --workers 16 --rate 12.0 --refresh-older-than-days 7 --limit 25000"
run_step "review_histogram" 1800 "python3 -m steam_scraper.scraper --db steam_games.db review-histogram --min-reviews 50 --workers 16 --rate 10.0"

# ── Barrier: Lane B must finish BEFORE review_deepen so the two heavy concurrent-worker phases
# never overlap (memory safety — see the Lane B note above). Lane B is already done by here.
echo "[lane-b] waiting for background service steps to finish before review_deepen ..."
wait_bg
echo "[lane-b] background service steps complete."

# [7b] Review DEEPEN — top up review TEXT toward 20k for under-target games Steam still has more of,
# MOST-RECENTLY-REVIEWED first (review_histogram velocity — still-updated/selling titles, not dead
# back-catalogue megahits). Tracked by reviews_deepened_at + 30d staleness so it advances a big slice
# each night instead of re-fetching the same games; commits per game so the 4h timeout keeps every
# finished title. The shallow ~2k stream pass (review_refresh) still seeds brand-new games separately.
run_step "review_deepen"   14400 "python3 -m steam_scraper.scraper --db steam_games.db deepen-reviews --target 20000 --min-reviews 50 --activity-months 12 --refresh-days 30 --limit 4000 --workers 16 --rate 8.0"

# [7c] Tag SYNC — rebuild game_tags (the ETL's niche-membership table) from the
# games.steamspy_tags JSON the enrichment loops maintain. It was a one-off
# materialisation that silently froze on ~2026-07-07: every game discovered after that
# was invisible to every niche (~25% of some tags' members). Runs right before the ETL
# so membership includes everything tonight's scrape + tags_refresh just wrote. ~2s.
run_step "tag_sync" 600 "python3 -m steam_scraper.scraper --db steam_games.db sync-game-tags"

# [8] ETL — timeout-bounded (was UNbounded; a hung ETL once ran 406min). On success: atomic swap +
# app restart + prune. On failure/timeout: keep the previous mart so the app never serves a partial.
STEP="etl"; ETL_T0=$(date -u +%s)
echo "[etl] start $(date -u)"
cd /root/prospect/etl || exit 1
ETL_RC=0
timeout 14400 /root/prospect/etl/.venv/bin/python build_marts.py --source /root/steam-scraper/steam_games.db --data-dir /root/prospect/data || ETL_RC=$?
ETL_DUR=$(( $(date -u +%s) - ETL_T0 ))
if [ "$ETL_RC" -eq 0 ]; then
    docker restart prospect
    ls -t /root/prospect/data/prospect_*.duckdb 2>/dev/null | tail -n +4 | xargs -r rm -f
    rm -rf /root/prospect/data/*.duckdb.tmp /root/prospect/data/*.duckdb.wal 2>/dev/null || true
    RESULT="OK"; STEP="done"
    echo "[etl] OK ${ETL_DUR}s — app restarted"
else
    echo "[etl] FAILED rc=$ETL_RC after ${ETL_DUR}s — kept previous mart, app not restarted"
fi
push "prospect_pipeline_step_duration_seconds{step=\"etl\"} $ETL_DUR
prospect_pipeline_step_success{step=\"etl\"} $([ "$ETL_RC" -eq 0 ] && echo 1 || echo 0)
prospect_pipeline_step_last_run_timestamp{step=\"etl\"} $(date -u +%s)"
echo "=================== refresh done: $(date -u) · $RESULT ==================="

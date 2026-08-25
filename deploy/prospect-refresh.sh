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
# Droplet-local secrets (STEAM_API_KEY, ...) — file lives only on the box, chmod 600,
# never in git. Steps that can use a key pick it up from the environment; every keyless
# path keeps working if the file is absent.
[ -f /root/.prospect-env ] && . /root/.prospect-env
# Unbuffered stdout for EVERY python step. Not cosmetic: a step killed by `timeout` never gets to
# flush, so a buffered step that dies takes its whole output with it. The 2026-08-21 ETL ran four
# hours, hit rc=124, and left ZERO lines to diagnose from — it prints per-mart timings the entire
# way and every one of them died in the buffer.
export PYTHONUNBUFFERED=1

LOG=/var/log/prospect-refresh.log
# One log file per step. The main log is a timeline (start/done/rc); the detail lives here.
# Two reasons this is not just tidiness:
#  - The parallel lane (news/twitch/ccu/tags_refresh/dev_socials) writes concurrently, so on a
#    shared stdout their lines interleave mid-traceback and the failure reason is unreadable.
#  - `[twitch]` failed 22 of 26 nightlies on "database is locked" and nobody could see why: the
#    run logged `WARN: exited rc=1` and the traceback explaining it was shredded among four other
#    steps' output. A failing step now tails its own log into the main one (see run_step).
STEP_LOG_DIR=/var/log/prospect-steps
mkdir -p "$STEP_LOG_DIR"
find "$STEP_LOG_DIR" -type f -mtime +14 -delete 2>/dev/null || true
RUN_TS=$(date -u +%Y%m%d-%H%M%S)

# Every step appends "label rc dur" here; step_summary() prints the scoreboard at the end of the
# run. A FILE, not a bash array, because the parallel lane runs each step in a subshell and a
# subshell cannot write to the parent's array.
#
# This is the piece that would have caught the twitch breakage. A run that ends "OK" while one of
# its steps has failed every night for a month is not OK, but nothing said so: the WARN scrolled
# past among thousands of lines and the final line only reported the ETL's fate.
STEP_RESULTS="$STEP_LOG_DIR/.results.$RUN_TS"
: > "$STEP_RESULTS"

step_summary() {
    [ -s "$STEP_RESULTS" ] || return 0
    echo "------------------- step summary -------------------"
    local nfail
    nfail=$(awk '$2 != 0' "$STEP_RESULTS" | wc -l | tr -d ' ')
    # Failures first and loudly — the whole point is that a bad step cannot scroll past unnoticed.
    awk '$2 != 0 {printf "  FAIL  %-16s rc=%-4s %ss\n", $1, $2, $3}' "$STEP_RESULTS"
    awk '$2 == 0 {printf "  ok    %-16s        %ss\n", $1, $3}' "$STEP_RESULTS"
    echo "  ${nfail} step(s) failed · logs in $STEP_LOG_DIR/*.${RUN_TS}.log"
    echo "----------------------------------------------------"
}
VM_IMPORT="http://localhost:8428/api/v1/import/prometheus"
START=$(date -u +%s)
RESULT="FAILED"   # flipped to OK only after a clean ETL
STEP="starting"

# Best-effort push of Prometheus-format metric lines to VictoriaMetrics (never fails the run).
push() { curl -s -m 8 -X POST "$VM_IMPORT" --data-binary "$1" >/dev/null 2>&1 || true; }

# run_step LABEL TIMEOUT_SECS "shell command" — time it, bound it with `timeout`, push per-step
# duration + success(1/0) + last-run timestamp. Never aborts the run on a step failure.
# explain_failure LABEL RC LOGFILE — put the reason INTO the main log, next to the WARN that
# announced it. Without this a failure is a bare rc and you have to go find the step log by hand,
# which is exactly why the chronic twitch breakage went unnoticed for weeks. rc=124 is `timeout`'s
# own exit code, so name it rather than making the reader look it up.
explain_failure() {
    local label="$1" rc="$2" log="$3"
    [ "$rc" -eq 124 ] && echo "       [$label] rc=124 means it hit its timeout, not an internal error"
    echo "       ---- [$label] last 25 lines of $log ----"
    tail -25 "$log" 2>/dev/null | sed 's/^/       | /'
    echo "       ---- end [$label] ----"
}

run_step() {
    local label="$1" tmo="$2" cmd="$3"
    STEP="$label"
    local t0 dur rc=0
    local slog="$STEP_LOG_DIR/${label}.${RUN_TS}.log"
    t0=$(date -u +%s)
    echo "[$label] start $(date -u) -> $slog"
    timeout "$tmo" bash -c "$cmd" > "$slog" 2>&1 || rc=$?
    dur=$(( $(date -u +%s) - t0 ))
    local ok=1
    [ "$rc" -ne 0 ] && { ok=0; echo "WARN: [$label] exited rc=$rc after ${dur}s"; explain_failure "$label" "$rc" "$slog"; }
    echo "[$label] done ${dur}s (rc=$rc)"
    echo "$label $rc $dur" >> "$STEP_RESULTS"
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
    local slog="$STEP_LOG_DIR/${label}.${RUN_TS}.log"
    (
        local t0 dur rc=0
        t0=$(date -u +%s)
        echo "[$label] start $(date -u) (parallel lane) -> $slog"
        # Redirect is what makes the parallel lane legible: five steps sharing one stdout
        # interleave line-by-line, so a traceback arrives shredded among four other steps.
        timeout "$tmo" bash -c "$cmd" > "$slog" 2>&1 || rc=$?
        dur=$(( $(date -u +%s) - t0 ))
        local ok=1
        [ "$rc" -ne 0 ] && { ok=0; echo "WARN: [$label] exited rc=$rc after ${dur}s"; explain_failure "$label" "$rc" "$slog"; }
        echo "[$label] done ${dur}s (rc=$rc)"
        # >> is atomic for short lines on Linux, so concurrent lane steps cannot interleave here.
        echo "$label $rc $dur" >> "$STEP_RESULTS"
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
          "players": n("player_counts")}
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
run_step_bg "news"   3000 "./run_news.sh"
# twitch REMOVED from this lane (2026-08-22). It failed 22 of 26 nightlies here with "database is
# locked" — not for lack of safeguards (twitch_bulk sets busy_timeout=120000 and commits every 15
# games), but because SQLite gives no fairness guarantee: against four concurrent lane-B writers
# plus Lane A, one writer can lose the race indefinitely. No timeout tuning fixes that; only
# scheduling does. It now runs from its own cron at 05:00 UTC (see deploy/crontab notes), a slot
# where it is the ONLY writer: lane B is long done, the ETL doesn't write SQLite, and the 06:00
# review keeper hasn't started. It grabs the same refresh flock non-blocking, so a nightly that
# overruns simply costs twitch one day instead of corrupting anything, and its 3000s timeout ends
# it by 05:50, before the keeper's own flock -n at 06:00 would be starved.
# The mart consumes its data one nightly later — a day of lag against the WEEKS of staleness the
# lock-race caused.
run_step_bg "ccu"    3600 "STEAM_DB=/root/steam-scraper/steam_games.db WORKERS=8 RATE_PER_WORKER=3.0 MIN_REVIEWS=50 python3 steam_players_bulk.py"
# Signals collectors (2026-08-24, docs/steam-data-sources.md). Both write signals.db — their
# OWN single-writer SQLite, so unlike everything above they cannot join the steam_games.db
# lock war; lane B is safe for them by construction. followers = the pre-release demand
# series (community-group member counts, can never be backfilled); prices = keyed catalog
# diff (price_change_number) -> batched GetItems snapshots, the raw material for sale
# markers and price history.
run_step_bg "followers" 7200 "/root/steam-scraper/.venv/bin/python -u /root/collectors/followers_bulk.py"
run_step_bg "prices"    5400 "/root/steam-scraper/.venv/bin/python -u /root/collectors/catalog_prices.py"
# tags_refresh MOVED OUT of this lane (2026-08-24) to the 19:15 quiet-window cron, following
# the twitch precedent: it lost the SQLite write race two nights running ("database is
# locked"), and the same night refresh_released and review_refresh lost it too — three
# casualties in one run. Every writer removed from this window also improves the odds for
# the ones that remain. See the crontab entry; log in /var/log/prospect-steps/quiet1915.cron.log.
# Dev socials — official X/Discord/YouTube/Bluesky links harvested from store pages +
# dev websites (X itself is unscrapeable; the devs publish their handles HERE). Feeds
# mart_game.dev_x_handle / mart_entity.x_handle. 90d rotation, 3000/night steady state.
run_step_bg "dev_socials" 5400 "python3 -m steam_scraper.scraper --db steam_games.db dev-socials --workers 8 --rate 2.0 --limit 3000"

# [1] Discovery — WEEKLY (Sundays), moved to LANE B (2026-08-18): backfill-missing walks the
# STOREFRONT SEARCH + SteamSpy appdetails — neither is the appreviews endpoint, so it no longer
# needs to block Lane A's start (it used to cost Sunday nights up to 2h of serial wall clock).
# wait_bg below still guarantees it finishes before review_deepen/ETL. Its payloads are small
# JSON, so it doesn't stack meaningfully against the 4GB ceiling the barrier protects.
if [ "$(date -u +%u)" = "7" ]; then
    run_step_bg "discovery" 7200 "python3 -m steam_scraper.scraper --db steam_games.db backfill-missing --workers 16 --rate 8.0"
else
    echo "[discovery] skipped (weekly — Sundays only)"
    push "prospect_pipeline_step_success{step=\"discovery\"} 1
prospect_pipeline_step_duration_seconds{step=\"discovery\"} 0"
fi

# ── Lane A (Steam review endpoint + shared proxy pool) — SEQUENTIAL by necessity: these all hit
# store.steampowered.com/appreviews through the ONE shared proxy pool, so parallelising them
# would multiply proxy/rate contention, not throughput. This lane is the critical path.

run_step "steam_scrape"     3600 "./run_full.sh"
# Games that RELEASED after we first saw them. `enrich --refresh-unreleased` was written for
# exactly this ("placeholder date + NULL price frozen forever otherwise") and then never wired
# into any schedule — the same built-but-never-invoked gap as game_genres above. Without it a
# title discovered pre-launch keeps its "Coming soon" placeholder, NULL price and NULL release
# year indefinitely, because run_full.sh's rotation takes many nights to come back around and
# nothing prioritises the one cohort whose data flips on a known date. 23,214 games were sitting
# in that state. Oldest-updated first, so the backlog drains in date order.
# refresh_released MOVED OUT (2026-08-24) to the 19:15 quiet-window cron with tags_refresh —
# it hit "database is locked" two nights running while Lane B wrote alongside it. Its data
# (unreleased-cohort metadata) is a rotation, not a dependency of the steps below; fetching
# it at 19:15 instead of ~22:30 costs nothing.
run_step "review_refresh"   3600 "python3 -m steam_scraper.scraper --db steam_games.db review-summary --workers 16 --rate 12.0 --refresh-older-than-days 7 --limit 25000"
run_step "review_histogram" 1800 "python3 -m steam_scraper.scraper --db steam_games.db review-histogram --min-reviews 50 --workers 16 --rate 10.0"

# ── Barrier: Lane B must finish BEFORE review_deepen so the two heavy concurrent-worker phases
# never overlap (memory safety — see the Lane B note above). Lane B is already done by here.
echo "[lane-b] waiting for background service steps to finish before review_deepen ..."
wait_bg
echo "[lane-b] background service steps complete."

# [7b] Review DEEPEN — nightly TOP-UP only (2026-08-18): the 06:00 UTC daytime coverage keeper
# (see crontab) owns the backlog with a 13h window and 15k/day budget, so the nightly pass just
# catches the cheapest gaps (smallest-total-first ordering = small games in the first thousands).
# Shrunk from limit 4000 / 4h to 1200 / 1.5h — the ETL and the morning mart now land ~3h earlier.
# Still behind the Lane B barrier: the memory ceiling reasoning is unchanged.
# --min-reviews 1 (2026-08-18): the old floor of 50 structurally excluded 75.9K small games —
# 31.3K of them had missing/zero texts and NOTHING would ever fetch them (one shallow fetch at
# discovery, then reviews accumulated forever un-refetched). Their whole gap is ~415K texts
# (~1 request/game), so with cost-ordered selection they clear in days and cost almost nothing.
run_step "review_deepen"   5400 "python3 -m steam_scraper.scraper --db steam_games.db deepen-reviews --target 20000 --min-reviews 1 --activity-months 12 --refresh-days 30 --limit 1200 --workers 16 --rate 8.0"

# [7c] Tag SYNC — rebuild game_tags (the ETL's niche-membership table) from the
# games.steamspy_tags JSON the enrichment loops maintain. It was a one-off
# materialisation that silently froze on ~2026-07-07: every game discovered after that
# was invisible to every niche (~25% of some tags' members). Runs right before the ETL
# so membership includes everything tonight's scrape + tags_refresh just wrote. ~2s.
run_step "tag_sync" 600 "python3 -m steam_scraper.scraper --db steam_games.db sync-game-tags"

# game_genres had the SAME disease as game_tags above, and nobody had looked: nothing in the
# scraper ever wrote it. Frozen since its one-off materialisation, so coverage decayed with game
# age — 98.4% of games under appid 1.0M had rows against 56.4% over 4.0M. A game without a
# primary_genre falls back to the catalog-wide Boxleiter multiplier instead of its genre's (worse
# revenue estimate) and vanishes from every genre percentile and genre niche: 19.3% of the
# published mart. Same placement and same reasoning as tag_sync — right before the ETL, full
# rebuild, no incremental state to get wrong.
run_step "genre_sync" 600 "python3 -m steam_scraper.scraper --db steam_games.db sync-game-genres"

# [8] ETL — timeout-bounded (was UNbounded; a hung ETL once ran 406min). On success: atomic swap +
# app restart + prune. On failure/timeout: keep the previous mart so the app never serves a partial.
STEP="etl"; ETL_T0=$(date -u +%s)
echo "[etl] start $(date -u)"
# Stray-job sweep (2026-08-19): the ETL peaks past 2GB and shares a 3.9GB box — any scraper
# job still running here (an overrunning daytime keeper, a manually chained catch-up run)
# starves it into an OOM kill (rc=137, exactly what happened on 2026-08-18: an overnight
# socials+demos chain ate the headroom). Every scraper job is resumable by design (staleness
# markers + daily crons re-select where they left off), so killing strays is always safe;
# losing tonight's mart is not. The refresh's OWN scraper steps are long done by this point.
pkill -f 'steam_scraper.scraper' 2>/dev/null && echo "[etl] swept stray scraper jobs" || true
sleep 5
# Stale-scratch sweep (2026-08-19). build_marts spills to <version>.duckdb.building.tmp/ and on
# this corpus that reached 18GB. A run that dies (last night's OOM) leaves the whole spill behind
# forever: the success-path cleanup below never matched it — its glob is *.duckdb.tmp, while the
# real names end in .duckdb.building.tmp — and the failure path cleaned nothing at all. One dead
# run had the disk at 90% (8GB free) while the next run was still spilling into it. Sweep BEFORE
# starting, and only artifacts not belonging to today's build, so headroom is guaranteed no matter
# how the previous attempt ended.
find /root/prospect/data -maxdepth 1 -name 'prospect_*.duckdb.building*' \
     ! -name "prospect_$(date -u +%Y%m%d).duckdb.building*" -exec rm -rf {} + 2>/dev/null || true
df -h /root/prospect/data | tail -1 | awk '{print "[etl] disk before build: " $4 " free (" $5 " used)"}'
cd /root/prospect/etl || exit 1
ETL_RC=0
# The ETL is the one step that does NOT go through run_step (it has a bespoke success path below:
# restart, prune, metrics). It still needs the same logging contract, so it gets one by hand.
#
# `python -u`: build_marts prints `[etl] ran <mart>.sql (Ns)` for every mart as it goes. On
# 2026-08-21 it was killed at the 4h timeout and not one of those lines survived the buffer,
# leaving a four-hour failure with nothing to diagnose. Unbuffered, a timeout now leaves behind
# the exact mart it died in.
#
# Timeout raised 4h -> 6h, because 4h was never above the distribution it was meant to bound.
# Historical ETL durations from this log (`grep '^\[etl\] \(OK\|FAILED\)'`):
#
#   2225 2402 2361 2413 ... 11245 12128 12469 12477 12652 12729 13267 13350 15151 16467 17403
#
# Three successful runs took 15151s, 16467s and 17403s — every one of them longer than the 14400s
# ceiling. They only survived because the timeout was added after they ran. So the 2026-08-21
# rc=124 was not a new regression; it was a mine laid earlier, and the marts added that day cost
# ~49s in total (mart_niche 35.3s + mart_game_event 9.7s + mart_niche_game 4.2s, measured).
#
# 6h sits 24% above the observed 17403s maximum, which leaves room for a corpus that keeps
# growing. It also still fits the schedule: the ETL starts ~23:08, so 6h ends ~05:08, before the
# 06:00 review keeper that shares this flock. The failure mode of a ceiling set too low is losing
# the ENTIRE night's mart, which is far worse than a run that goes long.
ETL_LOG="$STEP_LOG_DIR/etl.${RUN_TS}.log"
echo "[etl] log: $ETL_LOG"
timeout 21600 /root/prospect/etl/.venv/bin/python -u build_marts.py --source /root/steam-scraper/steam_games.db --data-dir /root/prospect/data > "$ETL_LOG" 2>&1 || ETL_RC=$?
[ "$ETL_RC" -ne 0 ] && explain_failure "etl" "$ETL_RC" "$ETL_LOG"
# Per-mart timings, slowest first — the run's own profile, kept even on success so a slow build is
# visible BEFORE it becomes a failed one.
grep -E '^\[etl\] ran ' "$ETL_LOG" 2>/dev/null | sort -t'(' -k2 -rn | head -8 | sed 's/^/[etl] slowest: /'
ETL_DUR=$(( $(date -u +%s) - ETL_T0 ))
if [ "$ETL_RC" -eq 0 ]; then
    docker restart prospect
    # Keep TWO marts, not three (2026-08-25). The full-review-text columns grew each mart to
    # ~2.4GB; three of them is 7.3GB on a disk whose free space IS the ETL's spill ceiling —
    # the 2026-08-24 nightly OOMed at a 20.2GiB cap that used to be 25+. Two marts = current
    # + one rollback, which is all the rollback that has ever been used.
    ls -t /root/prospect/data/prospect_*.duckdb 2>/dev/null | tail -n +3 | xargs -r rm -f
    # Corrected globs: the scratch artifacts are named <version>.duckdb.building{,.wal,.tmp/},
    # so the old *.duckdb.tmp / *.duckdb.wal patterns matched NOTHING and every run's spill
    # (up to 18GB) leaked. The pre-build sweep above is the belt; this is the braces.
    rm -rf /root/prospect/data/prospect_*.duckdb.building.tmp \
           /root/prospect/data/prospect_*.duckdb.building.wal \
           /root/prospect/data/prospect_*.duckdb.building 2>/dev/null || true
    # Corpus metrics (Grafana "Prospect — Corpus" dashboard): sizes/coverage of what the
    # fresh mart serves — pushed only on success so the series never describes a stale mart.
    run_step "metrics_export" 900 "/root/prospect/etl/.venv/bin/python /root/prospect/deploy/observability/export_metrics.py"
    RESULT="OK"; STEP="done"
    echo "[etl] OK ${ETL_DUR}s — app restarted"
else
    echo "[etl] FAILED rc=$ETL_RC after ${ETL_DUR}s — kept previous mart, app not restarted"
    # Reclaim the spill. A dead build leaves its DuckDB scratch directory behind, and on this
    # corpus that is enormous: the 2026-08-21 timeout left 24GB and held the disk at 91% until it
    # was cleared by hand. The pre-build sweep would have caught it, but only at the NEXT nightly
    # ~18 hours later, so every job in between ran against a nearly-full disk.
    #
    # The .tmp spill directory is the space; the .building file is the forensics. Delete the
    # former, keep the latter — it is a few tens of MB and is the only artifact left to inspect.
    #
    # Scoped to THIS build's version, read back from the log, rather than a bare
    # prospect_*.duckdb.building.tmp glob: a manual build runs outside the flock, and the glob
    # would delete the spill out from under one that is still running. Note the version cannot be
    # derived from `date -u` here — the run starts at 21:00 and can fail after midnight, which is
    # exactly what happened on 2026-08-21 (version 20260821, failure timestamped the 22nd).
    ETL_VERSION=$(grep -m1 -oE 'prospect_[0-9]{8}\.duckdb' "$ETL_LOG" 2>/dev/null | head -1)
    if [ -n "$ETL_VERSION" ]; then
        rm -rf "/root/prospect/data/${ETL_VERSION}.building.tmp" 2>/dev/null || true
    else
        echo "[etl] could not read build version from $ETL_LOG — leaving scratch for the pre-build sweep"
    fi
    df -h /root/prospect/data | tail -1 | awk '{print "[etl] disk after cleanup: " $4 " free (" $5 " used)"}'
fi
push "prospect_pipeline_step_duration_seconds{step=\"etl\"} $ETL_DUR
prospect_pipeline_step_success{step=\"etl\"} $([ "$ETL_RC" -eq 0 ] && echo 1 || echo 0)
prospect_pipeline_step_last_run_timestamp{step=\"etl\"} $(date -u +%s)"
echo "etl $ETL_RC $ETL_DUR" >> "$STEP_RESULTS"
step_summary
rm -f "$STEP_RESULTS"
echo "=================== refresh done: $(date -u) · $RESULT ==================="

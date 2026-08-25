"""Daily price snapshots via the keyed catalog diff — SteamDB's price history, rebuilt forward.

Two phases, both against Valve's own APIs (docs/steam-data-sources.md):

  A. IStoreService/GetAppList (keyed) pages the ENTIRE Steam catalog and — the find that
     makes this cheap — returns `price_change_number` and `last_modified` per app. A daily
     diff of price_change_number against yesterday's dump IS price-change detection: no PICS
     daemon, no per-game polling.
  B. IStoreBrowseService/GetItems (keyless, batched — 30 ids/call verified) fetches current
     price/discount for exactly the apps whose counter moved (first run: the whole catalog we
     track), into price_snapshots.

Writes signals.db — its own single-writer SQLite, never steam_games.db (see followers_bulk).

Env: STEAM_API_KEY (required), STEAM_DB (filters to our catalog), SIGNALS_DB, BATCH,
RATE_PER_SEC, COUNTRY.
"""
from __future__ import annotations

import datetime as dt
import json
import os
import sqlite3
import time

import requests

API_KEY = os.environ["STEAM_API_KEY"]
STEAM_DB = os.environ.get("STEAM_DB", "/root/steam-scraper/steam_games.db")
SIGNALS_DB = os.environ.get("SIGNALS_DB", "/root/prospect/data/signals.db")
BATCH = int(os.environ.get("BATCH", "30"))
RATE_PER_SEC = float(os.environ.get("RATE_PER_SEC", "1.5"))
COUNTRY = os.environ.get("COUNTRY", "US")

S = requests.Session()
S.headers["User-Agent"] = "Prospect/1.0 (market research; kachan1208@gmail.com)"


def fetch_catalog() -> dict[int, tuple[int, int]]:
    """appid -> (last_modified, price_change_number) for the whole Steam catalog."""
    out: dict[int, tuple[int, int]] = {}
    last_appid = 0
    while True:
        r = S.get(
            "https://api.steampowered.com/IStoreService/GetAppList/v1/",
            params={
                "key": API_KEY, "max_results": 50000, "last_appid": last_appid,
                "include_games": "true", "include_dlc": "false",
                "include_software": "false",
            },
            timeout=60,
        )
        r.raise_for_status()
        resp = r.json().get("response", {})
        apps = resp.get("apps", [])
        for a in apps:
            out[a["appid"]] = (a.get("last_modified", 0), a.get("price_change_number", 0))
        if not resp.get("have_more_results"):
            break
        last_appid = resp["last_appid"]
        time.sleep(1.0)
    return out


def fetch_prices(appids: list[int]) -> list[dict]:
    req = {
        "ids": [{"appid": a} for a in appids],
        "context": {"language": "english", "country_code": COUNTRY},
        "data_request": {"include_all_purchase_options": True},
    }
    r = S.get(
        "https://api.steampowered.com/IStoreBrowseService/GetItems/v1/",
        params={"input_json": json.dumps(req)},
        timeout=60,
    )
    r.raise_for_status()
    return r.json().get("response", {}).get("store_items", [])


def main() -> int:
    sig = sqlite3.connect(SIGNALS_DB, timeout=120)
    sig.execute("PRAGMA journal_mode=WAL")
    sig.execute("PRAGMA busy_timeout=120000")
    sig.execute(
        "CREATE TABLE IF NOT EXISTS catalog_state("
        "appid INTEGER PRIMARY KEY, last_modified INTEGER, price_change_number INTEGER,"
        " fetched_at TEXT)"
    )
    sig.execute(
        "CREATE TABLE IF NOT EXISTS price_snapshots("
        "appid INTEGER, captured_on TEXT, final_cents INTEGER, original_cents INTEGER,"
        " discount_pct INTEGER, is_free INTEGER, country TEXT,"
        " PRIMARY KEY(appid, captured_on, country))"
    )

    src = sqlite3.connect(f"file:{STEAM_DB}?mode=ro", uri=True, timeout=60)
    ours = {r[0] for r in src.execute("SELECT appid FROM games")}
    src.close()

    prev = {r[0]: (r[1], r[2]) for r in sig.execute(
        "SELECT appid, last_modified, price_change_number FROM catalog_state")}

    print(f"[prices] fetching catalog (prev state: {len(prev):,} apps) ...", flush=True)
    cat = fetch_catalog()
    print(f"[prices] catalog: {len(cat):,} apps from Steam, {len(ours):,} in our DB", flush=True)

    if prev:
        changed = [a for a, (_lm, pcn) in cat.items()
                   if a in ours and prev.get(a, (None, None))[1] != pcn]
    else:
        changed = [a for a in cat if a in ours]  # first run: baseline snapshot of everything
    today = dt.date.today().isoformat()
    done_today = {r[0] for r in sig.execute(
        "SELECT appid FROM price_snapshots WHERE captured_on = ? AND country = ?",
        (today, COUNTRY))}
    todo = [a for a in changed if a not in done_today]
    print(f"[prices] changed={len(changed):,} todo={len(todo):,} (batch={BATCH})", flush=True)

    n_rows = 0
    t0 = time.time()
    last_log = t0
    for i in range(0, len(todo), BATCH):
        chunk = todo[i:i + BATCH]
        try:
            items = fetch_prices(chunk)
        except Exception as e:  # one bad batch must not kill the sweep
            print(f"[prices] batch @{i} failed: {str(e)[:80]}", flush=True)
            time.sleep(5)
            continue
        rows = []
        for it in items:
            if it.get("success") != 1:
                continue
            b = it.get("best_purchase_option") or {}
            final = b.get("final_price_in_cents")
            rows.append((
                it["appid"], today,
                int(final) if final is not None else None,
                int(b["original_price_in_cents"]) if b.get("original_price_in_cents") else None,
                int(b.get("discount_pct") or 0),
                1 if it.get("is_free") else 0,
                COUNTRY,
            ))
        sig.executemany(
            "INSERT OR REPLACE INTO price_snapshots VALUES (?,?,?,?,?,?,?)", rows)
        sig.commit()
        n_rows += len(rows)
        if time.time() - last_log >= 30:
            rate = (i + len(chunk)) / max(time.time() - t0, 1)
            print(f"[prices] {i + len(chunk):,}/{len(todo):,} rows={n_rows:,} "
                  f"({rate:.0f} apps/s)", flush=True)
            last_log = time.time()
        time.sleep(max(0.0, len(chunk) / BATCH / RATE_PER_SEC))

    # The catalog state is written LAST, only after the snapshot sweep finished — a crashed
    # run therefore re-detects the same changes tomorrow instead of losing them.
    sig.executemany(
        "INSERT OR REPLACE INTO catalog_state VALUES (?,?,?,?)",
        [(a, lm, pcn, today) for a, (lm, pcn) in cat.items()])
    sig.commit()
    print(f"[prices] DONE rows={n_rows:,} catalog_state={len(cat):,} "
          f"in {time.time()-t0:.0f}s", flush=True)
    sig.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

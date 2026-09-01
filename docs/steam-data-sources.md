# Where SteamDB's data actually comes from — and what Prospect can take

Investigated 2026-08-24, live probes included. The key realization: **SteamDB has no data of
its own.** Their FAQ states it plainly — everything is Steam's, obtained via three mechanisms —
and they open-source their watching infrastructure (`SteamDatabase/SteamTracking` tracks every
endpoint; they co-maintain SteamKit2, the client-protocol library). So the investigation target
is not steamdb.info (Cloudflare-walled, ToS-protected, and pointless to scrape) but the Valve
endpoints underneath it. All probes below ran keyless unless noted.

## The three mechanisms

1. **PICS + changelists** (client protocol, via SteamKit2 / python `steam`): Steam pushes
   incrementing changenumbers; each names apps/packages whose metadata changed. This is the
   spine of SteamDB — app history, build/depot updates, price changes, everything dated.
2. **Web API** (api.steampowered.com): 110 interfaces tracked in SteamTracking/API — the
   catalog of what exists.
3. **Store-page parsing** for what neither exposes ("not all information is available in all
   the APIs" — their FAQ).

## What we probed, ranked by value to Prospect

### 1. Followers — the wishlist proxy we wanted ★★★

Every game has a community group; its member count IS SteamDB's "followers" figure.

```
GET https://steamcommunity.com/games/{appid}/memberslistxml/?xml=1
→ <memberCount>481274</memberCount>          # Subnautica 2, measured 2026-08-24
```

Keyless, one request per game. Wishlists themselves are developer-private; followers are the
standard public proxy (community heuristic: wishlists ≈ followers × 8–12). A nightly poller
over the coming-soon cohort + recent releases gives us the pre-release momentum curve that
"wishlist count for coming-soon games" asked for. Start accruing NOW — the value is the
time series, and day one starts the clock.

### 2. IStoreBrowseService/GetItems — appdetails, but batched ★★★

```
GET api.steampowered.com/IStoreBrowseService/GetItems/v1/?input_json={...}
  ids: [{appid: ...}, ...]          # 10/10 returned in one call, likely far more
  data_request: include_basic_info, include_release, include_reviews,
                include_all_purchase_options, include_tag_count
→ per item: is_early_access, tagids, category ids, review_count + percent_positive,
  steam_release_date, best_purchase_option.final_price_in_cents / discount_pct
```

Measured: 10 games in one keyless call, prices in cents (`Hades → 2499`). Our current
`enrich` path does one `appdetails` call per game and manages ~6,000 games/night; this can
sweep the whole 175K catalog in hours. Also the natural engine for a DAILY PRICE SNAPSHOT —
the missing ingredient for "-20% SALE" event markers (see IDEAS.md) and price history.

### 3. PICS changelist poller — real patch events, dated ★★☆

Anonymous Steam login (same as SteamCMD), `python-steam` or SteamKit2:
subscribe to changelists → for our appids, on change fetch productinfo → diff
`depots.branches.public.buildid` + `timeupdated`. A buildid bump IS a shipped update —
stronger signal than patch-notes text (many updates ship without notes; notes sometimes
precede the build). Feeds mart_game_event with `kind='build'` rows and gives per-game
update cadence (SteamDB's "updated N times" figure). Public branches only, no ownership
needed. Runs as a small always-on daemon or a cron sweep of changenumbers.

### 4. ISteamChartsService/GetMostPlayedGames — ranked weekly peaks ★☆☆

```
GET api.steampowered.com/ISteamChartsService/GetMostPlayedGames/v1/
→ rank, appid, peak_in_game, last_week_rank   # top-100, keyless
```

True weekly PEAK CCU (our sampler only sees nightly points) plus rank momentum, top-100
only. Cheap to store weekly; complements steamcharts for the head of the catalog.

### 5. Already ours / not worth it

- `appreviewhistogram` — already collected (review_histogram; now powers the Radar trend).
- `IWishlistService` — per-USER wishlists only; a game's count stays developer-private.
- Scraping steamdb.info itself — Cloudflare, ToS, and nothing there that isn't upstream.

## Suggested order of attack

1. ~~**Followers poller**~~ — **SHIPPED.** `deploy/collectors/followers_bulk.py:130` polls
   `memberslistxml` exactly as proposed here.
2. ~~**GetItems price snapshot**~~ — **SHIPPED.** `deploy/collectors/catalog_prices.py:72`
   calls `IStoreBrowseService/GetItems`. It also went one better than this doc suggested:
   diffing `price_change_number` against yesterday's dump gives price-change detection
   without the PICS daemon in item 4.
3. **GetItems as enrich fast-path**: replace/augment per-game appdetails in the nightly.
   Still unbuilt — this is where the remaining value is.
4. **PICS build watcher**: the daemon; biggest engineering lift, best event quality. Still
   unbuilt, and item 2's `price_change_number` diff removed much of its original motivation.

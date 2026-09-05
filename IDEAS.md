# Ideas

Product ideas worth building, with what already exists to build them from. Not a backlog of
committed work — a place where an idea keeps its reasoning until someone picks it up.

---

## Cut mart_game_aspect_reviews' 4-hour build step

**STATUS (2026-09-05): the text-last shape below has landed, and the 4 hours are gone — 1,401s of
a 3,154s ETL on the last successful nightly. What remains is not the sort.** It landed in two
cuts on top of the lean ranking barrier the file has had since 2026-07-29: #113 (2026-08-30) took
review_text/steam_url out of the ten excerpt arms and joins the capped text on LAST by
(appid, recommendationid) — and found that the real 4-hour cost was RE2 unrolling the sentence
regex, 19× on that expression alone; #119 (2026-08-31) stopped materialising the corpus's text
at all — survivors' text is re-read from src.reviews by primary key, and `_aspectrev_base` lost
its 8.45GB column. The guardrail tests named below are all green on that shape.

Profiled statement by statement (2026-09-05) on a 4.37M-review snapshot of the source — 1.66M
eligible English reviews over 15.9K games, 1,464,649 mentions (the same corpus the mart's
2026-08-19 note counted), 596K survivors — sqlite-ATTACHed as the nightly attaches it, at the
droplet's threads=2 / memory_limit=2500MB:

| stage | seconds | share |
|---|---|---|
| ten excerpt arms (`_aspectrev_matched`, ~23µs/survivor) | 13.7 | 40% |
| three full streams of `src.reviews` (elig 6.3, base 5.1, survivors' text 4.4) | 15.8 | 46% |
| final join + `ORDER BY` on the joined row | 1.1 | 3% |
| ranking window, meta copy, capped-text side table, everything else | 1.0 | 3% |
| **total** | **34.2** | |

Peak spill 182MB, all of it the survivors' *uncapped* text in `_aspectrev_surv` (helpful reviews
average ~1.7KB, five times the corpus mean). Re-run at memory_limit=1000MB so that table no longer
fits — the production condition, at ~1.8M survivors — the arms go 13.7s → 25.4s and nothing else
moves: each of the ten arms SEQ_SCANs `_aspectrev_surv`, free from the buffer pool, ten re-reads
of a spilled table otherwise. A stream of `src.reviews` costs the same whether or not
review_text is projected (3.4s vs 4.2s): the sqlite scanner pushes projections down but no
filters, so every row of every language crosses and the row walk is the price; `sqlite_query()`
would filter inside SQLite but returns every column as VARCHAR, so it is not a lever.

**Taken (this PR):** the eligibility floor is counted over the materialised lean pool instead of
its own stream of the source (`_aspectrev_base` → `_aspectrev_elig` → `_aspectrev_meta`): two
streams per build instead of three, identical output on both fixtures (multiset and row order).
**Next, not taken:** fold the ten arms into one pass — a `CASE` per derived column keyed on
kw_aspect so each row meets only its own arm's constant-pattern regex — which lives in
`_ASPECT_EXCERPT_ARM` in build_marts.py and must be re-verified with the differential tests in
etl/tests/test_mart_aspect_reviews_window_rewrite.py. Everything under this line is the history
that motivated the rewrite, kept for the reasoning.

**The problem, measured (2026-08-22).** This one mart takes 14,239s of an 18,276s ETL — 78% of
the whole build, 15× the next-slowest mart. The cost arrived with the full-review columns
(review_text capped at 2000 chars + steam_url): all ~1.77M surviving rows now carry up to 2KB of
text through the 10-arm excerpt regex, the windowing pass, and the final
`ORDER BY appid, aspect, sentiment, votes_up` — a multi-GB sort on a box with a 2.5GB DuckDB
memory limit, so it spills (the run's scratch peaked at 20GB). The mart file's own header warns
about dragging review_text through a sort; the final ORDER BY is the same trap one step later.

**The shape of the fix.** Keep the pipeline text-free end to end and attach the capped text LAST,
keyed on recommendationid: build the final table without review_text/steam_url (ordered as
today), then attach the two columns via a keyed join against a small (recommendationid →
capped_text, author_steamid) side table built once from the survivors. The sort then moves ~50
bytes/row instead of ~2KB. Ballpark from the pre-column era: this step ran minutes, not hours.

**Guardrails already in place.** etl/tests/test_mart_aspect_reviews_full_text.py pins the cap
boundary (1999/2000/2001), character-vs-byte truncation, and the NULL-steamid permalink rule —
the fix must keep all of it green. Don't rush it into a nightly: validate the rewrite against a
timed run on the droplet first (the 2026-08-21 nightly died at a 4h timeout exactly here).

---

## Event markers on lifetime charts

**The idea.** On every chart that runs across a game's life — review velocity, owners, players,
press — mark the events that explain the shape: releases, updates, sales, notable coverage. A
spike is data; a spike with "−20% SALE" or "PC GAMER REVIEW" against it is an explanation. Right
now a reader sees that something happened and has no way to find out why without leaving the
product.

**Why it is worth doing.** This is the difference between a chart that reports and a chart that
teaches. Prospect's whole pitch is helping a solo dev decide what to build and when to launch;
"this game's reviews tripled the week it went 20% off" is exactly the transferable lesson, and it
is invisible today.

**Partly specified already.** `design_handoff_prospect_dark_ui/README.md` §4c asks for it on one
chart: "event marker = 1px dashed paper vertical line + condensed uppercase annotation
'−20% SALE · JUL 30'". `GameTrendsChart` already draws dashed event markers (`3 4`). So the visual
grammar exists — what is missing is the event SOURCE, and the generalisation to every lifetime
chart rather than one.

**What could feed it, from data we already hold:**

| Event type | Source | State |
|---|---|---|
| Patch notes / updates | `articles` channel `patch_notes` — 162k rows, dated, avg 608 chars of real text | ready |
| Notable press coverage | `mart_game_press_notable` — dated, already surfaced on the game page | ready |
| Developer posts | `articles` channel `dev_post` — 425k rows, dated | ready |
| Release date | `games.release_date` | ready |
| Price changes / sales | `game_snapshots.price_final` + `discount_percent` | **schema exists, no history** — ~1 snapshot per game, so nothing to diff. Needs a scheduled snapshot; history accrues only from when it starts |

**The one caveat to design around.** Four of the five sources are dense: a popular game has
hundreds of patch notes. Marking all of them turns the chart into a picket fence. The interesting
design question is not how to draw a marker, it is how to decide which events are worth marking —
likely the ones that coincide with an actual inflection in the series, which is a different and
better problem than "annotate everything".

**Start with the clock, not the chart.** Price/sale markers are the most valuable of the five —
"reviews tripled the week it went 20% off" is the lesson a solo dev can actually reuse — and they
are the only ones that cannot be backfilled. Every day without a scheduled capture is a day of
price history that can never be recovered — Steam serves the current price and nothing else.

**DONE (verified 2026-08-29): the price clock is running.** `deploy/collectors/catalog_prices.py`
runs nightly from `prospect-refresh.sh` (`run_step_bg "prices"`), writing `price_snapshots` in
`signals.db` and served at `/api/games/{appid}/price-history`. It is a keyed catalog diff, not a
per-game poll: `IStoreService/GetAppList` returns `price_change_number` per app, so only apps whose
counter moved get fetched. That means one row per unchanged game is the correct steady state, not a
stalled job — do not "fix" it. `original_cents` is null whenever `discount_pct` is 0 (Valve omits it
at full price); the list price is `final_cents` in that case, so nothing is lost.
`deploy/collectors/followers_bulk.py` runs the same way for the follower series.

The visual work (chart markers) is still open and can follow whenever — the history is accruing.

---

## Open questions recorded elsewhere

Deviations between the shipped redesign and its spec, plus the data gaps behind them, live in the
working register rather than here — see the redesign PRs (#70, #71, #72) and the ETL gap work
(#69) for the decisions already taken.

---

## Consolidate the blueprint frame into one component

Ten hand-rolled `<div className="blueprint"><i className="bp-corner"/>` blocks across six page
files, because seven agents restyled in parallel and none could see the others. They agree on the
frame and the corner marks — they disagree on panel-title type (14px in `Card`, 16px in the
hand-rolled panels), which is the visible symptom.

`Card` briefly carried a `blueprint` prop for this. It was never called once, so it was deleted:
dead code that looked like a shared primitive was worse than no primitive at all.

The fix is a single exported `BlueprintPanel` (frame + corner marks + one title scale) that all
six pages import. Deliberately NOT done in the same pass as the red/green fixes — it touches six
live pages at once and needs per-page visual verification, which is a different kind of risk from
a five-line colour correction.

---

## What SteamDB has that Prospect could use

**Sourcing, stated plainly.** SteamDB serves a Cloudflare challenge to automated clients — a plain
fetch AND a real headless browser both got 403 "Just a moment...". They are deliberately refusing
automated access, so the SteamDB feature list below comes from search results and prior knowledge,
NOT from reading their pages. Treat it as accurate in outline, not audited.

What WAS verified in a browser is Steam's own public charts, which is where half of SteamDB's
value originates anyway — and that turned up something better than a SteamDB clone (item 6).

The filter applied throughout: **Prospect is not a SteamDB clone.** SteamDB answers "what is
happening to game X right now". Prospect answers "what should I build, and when should I launch".
A SteamDB feature only earns a place here if it serves that second question. Depots, package
diffs, the account-value calculator and per-user library tools are excluded on purpose — they are
good features answering a question this product does not ask.

### Buildable on data we already hold

**1. All-time and rolling peak CCU per game.** SteamDB's headline trio is current / peak 24h /
peak all-time. We hold `mart_game_players_daily` (nightly point samples, ~32 days deep) and
`game_snapshots.ccu`. That supports "peak observed in the last N days" honestly today, and
becomes a real all-time peak as the series lengthens. Note the sample is nightly, so it is a
floor on the true peak, not the peak — label it as observed, never as "peak".

**2. Charts by tag / category.** SteamDB's most-played-by-tag is one query away from
`mart_niche_players` + `mart_niche_players_top`, which already exist. The Prospect twist is worth
more than the clone: rank niches by *players per game* rather than total players, which is the
number that tells a solo dev whether a niche's audience is reachable or locked up in three giants.
`winner_concentration` is already computed for exactly this.

**3. Store-page change history — repositioning detection.** SteamDB tracks every change to a
game's store page. We hold the current values in `games` (tags, genres, price, description,
categories) and rewrite them on each enrichment pass, keeping no history. Diffing enrichment
passes would surface something genuinely useful and, as far as I know, unserved: *which games
changed their tags or repositioned themselves, and what happened to their reviews afterwards*.
That is a direct answer to "is this niche worth entering" — you can watch what repositioning did
for someone else. Needs a small history table, not a new scrape.

**6. Weekly top-seller rank, change, and weeks-on-chart.** VERIFIED IN BROWSER:
`store.steampowered.com/charts/topselling/US` returns HTTP 200 and its table carries exactly four
columns — **Rank · Price · Change · Weeks**. That is Valve's own published sales ranking, with
week-over-week movement and, crucially, *how many weeks a title has held the chart*.

This is the closest public proxy to sales that exists, and nothing in Prospect uses it. Two things
it answers that our current data cannot:

- *Staying power.* "Weeks on chart" separates a launch spike from a game that kept selling. Our
  revenue estimate is lifetime and static; this is the shape of it over time.
- *A sales signal independent of reviews.* Every revenue number in Prospect is derived from review
  counts through Boxleiter. A ranking Valve publishes from actual sales is a genuinely independent
  check — where the two disagree, the Boxleiter multiplier for that genre is probably wrong, which
  is worth knowing on its own.

Regional charts exist per country, so it also gives a read on which markets a niche sells in —
something no other source here carries.

### Needs a clock started (history accrues forward only)

**4. Price history and lowest-ever price. — CLOCK STARTED (verified 2026-08-29).** The nightly
`prices` step has been accruing `price_snapshots` for a while; see the DONE note under event markers
above for how the keyed diff works. What remains here is the *analysis*, not the capture: SteamDB's
version answers "should I buy"; ours answers "what discount depth do games in my niche run, and what
does it do to their review velocity". That question is still unbuilt, and gets more answerable with
every week the series lengthens.

**5. Wishlist/popularity rank for unreleased games.** Steam publishes a ranked "Popular Upcoming"
list — 51,958 titles, ~1,040 requests for a full sweep, verified fetchable. Absolute wishlist
counts are private to the developer and cannot be obtained by anyone. But a *rank*, tracked over
time, gives pre-launch momentum for competitors, which is the thing you cannot otherwise see. A
game climbing from 4,000th to 900th in a month is a signal no other source in this product carries.

### Deliberately not worth copying

- **Depots, manifests, package diffs** — engineering plumbing; no bearing on what to build.
- **Account value / cost-per-hour calculator** — a consumer toy.
- **Sale-date prediction from backend changes** — genuinely clever, and squarely SteamDB's game.
  Prospect's launch-timing answer should come from its own seasonality data, not from guessing
  Valve's calendar.

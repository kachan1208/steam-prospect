# Ideas

Product ideas worth building, with what already exists to build them from. Not a backlog of
committed work — a place where an idea keeps its reasoning until someone picks it up.

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
are the only ones that cannot be backfilled. `game_snapshots` already has the right schema
(`price_initial`, `price_final`, `discount_percent`, `ccu`); it is written only when the scraper
happens to pass a game, which works out to roughly one row each, so there is nothing to diff.
Every day without a scheduled capture is a day of price history that can never be recovered —
Steam serves the current price and nothing else.

So the first move is a cheap nightly snapshot step, independent of any chart work. It is the same
shape as the two gaps already fixed this week (`sync-game-genres`, `enrich --refresh-unreleased`):
the mechanism exists and simply nobody runs it on a schedule. The visual work can follow whenever;
the history only starts accruing once the job does.

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

SteamDB blocks automated fetching (403), so this is assembled from search results and prior
knowledge rather than a page-by-page crawl — treat the feature list as accurate in outline, not
audited.

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

### Needs a clock started (history accrues forward only)

**4. Price history and lowest-ever price.** Already argued above under event markers — the schema
exists in `game_snapshots`, nothing writes it on a schedule. SteamDB's version answers "should I
buy"; ours answers "what discount depth do games in my niche run, and what does it do to their
review velocity". Same data, a different and more useful question.

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

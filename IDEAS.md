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

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

---

## Open questions recorded elsewhere

Deviations between the shipped redesign and its spec, plus the data gaps behind them, live in the
working register rather than here — see the redesign PRs (#70, #71, #72) and the ETL gap work
(#69) for the decisions already taken.

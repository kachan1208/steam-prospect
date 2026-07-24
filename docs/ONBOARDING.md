# Welcome to Prospect — a newcomer's onboarding guide

New here? This is the short, friendly version. In about 15 minutes you'll know what Prospect
is, how to run your first useful search, and how to read the numbers without fooling yourself.
When you want the full reference, see the [User Guide](./USER_GUIDE.md) or the in-app **Docs**
page.

- **Open the app:** https://142-93-49-69.nip.io

---

## What Prospect is (in three sentences)

Prospect reads a nightly snapshot of all of Steam — the catalog, player reviews, and games
press — and turns it into answers for the decisions a solo/indie dev actually faces: *what to
build, what it could earn, why the hits win, and who to pitch.* It's read-only and uses only
public, aggregate data — there's no login, and it never touches your personal Steam account.
Nothing to set up; just start clicking.

## The one thing to remember

**Every number is an estimate, and estimates are shown as ranges on purpose.** Prospect would
rather tell you "somewhere between 40K and 110K owners" than pretend to know "73,412." When you
see a range, that spread *is* the honesty — don't collapse it to the midpoint in your head.

---

## Your first session (do this now)

1. **Start at Niche Finder** (left sidebar). It ranks every Steam tag/genre by an
   **Opportunity** score. Leave the defaults: sorted by Opportunity, "Min reviews" = 10, dimension
   = Tags.
2. **Read the three little bars, not just the score.** Each niche shows **Demand**,
   **Competition**, and **Quality gap**. High opportunity can mean "big hungry market" *or*
   "weak incumbents you can out-build" — the bars tell you which. Click a niche's name to open a
   drawer with its trend, revenue spread, and top games.
3. **Reality-check with Market Benchmarks.** Before a revenue number excites you, glance here to
   see what a *typical* Steam game earns (spoiler: the median is humbling). Now you have a
   yardstick.
4. **Estimate a payoff.** Open the **Estimator**, type in a review count (try a comparable
   game's), pick a price and genre, and read the owners / revenue **range**. Note the low-to-high
   spread — that's your uncertainty.
5. **Learn from a hit.** Open **Games**, search a game like the one you're imagining, open it,
   and click the **Why it works** tab. It shows what *that game's own players* praise more than
   the genre average — evidence of what resonates, not a formula.
6. **Check your timing.** Peek at **Launch & Timing** to see if your genre is "front-loaded" (win
   or lose in launch week) or a "slow-burn" (word-of-mouth builds for months). It changes how
   you'd spend a marketing budget.

That's the core loop: **find → size → learn → time.** Everything else builds on it.

---

## A tiny worked example

Say you're toying with a **cozy farming/base-building** game.

- In **Niche Finder**, search "farming" and "base building" tags. You're looking for a decent
  **Demand** bar, a **Competition** bar that isn't maxed out, and ideally a healthy **Quality
  gap** (means the current games are beatable).
- Note the niche's **median reviews** and **Hit ≥$200K** rate — the second one is your odds of a
  *real* outcome, not just the middle result.
- Drop that median review count into the **Estimator** at, say, $19.99, genre "Simulation." Read
  the range.
- Open a couple of the niche's top games (from the drawer) and read their **Why it works** tabs.
  Do players rave about *content & length*? *cozy vibe / art*? That's your bar to clear.

You now have a grounded, range-based read on a niche in a few minutes — the thing that used to
take a weekend of spreadsheet spelunking.

---

## The screens you'll actually use

| Screen | Use it to… |
|---|---|
| **Niche Finder** | Find under-served niches by Opportunity (start here). |
| **Market Benchmarks** | Know what "good" revenue even looks like. |
| **Launch & Timing** | See if your genre is launch-splash or slow-burn. |
| **Games** | Profile any title + read its "Why it works" teardown. |
| **Estimator** | Turn reviews or wishlists into an owners/revenue range. |
| **Marketing** | Find press outlets & journalists covering your genre. |
| **Dev log** | A private, browser-local journal for your own marketing beats. |
| **Use in Claude** | Ask Prospect's data questions in your own Claude (below). |

---

## Reading the numbers without fooling yourself

Three habits that keep you honest:

- **Opportunity is relative, not a grade.** An "80" means "better than most niches on this
  blend," not "80% chance of success." Always open the Demand / Competition / Quality-gap parts.
- **Revenue is a modeled range.** It's estimated owners × price, with owners derived from review
  counts (the "Boxleiter method," ~20–55 owners per review). Quote the low↔high span, and expect
  other tools to disagree — everyone uses different multipliers.
- **"Why it works" is evidence, not a recipe.** Teardowns and press reads are *correlational* —
  they show what players/press talked about, not proof that copying it will work. Marketing,
  timing, and luck aren't in the data.

Data freshness: everything rebuilds nightly. Hover the little **health dot** at the bottom of
the sidebar for the exact "data as of" build.

---

## Optional power move: ask in your own Claude

Prefer to just ask questions in plain language? Connect Prospect to your own Claude. In **Claude
Code**, run once:

```
claude mcp add --transport http prospect https://142-93-49-69.nip.io/mcp/
```

For **claude.ai / Claude Desktop**, add a custom connector pointing at
`https://142-93-49-69.nip.io/mcp/` (see the in-app **Use in Claude** page, or the
[User Guide](./USER_GUIDE.md#use-prospect-inside-your-own-claude-mcp), for the exact steps).
Then ask things like *"Find under-served roguelike deckbuilder niches with a real revenue
floor"* or *"Estimate revenue for a $19.99 RPG with 800 reviews."*

---

## Where to next

- **Just explore.** The core loop above is genuinely all you need to start.
- **Go deeper:** the full [User Guide](./USER_GUIDE.md) documents every screen, column, and the
  methodology behind each number.
- **Stay honest:** when in doubt, re-read [Methodology & data
  honesty](./USER_GUIDE.md#methodology--data-honesty). Prospect is a compass, not a crystal
  ball — it points you at good bets; the game is still yours to make.

Welcome aboard, and good luck with your game.

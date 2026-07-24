# Prospect — User Guide

Everything Prospect does, in plain language: what each screen answers, how to read the
numbers, and where the data comes from. Prospect turns Steam's public catalog, reviews, and
press coverage into the handful of decisions a solo or indie game dev actually has to make.

- **Live app:** https://142-93-49-69.nip.io
- **MCP server:** https://142-93-49-69.nip.io/mcp/
- **Freshness:** the data rebuilds nightly. The sidebar's health dot (and the **Data log**
  page) show the exact build — that's the authoritative "data as of" answer.

> This guide is also available inside the app under **Docs**.

---

## Contents

- [What Prospect is, and who it's for](#what-prospect-is-and-who-its-for)
- [Your first 10 minutes](#your-first-10-minutes)
- **The core**
  - [Niche Finder](#niche-finder)
  - [Market Benchmarks](#market-benchmarks)
  - [Launch & Timing](#launch--timing)
  - [Games & the "Why it works" teardown](#games--the-why-it-works-teardown)
  - [Estimator](#estimator)
- [Marketing & press](#marketing--press)
- **Your workspace**
  - [Alerts](#alerts)
  - [Dev log](#dev-log)
- [Use Prospect inside your own Claude (MCP)](#use-prospect-inside-your-own-claude-mcp)
- [Data log & freshness](#data-log--freshness)
- [Methodology & data honesty](#methodology--data-honesty)
- [FAQ & support](#faq--support)

---

## What Prospect is, and who it's for

**Prospect is a market-intelligence tool for solo and indie game developers.** It reads a
snapshot of all of Steam — the catalog, player reviews, and games-press coverage — and turns
it into answers to a few questions every dev has to face. It never connects to your personal
Steam account and never asks for one — it works entirely off public, aggregate data, and it's
read-only: you browse and analyze, nothing to configure.

What each surface answers, in one line:

| Surface | What it answers |
|---|---|
| **Niche Finder** | What should I build? Rank every Steam tag and genre by opportunity — demand vs. competition vs. how beatable the incumbents are. |
| **Market Benchmarks** | Is this number good or a fantasy? Reference points from indie-market research alongside what this catalog actually shows. |
| **Launch & Timing** | When should I launch, and is my genre a launch-splash or a slow-burn? |
| **Games & teardown** | Where does a specific title stand, and — from its own reviews — why does it win versus genre peers? |
| **Estimator** | If a game has N reviews (or wishlists) at price P, what's the owners and revenue range? |
| **Marketing** | Who to pitch and where to post — press outlets and named journalists covering your genre (plus creator channels where data exists). |
| **Alerts** | Get pinged when a game or niche you track surges, stalls, or shifts. |
| **Dev log** | A private, browser-local journal for your own marketing beats and wishlist milestones. |
| **Use in Claude** | Connect Prospect's analytics to your own Claude and just ask questions in natural language. |

A note that runs through the whole product: **every estimate is a range, never fake
precision**, and anything correlational is labeled as such. See
[Methodology & data honesty](#methodology--data-honesty) for exactly how the numbers are made
and where they fall short.

---

## Your first 10 minutes

1. **Find a niche.** Open **Niche Finder**, keep it sorted by **Opportunity**, and leave "Min
   reviews" at 10. Skim the top rows and click one to open its detail drawer (saturation
   trend, revenue histogram, top games).
2. **Sanity-check the market.** Glance at **Market Benchmarks** so you know what "good"
   revenue even looks like before you get excited about a number.
3. **Price the payoff.** Take that niche's median review count into the **Estimator**, set a
   price and genre, and read the owners / revenue range.
4. **Study a hit.** Search a comparable game in **Games**, open it, and read the **Why it
   works** tab — what its own players praise, measured against genre peers.
5. **Time it.** Check **Launch & Timing** to see whether your genre rewards a big launch week
   or a sustained slow burn.
6. **Take it into your own Claude.** Optionally connect the
   [MCP server](#use-prospect-inside-your-own-claude-mcp) and ask follow-up questions in plain
   language.

---

## Niche Finder

**What it answers:** which corners of Steam are under-served relative to demand?

The headline tool. It ranks every Steam **tag** or **genre** by an **Opportunity** score that
balances how big/hot the market is against how crowded and how beatable it is. Toggle **Tags
vs Genres** (tags are the larger, more specific community vocabulary — better for finding real
micro-niches) and **All-time vs Last 24 months** (24m catches niches heating up now). Search,
sort any column, save the view, or export to CSV. Click a niche name to open a drawer with its
saturation trend, revenue histogram, and representative games.

**The columns:**

| Column | Meaning |
|---|---|
| Games / Recent 24m | How many qualifying games are in the niche total, and how many launched in the last 24 months. |
| Median rev / Median price | The middle game's estimated lifetime revenue and launch price — a realistic center of gravity, not the average (which a few hits would inflate). |
| Demand / Comp. / Quality gap | The three 0–100 parts of the score. Demand = market size & heat. Competition = how crowded / winner-take-most (higher is worse). Quality gap = how beatable the incumbents are (higher is better). |
| Opportunity | The blended headline score, 0–100. Higher = a bigger, less-crowded, more-beatable niche. A relative ranking across niches, not an absolute grade. |
| Hit ≥$200K | Share of the niche's games that cleared ~$200K estimated revenue — your odds of a real outcome, not just the median. |
| Saturation YoY | Year-over-year change in release count. A big positive number means everyone is piling in. |

**How to read it:** don't read Opportunity alone — open the three bars. A high score driven by
a big **quality gap** means "the incumbents are weak, out-execute them"; one driven by low
**competition** means "few games here." A high **Hit ≥$200K** with a modest median is often
more encouraging than a high median alone.

**Practical tip:** "Min reviews" is the per-game review floor for the scoring, and only two
values are precomputed — **10** (broad, noisier) and **50** (stricter, cleaner). Set it to 10
or 50; other numbers return an empty table.

---

## Market Benchmarks

**What it answers:** is this revenue number good, average, or a fantasy?

Reference points for judging any dollar figure. The top row shows **cited** numbers from
public indie-market research (e.g. a median indie grosses only a few hundred dollars; a small
share of releases ever clear $100K; Steam keeps ~30% and pays ~70% to the dev). The second row
shows what **this catalog** actually computes, so you can see how the two differ and why.

Below: a **long-tail distribution** (revenue / reviews / owners, per genre and window) that
shows the full shape of outcomes — a huge left mass of small games and a thin tail of hits; the
**Boxleiter** reviews→owners chart (the same conversion the Estimator uses, fitted per genre);
and the four **dev tiers** (Hobby / Small / Middle / Triple-I) by lifetime copies sold.

**How to read it:** the cited median and the catalog median are *supposed* to differ — cited
figures are first-year / net-of-Steam's-cut over *all* releases; the catalog's are Boxleiter
gross-lifetime over games that cleared the review floor. Use the distribution's percentiles
(P50, P90…) to place any single game honestly — the mean is always well above the median
because of the tail.

---

## Launch & Timing

**What it answers:** when should I launch, and does the calendar even matter?

Three reads on release timing:

- **Launch shape by genre** — what share of a genre's first-year reviews land in each window
  after launch. A tall left side means **front-loaded** (the launch-week splash is
  everything); a flatter spread means **slow-burn** (sustained marketing and updates keep
  paying off).
- **Seasonality** — a month × weekday heatmap of median revenue, plus a launch-weekday bar.
- **Price distribution** — what paid games in a genre actually charge.

**How to read it:** timing effects are usually **mild** — treat this as a tiebreaker, not a
strategy. It's also correlational: a strong month often reflects *what kind* of game usually
launches then (big titles cluster in fall), not the date itself. The launch-shape read is the
more actionable one: it tells you whether to bet your marketing budget on week one or spread it
out.

---

## Games & the "Why it works" teardown

**Games (search) — what it answers:** where does a specific title or competitor actually stand?

Search the catalog by name, genre, or exact tag to profile any title. Sort by owners, reviews,
rating, or estimated revenue. Tags are case- and hyphenation-sensitive (Steam treats
"Rogue-like" and "Roguelike" as different tags), so use the tag chips under the search bar to
pick exact strings that exist in your results.

**Game profile — what it answers:** how big is this game, and what makes it stand out?

Every game opens to two tabs:

- **Overview** — its estimated revenue range, owners, reviews, rating and live players; a
  **percentile-vs-genre** read (where it ranks among genre peers on revenue, reviews and
  owners); its genre's launch shape; review and momentum timelines; a language split;
  playtime; and a **comparables** table ranked by tag overlap.
- **Why it works** (the teardown) — mines the game's own reviews into ten fixed aspects
  (Combat, World & Exploration, Art, Music, Story, Difficulty, Controls, Navigation, Content &
  Length, Price & Value) and shows, per aspect, whether players praise it *more than the genre
  baseline*. It also maps the game's press footprint and notable coverage.

**How to read the teardown:** the signal is the **difference vs. genre peers**, not raw
positivity — a badge means "this game over-indexes here versus similar games." Read it as
"here's what this game's players talk about that others don't," which is **correlational
evidence**, not a recipe. Aspects come from a recency-biased sample of English reviews, so
thin-review games carry a caveat.

---

## Estimator

**What it answers:** if a game has N reviews (or wishlists) at price P, what's the revenue
range?

Turn a review count **or** a launch-day wishlist count into an owners and revenue range. Pick
the basis, enter the number, a price and a genre, and read three ranges: **estimated owners**,
**gross revenue**, and **net revenue** (after Steam's ~30% cut). The dev-tier badge tells you
which of the four tiers the midpoint lands in, and "How this was calculated" shows the exact
multipliers used.

**How to read it:** always quote the **range**, not the midpoint. The reviews path uses the
Boxleiter method (~20–55 owners per review, fitted per genre), so the low↔high span is real
uncertainty, not decoration. Passing a genre matters — owners-per-review varies a lot by genre.
See [Methodology](#methodology--data-honesty) for the full formula.

---

## Marketing & press

**What it answers:** who covers my genre, and where does it get attention?

Pick your genre for a set of marketing reads. The **pitch / target list** has tabs for Press,
YouTube, Reddit, Twitch and X — each a ranked list of outlets, journalists, or creators
covering your genre, with an example mention and an "active vs. quiet" flag. There's also a
channel-mix read (where a genre's attention concentrates) and rising / cooling "buzz" themes.

**What to trust here:** the **Press** tab is the solid part — outlets and named journalists
drawn from ~1.1M scraped articles (journalist outlets only; Steam News excluded). The creator /
social tabs (YouTube, Reddit, Twitch, X) depend on separate scrapers and are often **sparse or
empty** — an empty list is an honest "no data yet," not an error. Rankings are by all-time
volume, so always check the example date and the "last 24mo" count before pitching; coverage is
fuzzy-matched, English-skewed, and reflects selection bias (these outlets already chose to
cover the genre).


---

## Dev log

**What it answers:** can I track my own marketing beats and wishlist growth?

A private journal for your game. Log **marketing events** (trailers, festivals, press, updates)
and **wishlist / follower milestones**, then read them back together; it also suggests a rough
wishlist target for your genre and tracks your progress toward a goal you set.

**Private to this browser:** your dev-log entries are stored locally in **your own browser** —
they're private to you, but they are **not synced or shared across devices**, and they'll be
gone if you clear the browser's site data. The suggested wishlist targets are rough heuristics,
not guarantees.

---

## Use Prospect inside your own Claude (MCP)

Prospect exposes its analytics as an **MCP server** — a standard way to plug a data source into
an AI assistant. Connect it to your own Claude (Desktop, Code, or claude.ai) and ask market
questions in plain language; the answers come straight from Prospect's Steam data, running on
your Claude. It's read-only, needs no API key, and there's nothing to install on Prospect's
side. (The in-app **Use in Claude** page has the same setup with copy buttons.)

**Server URL** — Streamable HTTP · read-only · no auth:

```
https://142-93-49-69.nip.io/mcp/
```

**Claude Code (CLI)** — run once; it registers Prospect for every session:

```
claude mcp add --transport http prospect https://142-93-49-69.nip.io/mcp/
```

**claude.ai / Claude Desktop (custom connector):**

1. Open **Settings → Connectors** and click **Add custom connector**.
2. Paste the server URL above, name it **Prospect**, and connect.
3. In a chat, enable the Prospect connector and ask away.

Custom connectors need a Claude Pro, Max, Team, or Enterprise plan.

**Claude Desktop (config file)** — add this under `mcpServers` (uses the `mcp-remote` bridge):

```json
"prospect": {
  "command": "npx",
  "args": ["mcp-remote", "https://142-93-49-69.nip.io/mcp/"]
}
```

**Things to ask:**

- "Find under-served roguelike deckbuilder niches with a real revenue floor."
- "What's the median revenue for Strategy games on Steam, and how skewed is the distribution?"
- "Estimate revenue for a $19.99 RPG with 800 reviews."
- "When should I launch a Simulation game — month and weekday?"
- "Do a teardown of Hades — why does it work versus its genre?"
- "Who should I pitch for press coverage in the Adventure genre?"

**Good to know:** Prospect exposes **15 read-only analytics tools** (find niches, niche detail,
market benchmarks, revenue distribution, estimate revenue, launch shape, best launch timing,
game search, game profile, game teardown, press pitch list, buzz trends, creator pitch list,
channel mix, channel buzz) plus a **data-dictionary resource**. Ask Claude to read the data
dictionary first, so it uses the same definitions of opportunity / demand / competition /
quality-gap that this guide does.

---

## Data log & freshness

**What it answers:** how fresh is the data I'm looking at?

The refresh history. Each nightly run re-scrapes Steam, rebuilds the analytics, and reloads the
app; this log shows what each run added (games, reviews, player updates), the mart version, and
how long it took. The sidebar's health dot is the quick version — hover it for the exact mart
version and build timestamp, which is the authoritative "data as of" answer.

---

## Methodology & data honesty

### Where the data comes from

All public, all aggregate — never your personal Steam account.

| Source | What it provides |
|---|---|
| **Steam storefront** | The public catalog (names, prices, tags, genres, release dates, header art, short descriptions) and player reviews. Review counts are reconciled against Steam's own numbers for ground truth where possible. |
| **SteamSpy** | Owner-range estimates. These got noisier after Steam changed its default profile privacy in 2018 — which is exactly why Prospect treats owners as a range and leans on review-based estimates. |
| **Games press** | Article metadata (headline, byline, date, outlet) from a set of tracked outlets — PC Gamer, IGN, Eurogamer, GamesIndustry.biz, Game Developer, and others — matched to games by title. Prospect links to the original article and never reproduces its body text. |

Roughly: the full Steam catalog (~142K apps), a few million sampled reviews, and ~1.1M press
articles — rebuilt nightly. The exact size and build date for your session are in the sidebar
health dot and the Data log.

### The Opportunity score

Every niche gets three 0–100 **percentile** scores, ranked against all other niches in the same
cut, then blended:

- **Demand** = `0.4 × (median revenue) + 0.3 × (median owners) + 0.3 × (recent 24-month review
  velocity)`. Higher = a bigger, hotter market.
- **Competition** = `0.6 × (count of recent releases) + 0.4 × (winner concentration — how much
  of the niche's revenue the top few games hold)`. Higher = more crowded / winner-take-most,
  which is bad for a new entrant.
- **Quality gap** = the share of incumbents that are weak — rating under 80% **OR** fewer than
  50 reviews. Higher = easier to out-execute the field.
- **Opportunity** = `clamp( 0.5 × Demand − 0.35 × Competition + 0.3 × Quality gap, 0, 100 )`.

Scores are computed at four cuts — window (all-time / last 24 months) × review floor (10 / 50) —
and a niche needs at least 30 qualifying games to be scored at all. Because the parts are
percentiles, **Opportunity is a relative ranking**, not an absolute grade: an 80 means "better
than most niches on this blend," not "80% likely to succeed." That's why the app always shows
the three parts, never just the blend.

### Revenue & owners estimates — and their error bars

The revenue figure used across the app is **estimated owners × launch price** = gross lifetime
box revenue (not net-of-Steam's-cut, not first-year-only). Owners come from the **Boxleiter
method**: reviews are a small, roughly-consistent fraction of owners, so owners ≈ reviews × a
multiplier of about **20–55**, fitted per genre (mid ≈ 30) and clamped to that band.

In the Estimator, the reviews path gives `owners = reviews × (20 / genre-mid / 55)` for
low/mid/high; `net = gross × ~70%` (after Steam's ~30% cut). The wishlist path is rougher:
`owners = wishlists × ~8–12% first-week conversion × 5` (first-week → first-year).

**How wide are the bars?** The low↔high span comes from the 20–55 owners-per-review band —
roughly a **2–3×** spread. This is an order-of-magnitude planning input, not a forecast. Treat
"mid" as a center of gravity and always keep the range in view.

### Honest limitations

- **Estimates, not truth.** Owners and revenue are modeled, not reported. Different tools use
  different multipliers and will disagree — that's expected.
- **Reviews & press are samples.** Review-based signals (velocity, timelines, teardown aspects)
  come from a sample that's recency-biased toward older/popular titles; press is a
  fuzzy-matched, confidence-filtered corpus that skews to the last ~year and to
  English/Western outlets, and excludes Steam News. Counts describe the sample, not Steam's
  true totals.
- **Correlational, not causal.** Teardowns and any press-vs-outcome read are evidence toward an
  explanation, never proof — marketing, timing and luck are unmeasured here.
- **Freshness.** The catalog rebuilds nightly, but a brand-new release lags until SteamSpy and
  the review scrape catch up (Prospect flags when a count is an honest lower bound). Trust the
  health dot's build date over your memory.
- **Tags vs. genres.** Genre is Steam's small, fixed, exact-match field (a game's primary genre
  is used); tags are the larger community vocabulary — more specific and better for
  niche-finding, but case- and hyphenation-sensitive. Non-descriptive tags like "early access"
  or "video game" are filtered out of the niche vocabulary on purpose. Release dates come from
  Steam and, for Early Access titles, generally reflect the Early Access launch rather than the
  1.0 date.

---

## FAQ & support

**Is Prospect affiliated with Valve or Steam?**
No. Prospect is an independent, third-party research tool built on publicly available data.
"Steam" is a trademark of Valve Corporation, referenced only to describe the platform.

**Are the revenue estimates guaranteed?**
No — they're statistical estimates, always shown as a range. Treat them as a planning input,
not a promise.

**Why do Prospect's numbers differ from other tools?**
Different tools use different owner multipliers and review sources. Prospect fits its Boxleiter
multiplier per genre and prefers Steam's ground-truth review counts where available — the
Estimator's "How this was calculated" panel shows the exact inputs for any estimate.

**Can I export data?**
Yes — CSV export is available from the Niche Finder. Bulk raw exports of the underlying catalog
aren't offered.

**Does Prospect track my personal Steam account?**
No. Prospect never connects to your Steam profile or library — it only uses public, aggregate
data.

**How current is what I'm seeing?**
The data rebuilds nightly. The sidebar health dot (and the Data log) show the exact mart
version and build timestamp — that's the authoritative "data as of."

---

*Prospect is early and solo-run — if a number looks wrong, note the mart version from the
sidebar health dot so it can be reproduced.*

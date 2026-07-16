# LEGAL.md — Data-source review: scraping & redistributing Steam/SteamSpy data in a paid product

**Status:** internal engineering assessment, not legal advice. Written by an AI coding agent
as part of Track G4 (`prospect-production-and-marketing-plan.md`). It is grounded in the
actual scraper code (`steam-scraper/steam_scraper/*.py`) and in the live terms-of-service
text quoted below, but **it has not been reviewed by a lawyer**. Treat every conclusion here
as "our best non-expert read, to be confirmed by counsel before charging money" — which is
exactly the plan's own framing for this item ("Resolve before money changes hands").

Last written: 2026-07-16.

---

## TL;DR

- Prospect's underlying data comes from three distinct sources with **three different risk
  profiles**: (1) Steam's own storefront/review JSON endpoints, (2) SteamSpy, (3) press
  RSS/sitemap metadata. They should not be reasoned about as one blob.
- The real exposure is **contractual (Steam's Terms of Service), not copyright**, for the
  factual data (names, prices, review counts, tags) — those facts are not copyrightable.
  The two places actual **copyrighted expression** gets redistributed are (a) Valve/publisher
  store-page description text, and (b) Steam user review excerpts — both are already
  mitigated in the current product (truncated / short excerpts, see below) but are worth
  tightening further before launch.
- Nothing found here is a "stop, this is illegal" finding. It is a real, live **breach-of-
  ToS risk** (Valve could restrict access; there is no indication Valve has ever pursued this
  class of analytics/insights tool legally, and an entire industry — SteamDB, SteamSpy
  itself, VG Insights, Gamalytic, IsThereAnyDeal, GameDiscoverCo — operates on the same class
  of data, commercially, today). The honest recommendation is: **ship with the mitigations
  below, keep a real lawyer in the loop before/at the point money changes hands**, and design
  so that losing any one source degrades gracefully rather than breaking the product.

---

## 1. What Prospect actually scrapes (grounded in the code)

Read directly from `steam-scraper/steam_scraper/`:

| Source | Endpoint(s) | What's taken | Where it surfaces in Prospect |
|---|---|---|---|
| Steam storefront (catalog) | `store.steampowered.com/api/appdetails`, `.../search/results/` | name, price, tags, genres, release date, `short_description`, `header_image` (a URL) | Niche Finder, Games, Estimator, Game Profile |
| Steam storefront (reviews) | `store.steampowered.com/appreviews/{appid}` | review text, vote/playtime metadata, language | Game Teardown aspect excerpts |
| SteamSpy | `steamspy.com/api.php` (`all`, `appdetails`) | owner-count **estimates**, ccu, tags | Boxleiter owner/revenue ranges (cross-checked against Steam's own review-count API where available) |
| Press RSS/sitemaps | PC Gamer, IGN, Eurogamer, GamesIndustry.biz, Game Developer, DOU Gamedev | title, author, published date, summary, **and full `raw_text`** (stored, see §5) | Press pitch lists, buzz trends — only title/author/date/link surfaced, never body text |

Two things are worth flagging up front because they materially change the risk read:

- **`store.steampowered.com/api/appdetails` and `.../appreviews/{appid}` are not the official,
  documented, key-gated Steam Web API** (`api.steampowered.com`, governed by the Steamworks
  Web API Terms of Use). They're the storefront website's own internal JSON endpoints —
  extremely widely scraped (every third-party Steam tool uses them), but they carry **no
  terms of their own**; they fall under Valve's general site terms (the Steam Subscriber
  Agreement), described below.
- `robots.txt` at `store.steampowered.com` does **not** disallow `/api/`, `/appreviews/`, or
  `/search/` (checked live 2026-07-16) — so this isn't a robots.txt violation. That's a low
  bar, not a green light; robots.txt silence doesn't override the Subscriber Agreement.

---

## 2. The governing terms, quoted

### 2.1 Steam Subscriber Agreement (`store.steampowered.com/subscriber_agreement`)

This is the general site terms that governs use of the storefront/website itself — the
relevant document for the undocumented `appdetails`/`appreviews`/`search` endpoints above.

> **§2.A (License):** "...you accept, a non-exclusive license and right, to use the Content
> and Services **for your personal, non-commercial use**."

> **§2.F (Ownership):** "All title, ownership rights and intellectual property rights in and
> to the Content and Services...are owned by Valve and/or its...licensors."

> **§2.G (Restrictions):** "you may not, in whole or in part, copy, photocopy, reproduce,
> publish, distribute, translate, reverse engineer, derive source code from, modify,
> disassemble, decompile..."

> **§4.C (Automation):** "You may not use any form of scripts, bots, macros, or other
> non-human-controlled systems ('Automation') to interact with Content and Services on Steam
> in any manner" (this section's examples are specific to marketplace/trading abuse, not
> read-only data collection generally — community consensus, not Valve's own clarification,
> reads this as aimed at marketplace bots rather than catalog scraping, but the plain text is
> broader than that).

**Read plainly, §2.A is the actual risk**: it grants a **personal, non-commercial** license
to "Content and Services," and a paid analytics product built by scraping the storefront is
squarely a *commercial* use of that content. This is a **breach-of-contract risk, not a
copyright claim on the underlying facts** — Valve's remedy would be to restrict/block access
or send a cease-and-desist, not (for the factual data) a copyright suit, since facts (prices,
names, review counts) are not copyrightable subject matter in the US (*Feist v. Rural*).

### 2.2 Steam Web API Terms of Use (`steamcommunity.com/dev/apiterms`)

This governs the **official**, key-gated `api.steampowered.com` Web API — which this project
mostly does *not* use for catalog/review data (see §1), but is worth knowing as the contrast
case and for any future migration:

> "You may distribute Steam Data to end users **for their personal use** via your
> Application."
> "You are limited to **one hundred thousand (100,000) calls** to the Steam Web API per day."
> "Valve may change, suspend or discontinue the Steam Web API...at any time for any reason,
> without notice."

Notably, this document at least contemplates third-party "Applications" built on Steam Data —
a materially different posture than the Subscriber Agreement's blanket "personal,
non-commercial" framing. Where a Prospect data need can be met by an **official, documented**
Web API endpoint instead of an undocumented storefront JSON endpoint, that's the more
defensible path (see §6).

### 2.3 SteamSpy (`steamspy.com/about`, `steamspy.com/api.php`)

> "Steam Spy extrapolates data from a limited number of user profiles and thus **isn't 100%
> correct**."
> "Most of Steam Spy's data is available through API here: steamspy.com/api.php"

**No explicit license grant, commercial-use restriction, or attribution requirement is
published on the site today.** That's silence, not permission — treat it as "no known
prohibition found" rather than "confirmed OK for commercial use." SteamSpy's own data quality
has also been degraded since Steam changed default profile visibility in 2018, which is a
second, independent reason (accuracy, not just legal risk) that Prospect already leans
increasingly on Steam's own ground-truth review-count API rather than SteamSpy alone — the
current codebase's own direction (85K+ titles reconciled to Steam review data) is the right
one and should continue.

### 2.4 Press outlets (PC Gamer, IGN, Eurogamer, GamesIndustry.biz, Game Developer, DOU Gamedev)

Each outlet's own ToS almost certainly has boilerplate anti-scraping language, but two
mitigating factors apply industry-wide and specifically here:

- **RSS feeds are explicitly published for machine syndication** — pulling title/author/date/
  summary from an RSS feed is categorically different from scraping rendered HTML against a
  site's wishes, and is standard practice for every feed reader, news aggregator, and PR clip-
  tracking tool.
- **Sitemap crawling for discovery is exactly what search-engine crawlers do**, and is
  normally implicitly sanctioned by publishing `sitemap.xml` without disallowing it in
  `robots.txt`.

This is the **lowest-risk source** of the three, and is a smaller version of a well-
established, widely-tolerated category (Google News, Feedly, PR clip-tracking services).

---

## 3. Where copyrighted *expression* (not just facts) gets redistributed

Facts (an appid, a price, a review count) are not copyrightable. Two places in Prospect *do*
carry someone else's actual creative/written expression, and deserve separate scrutiny:

1. **Store-page `short_description`** (Valve/publisher marketing copy). **Already mitigated**:
   `GameProfile.tsx` renders it `line-clamp-2` — a short, truncated snippet, not the full
   text — which is a materially better position than verbatim reproduction, though not a
   guarantee against a thin-copyright claim on the phrase itself. **Recommendation:** keep the
   truncation; consider dropping it in favor of Prospect's own computed summary if this
   product ever draws Valve/publisher attention.
2. **Steam user review excerpts** (Game Teardown's aspect drill-down). This is **the single
   largest legal exposure point** in the product, because it's user-generated content whose
   ToS (§2.A above) doesn't obviously sublicense third parties to redisplay it, and it's
   individually authored, copyrightable text (not a bare fact). Mitigating factors already in
   place: excerpts are short, aggregated for sentiment analysis (a transformative,
   analysis-driven use — not competing with or substituting for reading the review on Steam),
   and the surrounding feature is framed as data-mined analysis rather than a review
   reproduction service. **Recommendation before charging money:** keep excerpts short (a
   sentence, not a paragraph); consider adding a permalink back to the original review where
   the Steam reviews API exposes one, both as good practice and as a fair-use-style
   reinforcement ("we're pointing you at the source, not replacing it").
3. **Header images are hotlinked (a URL into Steam's CDN), never re-hosted** — confirmed in
   both the schema (`header_image: str`, a URL) and the frontend (`<img src={...}>` pointing
   directly at Steam's own CDN). This is the same pattern SteamDB/IsThereAnyDeal/etc. use and
   is a meaningfully lower-risk posture than copying and serving the assets from Prospect's
   own infrastructure.
4. **Press article bodies are scraped and stored (`articles.raw_text`) but never surfaced** —
   the API/frontend only ever expose title/author/date/outlet/link (`PressNotableArticle`,
   `PitchOutlet`, `PitchAuthor` schemas — no body-text field). Storing `raw_text` at all is
   unnecessary retained risk with no corresponding product value today (matching isn't
   `raw_text`-dependent per `game_matcher.py`'s title/appid-based approach). **Recommendation:**
   stop persisting `raw_text` beyond what matching needs, or purge it on a rolling basis — it
   is pure liability with no offsetting benefit while nothing reads it back.

---

## 4. Exports and bulk redistribution

Prospect already draws a reasonable line here and should **keep** it: `/api/niches/export.csv`
and `/api/explore/export.csv` export **computed, aggregated analytics** (opportunity scores,
percentiles, medians) rather than a bulk dump of the raw scraped catalog. A hypothetical
"export the entire catalog as CSV" feature would look much more like "redistributing Steam
Data" in the plain sense of the Subscriber Agreement's restrictions than what exists today.
**Recommendation:** do not add a raw full-catalog export; keep exports scoped to derived
analytics, which is both a better product decision and a materially safer legal posture.

---

## 5. How this compares to the rest of the industry

Prospect is not the first or only commercial product built this way. SteamDB, SteamSpy
itself, VG Insights, Gamalytic, IsThereAnyDeal, and GameDiscoverCo all operate commercially
(subscriptions, paid tiers, or ad-supported) on the same class of storefront-scraped +
SteamSpy-derived data, some for a decade-plus, without a public record of Valve pursuing
legal action against the "analytics/insights for developers" category specifically (as
opposed to, e.g., marketplace-arbitrage bots or key-reselling, which Valve has acted against).
That is informative — an industry practice, not a legal defense — and doesn't change that the
underlying license terms say "personal, non-commercial." It's the difference between "this is
technically outside the license" and "this is a category Valve has shown no enforcement
interest in policing," which is a business-risk judgment call, not a legal green light.

---

## 6. Concrete recommendations, ranked

1. **Get a real lawyer's eyes on this before the first paid invoice** — this document is
   scaffolding for that conversation, not a substitute for it. This is the plan's own
   instruction ("resolve before money changes hands") and the single most important line item
   here.
2. **Stop persisting press `raw_text`** (§3.4) — no product surface reads it, pure liability.
3. **Add a visible, permanent attribution/disclaimer** in the app (not just the landing
   footer) — "Prospect is an independent tool built on publicly available Steam data; not
   affiliated with or endorsed by Valve" — already present on the landing footer and now
   added to the Terms/Privacy pages and every legal-document footer; consider surfacing it
   once inside the authenticated app shell too (a Track O1-adjacent "data as of" line is the
   natural place to co-locate it).
4. **Keep review excerpts short and never reproduce full reviews**; add a source permalink
   where the API provides one.
5. **Never add a bulk/raw full-catalog export** — keep exports scoped to derived analytics
   (already true today).
6. **Where an official, documented Web API endpoint can replace an undocumented storefront
   endpoint for the same data, prefer the official one** — it at least contemplates
   third-party "Applications," which the storefront's internal JSON endpoints don't.
7. **Design for graceful degradation**, not catastrophic failure, if any one source
   (SteamSpy especially, given its own accuracy caveats and informal terms) becomes
   unavailable or is asked to stop — the multi-source design (Steam ground-truth reviews +
   SteamSpy + press) already provides some of this; keep it that way rather than
   deepening reliance on the least-certain source.

---

## 7. What this document is not

It is not a legal opinion, not a warranty that Prospect's current data practices are
compliant with any specific law or ToS, and not a substitute for counsel. It is a structured,
source-quoted starting point for that conversation, written because the production plan
explicitly called this out as the one item that must be genuinely resolved — not merely
scaffolded — before Prospect charges money.

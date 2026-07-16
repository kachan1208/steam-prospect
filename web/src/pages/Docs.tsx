import { Link, useParams } from "react-router-dom";

import { ChatMarkdown } from "../components/chat/ChatMarkdown";
import { Card } from "../components/ui/Card";

interface DocEntry {
  slug: string;
  title: string;
  summary: string;
  body: string;
}

const DOCS: DocEntry[] = [
  {
    slug: "getting-started",
    title: "Getting started",
    summary: "The four surfaces, and a sensible order to use them in.",
    body: `Prospect turns Steam's public catalog, review, and press data into four decisions:

1. **Find your niche** — open Niche Finder and sort by Opportunity (demand minus competition, plus quality gap). Filter by a minimum review count so you're looking at niches with a real sample size, not a handful of outliers.
2. **Estimate the payoff** — take a niche's median review count into the Estimator to get an owners/revenue range using the Boxleiter method, fitted per genre.
3. **Learn why hits win** — open a specific game's profile and read its "Why it works" teardown: praise/complaint themes mined from real reviews, measured against its genre's baseline.
4. **Find your press** — once you know your genre, Press ranks the outlets and named journalists actually covering it recently, with an example headline each.

Along the way: save any filter/sort combination you like from the Niche Finder or Explorer (Settings → Saved views brings them all together), and add games you're tracking to your Watchlist.

You can revisit the full welcome tour any time from Settings → Profile & preferences → "Reopen the welcome guide."`,
  },
  {
    slug: "understanding-the-numbers",
    title: "Understanding the numbers",
    summary: "Opportunity scores, the Boxleiter method, and why everything is a range.",
    body: `Prospect deliberately avoids fake precision. Two ideas run through the whole product:

## Opportunity = demand − competition + quality gap

Each niche (a tag or genre) gets three 0–100 percentile scores computed across all niches, then combined into one Opportunity number. You always see the three parts broken out — never just the single blended score — so you can judge whether "high opportunity" means "genuinely under-served" or "under-served because quality bar is high and few teams can clear it."

## Owners ≈ reviews × a Boxleiter multiplier

The Boxleiter method estimates lifetime owners from a review count, using a multiplier (roughly 20–55, fitted per genre from Prospect's own catalog) — reviews are a small, roughly-consistent fraction of total owners. Prospect fits this multiplier per genre using Steam-API ground-truth review counts where available, and always reports **low / mid / high**, never a single number.

## Correlational, not causal

Game teardowns show which review themes correlate with a game's success relative to its genre baseline. That is evidence, not proof — plenty of unmeasured factors (marketing spend, timing, luck) also matter. Read it as "here's what this game's players talk about that others in its genre don't," not "do X and you'll win."`,
  },
  {
    slug: "data-sources",
    title: "Data sources & freshness",
    summary: "Where the numbers come from, in plain English, and how current they are.",
    body: `Prospect is built from a versioned snapshot of three public sources:

- **Steam's own storefront** — the public catalog (names, prices, tags, genres, release dates) and player reviews, reconciled against Steam's own review-count API wherever possible for ground truth.
- **SteamSpy** — ownership-range estimates. SteamSpy's own estimates have gotten less precise since Steam changed its default profile privacy in 2018, which is why Prospect treats owners as a **range**, not a point figure, and increasingly leans on Steam's ground-truth review counts instead.
- **Press & trade-press RSS/sitemaps** — article metadata (headline, byline, date, outlet) from a set of tracked outlets, matched to games by title/appid. Prospect links back to the original article rather than reproducing its text.

Check the sidebar's health indicator (or the API's \`/api/health\` endpoint) for the exact mart version and build timestamp your instance is running on — that's the authoritative "data as of" answer. A full assessment of the legal considerations around scraping and redistributing this data lives in the project's internal \`LEGAL.md\`.`,
  },
  {
    slug: "faq",
    title: "FAQ",
    summary: "Common questions about accuracy, affiliation, and scope.",
    body: `**Is Prospect affiliated with Valve or Steam?**
No. Prospect is an independent, third-party research tool built on publicly available data. "Steam" is a trademark of Valve Corporation, referenced here only to describe the platform.

**Are the revenue estimates guaranteed?**
No — they're statistical estimates (see "Understanding the numbers"), always shown as a range. Treat them as a planning input, not a promise.

**Why do owners/revenue numbers look different from other tools?**
Different tools use different multipliers and different review-count sources. Prospect fits its Boxleiter multiplier per genre from its own catalog and prefers Steam's ground-truth review API where available — check the Estimator's "How this was calculated" panel for the exact inputs used on any given estimate.

**Can I export my data?**
Yes — CSV export is available from the Niche Finder and the Data Explorer. Bulk raw exports of the underlying scraped catalog aren't offered (see the Terms' acceptable-use section).

**Does Prospect track my personal Steam account?**
No — see the Privacy Policy. Prospect never connects to your personal Steam profile or library.`,
  },
  {
    slug: "support",
    title: "Support",
    summary: "How to reach us.",
    body: `Prospect is early — if something looks wrong or you're stuck, we want to hear about it.

- **Email**: support@prospect.app *(placeholder inbox — update once a real support channel is live)*
- **Response time**: solo-run for now, so please allow a few business days.

When reporting a data or estimate question, the mart version and build date shown in the sidebar's health indicator (or \`/api/health\`) helps us reproduce what you're seeing.`,
  },
];

function DocIndex() {
  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-lg font-semibold text-ink-primary">Docs</h1>
        <p className="mt-0.5 text-sm text-ink-muted">Short reference guides for how Prospect works and where its numbers come from.</p>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {DOCS.map((d) => (
          <Link
            key={d.slug}
            to={`/docs/${d.slug}`}
            className="block rounded-card border border-chartborder bg-surface p-4 shadow-sm transition-colors hover:border-borderstrong hover:shadow-md"
          >
            <div className="text-sm font-semibold text-ink-primary">{d.title}</div>
            <div className="mt-1 text-xs leading-relaxed text-ink-muted">{d.summary}</div>
          </Link>
        ))}
      </div>
    </div>
  );
}

function DocDetail({ slug }: { slug: string }) {
  const doc = DOCS.find((d) => d.slug === slug);
  return (
    <div className="flex flex-col gap-4">
      <Link to="/docs" className="w-fit text-xs font-medium text-series-1 hover:underline">
        ← Back to docs
      </Link>
      <Card title={doc?.title ?? "Not found"}>
        {doc ? <ChatMarkdown text={doc.body} /> : <div className="py-6 text-center text-sm text-ink-muted">That doc page doesn't exist.</div>}
      </Card>
    </div>
  );
}

export default function Docs() {
  const { slug } = useParams<{ slug?: string }>();
  return slug ? <DocDetail slug={slug} /> : <DocIndex />;
}

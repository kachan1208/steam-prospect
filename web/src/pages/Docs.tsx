import type { ReactNode } from "react";
import { Link } from "react-router-dom";

import { Card } from "../components/ui/Card";

// The live deployment. The MCP server is served from the same origin at /mcp/.
const APP_URL = "https://142-93-49-69.nip.io";
const MCP_URL = "https://142-93-49-69.nip.io/mcp/";

// ---- small building blocks --------------------------------------------------------------

/** A top-level section anchor + heading. `scroll-mt` keeps the heading clear of the top edge
 *  when you jump to it from the table of contents. */
function Section({ id, kicker, title, children }: { id: string; kicker?: string; title: string; children: ReactNode }) {
  return (
    <section id={id} className="flex scroll-mt-6 flex-col gap-3">
      <div>
        {kicker && <div className="text-[11px] font-semibold uppercase tracking-wide text-brand">{kicker}</div>}
        <h2 className="text-lg font-semibold text-ink-primary">{title}</h2>
      </div>
      {children}
    </section>
  );
}

/** One feature/page write-up. `to` links to the live page; `question` is the one-liner
 *  "what does this answer". */
function Feature({
  id,
  name,
  where,
  to,
  question,
  children,
}: {
  id: string;
  name: string;
  where: string;
  to?: string;
  question: string;
  children: ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-6">
      <Card
        title={name}
        subtitle={
          <>
            <span className="text-ink-secondary">{question}</span>
            <span className="mt-0.5 block text-[11px] uppercase tracking-wide text-ink-muted">{where}</span>
          </>
        }
        action={
          to ? (
            <Link to={to} className="shrink-0 text-xs font-medium text-brand hover:underline">
              Open →
            </Link>
          ) : undefined
        }
      >
        <div className="flex flex-col gap-3 text-sm leading-relaxed text-ink-secondary">{children}</div>
      </Card>
    </section>
  );
}

/** A labelled "how to read it" callout inside a feature card. */
function ReadBox({ label = "How to read it", children }: { label?: string; children: ReactNode }) {
  return (
    <div className="rounded-md border border-chartborder bg-page p-3">
      <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-brand">{label}</div>
      <div className="text-xs leading-relaxed text-ink-secondary">{children}</div>
    </div>
  );
}

/** A term / meaning glossary (used for column definitions). */
function Terms({ items }: { items: [string, ReactNode][] }) {
  return (
    <dl className="flex flex-col divide-y divide-chartborder/60 rounded-md border border-chartborder">
      {items.map(([term, meaning], i) => (
        <div key={i} className="flex flex-col gap-0.5 px-3 py-2 sm:flex-row sm:gap-4">
          <dt className="shrink-0 text-xs font-semibold text-ink-primary sm:w-44">{term}</dt>
          <dd className="text-xs leading-relaxed text-ink-secondary">{meaning}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Inline code / copyable command. */
function Code({ children }: { children: ReactNode }) {
  return <code className="rounded bg-page px-1.5 py-0.5 text-[12px] text-ink-primary">{children}</code>;
}

function Pre({ children }: { children: ReactNode }) {
  return (
    <pre className="overflow-x-auto rounded-md border border-chartborder bg-page px-3 py-2.5 text-[12px] leading-relaxed text-ink-primary">
      {children}
    </pre>
  );
}

// ---- table of contents ------------------------------------------------------------------

const TOC: { group: string; items: [string, string][] }[] = [
  {
    group: "Start here",
    items: [
      ["overview", "What Prospect is"],
      ["first-10", "Your first 10 minutes"],
    ],
  },
  {
    group: "The core",
    items: [
      ["niche-finder", "Niche Finder"],
      ["benchmarks", "Market Benchmarks"],
      ["timing", "Launch & Timing"],
      ["games", "Games & teardown"],
      ["estimator", "Estimator"],
    ],
  },
  {
    group: "Marketing",
    items: [["marketing", "Marketing & press"]],
  },
  {
    group: "Your workspace",
    items: [
      ["devlog", "Dev log"],
    ],
  },
  {
    group: "Connect",
    items: [["mcp", "Use Prospect in your Claude"]],
  },
  {
    group: "Data & trust",
    items: [
      ["datalog", "Data log & freshness"],
      ["methodology", "Methodology & data honesty"],
      ["faq", "FAQ & support"],
    ],
  },
];

function TableOfContents() {
  return (
    <Card title="On this page" subtitle="Jump to any section.">
      <div className="grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2 lg:grid-cols-4">
        {TOC.map((g) => (
          <div key={g.group}>
            <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-ink-muted">{g.group}</div>
            <ul className="flex flex-col gap-1">
              {g.items.map(([id, label]) => (
                <li key={id}>
                  <a href={`#${id}`} className="text-xs text-ink-secondary transition-colors hover:text-brand">
                    {label}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </Card>
  );
}

// ---- page -------------------------------------------------------------------------------

export default function Docs() {
  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-8 pb-20">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-ink-primary">Prospect user guide</h1>
        <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-ink-secondary">
          Everything Prospect does, in plain language — what each screen answers, how to read the numbers, and where
          the data comes from. Prospect turns Steam's public catalog, reviews, and press coverage into the handful of
          decisions a solo or indie dev actually has to make.
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-ink-muted">
          <span>
            Live at{" "}
            <a href={APP_URL} target="_blank" rel="noreferrer" className="text-brand hover:underline">
              142-93-49-69.nip.io
            </a>
          </span>
          <span aria-hidden>·</span>
          <span>Data refreshes nightly</span>
          <span aria-hidden>·</span>
          <span>The sidebar health dot shows the exact "data as of" build</span>
        </div>
      </div>

      <TableOfContents />

      {/* ============================ START HERE ============================ */}
      <Section id="overview" kicker="Start here" title="What Prospect is, and who it's for">
        <Card>
          <div className="flex flex-col gap-3 text-sm leading-relaxed text-ink-secondary">
            <p>
              <span className="font-semibold text-ink-primary">Prospect is a market-intelligence tool for solo and
              indie game developers.</span>{" "}
              It reads a snapshot of all of Steam — the catalog, player reviews, and games-press coverage — and turns
              it into answers to a few questions every dev has to face. It never connects to your personal Steam account
              and never asks for one — it works entirely off public, aggregate data, and it's read-only: you browse and
              analyze, nothing to configure.
            </p>
            <p className="text-ink-secondary">What each part of the core answers, in one line:</p>
            <Terms
              items={[
                [
                  "Niche Finder",
                  <>What should I build? Rank every Steam tag and genre by opportunity — demand vs. competition vs. how beatable the incumbents are.</>,
                ],
                [
                  "Market Benchmarks",
                  <>Is this number good or a fantasy? Reference points from indie-market research alongside what this catalog actually shows.</>,
                ],
                [
                  "Launch & Timing",
                  <>When should I launch, and is my genre a launch-splash or a slow-burn?</>,
                ],
                [
                  "Games & teardown",
                  <>Where does a specific title stand, and — from its own reviews — why does it win versus genre peers?</>,
                ],
                [
                  "Estimator",
                  <>If a game has N reviews (or wishlists) at price P, what's the owners and revenue range?</>,
                ],
                [
                  "Marketing",
                  <>Who to pitch and where to post — press outlets and named journalists covering your genre (plus creator channels where data exists).</>,
                ],
                [
                  "Dev log",
                  <>A private, browser-local journal for your own marketing beats and wishlist milestones.</>,
                ],
                [
                  "Use in Claude",
                  <>Connect Prospect's analytics to your own Claude and just ask questions in natural language.</>,
                ],
              ]}
            />
            <p className="text-xs text-ink-muted">
              A note that runs through the whole product: every estimate is a <span className="text-ink-primary">range</span>,
              never fake precision, and anything correlational is labeled as such. See{" "}
              <a href="#methodology" className="text-brand hover:underline">Methodology &amp; data honesty</a> for exactly
              how the numbers are made and where they fall short.
            </p>
          </div>
        </Card>
      </Section>

      <Section id="first-10" kicker="Start here" title="Your first 10 minutes">
        <Card>
          <ol className="flex flex-col gap-3 text-sm leading-relaxed text-ink-secondary">
            {[
              <>
                <span className="font-semibold text-ink-primary">Find a niche.</span> Open{" "}
                <Link to="/niches" className="font-medium text-brand hover:underline">Niche Finder</Link>, keep it sorted
                by <span className="text-ink-primary">Opportunity</span>, and leave "Min reviews" at 10. Skim the top
                rows and click one to open its detail drawer (saturation trend, revenue histogram, top games).
              </>,
              <>
                <span className="font-semibold text-ink-primary">Sanity-check the market.</span> Glance at{" "}
                <Link to="/benchmarks" className="font-medium text-brand hover:underline">Market Benchmarks</Link> so you
                know what "good" revenue even looks like before you get excited about a number.
              </>,
              <>
                <span className="font-semibold text-ink-primary">Price the payoff.</span> Take that niche's median
                review count into the{" "}
                <Link to="/estimator" className="font-medium text-brand hover:underline">Estimator</Link>, set a price
                and genre, and read the owners / revenue range.
              </>,
              <>
                <span className="font-semibold text-ink-primary">Study a hit.</span> Search a comparable game in{" "}
                <Link to="/games" className="font-medium text-brand hover:underline">Games</Link>, open it, and read the{" "}
                <span className="text-ink-primary">Why it works</span> tab — what its own players praise, measured
                against genre peers.
              </>,
              <>
                <span className="font-semibold text-ink-primary">Time it.</span> Check{" "}
                <Link to="/timing" className="font-medium text-brand hover:underline">Launch &amp; Timing</Link> to see
                whether your genre rewards a big launch week or a sustained slow burn.
              </>,
              <>
                <span className="font-semibold text-ink-primary">Take it into your own Claude.</span> Optionally connect
                the{" "}
                <a href="#mcp" className="font-medium text-brand hover:underline">MCP server</a> and just ask follow-up
                questions in plain language.
              </>,
            ].map((step, i) => (
              <li key={i} className="flex gap-3">
                <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-brand-tint text-[11px] font-semibold text-brand">
                  {i + 1}
                </span>
                <span>{step}</span>
              </li>
            ))}
          </ol>
        </Card>
      </Section>

      {/* ============================ THE CORE ============================ */}
      <Section id="niche-finder" kicker="The core" title="Niche Finder">
        <Feature
          id="niche-finder-card"
          name="Niche Finder"
          where="Sidebar “Niche Finder”"
          to="/niches"
          question="Which corners of Steam are under-served relative to demand?"
        >
          <p>
            The headline tool. It ranks every Steam <span className="text-ink-primary">tag</span> or{" "}
            <span className="text-ink-primary">genre</span> by an <span className="text-ink-primary">Opportunity</span>{" "}
            score that balances how big/hot the market is against how crowded and how beatable it is. Toggle{" "}
            <span className="text-ink-primary">Tags vs Genres</span> (tags are the larger, more specific community
            vocabulary — better for finding real micro-niches), and{" "}
            <span className="text-ink-primary">All-time vs Last 24 months</span> (24m catches niches heating up now).
            Search, sort any column, save the view, or export to CSV. Click a niche name to open a drawer with its
            saturation trend, revenue histogram, and representative games.
          </p>
          <p className="text-xs font-medium text-ink-secondary">The columns:</p>
          <Terms
            items={[
              ["Games / Recent 24m", "How many qualifying games are in the niche total, and how many launched in the last 24 months."],
              ["Median rev / Median price", "The middle game's estimated lifetime revenue and launch price — a realistic center of gravity, not the average (which a few hits would inflate)."],
              ["Demand / Comp. / Quality gap", "The three 0–100 parts of the score, shown as bars. Demand = market size & heat. Competition = how crowded / winner-take-most (higher is worse). Quality gap = how beatable the incumbents are (higher is better)."],
              ["Opportunity", "The blended headline score, 0–100. Higher = a bigger, less-crowded, more-beatable niche. It's a relative ranking across niches, not an absolute grade."],
              ["Hit ≥$200K", "Share of the niche's games that cleared ~$200K estimated revenue — your odds of a real outcome, not just the median."],
              ["Saturation YoY", "Year-over-year change in release count. A big positive number means everyone is piling in."],
            ]}
          />
          <ReadBox>
            Don't read Opportunity alone — open the three bars. A high score driven by a big{" "}
            <span className="text-ink-primary">quality gap</span> means "the incumbents are weak, out-execute them";
            one driven by low <span className="text-ink-primary">competition</span> means "few games here." A high{" "}
            <span className="text-ink-primary">Hit ≥$200K</span> with a modest median is often more encouraging than a
            high median alone.
          </ReadBox>
          <ReadBox label="Practical tip">
            "Min reviews" is the per-game review floor for the scoring, and only two values are precomputed —{" "}
            <span className="text-ink-primary">10</span> (broad, noisier) and <span className="text-ink-primary">50</span>{" "}
            (stricter, cleaner). Set it to 10 or 50; other numbers return an empty table.
          </ReadBox>
        </Feature>
      </Section>

      <Section id="benchmarks" kicker="The core" title="Market Benchmarks">
        <Feature
          id="benchmarks-card"
          name="Market Benchmarks"
          where="Sidebar “Market Benchmarks”"
          to="/benchmarks"
          question="Is this revenue number good, average, or a fantasy?"
        >
          <p>
            Reference points for judging any dollar figure. The top row shows{" "}
            <span className="text-ink-primary">cited</span> numbers from public indie-market research (e.g. a median
            indie grosses only a few hundred dollars; a small share of releases ever clear $100K; Steam keeps ~30% and
            pays ~70% to the dev). The second row shows what <span className="text-ink-primary">this catalog</span>{" "}
            actually computes, so you can see how the two differ and why.
          </p>
          <p>
            Below: a <span className="text-ink-primary">long-tail distribution</span> (revenue / reviews / owners, per
            genre and window) that shows the full shape of outcomes — a huge left mass of small games and a thin tail of
            hits; the <span className="text-ink-primary">Boxleiter</span> reviews→owners chart (the same conversion the
            Estimator uses, fitted per genre); and the four <span className="text-ink-primary">dev tiers</span>{" "}
            (Hobby / Small / Middle / Triple-I) by lifetime copies sold.
          </p>
          <ReadBox>
            The cited median and the catalog median are <span className="text-ink-primary">supposed</span> to differ:
            cited figures are first-year / net-of-Steam's-cut over <em>all</em> releases; the catalog's are Boxleiter
            gross-lifetime over games that cleared the review floor. Use the distribution's percentiles (P50, P90…) to
            place any single game honestly — the mean is always well above the median because of the tail.
          </ReadBox>
        </Feature>
      </Section>

      <Section id="timing" kicker="The core" title="Launch & Timing">
        <Feature
          id="timing-card"
          name="Launch & Timing"
          where="Sidebar “Launch & Timing”"
          to="/timing"
          question="When should I launch, and does the calendar even matter?"
        >
          <p>
            Three reads on release timing. <span className="text-ink-primary">Launch shape by genre</span> shows what
            share of a genre's first-year reviews land in each window after launch — a tall left side means{" "}
            <span className="text-ink-primary">front-loaded</span> (the launch-week splash is everything), a flatter
            spread means <span className="text-ink-primary">slow-burn</span> (sustained marketing and updates keep
            paying off). <span className="text-ink-primary">Seasonality</span> is a month × weekday heatmap of median
            revenue plus a launch-weekday bar. <span className="text-ink-primary">Price distribution</span> shows what
            paid games in a genre actually charge.
          </p>
          <ReadBox>
            Timing effects are usually <span className="text-ink-primary">mild</span> — treat this as a tiebreaker, not
            a strategy. It's also correlational: a strong month often reflects <em>what kind</em> of game usually
            launches then (big titles cluster in fall), not the date itself. The launch-shape read is the more
            actionable one: it tells you whether to bet your marketing budget on week one or spread it out.
          </ReadBox>
        </Feature>
      </Section>

      <Section id="games" kicker="The core" title="Games & the “Why it works” teardown">
        <Feature
          id="games-card"
          name="Games (search)"
          where="Sidebar “Games”"
          to="/games"
          question="Where does a specific title or competitor actually stand?"
        >
          <p>
            Search the catalog by name, genre, or exact tag to profile any title. Sort by owners, reviews, rating, or
            estimated revenue. Tags are case- and hyphenation-sensitive (Steam treats "Rogue-like" and "Roguelike" as
            different tags), so use the tag chips under the search bar to pick exact strings that exist in your results.
          </p>
        </Feature>

        <Feature
          id="game-profile"
          name="Game profile & “Why it works”"
          where="Click any game in search"
          question="How big is this game, and what makes it stand out?"
        >
          <p>
            Every game opens to two tabs. <span className="text-ink-primary">Overview</span> gives its estimated revenue
            range, owners, reviews, rating and live players; a <span className="text-ink-primary">percentile-vs-genre</span>{" "}
            read (where it ranks among genre peers on revenue, reviews and owners); its genre's launch shape; review and
            momentum timelines; a language split; playtime; and a <span className="text-ink-primary">comparables</span>{" "}
            table ranked by tag overlap.
          </p>
          <p>
            <span className="text-ink-primary">Why it works</span> is the teardown: it mines the game's own reviews into
            ten fixed aspects (Combat, World & Exploration, Art, Music, Story, Difficulty, Controls, Navigation, Content
            & Length, Price & Value) and shows, per aspect, whether players praise it <em>more than the genre
            baseline</em>. It also maps the game's press footprint and notable coverage.
          </p>
          <ReadBox>
            The teardown's signal is the <span className="text-ink-primary">difference vs. genre peers</span>, not raw
            positivity — a badge means "this game over-indexes here versus similar games." Read it as "here's what this
            game's players talk about that others don't," which is <span className="text-ink-primary">correlational
            evidence</span>, not a recipe. Aspects come from a recency-biased sample of English reviews, so thin-review
            games carry a caveat.
          </ReadBox>
        </Feature>
      </Section>

      <Section id="estimator" kicker="The core" title="Estimator">
        <Feature
          id="estimator-card"
          name="Estimator"
          where="Sidebar “Estimator”"
          to="/estimator"
          question="If a game has N reviews (or wishlists) at price P, what's the revenue range?"
        >
          <p>
            Turn a review count <span className="text-ink-primary">or</span> a launch-day wishlist count into an owners
            and revenue range. Pick the basis, enter the number, a price and a genre, and read three ranges:{" "}
            <span className="text-ink-primary">estimated owners</span>,{" "}
            <span className="text-ink-primary">gross revenue</span>, and{" "}
            <span className="text-ink-primary">net revenue</span> (after Steam's ~30% cut). The dev-tier badge tells you
            which of the four tiers the midpoint lands in, and "How this was calculated" shows the exact multipliers
            used.
          </p>
          <ReadBox>
            Always quote the <span className="text-ink-primary">range</span>, not the midpoint. The reviews path uses
            the Boxleiter method (~20–55 owners per review, fitted per genre), so the low↔high span is real
            uncertainty, not decoration. Passing a genre matters — owners-per-review varies a lot by genre. See{" "}
            <a href="#methodology" className="text-brand hover:underline">Methodology</a> for the full formula.
          </ReadBox>
        </Feature>
      </Section>

      {/* ============================ MARKETING ============================ */}
      <Section id="marketing" kicker="Marketing" title="Marketing & press">
        <Feature
          id="marketing-card"
          name="Marketing"
          where="Sidebar “Marketing”"
          to="/marketing"
          question="Who covers my genre, and where does it get attention?"
        >
          <p>
            Pick your genre for a set of marketing reads. The{" "}
            <span className="text-ink-primary">pitch / target list</span> has tabs for Press, YouTube, Reddit, Twitch
            and X — each a ranked list of outlets, journalists, or creators covering your genre, with an example mention
            and an "active vs. quiet" flag. There's also a channel-mix read (where a genre's attention concentrates) and
            rising / cooling "buzz" themes.
          </p>
          <ReadBox label="What to trust here">
            The <span className="text-ink-primary">Press</span> tab is the solid part — outlets and named journalists
            drawn from ~1.1M scraped articles (journalist outlets only; Steam News excluded). The creator / social tabs
            (YouTube, Reddit, Twitch, X) depend on separate scrapers and are often{" "}
            <span className="text-ink-primary">sparse or empty</span> — an empty list is an honest "no data yet," not an
            error. Rankings are by all-time volume, so always check the example date and the "last 24mo" count before
            pitching; coverage is fuzzy-matched, English-skewed, and reflects selection bias (these outlets already
            chose to cover the genre).
          </ReadBox>
        </Feature>
      </Section>

      {/* ============================ WORKSPACE ============================ */}
      <Section id="devlog" kicker="Your workspace" title="Dev log">
        <Feature
          id="devlog-card"
          name="Dev log"
          where="Sidebar “Dev log”"
          to="/devlog"
          question="Can I track my own marketing beats and wishlist growth?"
        >
          <p>
            A private journal for your game. Log{" "}
            <span className="text-ink-primary">marketing events</span> (trailers, festivals, press, updates) and{" "}
            <span className="text-ink-primary">wishlist / follower milestones</span>, then read them back together; it
            also suggests a rough wishlist target for your genre and tracks your progress toward a goal you set.
          </p>
          <ReadBox label="Private to this browser">
            Your dev-log entries are stored locally in <span className="text-ink-primary">your own browser</span> — they're
            private to you, but they are <span className="text-ink-primary">not synced or shared across devices</span>,
            and they'll be gone if you clear the browser's site data. The suggested wishlist targets are rough
            heuristics, not guarantees.
          </ReadBox>
        </Feature>
      </Section>

      {/* ============================ MCP ============================ */}
      <Section id="mcp" kicker="Connect" title="Use Prospect inside your own Claude">
        <Card>
          <div className="flex flex-col gap-4 text-sm leading-relaxed text-ink-secondary">
            <p>
              Prospect exposes its analytics as an <span className="font-semibold text-ink-primary">MCP server</span> —
              a standard way to plug a data source into an AI assistant. Connect it to your own Claude (Desktop, Code, or
              claude.ai) and ask market questions in plain language; the answers come straight from Prospect's Steam
              data, running on your Claude. It's read-only, needs no API key, and there's nothing to install on
              Prospect's side. (The in-app{" "}
              <Link to="/chat" className="font-medium text-brand hover:underline">Use in Claude</Link> page has the same
              setup with copy buttons.)
            </p>

            <div>
              <div className="mb-1.5 text-xs font-semibold text-ink-primary">Server URL</div>
              <Pre>{MCP_URL}</Pre>
              <p className="mt-1 text-[11px] text-ink-muted">Streamable HTTP · read-only · no auth</p>
            </div>

            <div>
              <div className="mb-2 text-xs font-semibold text-ink-primary">Claude Code (CLI)</div>
              <p className="mb-1.5 text-xs text-ink-muted">Run once — registers Prospect for every session:</p>
              <Pre>{`claude mcp add --transport http prospect ${MCP_URL}`}</Pre>
            </div>

            <div>
              <div className="mb-2 text-xs font-semibold text-ink-primary">claude.ai / Claude Desktop (custom connector)</div>
              <ol className="list-decimal space-y-1 pl-4 text-xs text-ink-secondary">
                <li>
                  Open <span className="text-ink-primary">Settings → Connectors</span> and click{" "}
                  <span className="text-ink-primary">Add custom connector</span>.
                </li>
                <li>
                  Paste the server URL above, name it <span className="text-ink-primary">Prospect</span>, and connect.
                </li>
                <li>In a chat, enable the Prospect connector and ask away.</li>
              </ol>
              <p className="mt-1.5 text-[11px] text-ink-muted">
                Custom connectors need a Claude Pro, Max, Team, or Enterprise plan.
              </p>
            </div>

            <div>
              <div className="mb-2 text-xs font-semibold text-ink-primary">Claude Desktop (config file)</div>
              <p className="mb-1.5 text-xs text-ink-muted">
                Prefer editing the config directly? Add this under <Code>mcpServers</Code> (uses the{" "}
                <Code>mcp-remote</Code> bridge):
              </p>
              <Pre>{`"prospect": {
  "command": "npx",
  "args": ["mcp-remote", "${MCP_URL}"]
}`}</Pre>
            </div>

            <div>
              <div className="mb-2 text-xs font-semibold text-ink-primary">Things to ask</div>
              <ul className="flex list-disc flex-col gap-1 pl-4 text-xs text-ink-secondary">
                <li>"Find under-served roguelike deckbuilder niches with a real revenue floor."</li>
                <li>"What's the median revenue for Strategy games on Steam, and how skewed is the distribution?"</li>
                <li>"Estimate revenue for a $19.99 RPG with 800 reviews."</li>
                <li>"When should I launch a Simulation game — month and weekday?"</li>
                <li>"Do a teardown of Hades — why does it work versus its genre?"</li>
                <li>"Who should I pitch for press coverage in the Adventure genre?"</li>
              </ul>
            </div>

            <ReadBox label="Good to know">
              Prospect exposes <span className="text-ink-primary">15 read-only analytics tools</span> (find niches,
              niche detail, market benchmarks, revenue distribution, estimate revenue, launch shape, best launch timing,
              game search, game profile, game teardown, press pitch list, buzz trends, creator pitch list, channel mix,
              channel buzz) plus a <span className="text-ink-primary">data-dictionary resource</span>. Ask Claude to read
              the data dictionary first, so it uses the same definitions of opportunity / demand / competition /
              quality-gap that this guide does.
            </ReadBox>
          </div>
        </Card>
      </Section>

      {/* ============================ DATA & TRUST ============================ */}
      <Section id="datalog" kicker="Data & trust" title="Data log & freshness">
        <Feature
          id="datalog-card"
          name="Data log"
          where="Sidebar “Data log”"
          to="/datalog"
          question="How fresh is the data I'm looking at?"
        >
          <p>
            The refresh history. Each nightly run re-scrapes Steam, rebuilds the analytics, and reloads the app; this log
            shows what each run added (games, reviews, player updates), the mart version, and how long it took. The
            sidebar's health dot is the quick version — hover it for the exact mart version and build timestamp, which is
            the authoritative "data as of" answer.
          </p>
        </Feature>
      </Section>

      <Section id="methodology" kicker="Data & trust" title="Methodology & data honesty">
        <Card title="Where the data comes from" subtitle="All public, all aggregate — never your personal Steam account.">
          <div className="flex flex-col gap-3 text-sm leading-relaxed text-ink-secondary">
            <Terms
              items={[
                ["Steam storefront", "The public catalog (names, prices, tags, genres, release dates, header art, short descriptions) and player reviews. Review counts are reconciled against Steam's own numbers for ground truth where possible."],
                ["SteamSpy", "Owner-range estimates. These got noisier after Steam changed its default profile privacy in 2018 — which is exactly why Prospect treats owners as a range and leans on review-based estimates."],
                ["Games press", "Article metadata (headline, byline, date, outlet) from a set of tracked outlets — PC Gamer, IGN, Eurogamer, GamesIndustry.biz, Game Developer, and others — matched to games by title. Prospect links to the original article and never reproduces its body text."],
              ]}
            />
            <p className="text-xs text-ink-muted">
              Roughly: the full Steam catalog (~142K apps), a few million sampled reviews, and ~1.1M press articles —
              rebuilt nightly. The exact size and build date for your session are in the sidebar health dot and the{" "}
              <a href="#datalog" className="text-brand hover:underline">Data log</a>.
            </p>
          </div>
        </Card>

        <Card title="The Opportunity score">
          <div className="flex flex-col gap-3 text-sm leading-relaxed text-ink-secondary">
            <p>
              Every niche gets three 0–100 <span className="text-ink-primary">percentile</span> scores, ranked against
              all other niches in the same cut, then blended:
            </p>
            <Terms
              items={[
                ["Demand", "0.4 × (median revenue) + 0.3 × (median owners) + 0.3 × (recent 24-month review velocity). Higher = a bigger, hotter market."],
                ["Competition", "0.6 × (count of recent releases) + 0.4 × (winner concentration — how much of the niche's revenue the top few games hold). Higher = more crowded / winner-take-most, which is bad for a new entrant."],
                ["Quality gap", "The share of incumbents that are weak — rating under 80% OR fewer than 50 reviews. Higher = easier to out-execute the field."],
                ["Opportunity", "clamp( 0.5 × Demand − 0.35 × Competition + 0.3 × Quality gap, 0, 100 )."],
              ]}
            />
            <p>
              Scores are computed at four cuts — window (all-time / last 24 months) × review floor (10 / 50) — and a
              niche needs at least 30 qualifying games to be scored at all. Because the parts are percentiles,{" "}
              <span className="text-ink-primary">Opportunity is a relative ranking</span>, not an absolute grade: an 80
              means "better than most niches on this blend," not "80% likely to succeed." That's why the app always
              shows the three parts, never just the blend.
            </p>
          </div>
        </Card>

        <Card title="Revenue & owners estimates — and their error bars">
          <div className="flex flex-col gap-3 text-sm leading-relaxed text-ink-secondary">
            <p>
              The revenue figure used across the app is{" "}
              <span className="text-ink-primary">estimated owners × launch price</span> = gross lifetime box revenue
              (not net-of-Steam's-cut, not first-year-only). Owners come from the{" "}
              <span className="text-ink-primary">Boxleiter method</span>: reviews are a small, roughly-consistent
              fraction of owners, so owners ≈ reviews × a multiplier of about{" "}
              <span className="text-ink-primary">20–55</span>, fitted per genre (mid ≈ 30) and clamped to that band.
            </p>
            <p>
              In the Estimator, the reviews path gives owners = reviews × (20 / genre-mid / 55) for low/mid/high; net =
              gross × ~70% (after Steam's ~30% cut). The wishlist path is rougher: owners = wishlists × ~8–12%
              first-week conversion × 5 (first-week → first-year).
            </p>
            <ReadBox label="How wide are the bars?">
              The low↔high span comes from the 20–55 owners-per-review band — roughly a <span className="text-ink-primary">2–3×</span>{" "}
              spread. This is an order-of-magnitude planning input, not a forecast. Treat "mid" as a center of gravity
              and always keep the range in view.
            </ReadBox>
          </div>
        </Card>

        <Card title="Honest limitations">
          <ul className="flex flex-col gap-2 text-sm leading-relaxed text-ink-secondary">
            {[
              <>
                <span className="font-semibold text-ink-primary">Estimates, not truth.</span> Owners and revenue are
                modeled, not reported. Different tools use different multipliers and will disagree — that's expected.
              </>,
              <>
                <span className="font-semibold text-ink-primary">Reviews & press are samples.</span> Review-based
                signals (velocity, timelines, teardown aspects) come from a sample that's recency-biased toward
                older/popular titles; press is a fuzzy-matched, confidence-filtered corpus that skews to the last ~year
                and to English/Western outlets, and excludes Steam News. Counts describe the sample, not Steam's true
                totals.
              </>,
              <>
                <span className="font-semibold text-ink-primary">Correlational, not causal.</span> Teardowns and any
                press-vs-outcome read are evidence toward an explanation, never proof — marketing, timing and luck are
                unmeasured here.
              </>,
              <>
                <span className="font-semibold text-ink-primary">Freshness.</span> The catalog rebuilds nightly, but a
                brand-new release lags until SteamSpy and the review scrape catch up (Prospect flags when a count is an
                honest lower bound). Trust the health dot's build date over your memory.
              </>,
              <>
                <span className="font-semibold text-ink-primary">Tags vs. genres.</span> Genre is Steam's small, fixed,
                exact-match field (a game's primary genre is used); tags are the larger community vocabulary — more
                specific and better for niche-finding, but case- and hyphenation-sensitive. Non-descriptive tags like
                "early access" or "video game" are filtered out of the niche vocabulary on purpose. Release dates come
                from Steam and, for Early Access titles, generally reflect the Early Access launch rather than the 1.0
                date.
              </>,
            ].map((li, i) => (
              <li key={i} className="flex gap-2">
                <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-brand" />
                <span>{li}</span>
              </li>
            ))}
          </ul>
        </Card>
      </Section>

      {/* ============================ FAQ ============================ */}
      <Section id="faq" kicker="Data & trust" title="FAQ & support">
        <Card>
          <div className="flex flex-col divide-y divide-chartborder/60">
            {[
              [
                "Is Prospect affiliated with Valve or Steam?",
                "No. Prospect is an independent, third-party research tool built on publicly available data. “Steam” is a trademark of Valve Corporation, referenced only to describe the platform.",
              ],
              [
                "Are the revenue estimates guaranteed?",
                "No — they're statistical estimates, always shown as a range. Treat them as a planning input, not a promise.",
              ],
              [
                "Why do Prospect's numbers differ from other tools?",
                "Different tools use different owner multipliers and review sources. Prospect fits its Boxleiter multiplier per genre and prefers Steam's ground-truth review counts where available — the Estimator's “How this was calculated” panel shows the exact inputs for any estimate.",
              ],
              [
                "Can I export data?",
                "Yes — CSV export is available from the Niche Finder. Bulk raw exports of the underlying catalog aren't offered.",
              ],
              [
                "Does Prospect track my personal Steam account?",
                "No. Prospect never connects to your Steam profile or library — it only uses public, aggregate data.",
              ],
              [
                "How current is what I'm seeing?",
                "The data rebuilds nightly. The sidebar health dot (and the Data log) show the exact mart version and build timestamp — that's the authoritative “data as of.”",
              ],
            ].map(([q, a], i) => (
              <div key={i} className="py-3 first:pt-0 last:pb-0">
                <div className="text-sm font-semibold text-ink-primary">{q}</div>
                <p className="mt-1 text-sm leading-relaxed text-ink-secondary">{a}</p>
              </div>
            ))}
          </div>
        </Card>
        <p className="text-center text-xs text-ink-muted">
          Prospect is early and solo-run — if a number looks wrong, note the mart version from the sidebar health dot so
          it can be reproduced.
        </p>
      </Section>
    </div>
  );
}

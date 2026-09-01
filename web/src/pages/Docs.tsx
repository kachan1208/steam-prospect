import type { ReactNode } from "react";
import { Link } from "react-router-dom";

import { Card } from "../components/ui/Card";
import { CSS_VAR } from "../lib/palette";
import { usePageTitle } from "../lib/usePageTitle";

// The live deployment. The MCP server is served from the same origin at /mcp/.
// Derived, not hardcoded — a domain move must not silently break every copy-paste snippet.
const APP_URL = window.location.origin;
const MCP_URL = `${window.location.origin}/mcp/`;

// ---- figures that have to be kept in sync by hand --------------------------------------
// Everything below is a number this page STATES rather than fetches. Each one carries where
// it comes from, so the next person can re-derive it instead of trusting the prose. This page
// drifted badly once already (it claimed 15 tools while the server had 25, and a ~142K catalog
// while the mart held ~175K) — that is what these comments exist to prevent.

// KEEP IN SYNC with mcp/prospect_mcp.py — the number of @mcp.tool() decorators in that file.
// Verify with: grep -c '@mcp.tool()' mcp/prospect_mcp.py
// Cross-check against the deployed server: tools/list over POST {origin}/mcp/.
// The same constant is stated on /chat (web/src/pages/Chat.tsx) — change both together.
const MCP_TOOL_COUNT = 25;

// Corpus size and freshness. Source: GET /api/refresh/history (the Data log's own feed) for
// the mart build these were read from. Deliberately stated as "as of <mart>" rather than as a
// bare number, so a stale figure is visibly stale instead of quietly wrong. Re-read with:
//   curl -s {origin}/api/refresh/history?limit=1
//   curl -s {origin}/api/games/search?limit=1   (the `total` = games searchable in mart_game)
const CORPUS_AS_OF = "mart 20260831";
const CORPUS_GAMES = "~175K";        // 174,705 scraped apps / 174,265 searchable in mart_game
const CORPUS_REVIEWS = "~52M";       // 51,965,530 sampled reviews
const CORPUS_ARTICLES = "~1.1M";     // 1,128,930 press articles
const CORPUS_OUTLETS = 6;            // distinct `source` values in the press corpus

// The build the worked example in #opportunity-score was read from. Stamped next to the
// numbers so a stale example announces itself instead of reading as current.
const EXAMPLE_AS_OF = "mart 20260831 (1 Sep 2026)";

// ---- small building blocks --------------------------------------------------------------

/** A top-level section anchor + heading. `scroll-mt` keeps the heading clear of the sticky
 *  app header (56px) when you jump to it from the table of contents. */
function Section({ id, kicker, title, children }: { id: string; kicker?: string; title: string; children: ReactNode }) {
  return (
    <section id={id} className="flex scroll-mt-20 flex-col gap-3">
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
    <section id={id} className="scroll-mt-20">
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

// ---- score infographic building blocks ---------------------------------------------------
// The score guide is deliberately visual-first: the formula as a flow of weighted blocks,
// the worked example as signed contribution bars — prose demoted to captions.

// The four terms mart_niche blends into opportunity_v2, in weight order. These ARE the
// Radar board's axes read on the Radar board's thresholds (see web/src/lib/radarVerdict.ts's
// "ONE MODEL, TWO VIEWS" block) — which is why the score and the ring agree on direction.
// Note what is NOT in this list: the supply brake. It is a multiplier, not a blended term,
// and it reads supply as a different question than the ring does (relative to demand, plus
// entrant economics) — they contradict on 28.0% of the default cut, deliberately.
// All four share CSS_VAR.demand deliberately, per palette.ts's two-tone rule: colour
// encodes POLARITY, not identity, and after the rebuild every blended term is positive
// (higher = better for the score). Crowding no longer arrives as a negative bar — it
// arrives as the supply brake, which is the only "downside" mark here and carries the
// muted paper tone. Labels tell the four apart; the tone tells you which way they push.
const SCORE_PARTS = [
  { key: "momentum", label: "Momentum", weight: "0.40×", color: CSS_VAR.demand, hint: "is demand growing (50 = flat, 88 = the radar's “enter” bar)" },
  { key: "market", label: "Market pull", weight: "0.22×", color: CSS_VAR.demand, hint: "what the typical game earns × how big the pie is" },
  { key: "spread", label: "Revenue spread", weight: "0.20×", color: CSS_VAR.demand, hint: "50 = winner-take-most; higher = money spread around" },
  { key: "quality", label: "Quality gap", weight: "0.18×", color: CSS_VAR.demand, hint: "how beatable the field is" },
];

function FormulaFlow() {
  return (
    <div className="flex flex-wrap items-stretch gap-2">
      {SCORE_PARTS.map((p, i) => (
        <div key={p.key} className="flex items-center gap-2">
          {i > 0 && <span aria-hidden className="text-lg text-ink-muted">+</span>}
          <div className="rounded-card border border-chartborder bg-surface px-3 py-2 text-center">
            <div className="flex items-center justify-center gap-1.5">
              <span className="h-2 w-2 rounded-full" style={{ backgroundColor: p.color }} />
              <span className="text-xs font-semibold text-ink-primary">{p.label}</span>
            </div>
            <div className="tabular mt-0.5 text-[11px] font-semibold" style={{ color: p.color }}>
              {p.weight} <span className="text-ink-muted">(0–100)</span>
            </div>
            <div className="mt-0.5 max-w-[13rem] text-[10px] text-ink-muted">{p.hint}</div>
          </div>
        </div>
      ))}
      <span aria-hidden className="self-center text-lg text-ink-muted">×</span>
      <div className="self-center rounded-card border border-chartborder bg-surface2/60 px-3 py-2 text-center">
        <div className="flex items-center justify-center gap-1.5">
          <span className="h-2 w-2 rounded-full" style={{ backgroundColor: CSS_VAR.competition }} />
          <span className="text-xs font-semibold text-ink-primary">supply brake 0.35–1.0</span>
        </div>
        <div className="mt-0.5 max-w-[15rem] text-[10px] text-ink-muted">
          bites when releases outgrow demand, or newcomers earn under the catalog norm — either one alone can sink
          the score
        </div>
      </div>
      <span aria-hidden className="self-center text-lg text-ink-muted">=</span>
      <div className="self-center rounded-card border border-brand bg-brand-tint px-3 py-2 text-center">
        <div className="text-xs font-semibold text-brand">Opportunity v2</div>
      </div>
    </div>
  );
}

/** One niche's score, decomposed into its four weighted sub-score contributions plus the
 * supply brake. Bar length is contribution / SCALE, so the two example cards are directly
 * comparable at a glance. All four terms are positive by construction — crowding no longer
 * arrives as a negative term, it arrives as the multiplier at the bottom. */
function ScoreWaterfall({
  name,
  momentum,
  market,
  spread,
  quality,
  brake,
  final,
  note,
}: {
  name: string;
  momentum: number;
  market: number;
  spread: number;
  quality: number;
  brake: number;
  final: number;
  note: string;
}) {
  // One tone for all four: see SCORE_PARTS — colour is polarity, and every blended term
  // now pushes the same way. The brake, printed below, is the downside mark.
  const parts = [
    { label: "Momentum", v: 0.4 * momentum, detail: `0.40 × ${momentum.toFixed(1)}`, color: CSS_VAR.demand },
    { label: "Market pull", v: 0.22 * market, detail: `0.22 × ${market.toFixed(1)}`, color: CSS_VAR.demand },
    { label: "Revenue spread", v: 0.2 * spread, detail: `0.20 × ${spread.toFixed(1)}`, color: CSS_VAR.demand },
    { label: "Quality gap", v: 0.18 * quality, detail: `0.18 × ${quality.toFixed(1)}`, color: CSS_VAR.demand },
  ];
  const core = parts.reduce((a, p) => a + p.v, 0);
  const SCALE = 40; // max contribution the full width represents
  return (
    <div className="flex-1 rounded-card border border-chartborder bg-surface p-3">
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <span className="text-sm font-semibold text-ink-primary">{name}</span>
        <span className="tabular text-lg font-bold text-ink-primary">{final.toFixed(1)}</span>
      </div>
      <div className="flex flex-col gap-1.5">
        {parts.map((p) => (
          <div key={p.label} className="flex items-center gap-2">
            <span className="w-24 shrink-0 text-[10px] text-ink-muted">{p.label}</span>
            <div className="relative h-3.5 flex-1 overflow-hidden rounded bg-surface2">
              <span
                className="absolute inset-y-0.5 left-0 rounded-sm"
                style={{ width: `${Math.min(100, (p.v / SCALE) * 100)}%`, backgroundColor: p.color }}
              />
            </div>
            <span className="tabular w-24 shrink-0 text-right text-[10px] text-ink-secondary">
              {p.detail} = {p.v.toFixed(1)}
            </span>
          </div>
        ))}
      </div>
      <div className="tabular mt-2 border-t border-chartborder pt-1.5 text-right text-[11px] text-ink-secondary">
        core {core.toFixed(1)} → × supply brake {brake.toFixed(2)} ={" "}
        <span className="font-semibold text-ink-primary">{final.toFixed(1)}</span>
      </div>
      <div className="mt-1 text-[10px] leading-snug text-ink-muted">{note}</div>
    </div>
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
      ["radar", "Radar"],
      ["niches", "Niche Finder"],
      ["opportunity-score", "Reading the Opportunity score"],
      ["games", "Games & teardown"],
      ["studios", "Studios"],
      ["timing", "Launch & Timing"],
      ["watchlist", "Watchlist"],
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
  usePageTitle("Docs");
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
              {APP_URL.replace(/^https?:\/\//, "")}
            </a>
          </span>
          <span aria-hidden>·</span>
          <span>Data refreshes nightly</span>
          <span aria-hidden>·</span>
          <span>The footer health dot shows the exact "data as of" build</span>
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
            <p className="text-ink-secondary">
              Prospect is six screens plus a connector. The screens are the things worth looking at — charts you
              read rather than numbers you quote. Everything else is answered by asking, through the MCP:
            </p>
            <Terms
              items={[
                [
                  "Radar",
                  <>
                    The landing screen (<Code>/</Code> redirects here). Every niche plotted on the board's verdict
                    quadrants for the last 24 months — the fastest read on where the openings are, and the way into
                    the Niche Finder.
                  </>,
                ],
                [
                  "Niche Finder",
                  <>What should I build — which niches reward a new entrant, and which only look open?</>,
                ],
                [
                  "Games & teardown",
                  <>Where does a specific title stand, and — from its own reviews — why does it win versus genre peers?</>,
                ],
                [
                  "Studios",
                  <>Who ships games like mine — which developers and publishers, with what track record?</>,
                ],
                [
                  "Launch & Timing",
                  <>When should I launch, and is my genre a launch-splash or a slow-burn?</>,
                ],
                [
                  "Watchlist",
                  <>
                    Niches and games you saved, with alert rules that are evaluated live against current data (not by
                    a nightly job). Prospect keeps no change history — you see the current value, not a diff.
                  </>,
                ],
                [
                  "MCP",
                  <>
                    Connect Prospect to your own Claude and ask in plain language. This is where the rest of the
                    analysis lives: <Code>find_niches</Code> (what should I build), <Code>market_benchmarks</Code>{" "}
                    (is this number good), <Code>estimate_revenue</Code> (owners/revenue range for N reviews at
                    price P), <Code>press_pitch_list</Code> and <Code>publisher_pitch_list</Code> (who to pitch) —
                    {" "}{MCP_TOOL_COUNT} tools over the same marts these screens read.
                  </>,
                ],
                [
                  "Data log",
                  <>
                    What changed in the data, and when it last refreshed. Reached from the{" "}
                    <span className="text-ink-primary">footer</span>, not the header nav.
                  </>,
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
                <span className="font-semibold text-ink-primary">Connect Prospect to your Claude.</span> Follow{" "}
                <Link to="/chat" className="font-medium text-brand hover:underline">MCP</Link> — one command.
                The next two steps happen there, in plain language.
              </>,
              <>
                <span className="font-semibold text-ink-primary">Find a niche.</span> Ask{" "}
                <em>"what are the best under-served Steam niches right now?"</em> — that runs{" "}
                <Code>find_niches</Code>, ranking every tag and genre by opportunity (demand vs. competition vs. how
                beatable the incumbents look). Follow up on any one of them for its saturation trend, revenue
                histogram and top games.
              </>,
              <>
                <span className="font-semibold text-ink-primary">Price the payoff.</span> Ask what a game with that
                niche's median review count would earn at your price — <Code>estimate_revenue</Code> returns an
                owners and revenue <em>range</em>, never a single fake-precise number.
              </>,
              <>
                <span className="font-semibold text-ink-primary">Study a hit.</span> Search a comparable game in{" "}
                <Link to="/games" className="font-medium text-brand hover:underline">Games</Link>, open it, and read{" "}
                <span className="text-ink-primary">What reviews praise / pan</span> — what its own players praise,
                measured against genre peers. Flip the page's{" "}
                <span className="text-ink-primary">Simple / Detailed</span> control to Detailed for the charts and the
                press footprint.
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
      <Section id="radar" kicker="The core" title="Radar">
        <Feature
          id="radar-card"
          name="Niche radar"
          where="Header nav “Radar” — also the landing screen"
          to="/radar"
          question="Where are the openings right now, at a glance?"
        >
          <p>
            The board every session starts on: <Code>/</Code> redirects here. Every scored niche is plotted on the
            last-24-months cut into <span className="text-ink-primary">verdict quadrants</span>, so the shape of the
            market reads before any number does. Filter by class, restrict to{" "}
            <span className="text-ink-primary">solo-friendly</span> niches, or cap the board to the top N. Click a
            quadrant to zoom it; <span className="text-ink-primary">Open Niche Finder →</span> takes the same cut into
            the sortable table.
          </p>
          {/* The old copy here read "the same evidence, on the same thresholds ... it is why the
              board and the score can't disagree about direction". The first half is true of the
              demand and concentration bars; the claim about supply was false and measurably so —
              59 of 211 comparable niches on this cut (28.0%) contradict. Rewritten 2026-09-01
              rather than changing either model: both readings were measured, both are correct for
              their own job, and swapping either was rejected (see radarVerdict.ts's ONE MODEL,
              TWO VIEWS block for the full measurement). No published number moved with this copy. */}
          <ReadBox>
            The radar and the <span className="text-ink-primary">Opportunity score</span> below share their demand
            and concentration bars — the same <span className="text-ink-primary">+40%/24m</span> growth line and the
            same <span className="text-ink-primary">0.85</span> winner-take-most line, pinned by a test so they
            cannot drift — and the direction ordering does hold: median score falls ring by ring, enter › watch ›
            crowded › declining, on every cut the mart builds.{" "}
            <span className="text-ink-primary">Supply is deliberately not shared.</span>{" "}
            The ring asks “how fast is the release pipeline growing” — absolute, the +15%/yr line drawn across the
            board. The score asks “is the pipeline outgrowing <em>demand</em>”, and brakes further on how recent
            entrants actually earn. On roughly a quarter of the board those two reads disagree: a niche can ring
            “pipeline calm” and still be braked, or ring “flooding” and take no brake at all. That is the design, not
            a defect — a new entrant ships into the whole pipeline, while the score has to refuse to call a niche
            open just because everyone left it. The radar is the picture; the finder is the ranking; the niche
            deep-dive is the argument against both.
          </ReadBox>
        </Feature>
      </Section>

      <Section id="niches" kicker="The core" title="Niche Finder">
        <Feature
          id="niches-card"
          name="Niche Finder"
          where="From Radar → “Open Niche Finder →” (not in the header nav)"
          to="/niches"
          question="What should I build — which niches reward a new entrant, and which only look open?"
        >
          <p>
            Ranks every Steam community tag and genre by the{" "}
            <span className="text-ink-primary">Opportunity score</span> (explained in full below), alongside the
            evidence you should check before believing it: how many games compete there, what the successful ones earn
            (P90 revenue), how big the total audience is (owners), <span className="text-ink-primary">who is actually
            playing right now</span> (live concurrent players, updated nightly, with a 7-day trend), and whether the
            release pipeline is growing or shrinking. Click any niche for the deep dive, in the order the page actually
            presents it: the stat tiles, demand-vs-pipeline by year, the score breakdown (headed{" "}
            <span className="text-ink-primary">“Why”</span> plus that niche's score), the niche's top games, and then
            the <span className="text-ink-primary">“Read this first”</span> flags that argue against the score.
            Switching that page to <span className="text-ink-primary">Detailed</span> adds live-player history, revenue
            spread, hit rates, the saturation trend, what players praise and complain about, press coverage, the
            revenue and price distributions, and the full games table.
          </p>
          <ReadBox>
            Defaults are opinionated on purpose: the <span className="text-ink-primary">last-24-months</span> window
            (the market a new entrant actually faces, not all of Steam history), a{" "}
            <span className="text-ink-primary">≥50-review floor</span> (enough of a track record to estimate from), and
            only <span className="text-ink-primary">buildable tiers</span> (micro-genres and themes — “Open World” is a
            container, not a plan). Window and floor are the two controls at the top; between them they select the six
            cuts the mart materialises. Every column header has a ⓘ hover explaining how to read it.
          </ReadBox>
        </Feature>
      </Section>

      <Section id="opportunity-score" kicker="The core" title="Reading the Opportunity score">
        <Card>
          <div className="flex flex-col gap-4 text-sm leading-relaxed text-ink-secondary">
            {/* Same correction as the Radar ReadBox above: momentum and revenue_spread really are
                anchored on the ring's own bars, but the supply BRAKE is a different question and
                contradicts the ring on
                28.0% of the default cut (9/222 ring "flooding" with no brake; 43/222 ring "calm"
                and brake below x0.80, 15 of those on entrant_ratio alone). Say so here, where the
                brake is being explained, instead of promising an agreement that does not exist. */}
            <p className="text-xs text-ink-muted">
              Four 0–100 sub-scores, blended with fixed weights, then multiplied by the supply brake. The two blended
              terms that have a <span className="text-ink-primary">Radar ring</span> counterpart read its exact bars
              — +40%/24m for demand, 0.85 for winner-take-most — so a high score does mean “the radar would tell you
              to enter”, and the ring ordering holds. The <span className="text-ink-primary">brake</span> is where they
              part company on purpose: the ring flags a pipeline growing more than +15%/yr, full stop, while the
              brake flags a pipeline outgrowing <em>demand</em> by that much and then brakes again if recent entrants
              earn below the niche median (a tell that never moves a ring). So a calm ring can sit beside a heavily
              braked score, and about a quarter of the board does. Hover any ⓘ in the finder for the same math with
              that row's real numbers.
            </p>
            <FormulaFlow />
            <div>
              <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-muted">
                Why a well-off niche can still score badly — a worked example
              </div>
              {/* SNAPSHOT, NOT A LIVE READ. Every number in this block was read from the
                  production API at the stated cut and mart version:
                    GET /api/niches/tag/Colony%20Sim?window=24m&min_reviews=50
                    GET /api/niches/tag/Action%20RTS?window=24m&min_reviews=50
                  Nightly rebuilds move these. The as-of line below is not decoration — it is
                  what makes a stale example visibly stale rather than quietly wrong, which is
                  exactly how the previous figures (86.7 / 57.2 / 86.5, "$150K vs $124K") survived
                  well past the rebuild that changed them. If you refresh the numbers, refresh the
                  stamp in the same commit. */}
              <p className="mb-2 text-[11px] text-ink-muted">
                A snapshot of two real niches, read from the{" "}
                <span className="text-ink-primary">last 24 months · ≥50 reviews</span> cut as of{" "}
                <span className="text-ink-primary">{EXAMPLE_AS_OF}</span> — open either niche today and the numbers
                will have moved; the shape of the argument is the durable part.
              </p>
              <div className="flex flex-col gap-3 sm:flex-row">
                <ScoreWaterfall
                  name="Colony Sim"
                  momentum={38.92}
                  market={73.7}
                  spread={100}
                  quality={89.25}
                  brake={0.35}
                  final={23.75}
                  note="Demand −7% / 24m while releases grew +37% YoY — the pipeline is filling faster than the audience."
                />
                <ScoreWaterfall
                  name="Action RTS"
                  momentum={96.36}
                  market={58.6}
                  spread={100}
                  quality={87.16}
                  brake={1.0}
                  final={87.12}
                  note="Demand +74% / 24m while releases fell −7% YoY — growing audience, thinning competition."
                />
              </div>
              <p className="mt-2 text-xs text-ink-muted">
                Colony Sim wins on <span className="text-ink-primary">nearly every static measure</span> — its typical
                game earns more ($145K vs $124K), its revenue is just as spread out, its field is a shade more
                beatable. It still scores a quarter as much, because{" "}
                <span className="font-semibold text-ink-primary">a market being flooded faster than it grows is a
                worse place to start a 2-year build than a smaller one that's pulling away.</span>{" "}
                Momentum and the supply brake carry that; the money terms deliberately can't outvote them.
              </p>
            </div>
            <ReadBox>
              A high score is a <span className="text-ink-primary">screening result, not a verdict</span> — open the
              deep dive and let the “Read this first” flags argue with it (shrinking pipeline, underearning newcomers,
              winner-take-most, multiplayer dependence). A low score doesn't forbid building there; it says the bet
              needs a reason the median doesn't apply to you.
            </ReadBox>
          </div>
        </Card>
      </Section>

      <Section id="timing" kicker="The core" title="Launch & Timing">
        <Feature
          id="timing-card"
          name="Launch & Timing"
          where="Header nav “Timing”"
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

      <Section id="games" kicker="The core" title="Games & the review teardown">
        <Feature
          id="games-card"
          name="Games (search)"
          where="Header nav “Games”"
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
          name="Game profile & the review teardown"
          where="Click any game in search"
          question="How big is this game, and what makes it stand out?"
        >
          <p>
            A game profile is one page with a <span className="text-ink-primary">Simple / Detailed</span> control
            part-way down — not tabs. <span className="text-ink-primary">Simple</span> keeps the decision-critical
            reads: the estimated revenue range, owners, reviews, rating and live players; review velocity since launch;
            price history; the niches the game belongs to; and{" "}
            <span className="text-ink-primary">What reviews praise / pan</span>, the teardown.{" "}
            <span className="text-ink-primary">Detailed</span> adds the{" "}
            <span className="text-ink-primary">percentile-vs-genre</span> read (where it ranks among genre peers on
            revenue, reviews and owners), review and momentum timelines, its genre's launch shape and channel mix, a
            language split, playtime, a <span className="text-ink-primary">comparables</span> table ranked by tag
            overlap, and the press footprint.
          </p>
          <p>
            The teardown mines the game's own reviews into ten fixed aspects (Combat, World & Exploration, Art, Music,
            Story, Difficulty, Controls, Navigation, Content & Length, Price & Value) and shows, per aspect, whether
            players praise it <em>more than the genre baseline</em>. Sentiment is read from the review text around each
            aspect keyword by a classifier trained on game reviews, so a thumbs-up review that pans one aspect counts
            as negative for that aspect — the overall thumbs-up/down split is shown underneath for comparison. Every
            row opens to the actual review excerpts behind it.
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

      <Section id="studios" kicker="The core" title="Studios">
        <Feature
          id="studios-card"
          name="Studios"
          where="Header nav “Studios”"
          to="/studios"
          question="Who ships games like mine, and what's their track record?"
        >
          <p>
            Browse or search developer and publisher track records — release count, career and median est. revenue,
            hit rate, and whether they're still shipping — then open any studio for its full release trajectory. Built
            for publisher scouting: filter to publishers, find who's active in your genres, and judge them by what
            their releases actually did.
          </p>
          <ReadBox>
            Studio names are self-reported Steam credit strings, so the same company can appear under several
            spellings, and every revenue figure is a review-based estimate — read the numbers as directional, not as a
            registry.
          </ReadBox>
        </Feature>
      </Section>

      <Section id="watchlist" kicker="The core" title="Watchlist">
        <Feature
          id="watchlist-card"
          name="Watchlist"
          where="Header nav “Watchlist”"
          to="/watchlist"
          question="Which niches and games am I tracking, and has anything crossed a line I care about?"
        >
          <p>
            Save any niche or game and give it an <span className="text-ink-primary">alert rule</span> — a metric, a
            direction and a threshold. Rules are evaluated <span className="text-ink-primary">live against the current
            data</span> whenever you open the page, not by a nightly job that emails you, so an alert is a statement
            about the mart you are looking at right now.
          </p>
          <ReadBox>
            Prospect keeps <span className="text-ink-primary">no per-item change history</span> — the page shows the
            current value of the metric you're watching, not a diff against last week. If you need the trajectory,
            open the niche or game itself. The list is stored in your browser, so it doesn't follow you to another
            device.
          </ReadBox>
        </Feature>
      </Section>

      <Section id="mcp" kicker="Connect" title="Use Prospect inside your own Claude">
        <Card>
          <div className="flex flex-col gap-4 text-sm leading-relaxed text-ink-secondary">
            <p>
              Prospect exposes its analytics as an <span className="font-semibold text-ink-primary">MCP server</span> —
              a standard way to plug a data source into an AI assistant. Connect it to your own Claude (Desktop, Code, or
              claude.ai) and ask market questions in plain language; the answers come straight from Prospect's Steam
              data, running on your Claude. It's read-only, needs no API key, and there's nothing to install on
              Prospect's side. (The in-app{" "}
              <Link to="/chat" className="font-medium text-brand hover:underline">MCP</Link> page has the same
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

            {/* The tool names below are the @mcp.tool() function names in mcp/prospect_mcp.py,
                verbatim and in full — a list is far more likely to stay honest than a prose
                summary, because a missing name is obvious next to a count. This list previously
                claimed 15 and included `creator_pitch_list`, a tool the server has never
                defined. See MCP_TOOL_COUNT at the top of this file for how to re-verify. */}
            <ReadBox label="Good to know">
              Prospect exposes{" "}
              <span className="text-ink-primary">{MCP_TOOL_COUNT} read-only analytics tools</span> plus a{" "}
              <span className="text-ink-primary">data-dictionary resource</span>:{" "}
              <Code>find_niches</Code>, <Code>niche_detail</Code>, <Code>niche_player_history</Code>,{" "}
              <Code>niche_review_themes</Code>, <Code>tag_combos</Code>, <Code>tag_suggest</Code>,{" "}
              <Code>market_benchmarks</Code>, <Code>revenue_distribution</Code>, <Code>estimate_revenue</Code>,{" "}
              <Code>launch_shape</Code>, <Code>best_launch_timing</Code>, <Code>lifetime_curve</Code>,{" "}
              <Code>game_search</Code>, <Code>game_profile</Code>, <Code>game_teardown</Code>,{" "}
              <Code>game_reviews_summary</Code>, <Code>game_player_history</Code>, <Code>aspect_reviews</Code>,{" "}
              <Code>find_comparables</Code>, <Code>entity_profile</Code>, <Code>publisher_pitch_list</Code>,{" "}
              <Code>press_pitch_list</Code>, <Code>buzz_trends</Code>, <Code>channel_mix</Code> and{" "}
              <Code>channel_buzz</Code>. Ask Claude to read the data dictionary first, so it uses the same definitions
              of opportunity / demand / competition / quality-gap that this guide does.
            </ReadBox>
          </div>
        </Card>
      </Section>

      {/* ============================ DATA & TRUST ============================ */}
      <Section id="datalog" kicker="Data & trust" title="Data log & freshness">
        <Feature
          id="datalog-card"
          name="Data log"
          where="Footer link “Data log”"
          to="/datalog"
          question="How fresh is the data I'm looking at?"
        >
          <p>
            The refresh history. Each nightly run re-scrapes Steam, rebuilds the analytics, and reloads the app; this log
            shows what each run added (games, reviews, player updates), the mart version, and how long it took. The
            footer's health dot is the quick version — hover it for the exact mart version and build timestamp, which is
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
                ["Games press", `Article metadata (headline, byline, date, outlet) from ${CORPUS_OUTLETS} tracked outlets — Eurogamer, GamesIndustry.biz, PC Gamer, IGN, Game Developer and DOU Gamedev — matched to games by title. Prospect links to the original article and never reproduces its body text.`],
              ]}
            />
            {/* Numbers come from the constants at the top of this file; see the provenance
                comment there for how to re-read them. Stated with an explicit as-of because
                the previous version of this line claimed ~142K apps against a ~175K mart. */}
            <p className="text-xs text-ink-muted">
              Roughly, as of <span className="text-ink-primary">{CORPUS_AS_OF}</span>: the full Steam catalog
              ({CORPUS_GAMES} apps), {CORPUS_REVIEWS} sampled reviews, and {CORPUS_ARTICLES} press articles — rebuilt
              nightly, and growing. Don't quote these; the exact size and build date for your session are in the footer
              health dot and the <a href="#datalog" className="text-brand hover:underline">Data log</a>, which is the
              authoritative answer.
            </p>
          </div>
        </Card>

        {/* The score the app actually ranks by. This card documented the RETIRED v1 blend
            (0.5·Demand − 0.35·Competition + 0.3·Quality gap over three percentile scores) for
            some time after the rebuild, while #opportunity-score above described the current
            model — two mutually exclusive formulas on one page. Weights below are mirrored from
            etl/build_marts.py (W2_MOMENTUM/W2_MARKET/W2_SPREAD/W2_QUALITY, SUPPLY_BRAKE_FLOOR,
            MIN_NICHE_GAMES); the assembly is etl/marts/mart_niche.sql's `scored_v2` CTE. If you
            change a weight there, change it here AND in SCORE_PARTS at the top of this file. */}
        <Card title="The Opportunity score">
          <div className="flex flex-col gap-3 text-sm leading-relaxed text-ink-secondary">
            <p>
              The headline score is <Code>opportunity_v2</Code>. Every niche gets four{" "}
              <span className="text-ink-primary">0–100 sub-scores</span> — absolute readings against fixed
              thresholds, not percentile ranks against other niches — which are blended with fixed weights and then
              multiplied by a supply brake. This is the same model the{" "}
              <a href="#opportunity-score" className="text-brand hover:underline">score guide above</a> draws:
            </p>
            <Terms
              items={[
                ["Momentum (0.40)", "Demand FLOW: the niche's annualised review-inflow growth, squashed to 0–100 so 50 = flat and 88 = the Radar's “enter” bar. The largest weight, on purpose — a market's direction outranks its current size."],
                ["Market pull (0.22)", "What the typical game there earns, scaled by how big the pie is. The money term."],
                ["Revenue spread (0.20)", "How evenly revenue is shared. 50 = winner-take-most; higher = money reaches more than the top few."],
                ["Quality gap (0.18)", "How beatable the field is — the share of incumbents weak enough to out-execute."],
                ["Supply brake (×0.35–1.0)", "The only downside term. It bites when releases outgrow demand, or when recent entrants earn under the catalog norm — either alone can sink a score. An unknown supply read is never a penalty: it scores 1.0."],
                ["Opportunity v2", "clamp( (0.40 × Momentum + 0.22 × Market pull + 0.20 × Revenue spread + 0.18 × Quality gap) × Supply brake, 0, 100 ). A sub-score that can't be computed drops out of both the numerator and the weight total, so a missing part never reads as a zero."],
              ]}
            />
            <p>
              Scores are computed at <span className="text-ink-primary">six cuts</span> — window (all-time / last 24
              months) × review floor (no floor / ≥50 / ≥100) — and a niche needs at least 30 qualifying games in a cut
              to be scored at all. A score is an{" "}
              <span className="text-ink-primary">absolute reading, but a screening one</span>: an 85 means "this niche
              clears the bars the Radar draws," not "85% likely to succeed." That's why the app always shows the
              parts, never just the blend.
            </p>
            <ReadBox label="Columns that are evidence, not score inputs">
              The finder still serves the older <Code>demand</Code>, <Code>competition</Code>,{" "}
              <Code>quality_gap</Code> and <Code>opportunity</Code> columns, plus{" "}
              <Code>decline_gate</Code>. These are kept because they are useful to inspect and to argue with —{" "}
              <span className="text-ink-primary">none of them multiplies or feeds the ranked score</span>.{" "}
              <Code>decline_gate</Code> in particular stopped being a score factor and is now purely a falsification
              tell: a low value is a reason to go and check the saturation trend, not a penalty that has already been
              applied for you.
            </ReadBox>
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
              In estimate_revenue, the reviews path gives owners = reviews × (20 / genre-mid / 55) for low/mid/high; net =
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
                "Different tools use different owner multipliers and review sources. Prospect fits its Boxleiter multiplier per genre and prefers Steam's ground-truth review counts where available — estimate_revenue returns the exact inputs it used alongside every estimate.",
              ],
              [
                "Can I export data?",
                "Ask your Claude — the MCP tools return structured JSON you can save or reshape. Bulk raw exports of the underlying catalog aren't offered.",
              ],
              [
                "Does Prospect track my personal Steam account?",
                "No. Prospect never connects to your Steam profile or library — it only uses public, aggregate data.",
              ],
              [
                "How current is what I'm seeing?",
                "The data rebuilds nightly. The footer health dot (and the Data log) show the exact mart version and build timestamp — that's the authoritative “data as of.”",
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
          Prospect is early and solo-run — if a number looks wrong, note the mart version from the footer health dot so
          it can be reproduced.
        </p>
      </Section>
    </div>
  );
}

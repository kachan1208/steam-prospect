import { Link } from "react-router-dom";

import "./Landing.css";

const BarMark = ({ size = 15, stroke = 2.4 }: { size?: number; stroke?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth={stroke} strokeLinecap="round">
    <path d="M5 19v-6M12 19V6M19 19v-9" />
  </svg>
);

export default function Landing() {
  return (
    <div className="landing">
      <nav>
        <div className="wrap nav-in">
          <Link className="brand" to="/niches">
            <span className="mark">
              <BarMark />
            </span>
            Prospect
          </Link>
          <span className="nav-links">
            <a href="#features">Product</a>
            <a href="#method">Method</a>
            <a href="#data">The data</a>
          </span>
          <span className="nav-cta">
            <Link className="btn btn-quiet" to="/niches">
              Sign in
            </Link>
            <Link className="btn btn-primary" to="/niches">
              Start free →
            </Link>
          </span>
        </div>
      </nav>

      <header className="hero">
        <div className="wrap hero-grid">
          <div>
            <p className="eyebrow reveal">Steam market intelligence · for solo &amp; indie devs</p>
            <h1 className="reveal d1">Build the game the market is actually missing.</h1>
            <p className="lede reveal d1">
              Prospect reads all of Steam — 142,000 games, three million reviews, a million press articles — and turns
              it into the four decisions a solo dev actually has to make: what to build, what it could earn, why the hits
              win, and who to pitch.
            </p>
            <div className="hero-cta reveal d2">
              <Link className="btn btn-primary" to="/niches">
                Start prospecting →
              </Link>
              <a className="btn btn-ghost" href="#method">
                See the method
              </a>
            </div>
            <p className="trust reveal d2">Read-only Steam data · every estimate is a range, never fake precision</p>
          </div>

          <div className="glimpse-stack reveal d2">
            <div className="glimpse">
              <div className="g-head">
                <span className="g-tag">Niche Finder · top opportunity</span>
                <span className="g-chip">tag</span>
              </div>
              <div className="g-row">
                <span className="g-name">Extraction Shooter</span>
                <span className="g-opp">
                  <span className="dot" />
                  <span className="val num">49.7</span>
                  <span className="cap">opp</span>
                </span>
              </div>
              <div className="bar-row">
                <span className="bar-lbl">Demand</span>
                <span className="bar-track">
                  <span className="bar-fill" style={{ width: "99%", background: "#2a78d6" }} />
                </span>
                <span className="bar-val num">99</span>
              </div>
              <div className="bar-row">
                <span className="bar-lbl">Competition</span>
                <span className="bar-track">
                  <span className="bar-fill" style={{ width: "22%", background: "#1baf7a" }} />
                </span>
                <span className="bar-val num">22</span>
              </div>
              <div className="bar-row">
                <span className="bar-lbl">Quality gap</span>
                <span className="bar-track">
                  <span className="bar-fill" style={{ width: "25%", background: "#eda100" }} />
                </span>
                <span className="bar-val num">25</span>
              </div>
              <div className="g-foot">56 games · ~$989K median revenue · 64% clear $200K</div>
            </div>
          </div>
        </div>
      </header>

      <div className="band" id="data">
        <div className="wrap">
          <div className="band-grid">
            <div className="stat">
              <div className="n num">142,053</div>
              <div className="l">games in the catalog, scored &amp; searchable</div>
            </div>
            <div className="stat">
              <div className="n num">3M+</div>
              <div className="l">player reviews mined for sentiment &amp; themes</div>
            </div>
            <div className="stat">
              <div className="n num">1.12M</div>
              <div className="l">press articles behind the pitch lists</div>
            </div>
            <div className="stat">
              <div className="n num">85,000+</div>
              <div className="l">titles reconciled to Steam's own review API</div>
            </div>
          </div>
          <p className="band-note">
            One shared, versioned snapshot — public Steam data, SteamSpy, and a press corpus — rebuilt as it moves.
          </p>
        </div>
      </div>

      <section className="block" id="features">
        <div className="wrap">
          <div className="sec-head">
            <p className="eyebrow">What Prospect answers</p>
            <h2>Four decisions, one source of truth.</h2>
            <p className="sec-sub">
              Not another dashboard of vanity metrics — the specific questions that decide whether a solo project is
              worth a year of your life.
            </p>
          </div>
          <div className="feat-grid">
            <div className="feat">
              <span className="fi">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="9" />
                  <polygon points="15.5 8.5 13.5 13.5 8.5 15.5 10.5 10.5" />
                </svg>
              </span>
              <h3>Find your niche</h3>
              <p>
                Rank every Steam tag and genre by a real opportunity score — demand, minus competition, plus the quality
                gap (how beatable the incumbents are). Sort 400+ niches down to the few a small team can actually win.
              </p>
              <span className="fe">Opportunity Finder</span>
            </div>
            <div className="feat">
              <span className="fi">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="5" y="3" width="14" height="18" rx="2" />
                  <line x1="8" y1="7" x2="16" y2="7" />
                  <line x1="8" y1="12" x2="16" y2="12" />
                  <line x1="8" y1="16" x2="13" y2="16" />
                </svg>
              </span>
              <h3>Estimate the payoff</h3>
              <p>
                Turn a review or wishlist count into a lifetime revenue range with the Boxleiter method (owners ≈ reviews
                × 20–55), fitted per genre. Always a low–mid–high band — never a single made-up number.
              </p>
              <span className="fe">Revenue Estimator</span>
            </div>
            <div className="feat">
              <span className="fi">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M4 19V5M9 19v-7M14 19v-4M19 19v-9" />
                </svg>
              </span>
              <h3>Learn why hits win</h3>
              <p>
                Mine a game's reviews into praise and complaint themes measured against its genre baseline, fused with
                its press timeline — correlational evidence for what actually made it land, honestly labeled.
              </p>
              <span className="fe">Game Teardown</span>
            </div>
            <div className="feat">
              <span className="fi">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M4 9v6h3l7 4V5L7 9H4Z" />
                  <path d="M17.5 8.5a5 5 0 0 1 0 7" />
                </svg>
              </span>
              <h3>Find your press</h3>
              <p>
                Rank the outlets and named journalists who actually cover your genre — each with a recent example and an
                active-or-quiet signal, so you pitch the people still on the beat instead of a stale media list.
              </p>
              <span className="fe">Press Pitch Lists</span>
            </div>
          </div>
          <p className="sec-sub" style={{ marginTop: "22px" }}>
            Plus a whitelisted <b style={{ color: "var(--ink)", fontWeight: 650 }}>Data Explorer</b> for your own cuts,
            and an in-app <b style={{ color: "var(--ink)", fontWeight: 650 }}>Analytics Chat</b> that answers questions
            straight from the marts.
          </p>
        </div>
      </section>

      <section className="block tinted" id="method">
        <div className="wrap method-grid">
          <div className="sec-head" style={{ margin: 0 }}>
            <p className="eyebrow">The method</p>
            <h2>Estimates, not fortune-telling.</h2>
            <div className="callout" style={{ marginTop: "22px" }}>
              <p>Every number here is an estimate with a real bias — and Prospect says so, out loud, where it matters.</p>
              <p>
                <b>Revenue comes as a range.</b> <b>"Why it works" is labeled correlational</b>, never causal. Review and
                press samples name their own skew.
              </p>
              <p>It's the honest read a spreadsheet of scraped numbers can't give you.</p>
            </div>
          </div>
          <ul className="method-list">
            <li>
              <span className="ml-k">opportunity</span>
              <span className="ml-v">
                <b>demand − competition + quality gap</b>, each a 0–100 percentile across niches. You always see the
                three parts, never a lone score.
              </span>
            </li>
            <li>
              <span className="ml-k">owners</span>
              <span className="ml-v">
                <b>reviews × 20–55</b> (Boxleiter), the multiplier fitted per genre — with Steam-API ground-truth review
                counts wherever we have them.
              </span>
            </li>
            <li>
              <span className="ml-k">teardown</span>
              <span className="ml-v">
                Aspect sentiment mined from real review text, measured as a <b>delta vs. the genre baseline</b> — what
                this game does differently, not just what it does.
              </span>
            </li>
            <li>
              <span className="ml-k">press</span>
              <span className="ml-v">
                Outlets and journalists ranked by real coverage volume, filtered to a <b>recent-activity signal</b> so
                the list is who's on the beat now.
              </span>
            </li>
          </ul>
        </div>
      </section>

      <section className="cta" id="cta">
        <div className="wrap">
          <p className="eyebrow" style={{ textAlign: "center" }}>
            Get started
          </p>
          <h2>Your next game is hiding in the data.</h2>
          <p>
            Open the Niche Finder and sort the whole catalog to the openings a solo team can win. No setup, your own copy
            of the data, self-hostable when you're ready.
          </p>
          <Link className="btn btn-primary" to="/niches" style={{ fontSize: "15px", padding: "12px 22px" }}>
            Start prospecting →
          </Link>
        </div>
      </section>

      <footer>
        <div className="wrap">
          <span className="brand" style={{ fontSize: "14px" }}>
            <span className="mark" style={{ width: "24px", height: "24px", borderRadius: "6px" }}>
              <BarMark size={12} stroke={2.6} />
            </span>
            Prospect
          </span>
          <span className="foot-links">
            <Link to="/docs">Docs</Link>
            <Link to="/terms">Terms</Link>
            <Link to="/privacy">Privacy</Link>
          </span>
          <span className="foot-note">Steam market intelligence for solo &amp; indie developers.</span>
          <span className="foot-note r">Built on public Steam data · not affiliated with Valve</span>
        </div>
      </footer>
    </div>
  );
}

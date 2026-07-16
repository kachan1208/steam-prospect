import { ChatMarkdown } from "../components/chat/ChatMarkdown";
import { LegalLayout } from "../components/LegalLayout";

const UPDATED = "July 16, 2026";

const TERMS_MD = `*This is a general-purpose template, not a substitute for legal advice — it is pending review by a qualified attorney before any paid plan launches. See the project's internal data-source review for the open questions we're tracking around redistributing Steam/SteamSpy data.*

## 1. Acceptance of these terms

By creating an account or otherwise using Prospect ("Prospect," "we," "us"), you agree to these Terms of Service. If you're using Prospect on behalf of a studio or company, you're confirming you have authority to bind that organization.

## 2. What Prospect is

Prospect analyzes publicly available Steam catalog, review, and press-coverage data into niche rankings, revenue estimates, game teardowns, and press pitch lists for solo and indie developers.

- Every revenue and owner figure is an **estimate shown as a range**, derived from the Boxleiter method and similar heuristics — never a guarantee of sales, and never financial or investment advice.
- "Why it works" teardowns describe **correlation**, not proven causation.
- Prospect is an independent, third-party research tool. It is **not affiliated with, endorsed by, or sponsored by Valve Corporation**, and "Steam" is a trademark of Valve Corporation used here only to describe the platform the data is about.

## 3. Accounts

You're responsible for the accuracy of the information you provide and for activity that happens under your account or API keys. Tell us promptly if you suspect unauthorized access. Prospect currently ships in a single-organization "solo mode" — multi-user accounts, roles, and invitations arrive alongside billing.

## 4. Acceptable use

You agree not to:

- Scrape, crawl, or bulk-extract Prospect's own outputs to build a competing product.
- Redistribute Prospect's raw per-game data as a standalone dataset (aggregated insights and your own analysis built on top are fine).
- Attempt to circumvent rate limits, entitlement checks, or the whitelist-only query surface in the Data Explorer.
- Use Prospect to harass, defraud, or make representations that its estimates are guaranteed outcomes.

## 5. Data sources

Prospect is built on a versioned snapshot of publicly available Steam storefront data, SteamSpy's ownership estimates, and press/RSS metadata, refreshed periodically. Underlying facts (names, prices, review counts, tags) are not something Prospect claims to own; Prospect's own contribution is the analysis, scoring, and estimation layered on top. See the Docs section "Data sources & freshness" for the plain-English version, and the internal \`LEGAL.md\` for the full assessment of the redistribution question.

## 6. Subscriptions & billing

Billing is not live yet. Prospect currently runs in solo/local mode with a single seeded "Solo" plan and no payment collection. These terms will be updated with specific billing, refund, and cancellation language before any paid plan launches — nothing here should be read as a present commitment on pricing.

## 7. Your data

Saved views, watchlist entries, and API keys you create belong to you. You can delete any of them at any time from Settings. See the Privacy Policy for how account data is handled.

## 8. Intellectual property

Prospect's software, scoring methodology, and UI are owned by us. Underlying Steam/SteamSpy facts and press metadata are not; we make no ownership claim over them and use them under the "estimates from public data" framing described above.

## 9. Disclaimers

Prospect is provided **"as is"** and **"as available,"** without warranties of any kind, express or implied, including accuracy, fitness for a particular purpose, or non-infringement. Market conditions change; historical patterns in the data may not predict future outcomes. You are solely responsible for decisions you make using Prospect's output.

## 10. Limitation of liability

To the maximum extent permitted by law, Prospect and its operators will not be liable for indirect, incidental, special, or consequential damages, or for lost profits or lost data, arising from your use of the service.

## 11. Termination

We may suspend or terminate access for violation of these terms. You may stop using Prospect and request account deletion at any time.

## 12. Changes to these terms

We'll update the "last updated" date above when these terms change and, once accounts have verified emails, notify active users of material changes.

## 13. Governing law

To be finalized with counsel prior to commercial launch.

## 14. Contact

Questions about these terms: see the Support page under Docs for the current contact channel.`;

export default function Terms() {
  return (
    <LegalLayout title="Terms of Service" updated={UPDATED}>
      <ChatMarkdown text={TERMS_MD} />
    </LegalLayout>
  );
}

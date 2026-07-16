import { ChatMarkdown } from "../components/chat/ChatMarkdown";
import { LegalLayout } from "../components/LegalLayout";

const UPDATED = "July 16, 2026";

const PRIVACY_MD = `*This is a general-purpose template pending review by a qualified attorney before any paid plan launches. It covers data about you, the Prospect user — not the publicly sourced Steam catalog data Prospect analyzes (see the Docs section "Data sources & freshness" for that).*

## 1. What we collect

- **Account data**: your email address and an optional display name.
- **Things you create**: saved views, watchlist entries, and API keys (the API key itself is hashed — we can't read it back after it's created).
- **Preferences**: your theme/accent choice and whether you've completed the welcome tour, stored in your browser's local storage, not on our servers.
- **Standard server logs**: request timestamps, IP address, and route, for debugging and abuse prevention — the same baseline logging any web service keeps.

We do **not** currently collect payment information — billing isn't live yet.

## 2. What we don't collect

Prospect never asks for or connects to your personal Steam account. The catalog, review, and press data it analyzes is a pre-scraped public snapshot, not anything read from your Steam profile, library, or purchase history.

## 3. Cookies & local storage

Prospect uses browser local storage for functional purposes only — remembering your theme/accent preference and whether you've seen the onboarding tour. There is no advertising or cross-site tracking pixel in the product today.

## 4. How we use your data

To operate the service (authenticate requests, save your views/watchlist, enforce plan limits), to respond when you contact support, and to fix bugs. We don't sell your data.

## 5. Third parties

Once Prospect is hosted commercially, a hosting/infrastructure provider will process data on our behalf under its own data-processing terms; this policy will be updated with the specific provider before that happens. No user data is shared with data brokers or advertisers.

## 6. Retention & deletion

You can delete your saved views, watchlist entries, and API keys at any time from Settings. To delete your account entirely, contact us via the channel listed on the Support doc page — we'll remove your account data, retaining only what's required for legitimate legal/accounting purposes.

## 7. Security

API key secrets are hashed at rest and shown to you exactly once, at creation. Reasonable technical measures are used to protect account data, though no method of storage or transmission is 100% secure.

## 8. Children's privacy

Prospect is a B2B analytics tool for game developers and is not directed at, or knowingly used by, children under 13 (or the relevant minimum age in your jurisdiction).

## 9. International users

If Prospect is hosted in a different country than you, your data may be processed there. This section will be expanded with specific transfer mechanisms (e.g., SCCs) before international commercial launch.

## 10. Changes to this policy

We'll update the "last updated" date above when this policy changes and, once accounts have verified emails, notify active users of material changes.

## 11. Contact

Questions about this policy: see the Support page under Docs for the current contact channel.`;

export default function Privacy() {
  return (
    <LegalLayout title="Privacy Policy" updated={UPDATED}>
      <ChatMarkdown text={PRIVACY_MD} />
    </LegalLayout>
  );
}

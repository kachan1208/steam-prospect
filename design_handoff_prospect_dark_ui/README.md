# Handoff: Prospect — dark "Industry" UI redesign

## Overview
A visual redesign of Prospect (Steam market-intelligence tool) around one core job: **surface underserved niches**. The home becomes an opportunity feed (hero insight + moving-niche cards with 90-day trend verdicts), and all pages move to a dark "blueprint" aesthetic: steel-blue ground, paper-white type, hairline borders with "+" corner registration marks, condensed headings, thin-stroke charts.

Target codebase: `kachan1208/steam-prospect` — `web/` (React + Vite + Tailwind, react-router, @tanstack/react-table). Implement these designs as a Tailwind theme + component restyle of the existing pages, not a rewrite.

## About the Design Files
The files in this bundle are **design references created in HTML** — prototypes showing intended look and behavior, not production code to copy. Recreate them in the existing React/Tailwind environment using its established patterns (theme.tsx presets, existing chart components, Card/StatTile/Badge UI primitives). `Prospect Mockups.dc.html` is a canvas of mockups; `industry-styles.css` is the design-token stylesheet the mockups consume.

## Fidelity
**High-fidelity.** Colors, typography, spacing and copy patterns are final; recreate pixel-perfectly with the codebase's existing libraries. Chart data shown is illustrative — bind real API data.

## Screens / Views
Mockup ids refer to badges visible in `Prospect Mockups.dc.html`.

### 3a — Radar (new home, replaces /games as index route)
- Purpose: feed-first opening — one hero insight + grid of moving niches.
- Layout: max-width ~1180px. Header nav; below, a full-width hero "blueprint" plate (flex: text column + 400px chart column separated by a hairline); then "Moving niches" heading row; then a 3-column grid (gap 22px) of niche cards.
- Hero plate: kicker (10px, letterspacing .12em, uppercase, accent-300, condensed font) → H2 headline (32px condensed, paper) → body (14px, paper at 68%) → button row (primary = accent-300 fill with accent-900 text; secondary = hairline paper border, transparent).
- Hero chart column: "▲ +24%" (40px condensed, accent-300) + caption; line chart (accent-300 solid = review velocity, paper 45% dashed = releases), gridlines paper 12–14%; legend swatches 14×2px.
- Niche card: blueprint frame; kicker row (tier + game count, accent-300; verdict ▲/▼ +% right-aligned, 20px condensed — accent-300 when up, paper 55% when down); title 20px condensed; sparkline (44px tall, 1.5px stroke); meta line 11px paper 55% ("P90 rev $612K · opp v2 87.4 · players 7d +6.2%") with the opp score bolded accent-300 when strong.

### 4a — Niche Finder (/niches)
- Filter row: segmented controls (Tags/Genres, Last 24 months/All-time, All games/≥50/≥100), square-cornered, selected cell = accent-300 fill + accent-900 text; search input 220px hairline; tier chips as outline tags.
- Table inside one blueprint frame. Columns: Niche | Games | P90 rev | Demand | Competition | Quality gap | Opp v2 ↓ | Players 7d. Grid template `2fr .7fr 1fr 1fr 1fr 1fr .9fr 1fr`, gap 14px, rows 13px vertical padding, row rules paper 12%.
- D/C/Q cells are 4px-tall bars: track paper 15%; demand & quality fill accent-300, competition fill paper 50%.
- Opp v2: 17px condensed; accent-300 when ≥ ~70, paper 80% otherwise; decline gate shown as small "×0.84" suffix (10px, paper 50%).
- Header row: condensed 12px uppercase, letterspacing .08em, paper 55%, sorted column carries ↓.
- Footer: "1–50 of 1,412" + Prev/Next hairline buttons (disabled = paper 45% text).

### 4b — Niche deep dive (/niches/:key)
- Header: breadcrumb (11px paper 55%) → H2 niche name → outline tags (tier, window, review floor). Actions right: "+ Watchlist" (hairline) and "Combine with…" (primary).
- KPI strip: 4 equal cells in a 1px-gap grid (gap color paper 20% acts as rules). Each: condensed uppercase label 11px paper 55% → value 38px condensed (accent-300 for score/demand, paper for the rest) → footnote 11px.
- Two panels side by side (1.6fr / 1fr, gap 22px), both blueprint frames, padding 20/24:
  - "Demand vs pipeline, 24 months": 180px line chart, same two-series language as hero.
  - "Why 87.4": three labeled 4px bars (Demand 82 × 0.5, Competition 31 × −0.35, Quality gap 74 × 0.3) + formula footnote separated by a hairline: "0.5×82 − 0.35×31 + 0.3×74 = 52.4 → × decline gate 1.00 → percentile 87.4".
- "Top games in the niche": blueprint frame table, columns 60px thumb | 2fr game | released | est. revenue | reviews | players now; thumbs are 26px-tall diagonal-stripe placeholders (replace with capsule images).

### 4c — Game profile (/games/:appid)
- Header: 184×86 capsule placeholder in a blueprint frame; H2 title; meta line (studio · release date · price); outline accent tags; actions "+ Watchlist" / "+ Compare" (primary).
- Body: 1.7fr main / 1fr sidebar, gap 22px.
- Main: "Review velocity since launch" bar chart (150px; bars accent-300 at 55% alpha, highlight week full accent-300; event marker = 1px dashed paper vertical line + condensed uppercase annotation "−20% SALE · JUL 30"); below, two half panels: "Price history" step line (accent-300) and "What reviews praise / pan" aspect bars (positive accent-300, negative paper 50%, signed values right).
- Sidebar: "Estimates" panel with **accent-300 border** (the one emphasized frame): rows label paper 65% / value 17px condensed (Gross revenue $1.24M, Units 71,400, Reviews 3,812 · 91%, Peak CCU 8,204, Players now 2,404 in accent-300); methodology footnote under a hairline. Below: "In niches" panel listing niche → opp score links.

### 4d — Compare (/compare)
- Title row + "+ Add game" hairline button; "3 of 4 slots · share this view by URL" caption.
- Overlay chart panel: "Review velocity, first 12 weeks", three series — accent-300 / paper 75% / paper 35%.
- Metric grid in a blueprint frame: header row with 40px stripe thumbs + names (17px condensed) + release/price captions; rows Est. gross revenue / Est. units / Rating / Peak CCU / Players 7d; the best value per row is bold accent-300.

### 4e — Game search (/games)
- Large blueprint search field (Lucide search icon 1.5 stroke, accent-300; caret drawn accent-300; result count right, paper 55%).
- Filter chip row (active = accent outline, inactive = paper-30% outline) + "sorted by est. revenue".
- Result rows (hairline top rules): 96×45 stripe capsule placeholder | name 17px condensed + tags/date caption | rating · review count | est. revenue 16px condensed (accent-300 for the top result) | players 7d verdict.

### 4f — Watchlist (new page, nav item)
- Fired-alert banner: blueprint frame with **accent-300 border**, big ▲, sentence "Colony Sim crossed your alert — demand +24% / 90d passed the +20% threshold on Aug 19", primary "Open deep dive" button right.
- Table: Item | Type (outline tag: niche = accent, game = neutral) | Alert rule (13px paper 65%) | 90d trend verdict | Last change. Grid `1.6fr .7fr 1.6fr 1fr 1fr`.

## Interactions & Behavior
- Nav: Radar / Niches / Games / Studios / Timing + "MCP" primary button (accent-300 fill). Active link = accent-300; inactive = paper 75%, hover → paper 100%.
- Trend verdict language everywhere: ▲/▼ + signed % over 90 days. Up = accent-300, down/flat = paper 55%. Never red/green — the palette is mono steel.
- Buttons: primary accent-300 fill → hover accent-400; hairline secondary → hover paper 8% tint. Square corners always.
- Focus: `:focus-visible { outline: 2px solid accent; offset 2px }` (already the DS rule).
- Table rows: hover paper 4–6% tint; niche/game names link to deep dive/profile.
- Sorting (4a): column headers clickable, arrow on active column — behavior already exists in NicheFinder.tsx; restyle only.
- Charts: keep existing tooltip/drilldown behavior from `web/src/components/charts/*`; restyle strokes/fills to this palette, 1.5px line weight.
- Watchlist alerts: evaluated on nightly mart build; banner appears when a rule fired since last visit.

## State Management
No new state model for restyled pages — reuse existing query hooks (`useNiches`, etc.). New: Radar feed (needs an endpoint or client-side derivation: top movers by 90d demand trend among micro/theme tags) and Watchlist (persisted items + alert rules; localStorage or the control-plane DB).

## Design Tokens
From the Industry design system (`industry-styles.css` in this bundle; use as CSS variables or Tailwind theme values):
- Ground (dark pages): `--color-accent-900` #1d2d3d. Paper text: #f2f2f3.
- Accent steps: 100 #eef6ff · 200 #d6ebff · **300 #b5d9fd (primary on dark)** · 400 #94bce3 · 500 #749dc4 · 600 #597ea3 · 700 #416180 · 800 #2c455d · 900 #1d2d3d.
- Paper alphas on dark: text-muted 55–68%, borders/frames 18–35%, row rules 12–15%, chart gridlines 12–14%, bar tracks 15%, secondary series 35–75%.
- Fonts: headings "Barlow Condensed" 600; body "Barlow" 400/500 (Google Fonts). Body 14–15px; captions 11–13px; kickers 10–12px condensed uppercase letterspacing .08–.12em.
- Radius: **0 on all cards/buttons/tags/inputs** (blueprint grammar).
- Blueprint frame: 1px border + four 11×11px "+" corner marks overhanging −6px (see `.blueprint` / `.corner` in industry-styles.css); corner color paper 55% on dark.
- Icons: Lucide, stroke-width 1.5.
- Chart line weight: 1.5px; dashed series `4 3`; event markers dashed `3 4`.

## Assets
- No raster assets. Capsule/thumbnail placeholders are 45° diagonal stripes (paper 12%) — replace with real Steam capsule art (`header_image` URLs) at 616×353 ratio.
- Logo: concentric-circles target mark (already `ICONS.target` in App.tsx) in accent-300 + "PROSPECT" wordmark in Barlow Condensed.

## Files
- `Prospect Mockups.dc.html` — all mockups on one canvas: 3a (Radar home) and 4a–4f (Finder, deep dive, game profile, compare, search, watchlist). Open in a browser; every measurement above can be read from its inline styles.
- `industry-styles.css` — the design-system token sheet + component classes the mockups consume (ramps, spacing, `.blueprint`, `.btn`, `.tag`, `.nav`).

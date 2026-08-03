// Shared endpoint catalogue + data pools for the Prospect k6 load tests.
//
// Every request is tagged with a stable `name` so k6 aggregates latency/error metrics
// PER ENDPOINT (and avoids high-cardinality URL tags). Weights approximate real traffic:
// since the trim to four surfaces (Games · Launch & Timing · Use in Claude · Data log),
// Games is the entry point and dominates, while teardown stays rare because it's heavy.
// All endpoints are GET reads and unauthenticated.
import http from 'k6/http';

export const BASE_URL = (__ENV.BASE_URL || 'https://142-93-49-69.nip.io').replace(/\/+$/, '');

// Real values that exist in the catalogue (so responses are non-trivial, cache-representative).
const APPIDS = [294100, 323190, 457140, 1623730, 2300320, 644930, 233450, 1313140, 466560, 1044720];
const GENRES = ['Indie', 'Strategy', 'Action', 'RPG', 'Simulation', 'Adventure', 'Casual'];
const SEARCH_TERMS = ['colon', 'farm', 'rogue', 'sim', 'space', 'dragon', 'survival', 'tycoon', 'dungeon'];
const WINDOWS = ['all', '24m'];
const METRICS = ['revenue', 'reviews', 'owners', 'price'];
// Aspect labels the teardown mart actually emits — the drill-down is a real user action
// (click a teardown bar), so it belongs in the mix. These must match the router's
// whitelist exactly (it 400s on anything else), so keep this list in sync with
// mart_game_aspect_reviews' distinct `aspect` values.
const ASPECTS = ['Art & Visuals', 'Combat & Bosses', 'Content & Length',
  'Controls & Performance', 'Difficulty', 'Map & Navigation / Backtracking',
  'Music & Audio', 'Price & Value', 'Story & Writing', 'World & Exploration'];
const SENTIMENTS = ['praise', 'complaint'];

export function pick(a) { return a[Math.floor(Math.random() * a.length)]; }
const enc = encodeURIComponent;

// name: metric label · weight: relative frequency · path(): builds a fresh randomized URL.
export const ENDPOINTS = [
  { name: 'health',           weight: 1,  path: () => `/api/health` },
  // Games — the entry point, so it carries most of the mix.
  { name: 'game_search',      weight: 14, path: () => `/api/games/search?q=${enc(pick(SEARCH_TERMS))}&min_reviews=30&limit=20` },
  { name: 'game_profile',     weight: 10, path: () => `/api/games/${pick(APPIDS)}` },
  { name: 'game_comparables', weight: 4,  path: () => `/api/games/${pick(APPIDS)}/comparables` },
  { name: 'game_trends',      weight: 3,  path: () => `/api/games/${pick(APPIDS)}/trends` },
  { name: 'game_teardown',    weight: 2,  path: () => `/api/games/${pick(APPIDS)}/teardown` }, // HEAVY (aspect mining)
  { name: 'aspect_reviews',   weight: 2,  path: () => `/api/games/${pick(APPIDS)}/aspect-reviews?aspect=${enc(pick(ASPECTS))}&sentiment=${pick(SENTIMENTS)}` },
  // Launch & Timing.
  { name: 'launch_curve',     weight: 3,  path: () => `/api/launch-curve?genre=${enc(pick(GENRES))}` },
  { name: 'seasonality',      weight: 2,  path: () => `/api/seasonality` },
  { name: 'market_dist',      weight: 3,  path: () => `/api/market/distribution?metric=${pick(METRICS)}&genre=__all__&window=${pick(WINDOWS)}` },
  // Feeds the genre pickers on both surviving pages, so it is hit on nearly every visit.
  { name: 'market_bench',     weight: 4,  path: () => `/api/market/benchmarks` },
  // Data log.
  { name: 'refresh_history',  weight: 1,  path: () => `/api/refresh/history` },
];

// Weighted picker over ENDPOINTS (cumulative-weight scan).
const TOTAL_WEIGHT = ENDPOINTS.reduce((s, e) => s + e.weight, 0);
export function weightedEndpoint() {
  let r = Math.random() * TOTAL_WEIGHT;
  for (const e of ENDPOINTS) { if ((r -= e.weight) < 0) return e; }
  return ENDPOINTS[0];
}

// Fire one request for a given endpoint def, tagged by name, with a basic status check.
export function hit(ep, check_) {
  const res = http.get(`${BASE_URL}${ep.path()}`, { tags: { name: ep.name } });
  check_(res, {
    [`${ep.name}: status 200`]: (r) => r.status === 200,
    [`${ep.name}: has body`]: (r) => r.body && r.body.length > 0,
  });
  return res;
}

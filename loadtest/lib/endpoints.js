// Shared endpoint catalogue + data pools for the Prospect k6 load tests.
//
// Every request is tagged with a stable `name` so k6 aggregates latency/error metrics
// PER ENDPOINT (and avoids high-cardinality URL tags). Weights approximate real traffic
// (Niche Finder dominates; teardown is heavy so it's rare). All endpoints are GET reads;
// the app runs in solo mode so NO auth header is required.
import http from 'k6/http';

export const BASE_URL = (__ENV.BASE_URL || 'https://142-93-49-69.nip.io').replace(/\/+$/, '');

// Real values that exist in the catalogue (so responses are non-trivial, cache-representative).
const APPIDS = [294100, 323190, 457140, 1623730, 2300320, 644930, 233450, 1313140, 466560, 1044720];
const NICHE_TAGS = ['Colony Sim', 'Farming', 'Extraction Shooter', '4X', 'City Builder',
  'Automobile Sim', 'Souls-like', 'Base-Building', 'Roguelike Deckbuilder', 'Political'];
const GENRES = ['Indie', 'Strategy', 'Action', 'RPG', 'Simulation', 'Adventure', 'Casual'];
const SEARCH_TERMS = ['colon', 'farm', 'rogue', 'sim', 'space', 'dragon', 'survival', 'tycoon', 'dungeon'];
const SORTS = ['opportunity', 'market_size', 'total_owners', 'demand', 'median_rev', 'hit_rate_200k'];
const WINDOWS = ['all', '24m'];
const METRICS = ['revenue', 'reviews', 'owners', 'price'];

export function pick(a) { return a[Math.floor(Math.random() * a.length)]; }
const enc = encodeURIComponent;

// name: metric label · weight: relative frequency · path(): builds a fresh randomized URL.
export const ENDPOINTS = [
  { name: 'health',           weight: 1,  path: () => `/api/health` },
  { name: 'niches_list',      weight: 12, path: () => `/api/niches?dimension=tag&window=${pick(WINDOWS)}&min_reviews=50&sort=${pick(SORTS)}&limit=25` },
  { name: 'niche_detail',     weight: 7,  path: () => `/api/niches/tag/${enc(pick(NICHE_TAGS))}` },
  { name: 'niches_csv',       weight: 1,  path: () => `/api/niches/export.csv?dimension=tag&window=all&min_reviews=50` },
  { name: 'game_search',      weight: 8,  path: () => `/api/games/search?q=${enc(pick(SEARCH_TERMS))}&min_reviews=30&limit=20` },
  { name: 'game_profile',     weight: 6,  path: () => `/api/games/${pick(APPIDS)}` },
  { name: 'game_comparables', weight: 3,  path: () => `/api/games/${pick(APPIDS)}/comparables` },
  { name: 'game_trends',      weight: 2,  path: () => `/api/games/${pick(APPIDS)}/trends` },
  { name: 'game_teardown',    weight: 2,  path: () => `/api/games/${pick(APPIDS)}/teardown` }, // HEAVY (aspect mining)
  { name: 'market_dist',      weight: 3,  path: () => `/api/market/distribution?metric=${pick(METRICS)}&genre=__all__&window=${pick(WINDOWS)}` },
  { name: 'market_bench',     weight: 2,  path: () => `/api/market/benchmarks` },
  { name: 'seasonality',      weight: 1,  path: () => `/api/seasonality` },
  { name: 'press_coverage',   weight: 1,  path: () => `/api/press/coverage?appid=${pick(APPIDS)}` },
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

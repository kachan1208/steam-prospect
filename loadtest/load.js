// LOAD — steady, realistic traffic at an expected concurrency, weighted like real usage
// (Games dominates). Ramps up, holds, ramps down. This is the "is it healthy under
// normal peak load" test.
//   VUS=25 DURATION=3m k6 run loadtest/load.js
//   BASE_URL=http://127.0.0.1:8080 VUS=25 k6 run loadtest/load.js   (app-local, no TLS/nginx)
import { check, sleep } from 'k6';
import { weightedEndpoint, hit } from './lib/endpoints.js';

const VUS = Number(__ENV.VUS || 25);
const DURATION = __ENV.DURATION || '2m';

export const options = {
  scenarios: {
    load: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '30s', target: VUS },   // ramp up
        { duration: DURATION, target: VUS }, // hold at peak
        { duration: '20s', target: 0 },      // ramp down
      ],
      gracefulRampDown: '10s',
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],                     // <1% errors
    http_req_duration: ['p(95)<800', 'p(99)<2000'],     // overall
    // Per-endpoint p95 budgets (heavy teardown gets its own looser budget):
    'http_req_duration{name:game_search}': ['p(95)<700'],  // substring scan — measured ~620ms p95 @25VUs
    'http_req_duration{name:game_profile}': ['p(95)<600'],
    'http_req_duration{name:game_teardown}': ['p(95)<4000'],
    // Slowest handler on the droplet by ~4x (808ms p95 server-side, measured 2026-08-03):
    // it computes tag-Jaccard at query time over every game in the genre + price band
    // before LIMIT. Budgeted loosely so it's tracked rather than silently the tail driver.
    'http_req_duration{name:game_comparables}': ['p(95)<1500'],
  },
};

export default function () {
  hit(weightedEndpoint(), check);
  sleep(Math.random() * 1.5 + 0.5); // 0.5–2s think time
}

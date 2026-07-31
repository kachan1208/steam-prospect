// SMOKE — minimal load, hits every endpoint once to prove the system + scenarios work.
// Safe to run against production anytime. Use as the pre-flight before load/stress.
//   k6 run loadtest/smoke.js
//   BASE_URL=http://127.0.0.1:8080 k6 run loadtest/smoke.js
import { check, sleep } from 'k6';
import { ENDPOINTS, hit } from './lib/endpoints.js';

export const options = {
  vus: 1,
  iterations: ENDPOINTS.length,
  thresholds: {
    http_req_failed: ['rate==0'],            // zero errors allowed in smoke
    http_req_duration: ['p(95)<3000'],       // generous; teardown is heavy
  },
};

export default function () {
  const ep = ENDPOINTS[__ITER % ENDPOINTS.length];
  hit(ep, check);
  sleep(0.5);
}

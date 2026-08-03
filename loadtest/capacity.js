// CAPACITY — the "where's the limit?" test. Open model: k6 drives a rising REQUEST RATE
// (independent of response time) so the server's saturation point is exposed as the RPS at
// which p95 latency balloons and/or errors climb. Read the knee from the per-stage output
// (or a metrics dashboard) — the last RPS with healthy p95/errors is the practical ceiling.
//
// ⚠️ Production 4GB Droplet — DO NOT overlap the 21:00 UTC nightly. Watch host metrics.
//   PEAK_RPS=500 k6 run loadtest/capacity.js
import { check } from 'k6';
import { weightedEndpoint, hit } from './lib/endpoints.js';

const START = Number(__ENV.START_RPS || 20);
const PEAK = Number(__ENV.PEAK_RPS || 500);
const RAMP = __ENV.RAMP || '5m';

export const options = {
  scenarios: {
    capacity: {
      executor: 'ramping-arrival-rate',
      startRate: START,
      timeUnit: '1s',
      preAllocatedVUs: 100,
      maxVUs: Number(__ENV.MAX_VUS || 800), // must cover PEAK_RPS × worst-case latency
      stages: [
        { target: START, duration: '20s' },  // warm up
        { target: PEAK, duration: RAMP },     // linearly ramp the arrival rate
        { target: PEAK, duration: '30s' },    // hold at peak
        { target: 0, duration: '10s' },
      ],
    },
  },
  thresholds: {
    // Informational — we WANT to see these cross so we can locate the knee.
    http_req_failed: ['rate<0.10'],
    http_req_duration: ['p(95)<3000'],
  },
};

export default function () {
  hit(weightedEndpoint(), check);
}

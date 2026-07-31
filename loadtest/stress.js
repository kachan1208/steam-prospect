// STRESS — push past expected load in steps to find the breaking point / saturation curve.
// ⚠️ Runs against the single production Droplet (4GB box). Run deliberately, watch the
// "Prospect — Data Pipeline"/host metrics, and avoid overlapping the nightly (21:00 UTC).
//   MAX_VUS=150 k6 run loadtest/stress.js
import { check, sleep } from 'k6';
import { weightedEndpoint, hit } from './lib/endpoints.js';

const MAX = Number(__ENV.MAX_VUS || 150);
const step = (frac) => Math.max(1, Math.round(MAX * frac));

export const options = {
  scenarios: {
    stress: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '1m', target: step(0.2) },
        { duration: '2m', target: step(0.5) },
        { duration: '2m', target: step(0.8) },
        { duration: '2m', target: MAX },
        { duration: '2m', target: MAX },   // sustain at max
        { duration: '1m', target: 0 },
      ],
      gracefulRampDown: '15s',
    },
  },
  thresholds: {
    // Don't fail the run on breach — we WANT to observe degradation. These are annotations.
    http_req_failed: ['rate<0.05'],
    http_req_duration: ['p(95)<2500'],
  },
};

export default function () {
  hit(weightedEndpoint(), check);
  sleep(Math.random() * 1.0 + 0.3);
}

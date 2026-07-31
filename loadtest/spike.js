// SPIKE — sudden burst then drop, to test how the app absorbs a traffic spike (e.g. a
// launch, an HN/Reddit front-page) and whether it recovers cleanly afterward.
// ⚠️ Production Droplet — see the warning in stress.js.
//   SPIKE_VUS=120 k6 run loadtest/spike.js
import { check, sleep } from 'k6';
import { weightedEndpoint, hit } from './lib/endpoints.js';

const SPIKE = Number(__ENV.SPIKE_VUS || 120);

export const options = {
  scenarios: {
    spike: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '20s', target: 5 },      // baseline
        { duration: '10s', target: SPIKE },  // sudden spike
        { duration: '1m', target: SPIKE },   // sustain the burst
        { duration: '10s', target: 5 },      // drop back
        { duration: '40s', target: 5 },      // observe recovery
        { duration: '10s', target: 0 },
      ],
      gracefulRampDown: '10s',
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.05'],
    http_req_duration: ['p(95)<3000'],
  },
};

export default function () {
  hit(weightedEndpoint(), check);
  sleep(Math.random() * 0.8 + 0.2);
}

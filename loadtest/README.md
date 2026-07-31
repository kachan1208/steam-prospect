# Prospect load tests (k6)

Load/stress scenarios for the Prospect API, driven by [k6](https://k6.io).

All scenarios share one endpoint catalogue (`lib/endpoints.js`) that weights requests like
real traffic (Niche Finder dominates; the heavy `game_teardown` aspect-mining endpoint is
rare) and tags each request with a stable `name` so k6 reports latency/errors **per endpoint**.

The app runs in **solo mode**, so every endpoint is a public GET — **no auth header needed**.
`/api/chat` (LLM-backed, expensive) is intentionally excluded.

## Install k6

```bash
brew install k6                 # macOS
# or: https://grafana.com/docs/k6/latest/set-up/install-k6/
```

## Target (`BASE_URL`)

Defaults to production `https://142-93-49-69.nip.io`. Override to hit the app locally
(skips nginx/TLS, measures the app itself):

```bash
BASE_URL=http://127.0.0.1:8080 k6 run loadtest/smoke.js
```

There is only one deployment (the Droplet); there is no staging. **Load/stress/spike runs hit
production**, so run them deliberately.

## Scenarios

| File | What it does | Run |
|------|--------------|-----|
| `smoke.js` | 1 VU, each endpoint once. Proves the system + scripts work. Safe anytime. | `k6 run loadtest/smoke.js` |
| `load.js` | Steady realistic traffic at expected peak. "Is it healthy under normal load?" | `VUS=25 DURATION=3m k6 run loadtest/load.js` |
| `stress.js` | Steps past expected load to find the saturation point. | `MAX_VUS=150 k6 run loadtest/stress.js` |
| `spike.js` | Sudden burst then drop; tests absorption + recovery. | `SPIKE_VUS=120 k6 run loadtest/spike.js` |

### Env vars
- `BASE_URL` — target base URL (default prod).
- `VUS`, `DURATION` — `load.js` peak concurrency / hold time.
- `MAX_VUS` — `stress.js` ceiling.
- `SPIKE_VUS` — `spike.js` burst size.

## ⚠️ Running against production safely

The Droplet is a small (4 GB) box also running VictoriaMetrics + Grafana + the nightly ETL.

- **Always run `smoke.js` first.**
- **Don't overlap the nightly refresh (21:00 UTC)** — the ETL is CPU/IO heavy.
- Start small (`VUS=10`) and climb; watch host metrics / the "Prospect — Data Pipeline" Grafana while running.
- Prefer `BASE_URL=http://127.0.0.1:8080` (run k6 *on* the box, or via SSH tunnel) to isolate app performance from internet/TLS variance — but note k6 then competes with the app for CPU.

## Reading results

k6 prints an end-of-run summary. Key lines:
- `http_req_duration` — `avg`, `p(95)`, `p(99)` (the thresholds gate on p95/p99).
- `http_req_failed` — error rate (thresholds require <1% for `load.js`).
- Per-endpoint: filter by the `name` tag, e.g. `http_req_duration{name:niches_list}`.
- A ✓/✗ next to each threshold; k6 exits non-zero if any threshold fails (CI-friendly).

Save a machine-readable summary:
```bash
k6 run --summary-export=loadtest/last-summary.json loadtest/load.js
```

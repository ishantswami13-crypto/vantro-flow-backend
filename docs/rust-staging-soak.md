# Rust Staging 24-Hour Soak Plan

**Purpose:** Verify the Rust staging service is stable under realistic
conditions before enabling `RUST_AUTOMATION_API_ENABLED` in production.

**Pre-condition:** All perf lab tests pass (13/13, `safe_to_enable_rust: YES
(staging only)`). This soak confirms *sustained* reliability, not just point-in-time.

**Production flag stays OFF throughout this soak.**

---

## What the Soak Proves

A one-time perf run proves Rust responds correctly and hits latency budgets.
A 24-hour soak proves:

- No memory leak (RSS grows and stays high → OOM risk)
- No connection pool exhaustion (Railway Postgres max connections)
- No restart loop (crashloop → Railway shows it as Online but restarts every N min)
- No latency degradation after cache warm/cold cycles
- JWT expiry is handled gracefully (no auth panics)
- No 5xx responses emerging under continued load

---

## Step 1 — Confirm Staging Service Is Running

```bash
curl -s https://vantro-automation-staging-production.up.railway.app/health
# Expected: {"ok":true,"service":"vantro-automation-rs","version":"..."}
```

In Railway dashboard → `vantro-automation-staging` → check:
- Status: **Online** (green)
- No red restart counter
- Deployment matches branch `performance-bootstrap-cortex-fix-v1`

---

## Step 2 — Record Baseline Metrics Before Soak

Before starting, note in your soak log:

| Metric | Value |
|---|---|
| Start time | YYYY-MM-DD HH:MM IST |
| Railway memory (before) | __ MB |
| Railway CPU (before) | __ % |
| Deployment ID | (from Railway dashboard) |
| Branch / commit | performance-bootstrap-cortex-fix-v1 / b2e4903 |

Find memory and CPU in Railway dashboard → service → **Metrics** tab.

---

## Step 3 — Health Ping During Soak

### Option A — Manual (no tooling needed)

Every 30–60 minutes during the 24h window, run:

```bash
curl -s https://vantro-automation-staging-production.up.railway.app/health | node -e "process.stdin.resume(); let d=''; process.stdin.on('data',c=>d+=c); process.stdin.on('end',()=>{ const j=JSON.parse(d); console.log(new Date().toISOString(), j.ok ? 'OK' : 'FAIL', j); })"
```

Record any non-200 responses.

### Option B — Scheduled task (if available)

If you have a cron or scheduled task available, run:

```bash
# Every 5 minutes for 24 hours
*/5 * * * * curl -sf https://vantro-automation-staging-production.up.railway.app/health >> /tmp/soak-health.log 2>&1
```

No paid uptime monitoring is required for this soak. Railway's own Metrics
tab shows uptime and restart count for free.

---

## Step 4 — Run Occasional Perf Spot Checks

At T+4h, T+8h, T+24h, re-run the perf lab to confirm latency hasn't degraded:

```bash
JWT_SECRET=<staging-secret> npm run staging:jwt   # refresh 2h token if needed

PERF_RUN_LIVE=true \
PERF_RUST_BASE_URL=https://vantro-automation-staging-production.up.railway.app \
PERF_TEST_TOKEN=$(cat .staging-token) \
PERF_ITERATIONS=5 \
PERF_TIMEOUT_MS=5000 \
npm run perf:test
```

Record the p50 server-compute and wall-clock for each spot check.

---

## Step 5 — Read Railway Logs

After 24h (or any time a health ping returns non-200), check logs:

```bash
# Via Railway CLI
railway logs --service vantro-automation-staging --project ef15ae28-4a41-472f-8eb0-b3554b280fc0 --environment production 2>&1 | grep -E "PANIC|ERROR|error|OOM|killed|restart|timeout|5[0-9][0-9]"
```

Or in Railway dashboard → service → **Logs** tab. Filter for:

| Pattern | Indicates |
|---|---|
| `PANIC` / `panic` | Rust runtime panic — always a bug |
| `OOM` / `killed` | Out of memory — check Metrics tab |
| `connection pool` | DB connection exhaustion |
| `timeout` | Upstream DB slow or pool starved |
| `5xx` in access logs | Endpoint returning server errors |
| `restart` | Railway restarting the service |
| `Error` / `error` from `tracing` spans | Application-level errors |

---

## Step 6 — Record End-of-Soak Metrics

At T+24h, record:

| Metric | Value | Pass? |
|---|---|---|
| Total duration | 24h | ✓ if no manual restart |
| Restarts (Railway dashboard) | __ | ✓ if 0 |
| Memory at end (Railway Metrics) | __ MB | ✓ if < 2× baseline |
| Any PANIC in logs | YES / NO | ✓ if NO |
| Any OOM in logs | YES / NO | ✓ if NO |
| Any 5xx responses | YES / NO | ✓ if NO |
| Health ping failures | __ / total pings | ✓ if < 1% |
| p50 server-compute at T+24h | __ ms | ✓ if still 0–1ms |
| safe_to_enable_rust (final perf run) | | ✓ if YES (staging only) |

---

## Step 7 — Soak Pass / Fail Decision

**PASS** (all of):
- 0 restarts or only Railway-initiated rolling deploy restarts
- No PANIC in logs
- No OOM
- No 5xx spikes
- Memory stable (not growing monotonically)
- p50 server-compute still 0–1ms at T+24h

**FAIL** (any of):
- Crash loop or unexpected restarts
- PANIC in logs → open a Rust bug before any production cutover
- OOM → profile heap, check connection pool limits, increase Railway memory tier
- 5xx spike → trace the specific endpoint, fix before proceeding
- p50 server-compute > 5ms at T+24h → investigate cache invalidation or DB slowness

If soak FAILs on any criteria, **do not proceed to canary rollout** until the
root cause is identified and fixed.

---

## After Soak Passes — Canary Rollout Sequence

The soak proves stability. The canary gate proves production correctness.
These are separate steps.

1. **T+0** — Soak passes all criteria above.
2. **T+1h** — Enable flag for 1 internal/test user only:
   - Set `RUST_AUTOMATION_API_ENABLED=true` on the production Node backend
   - Verify `RUST_AUTOMATION_BASE_URL` points to the correct Rust service
   - Tail production Node logs for `rust_call_success` vs fallback codes
3. **T+24h** — If no errors for internal user, enable for 5% of users (or next
   internal user group). Monitor for 24h.
4. **T+48h** — If still clean, full production enable. Continue monitoring.

**At no stage does `safe_to_enable_rust: YES (staging only)` from the perf lab
automatically mean production is ready.** The staging result is a necessary
but not sufficient condition.

---

## Rollback

If anything goes wrong during canary:

```bash
# On production Node backend Railway service — set via Railway dashboard or CLI
RUST_AUTOMATION_API_ENABLED=false
```

The Node fallback is always active (8/8 matrix tests pass). Setting the flag
to false reverts all traffic to the existing Node code path instantly with no
redeploy required.

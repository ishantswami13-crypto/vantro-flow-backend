# Load Testing Plan & Benchmark Guidelines (Vantro Flow)

This document establishes the load testing framework and profile metrics needed to ensure Vantro Flow satisfies scalability targets up to **10,000+ active daily users** and **1,000+ API QPS** safely without degrading.

---

## 1. Concurrency & Performance Targets

We define three key scale tiers for our application benchmarking:

*   **Target A: 100 RPS (Requests Per Second)**: Standard operational baseline.
*   **Target B: 500 RPS**: Peak hours concurrency (such as during daily automated WhatsApp reminders dispatch).
*   **Target C: 1,000+ RPS**: High-traffic peak scale.
*   **Active Users Capacity**: Adequate support for 10,000+ daily active businesses.

---

## 2. API Routes Under Test

To evaluate backend capabilities accurately, we test three main request scenarios:

1.  **Lightweight Reads**: `/api/health`
2.  **Standard Reads**: `/api/auth/me`
3.  **Heavy Calculations (Dynamic)**:
    *   `/api/business/control-room` (Dashboard analytics)
    *   `/api/analytics/:userId` (Analytics graphs calculation)
    *   `/api/cash-forecast/:userId` (Dynamic forecast calculation)
    *   `/api/inventory/:userId` (Valuation calculation)
4.  **Transactional Writes**: `/api/sales` / `/api/purchases`

---

## 3. Core Metrics to Profile

During test execution, we track:
*   **Response Latencies**:
    *   `p50`: Median latency (target: $<150ms$).
    *   `p95`: 95% of requests completed (target: $<300ms$).
    *   `p99`: Extreme latency outlier limit (target: $<1000ms$).
*   **Failure/Error Rate**: Percentage of queries returning non-2xx codes (target: $0.00\%$).
*   **Database Capacity Sinks**: Database CPU usage, connection exhaustion rates, and occurrences of Postgres slow query transactions.

---

## 4. Safe Testing Policy (SRE Rule Book)

> [!WARNING]
> **Strict Environment Rules**: Under no circumstances should heavy load tests be run directly against the production backend (`vantro-flow-backend-production.up.railway.app`) or production Supabase database.
> *   All benchmarks must be run on a local machine, isolated staging instance, or local Docker containers.
> *   Start profiling with lightweight read-only routes before testing write endpoints to avoid database write locking.

---

## 5. Tooling Selection: Autocannon
We choose **Autocannon** because it is a lightweight, high-performance HTTP benchmarking tool written in Node.js, requiring zero additional binary dependencies.

### Local Script Template

Create a file at `scripts/load_test_autocannon.js`:

```javascript
// scripts/load_test_autocannon.js
const autocannon = require('autocannon');

async function startLoadTest() {
  console.log('⚡ Starting Vantro Flow Local Load Test...');
  
  const instance = autocannon({
    url: process.env.TEST_URL || 'http://localhost:3001',
    connections: 100, // Concurrent client connections
    pipelining: 1,
    duration: 10, // Test duration in seconds
    title: 'Dashboard Control Room stress-test',
    headers: {
      'Authorization': `Bearer ${process.env.TEST_AUTH_TOKEN || 'MOCK_TOKEN'}`
    },
    requests: [
      {
        method: 'GET',
        path: '/api/business/control-room'
      }
    ]
  }, (err, result) => {
    if (err) {
      console.error('Error during test execution:', err);
    } else {
      console.log('📊 Benchmark Results complete!');
      console.log(`- Total Requests: ${result.requests.total}`);
      console.log(`- Throughput (RPS): ${result.requests.average}`);
      console.log(`- p50 Latency (ms): ${result.latency.p50}`);
      console.log(`- p95 Latency (ms): ${result.latency.p95}`);
      console.log(`- Error rate: ${result.errors}`);
    }
  });

  autocannon.track(instance, { renderProgressBar: true });
}

startLoadTest();
```

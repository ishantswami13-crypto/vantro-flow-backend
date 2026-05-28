# Grafana Dashboard Plan

## 1. Goal
Provide real-time visibility into the health, scaling, and business metrics of Vantro Flow without logging into the server.

## 2. Dashboards

### Dashboard 1: API Overview (The "Golden Signals")
- **Total Requests (RPS)**: `sum(rate(http_requests_total[5m])) by (method)`
- **Error Rate (5xx)**: `sum(rate(http_errors_total[5m])) / sum(rate(http_requests_total[5m]))`
- **Latency (p95 / p99)**: `histogram_quantile(0.95, sum(rate(http_request_duration_seconds_bucket[5m])) by (le))`
- **Active Traffic by Route**: Top 10 most accessed normalized routes.

### Dashboard 2: Auth Health
- **Signup Success vs Failures**
- **Login Success vs Failures** (Detect brute force attacks early)
- **Token Expiry/Invalidation Events**

### Dashboard 3: Cache Performance
- **Cache Hit Rate**: `sum(rate(cache_hits_total[5m])) / (sum(rate(cache_hits_total[5m])) + sum(rate(cache_misses_total[5m])))`
- **Cache Evictions / Invalidations**
- *Note: Custom metrics for cache will be added to `server.js` in a future phase.*

### Dashboard 4: Business Pipeline
- **AI Route Usage**: Volume of `/api/ai-chat` and `/api/ml/briefing` hits.
- **Webhook Processing**: Stripe/Razorpay/Twilio incoming hook success rates.
- **Document Scans**: OCR volume via `/api/scan-document`.

### Dashboard 5: Database Pressure (To be configured via PgBouncer/Supabase)
- **Active Connections**
- **Idle Connections**
- **Max Connections Reached Events**

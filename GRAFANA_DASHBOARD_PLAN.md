# Grafana Dashboard Plan

## Dashboard 1: Vantro Executive Overview
- **Total Requests (Rate)**: `sum(rate(http_requests_total[5m]))`
- **Error Rate (%)**: `sum(rate(http_errors_total[5m])) / sum(rate(http_requests_total[5m]))`
- **P95 Latency**: `histogram_quantile(0.95, sum(rate(http_request_duration_seconds_bucket[5m])) by (le))`

## Dashboard 2: Security & Abuse
- **Rate Limit Hits**: Spike in `429` status codes.
- **Auth Failures**: Spike in `401` status codes.
- **Webhook Failures**: Errors logged on `/api/payments/webhook` or `/api/voice/*`.

## Dashboard 3: Business Metrics (Via Database / Metabase)
- **Daily Active Businesses** (Query from `users` table login logs)
- **Total Ledger Outstanding Volume**

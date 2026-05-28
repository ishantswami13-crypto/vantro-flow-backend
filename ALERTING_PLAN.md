# Alerting Plan

## 1. Goal
Proactively detect system degradation before users report it. Alerts will be routed via Grafana Alerting to Slack and PagerDuty (or equivalent).

## 2. Alert Definitions

### Alert: Backend Down or Restarting Loop
- **Trigger**: `up == 0` for more than 2 minutes.
- **Severity**: P1 (Critical)
- **Action**: Check Railway deployment logs and auto-rollback if a recent deployment occurred.

### Alert: High Error Rate (5xx)
- **Trigger**: `sum(rate(http_errors_total[5m])) / sum(rate(http_requests_total[5m])) > 0.05` (5% error rate).
- **Severity**: P1 (Critical)
- **Action**: Check Loki logs for stack traces, specifically correlating `X-Request-ID`.

### Alert: High API Latency
- **Trigger**: p95 latency > 2000ms for more than 5 minutes.
- **Severity**: P2 (Warning)
- **Action**: Look for database locking, missing indexes, or a spike in AI document scanning requests.

### Alert: Auth Failure Spike
- **Trigger**: Spikes in 401/403 responses > 50 per minute.
- **Severity**: P2 (Warning)
- **Action**: Investigate potential brute-force attacks or a mistakenly revoked JWT secret.

### Alert: Database Connection Pool Saturated
- **Trigger**: Active connections > 80% of max allowed.
- **Severity**: P1 (Critical)
- **Action**: Spin up PgBouncer or switch to Supabase transaction pooler immediately.

### Alert: Webhook Failure Spike
- **Trigger**: Payment or WhatsApp webhooks returning non-200 > 5 per minute.
- **Severity**: P1 (Critical)
- **Action**: Check partner API dashboards (Razorpay/Twilio) and internal logs. Payment state mismatches require immediate manual reconciliation.

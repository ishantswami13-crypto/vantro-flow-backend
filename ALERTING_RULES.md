# Alerting Rules

Configure Prometheus Alertmanager or Grafana Alerting with these rules to catch production anomalies.

## 1. High API Error Rate
**Trigger**: When 5xx errors exceed 5% of all traffic over a 5-minute rolling window.
**Action**: Page on-call backend engineer.
**PromQL**:
```promql
sum(rate(http_errors_total{status_code=~"5.."}[5m]))
/
sum(rate(http_requests_total[5m])) > 0.05
```

## 2. High Auth Failure Spike (Credential Stuffing Attack)
**Trigger**: When 401s on `/api/auth/login` spike > 5x the baseline.
**Action**: Notify Security Slack channel.

## 3. High Latency Degradation
**Trigger**: When P95 latency across all routes exceeds 2000ms for 10 minutes.
**Action**: Page infrastructure engineer to check Database CPU / connection pooling.

## 4. Webhook Failures
**Trigger**: Any 5xx response returned from `/api/payments/webhook`.
**Action**: Page on-call engineer immediately (revenue-impacting).

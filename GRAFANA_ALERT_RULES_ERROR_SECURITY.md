# Grafana Alert Rules for Error & Security Intelligence

## Thresholds

### 1. High Error Rate (5xx)
- **Condition**: `sum(rate(http_errors_total{status_code=~"5.."}[5m])) / sum(rate(http_requests_total[5m])) > 0.05`
- **Duration**: 5 minutes
- **Action**: Page Backend Engineer

### 2. Critical Errors Spike
- **Condition**: `increase(error_events_total{severity="critical"}[10m]) > 3`
- **Duration**: Immediate
- **Action**: Page Engineering Lead

### 3. Payment Webhook Failure
- **Condition**: `increase(security_events_total{type="WEBHOOK_SIGNATURE_FAILED", provider="razorpay"}[5m]) > 1`
- **Duration**: Immediate
- **Action**: Page On-Call, Revenue Impacting

### 4. Credential Stuffing / Login Spike
- **Condition**: `increase(security_events_total{type="FAILED_LOGIN"}[5m]) > 50`
- **Duration**: 2 minutes
- **Action**: Alert Security Team slack channel

### 5. Suspicious Uploads
- **Condition**: `increase(security_events_total{type="FILE_UPLOAD_REJECTED"}[10m]) > 20`
- **Duration**: 5 minutes
- **Action**: Informational alert to `#security-alerts`

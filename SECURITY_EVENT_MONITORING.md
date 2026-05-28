# Security Event Monitoring

We classify explicitly anomalous or malicious behaviors outside of generic server errors.

## Monitored Events
- `FAILED_LOGIN`
- `INVALID_TOKEN`
- `FORBIDDEN_RESOURCE_ACCESS`
- `RATE_LIMIT_HIT`
- `WEBHOOK_SIGNATURE_FAILED`
- `FILE_UPLOAD_REJECTED`
- `CROSS_USER_ACCESS_ATTEMPT`

## How it works
Calls to `logSecurityEvent(req, type, details)` immediately emit a `warn`-level JSON log. 
These are indexed by our logging provider (Loki/Datadog) and will trigger PagerDuty alerts if thresholds are breached (e.g., credential stuffing attacks or mass rate limiting).

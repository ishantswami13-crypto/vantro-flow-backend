# Vantro Observability Skill

## Overview

Use this skill when adding logging, metrics, error tracking, health checks, alerts, or reviewing production reliability for Vantro Flow.

Trigger: "logging", "metrics", "observability", "error tracking", "health check", "Prometheus", "Grafana", "alert", "incident", "production reliability", "Railway logs".

## What This Skill Does

1. Reviews logging completeness for a feature or route
2. Checks Prometheus metric coverage
3. Verifies health endpoint accuracy
4. Identifies missing error tracking
5. Reviews alert coverage against ALERTING_PLAN.md

## Observability Files

| File | Purpose |
|------|---------|
| `lib/observability/logger.js` | Structured logging |
| `lib/observability/error-tracking.js` | Error capture |
| `prom-client` (in server.js) | Prometheus metrics |
| `OBSERVABILITY_PLAN.md` | Full observability plan |
| `ALERTING_PLAN.md` | Alert rules |
| `ALERTING_RULES.md` | Prometheus alert rules |
| `GRAFANA_DASHBOARD_PLAN.md` | Dashboard design |
| `SRE_RUNBOOKS.md` | Operational runbooks |
| `INCIDENT_RESPONSE_PLAYBOOK.md` | Incident steps |
| `performance-lab/report.md` | Performance test results |

## Logging Standards

Every route must log:
```javascript
logger.info({ method, path, user_id: req.user?.id, status, duration_ms }, 'request completed');
```

Every error must log:
```javascript
logger.error({ error: err.message, code: err.code, user_id, request_id, stack: err.stack }, 'request failed');
```

**Never log**: passwords, JWT tokens, Supabase service role key, customer phone numbers in plain text.

## Prometheus Metrics to Track

```javascript
// Required metrics
requests_total{method, path, status}        // counter
request_duration_seconds{method, path}      // histogram
ai_tokens_total{agent_id}                   // counter
policy_blocks_total{reason}                 // counter
auth_failures_total{reason}                 // counter
```

`/metrics` endpoint secured by `METRICS_TOKEN` — verify it's set in Railway.

## Health Endpoint

Must return:
```json
{
  "status": "ok",
  "timestamp": "2026-...",
  "checks": {
    "database": "ok",
    "rust_cortex": "disabled",
    "rust_automation": "disabled"
  }
}
```

If database check fails: return `"status": "degraded"` not `"ok"`.

## Debugging Checklist

Can you answer these in <5 minutes from logs?
- [ ] Which user_id triggered the error?
- [ ] What request caused the error?
- [ ] What was the error message?
- [ ] What was the stack trace?
- [ ] Did the Rust service contribute?

If NO to any: logging is insufficient for production.

## Observability Verdict Format

Logging: COMPLETE / INCOMPLETE (list what's missing)
Metrics: COVERED / MISSING (list which metrics)
Health endpoint: ACCURATE / INACCURATE
Error tracking: ACTIVE / MISSING
Alert coverage: [Y/N for each critical error type]
Production debuggable: YES / NO

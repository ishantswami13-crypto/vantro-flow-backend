# OpenTelemetry & Tempo Trace Plan

## 1. Why Traces Matter
While Request IDs tie logs together, they do not show the waterfall of where time is spent. Distributed traces allow us to see if the delay is in the auth middleware, the database, an external webhook, or an AI route.

## 2. Request ID vs Trace ID
- **Request ID**: A single string (e.g., UUID) passed via `X-Request-ID` to correlate logs for a single HTTP transaction.
- **Trace ID**: Part of the OpenTelemetry W3C context that can spawn child spans across multiple microservices or background jobs. The trace ID encompasses the entire flow.

## 3. Trace Path
1. **Frontend**: Next.js wrapper generates a trace context.
2. **Backend**: Express OpenTelemetry middleware picks up the trace context.
3. **Database**: Postgres driver instrumented with `pg` OpenTelemetry plugin captures query times.

## 4. OTLP Exporter Setup
We will use `@opentelemetry/exporter-trace-otlp-http`. It runs asynchronously and batches spans before pushing to avoid blocking the main Node.js event loop.

## 5. Tempo Setup Options
- **Managed**: Grafana Cloud (Recommended for MVP, zero operational overhead).
- **Self-Hosted**: Deploy Tempo alongside Loki in a new Railway project.

## 6. What Spans to Capture
- HTTP requests
- Auth middleware validation
- Database queries
- Cache lookups
- Webhook processing
- AI inference latency
- Background event dispatch

## 7. What Not to Capture (PII & Secrets)
- User passwords, JWTs, Cookies.
- Uploaded invoice files or full OCR content.
- Full customer phone numbers or sensitive business data in the spans.

## 8. Required Environment Variables
- `OTEL_EXPORTER_OTLP_ENDPOINT`
- `OTEL_EXPORTER_OTLP_HEADERS`
- `OTEL_SERVICE_NAME=vantro-flow-backend`

## 9. Rollout Plan
1. Add `@opentelemetry/auto-instrumentations-node` in staging.
2. Verify latency impact under load test.
3. Deploy to production with 10% sampling rate.

## 10. Rollback Plan
If traces cause memory leaks or connection exhaustion, unset `OTEL_EXPORTER_OTLP_ENDPOINT` to disable exporting, or revert the PR containing the NodeSDK initialization.

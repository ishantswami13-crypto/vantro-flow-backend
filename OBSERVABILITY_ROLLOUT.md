# Observability Rollout Plan

This document outlines the transition to a full observability stack (Logs, Metrics, Traces) for Vantro backend and frontend.

## 1. Metrics Stack
- **Prometheus** scrapes the `GET /metrics` endpoint exposed by the backend.
- **Endpoint Security**: The endpoint is guarded by `METRICS_TOKEN` in production.
- **Key Metrics Available**:
  - `http_requests_total`
  - `http_errors_total`
  - `http_request_duration_seconds`

## 2. Distributed Tracing (OpenTelemetry)
- To enable tracing, install the `@opentelemetry/api` package and configure a Jaeger or Tempo exporter in `server.js` during the next phase.
- Ensure `X-Request-ID` is passed from the Next.js frontend to the Express backend to stitch traces across boundaries.

## 3. Centralized Logging (Loki / Alloy)
- All logs from `server.js` (via `safeLog`) are emitted as JSON.
- Deploy a Grafana Alloy agent to tail the Docker logs or PM2 logs and ship them to Grafana Loki.
- PII and Tokens are scrubbed prior to JSON serialization via the `safeLog` redact mechanism.

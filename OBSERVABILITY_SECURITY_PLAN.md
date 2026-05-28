# Observability Security Plan

## 1. Goal
Ensure that the metrics, logs, and traces collected for operational health do not inadvertently leak Personally Identifiable Information (PII) or secrets.

## 2. Redaction Strategy
- The `safeLog()` function actively intercepts JSON log payloads and replaces the values of keys like `password`, `token`, `jwt`, `secret`, and `authorization` with `[REDACTED]`.
- This ensures that if Grafana Loki is compromised, the logs cannot be used to forge sessions.

## 3. Metrics Security
- The `/metrics` endpoint is protected by a Bearer token (`METRICS_TOKEN`) to prevent external scraping.
- High-cardinality labels (like `user_id` or `business_id`) are explicitly omitted from Prometheus histograms to prevent memory exhaustion and data leaks.

## 4. Trace Protection
- When implementing Tempo traces, HTTP headers containing Authorization and Cookies must be dropped by the OpenTelemetry collector before being exported.

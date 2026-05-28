# Observability Security
- /metrics endpoint protected by METRICS_TOKEN.
- PII/Secrets redacted in logs via `safeLog`.
- Stack traces masked in production JSON payload.

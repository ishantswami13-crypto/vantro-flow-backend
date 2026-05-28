# Observability Deployment Plan

## 1. Architecture
- **Metrics**: Prometheus (scrapes `/metrics` from backend)
- **Logs**: Loki (stores JSON structured logs)
- **Traces**: Tempo (receives OTLP traces)
- **Collector**: Grafana Alloy (agent running near the app to gather logs and traces and ship them securely)
- **Dashboards**: Grafana

## 2. Deployment Target
**Grafana Cloud (Managed)** is recommended for the initial MVP to avoid the overhead of managing the observability stack itself.

## 3. Required Environment Variables
- `METRICS_TOKEN` (Shared secret between Prometheus scraper and backend)
- `GRAFANA_CLOUD_LOKI_URL` & `GRAFANA_CLOUD_LOKI_USER`
- `GRAFANA_CLOUD_PROMETHEUS_URL` & `GRAFANA_CLOUD_PROMETHEUS_USER`
- `GRAFANA_CLOUD_TEMPO_URL`
- `GRAFANA_CLOUD_API_KEY`

## 4. Deployment Steps
1. Provision a free-tier Grafana Cloud instance.
2. Set `METRICS_TOKEN` in the Railway environment.
3. Configure Grafana Cloud Prometheus to scrape `https://vantro-flow-backend-production.up.railway.app/metrics` with the Bearer token.
4. Modify Railway deployment to run a sidecar or use Railway log drains to forward stdout JSON logs directly to Grafana Cloud Loki.
5. Apply the OpenTelemetry Node SDK and set OTLP endpoint to the Tempo URL.

## 5. Security Considerations
- The `/metrics` endpoint contains operational data but no PII. It is protected by `METRICS_TOKEN`.
- Logs are pre-redacted by `safeLog()` before printing to `stdout`, ensuring JWTs, passwords, and sensitive keys never leave the host.
- Do NOT expose Prometheus or Loki directly to the public internet without auth.

## 6. Rollback Plan
- If logging overhead is too high, revert the `safeLog` format to basic strings.
- If `/metrics` scraping causes load, disable it by removing the prometheus config or rotating `METRICS_TOKEN`.

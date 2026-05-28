# Rate Limiting & Abuse Security
- Global Express rate limiter active.
- Auth specific endpoints require tighter limits (100 req / 15m).
- Client error telemetry endpoint strictly limited (1mb payload).

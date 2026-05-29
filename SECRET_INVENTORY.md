# Vantro Secret Inventory

| Secret Name | Provider | Purpose | Risk Level | Location | Support CURRENT/PREVIOUS? | Auto-rotatable? |
|-------------|----------|---------|------------|----------|---------------------------|-----------------|
| `JWT_SECRET` | System (openssl) | Signs user authentication tokens | **CRITICAL** | Backend | Yes | No (requires manual) |
| `SUPABASE_URL` | Supabase | DB connection URL | Low | Backend | No | N/A |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase | Admin DB access bypassing RLS | **CRITICAL** | Backend | No (Provider limitation) | No |
| `SUPABASE_ANON_KEY` | Supabase | Public frontend DB access | Low | Backend | No | Yes (via API) |
| `DATABASE_URL` | Supabase (Postgres) | Direct Postgres connection pool | High | Backend | No | No (requires DB downtime) |
| `ANTHROPIC_API_KEY` | Anthropic | AI completion | Medium | Backend | No | Yes |
| `GROQ_API_KEY` | Groq | AI completion | Medium | Backend | No | Yes |
| `GEMINI_API_KEY` | Google | AI completion | Medium | Backend | No | Yes |
| `RAZORPAY_KEY_ID` | Razorpay | Payment gateway identification | Low | Backend | Yes (Multiple active) | Yes |
| `RAZORPAY_KEY_SECRET` | Razorpay | Payment gateway signing | **CRITICAL** | Backend | Yes (Multiple active) | Yes |
| `RAZORPAY_WEBHOOK_SECRET` | Razorpay | Verifies payment webhooks | High | Backend | Yes | No (manual) |
| `VOICE_WEBHOOK_SECRET` | Twilio | Verifies voice webhooks | High | Backend | Yes | No (manual) |
| `TWILIO_ACCOUNT_SID` | Twilio | Voice/SMS provider ID | Low | Backend | Yes (Multiple active) | Yes |
| `TWILIO_AUTH_TOKEN` | Twilio | Voice/SMS API token | High | Backend | Yes (Multiple active) | Yes |
| `VAPID_PUBLIC_KEY` | System (web-push) | Push notification public key | Low | Backend | No | N/A |
| `VAPID_PRIVATE_KEY` | System (web-push) | Push notification signing key | High | Backend | No | No |
| `METRICS_TOKEN` | System | Secures Prometheus metrics | Medium | Backend | Yes | Yes |
| `NEXT_PUBLIC_API_URL` | Vercel | API Hostname | Low | Frontend | N/A | N/A |
| `NEXT_PUBLIC_POSTHOG_KEY` | PostHog | Analytics ingestion | Low | Frontend | N/A | N/A |

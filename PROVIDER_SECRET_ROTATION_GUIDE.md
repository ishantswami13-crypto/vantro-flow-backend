# Provider-Specific Secret Rotation Guide

### Supabase Keys
- **Auto-rotatable**: Yes (via CLI/API for some, manual for others)
- **Steps**: Supabase Dashboard > Settings > API.
- **Downtime Required**: Very briefly during env redeploy (Service Role Key does not support Current/Previous out of the box).
- **Risk**: Critical.

### Railway / Vercel Environment Variables
- Variables can be updated via their CLIs (`railway variables set`, `vercel env add`).
- We can automate adding/removing variables through GitHub actions utilizing their CLIs.

### Razorpay API Keys & Webhooks
- **API Keys**: Supports multiple active keys. Generate a new key, update the backend, verify, then revoke the old key. **Downtime: None.**
- **Webhook Secrets**: Implement `_CURRENT` / `_PREVIOUS`. Update webhook settings in Razorpay, add both to backend. **Downtime: None.**

### Twilio
- **Tokens**: Twilio supports secondary tokens. Promote secondary token to primary, update backend, delete old token. **Downtime: None.**

### AI Providers (OpenAI, Anthropic, Gemini, Groq, OpenRouter)
- **Auto-rotatable**: Yes, mostly via API or dashboard.
- Generate new key -> Update Railway -> Wait -> Revoke old key. **Downtime: None.**

### Sentry / PostHog
- DSNs and ingest keys rarely rotate unless leaked, but follow the generate/redeploy/revoke pattern. **Downtime: None.**

# Webhook Security Rollout

## Razorpay Webhooks
Razorpay webhooks are secured using HMAC-SHA256 signatures.
- Endpoint: `POST /api/payments/webhook`
- Verification: `req.headers['x-razorpay-signature']` against `crypto.createHmac('sha256', RAZORPAY_WEBHOOK_SECRET)`
- Status: **SECURED**

## Twilio / Voice Webhooks
Twilio inbound and status callbacks use a custom secret in the query string or header.
- Endpoints: `POST /api/voice/inbound`, `/api/voice/recording`, `/api/voice/status`
- Verification: `req.query.secret` or `req.headers['x-vantro-webhook-secret']` against `VOICE_WEBHOOK_SECRET`
- Status: **SECURED** (Timing-safe equality checks are implemented)

## Next Steps for Future Providers
- Always use `crypto.timingSafeEqual` for string comparisons to prevent timing attacks.
- Log webhook ID and enforce idempotency using Redis or DB unique constraints to prevent replay attacks.
- Verify timestamp headers if provided by the vendor (e.g., Stripe's `t=` header) with a 5-minute tolerance.

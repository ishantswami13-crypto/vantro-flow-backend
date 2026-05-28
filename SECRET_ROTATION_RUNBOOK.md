# Secret Rotation Runbook

Do not rotate secrets directly in production without completing this checklist.

## Rotation Schedule
- **JWT_SECRET**: Rotate annually, or immediately on staff off-boarding.
- **SUPABASE_SERVICE_ROLE_KEY**: Rotate every 6 months.
- **RAZORPAY_WEBHOOK_SECRET**: Rotate annually.
- **VOICE_WEBHOOK_SECRET**: Rotate every 6 months.

## Safe Rotation Procedure (Zero-Downtime)
1. **Prepare New Secret**: Generate a cryptographically secure random string (e.g., `openssl rand -base64 32`).
2. **Dual-Support Code**: Modify backend to accept BOTH `SECRET_CURRENT` and `SECRET_PREVIOUS` during the transition window.
3. **Deploy Backend**: Deploy the code supporting both secrets.
4. **Update Vendor**: Update the webhook provider (e.g., Razorpay dashboard) with the *new* secret.
5. **Monitor Logs**: Ensure webhooks and authentications are completing without 401/403 errors using the observability dashboard.
6. **Cleanup**: After 24-48 hours (when all old tokens/webhooks expire), remove `SECRET_PREVIOUS` from code and environment.

Use `npm run security:secrets` before every commit to ensure no secrets are hardcoded.

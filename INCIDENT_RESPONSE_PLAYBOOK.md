# Incident Response Playbook

## 1. Secret Leak Incident
- **Scenario**: A developer commits `.env` to GitHub.
- **Action**: 
  1. Revoke the secret on the provider's end immediately (e.g., Supabase Dashboard, Razorpay Dashboard).
  2. Update the environment variables in Railway.
  3. Run BFG Repo-Cleaner to strip the secret from Git history.
  4. Force push the clean history.

## 2. Account Takeover / Brute Force
- **Scenario**: Spikes in 401 Unauthorized errors from specific IPs.
- **Action**:
  1. Ensure `express-rate-limit` is actively blocking the IP.
  2. If a distributed attack occurs, enable Cloudflare "Under Attack" mode or configure Railway proxy blocklists.
  3. Force password resets for affected users.

## 3. Webhook Abuse
- **Scenario**: Attackers are hitting `/api/payments/webhook` with fake successful payments.
- **Action**:
  1. Since we enforce HMAC verification (`getSecret('RAZORPAY_WEBHOOK_SECRET')`), these attacks will fail with 403/400.
  2. If the secret was leaked and attacks succeed, rotate `RAZORPAY_WEBHOOK_SECRET` immediately.
  3. Audit `activity_logs` for any forged payments and manually reconcile the ledger.

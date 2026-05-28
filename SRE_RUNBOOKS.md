# SRE Runbooks

## 1. Backend is Down (HTTP 502/503)
**Symptoms**: Frontend shows "Backend Down", API returns 502 Bad Gateway.
**Action**:
1. Check Railway dashboard for Out of Memory (OOM) kills.
2. Check `GET /api/health` and `GET /api/ready` externally.
3. If OOM: Temporarily increase Railway RAM. Restart container.
4. If Deploy Failed: Revert to previous successful commit in Railway.

## 2. High 5xx Error Rate
**Symptoms**: Users see "Internal Server Error", Alerts fire for high error rate.
**Action**:
1. Go to Loki/Grafana and filter by `{level="error"}`.
2. Group by `route`. Is it isolated to a single route?
3. Find a specific `requestId`. Trace it in Tempo to see if it failed at the DB, external API, or node layer.
4. If DB timeout: Check `DATABASE_PERFORMANCE_PLAN.md` and ensure indexes exist.

## 3. Database Connection Exhaustion
**Symptoms**: Logs show `remaining connection slots are reserved`, API hangs or returns 500.
**Action**:
1. Verify Supabase dashboard for active connections.
2. Ensure Vantro Flow backend is using the Transaction Pooler connection string (Port 6543) instead of direct connection (Port 5432).
3. If using pooler, increase pool size temporarily.

## 4. Payment Webhook Failures
**Symptoms**: Invoices are paid on Razorpay but remain "Pending" in Vantro Flow.
**Action**:
1. Check Loki logs for `route="/api/payments/webhook"`.
2. Check if it's an "invalid signature" error (check `RAZORPAY_WEBHOOK_SECRET`).
3. Manually trigger reconciliation job for the affected `invoice_id`.

## 5. Duplicate Payment Risk
**Symptoms**: User reports paying twice or ledger showing double entry.
**Action**:
1. Check `bank_transactions` for the user.
2. Ensure idempotency keys are respected on `/api/mark-paid`.
3. Escalate to Engineering to manually void the duplicate in DB and refund via Razorpay.

## 6. Secret Leak
**Symptoms**: A `.env` file or secret was committed to GitHub or exposed on frontend.
**Action**:
1. IMMEDIATELY rotate the exposed secret (e.g., Supabase DB password, JWT Secret).
2. If JWT Secret is rotated, all active users will be logged out. This is necessary.
3. Use BFG Repo-Cleaner to scrub the secret from git history.

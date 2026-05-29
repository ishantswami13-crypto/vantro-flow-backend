# Zero-Downtime Secret Rotation Runbook

When rotating critical secrets that support `_CURRENT` and `_PREVIOUS` patterns (e.g., `JWT_SECRET`, `RAZORPAY_WEBHOOK_SECRET`), follow this exact sequence to ensure zero downtime.

### Step 1: Generate the New Key
Generate a new secure key (for JWT) or generate a new secret in the provider dashboard (e.g., Razorpay webhook).
- **JWT Generation**: `openssl rand -hex 32`

### Step 2: Update Environment Variables (Stage 1)
In the Railway / Vercel dashboard:
- Copy the existing `_CURRENT` (or base secret) to `_PREVIOUS`.
- Set the new key as `_CURRENT`.
*(For JWT: `JWT_SECRET_PREVIOUS` = old key, `JWT_SECRET_CURRENT` = new key)*

### Step 3: Redeploy
Deploy the backend.
- **Verification**: The backend will now issue new tokens signed with `_CURRENT` but can still verify old tokens using `_PREVIOUS`.

### Step 4: Verify Production
Monitor logs for 15 minutes. Check error rates and verify that user sessions haven't been broken.

### Step 5: Wait Rotation Window
Wait until the old tokens expire (e.g., 30 days for JWT) or wait a short 24-hour window for webhooks to ensure pending retry webhooks have landed.

### Step 6: Revoke Old Key
If applicable, revoke the old key in the provider dashboard.

### Step 7: Remove `_PREVIOUS`
In the Railway / Vercel dashboard, delete the `_PREVIOUS` environment variable.

### Step 8: Redeploy
Deploy the backend again.

### Step 9: Final Verification
Monitor for any late 401s or failed webhook signatures.

### Rollback Plan
If Step 3 introduces issues:
1. Revert `_CURRENT` to the old key.
2. Delete `_PREVIOUS`.
3. Redeploy.

# Secret Rotation Playbook

## 1. Goal
Provide safe procedures for rotating critical secrets without breaking production or causing extended downtime.

## 2. Playbooks

### JWT_SECRET
- **Frequency**: Annually or immediately upon compromise.
- **Impact**: All active users will be forcefully logged out and must log in again.
- **Steps**:
  1. Generate a new strong random string (e.g., `openssl rand -base64 32`).
  2. Update `JWT_SECRET` in the Railway environment variables.
  3. The backend container will auto-restart.
  4. Verify login flow still works on the frontend.

### SUPABASE_SERVICE_ROLE_KEY
- **Frequency**: Only upon compromise.
- **Impact**: Momentary downtime for backend API routes relying on Supabase.
- **Steps**:
  1. Go to Supabase Dashboard -> Project Settings -> API.
  2. Click "Roll" next to the `service_role` secret.
  3. Immediately update the new key in the Railway environment.
  4. The backend container will auto-restart.

### RAZORPAY_WEBHOOK_SECRET
- **Frequency**: Every 6 months.
- **Impact**: If not done carefully, webhooks during rotation will fail, requiring manual reconciliation.
- **Steps**:
  1. Go to Razorpay Dashboard -> Webhooks.
  2. Modify the webhook and enter a new secret.
  3. Immediately update `RAZORPAY_WEBHOOK_SECRET` in Railway.
  4. Manually reconcile any payments that were missed during the 2-minute redeploy window.

# Secret Leak Incident Response Runbook

### 1. Detection & Verification
- Verify the leak (GitHub advanced security alert, user report, bug bounty).
- Determine exactly which secret was leaked and its scope.

### 2. Freeze & Contain
- Pause all CI/CD deployments to prevent the leaked secret from propagating further.
- Lock down the compromised provider account if necessary.

### 3. Rotate & Revoke (The "Kill Switch")
- Generate a new secret immediately.
- Replace it in Railway/Vercel.
- **Revoke the leaked key immediately in the provider dashboard.** (Do NOT wait for zero-downtime rotation patterns if it is a severe leak).
- Redeploy the application.

### 4. Special Scenarios
- **JWT Leak**: Rotate `JWT_SECRET`. **WARNING**: All users will be immediately logged out.
- **Supabase Service Role Leak**: Rotate immediately. RLS is bypassed by this key, risking a total data breach.
- **Database URL Leak**: Change the Postgres password in Supabase immediately.

### 5. Audit & Forensic
- Inspect access logs (Supabase, Railway, Vercel) for unauthorized usage during the leak window.
- If an npm supply-chain attack caused the leak, remove the malicious package and run `npm audit`.

### 6. Postmortem
- Write a blameless postmortem.
- Implement preventions (e.g., git hooks to scan for secrets before commit).

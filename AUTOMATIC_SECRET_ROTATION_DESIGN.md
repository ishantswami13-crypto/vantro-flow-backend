# Automatic Secret Rotation Design (Gated)

We intend to eventually automate the lifecycle of secrets, with strict human-in-the-loop gates for critical credentials.

## Design Components

1. **Rotation Scheduler**: A GitHub Action or temporal workflow that runs weekly, checking `secret-rotation-policy.json`.
2. **Provider Adapters**:
   - `SupabaseAdapter`: Interacts with Supabase Management API.
   - `RailwayAdapter` / `VercelAdapter`: Uses CLIs or APIs to mutate env vars.
   - `RazorpayAdapter`: Generates keys via Razorpay API.
3. **Manual Approval Gate**: When a secret is due, the system opens a GitHub Issue or Slack message. A human must approve (e.g., `/approve-rotation`).
4. **Dry-Run Mode**: Always runs in dry-run first to ensure adapters have valid credentials to perform the rotation.
5. **Post-Rotation Health Checks**: E2E tests run against staging with the new key.
6. **Rollback Trigger**: If health checks fail, the workflow immediately reverts the env vars via the adapters.

### Constraints
- Database passwords and Supabase Service Role keys **MUST NOT** be automatically rotated without explicit maintenance windows.
- Payment keys require sign-off from the Finance team.

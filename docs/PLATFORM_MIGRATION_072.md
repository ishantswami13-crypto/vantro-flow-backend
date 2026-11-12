# Migration 072 (platform core): apply and roll back

**Needs approval before it runs anywhere shared.** It has not been applied to staging or production.

## What it does

- Adds three nullable/defaulted columns to `organizations` (`operating_context`, `preferences`, `onboarded_at`).
- Creates `organization_members`, `organization_apps`, `platform_teams`, `platform_team_members`, `platform_org_policies`, `platform_audit_events`, `platform_agents`, `platform_agent_versions` (with an immutability trigger), `platform_agent_executions`, `platform_execution_steps`, `platform_approval_requests`, `platform_knowledge_collections`, `platform_knowledge_documents`, `platform_knowledge_chunks` (generated `tsvector` + GIN index).
- Data backfills, all `ON CONFLICT DO NOTHING`:
  1. an `organizations` row for every user that has none (same values `getOrCreateOrganizationContext` would write);
  2. `onboarded_at` set for every existing organization, so current users are not sent through the new setup;
  3. an `owner` membership for every organization owner;
  4. `finance` and `procurement` apps enabled for every existing organization, so no current user loses a screen.

Nothing existing is renamed, dropped or rewritten. Finance tables keep `user_id` as their tenant key.

## Apply

1. Staging first: `DATABASE_URL=<staging> npm run db:migrate:status` (expect only 072 pending), then `npm run db:migrate`.
2. Check: `SELECT COUNT(*) FROM organizations o LEFT JOIN organization_members m ON m.organization_id = o.id AND m.role = 'owner' WHERE m.user_id IS NULL;` returns 0.
3. Deploy the backend. `GET /api/platform/workspace` returns 200 for a signed-in user.
4. Production: same steps after the staging check, in a quiet period. The migration runs in one transaction; the backfills touch one row per user.

Until 072 is applied, `/api/platform/*` answers `503 PLATFORM_NOT_READY` and the frontend keeps today's navigation; nothing else changes.

## Environment

| Variable | Default | Effect |
|---|---|---|
| `PLATFORM_WORKER_ENABLED` | `true` | Set `false` to stop this instance from running agent executions |
| `PLATFORM_WORKER_INTERVAL_MS` | `2000` | Queue poll interval |
| `PLATFORM_WORKER_PARALLEL` | `2` | Executions one instance runs at once |
| `PLATFORM_MAX_CONCURRENCY_CEILING` | `10` | Upper bound an org admin can set for concurrent runs |
| `PLATFORM_DAILY_EXECUTION_CEILING` | `1000` | Upper bound an org admin can set for daily runs |
| Any model key (`ANTHROPIC_API_KEY`, `GROQ_API_KEY`, ...) | none | Agents cannot run or activate without one; runs fail with `MODEL_UNAVAILABLE` |
| `FEATURE_WORKFLOW_HTTP_ACTIONS_ENABLED` | `false` | Needed for the "Call a connected API" tool |

## Roll back

Stop the worker (`PLATFORM_WORKER_ENABLED=false`) or roll back the backend deploy, then in one transaction:

```sql
BEGIN;
DROP TABLE IF EXISTS platform_knowledge_chunks, platform_knowledge_documents, platform_knowledge_collections,
  platform_approval_requests, platform_execution_steps, platform_agent_executions, platform_agent_versions,
  platform_agents, platform_audit_events, platform_org_policies, platform_team_members, platform_teams,
  organization_apps, organization_members CASCADE;
DROP FUNCTION IF EXISTS platform_agent_versions_immutable();
ALTER TABLE organizations DROP COLUMN IF EXISTS operating_context, DROP COLUMN IF EXISTS preferences, DROP COLUMN IF EXISTS onboarded_at;
DELETE FROM starlane_migrations WHERE filename = 'migrations/072_platform_core.sql';
COMMIT;
```

This loses agents, runs, approvals and knowledge created on the platform. Organization rows created by the backfill are harmless and can stay.

## Migration 073: invitations

`migrations/073_platform_invitations.sql` adds one table, `platform_invitations`, and depends on 072. It is additive and safe to apply right after 072 with the same `npm run db:migrate`. Until it is applied, everything else keeps working; only inviting someone without an account fails (adding an existing account does not use it).

Roll back with:

```sql
BEGIN;
DROP TABLE IF EXISTS platform_invitations;
DELETE FROM starlane_migrations WHERE filename = 'migrations/073_platform_invitations.sql';
COMMIT;
```

Invitation emails go out only when the admin ticks the box and `RESEND_API_KEY` is set; links point at `FRONTEND_URL`.

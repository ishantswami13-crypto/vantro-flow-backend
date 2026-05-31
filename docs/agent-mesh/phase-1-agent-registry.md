# Atlas Agent Mesh — Phase 1: Agent Registry Foundation

> **Status:** Registry Created — Phase 1 implementation complete
> **Date:** 2026-06-01
> **Branch:** performance-bootstrap-cortex-fix-v1

---

## What Phase 1 Created

Phase 1 creates the database foundation for the Atlas Agent Mesh 216. It is **metadata only** — no agent runs automatically, no actions are executed.

### Files Created / Modified

| File | Change |
|------|--------|
| `migrations/007_agent_registry.sql` | New table: `agent_registry` with full schema |
| `scripts/seed-agent-registry.js` | Idempotent seed for 12 core agents |
| `scripts/staging-migrate.js` | Added 007 to MIGRATIONS list |
| `lib/featureFlags.js` | Added `agent_registry_api_enabled` flag |
| `server.js` | Added read-only GET /api/agents/registry routes |
| `package.json` | Added `agents:seed` and `agents:seed:validate` scripts |

---

## Why Agents Are Not Runtime-Active Yet

All 12 core agents are seeded with `is_active = false` and `status = 'registry'`.

**Before any agent can execute, it must:**
1. Pass static harness (schema, policy, tool availability)
2. Pass dry-run harness (synthetic data, no side effects)
3. Pass red-team harness for HIGH risk agents
4. Pass live harness in staging
5. Have `is_active = true` set explicitly in the registry
6. Have its feature flag set to `true` in Railway env

This is intentional. Phase 1 = registry foundation. Phase 1 does NOT = runtime execution.

---

## How to Apply Migration 007 (Staging)

```bash
# Apply to staging Postgres only
DATABASE_URL=<staging-postgres-url> npm run staging:migrate

# Verify table was created
# In psql or Supabase SQL editor:
# SELECT COUNT(*) FROM agent_registry;  -- should return 0 (empty before seed)
```

**Do NOT apply to production Supabase.** The staging-migrate.js script blocks production URLs.

---

## How to Seed the 12 Core Agents (Staging)

```bash
# Validate first (no DB writes)
DATABASE_URL=<staging-url> npm run agents:seed:validate

# Seed to staging DB
DATABASE_URL=<staging-url> npm run agents:seed

# Verify
# SELECT agent_id, name, risk_level, is_active, status
# FROM agent_registry
# ORDER BY name;
```

Expected output:
- 12 rows, all `is_active = false`, all `status = 'registry'`, all `public_claim_status = 'core_public'`

---

## How to Enable the Read API (Staging)

After migration and seed:

```bash
# In staging Railway env (NOT production):
FEATURE_AGENT_REGISTRY_API_ENABLED=true

# Test:
curl -H "Authorization: Bearer <jwt>" \
  https://<staging-url>/api/agents/registry

# Expected response:
{
  "success": true,
  "count": 12,
  "agents": [...],
  "public_claim": "12 core specialized agents with an expandable Agent Mesh architecture."
}
```

---

## Public Claim — Unchanged

The public website claim remains:

> **"12 core specialized agents with an expandable Agent Mesh architecture."**

Phase 1 creates the registry foundation. Agents become publicly claimable only when they are:
- In `production` status
- `is_active = true`
- Harness X verified
- Owner-approval rules tested
- Production monitoring live

The "216 agents" number remains internal architecture only. See `public-vs-internal-agent-claims.md`.

---

## Rollback

```bash
# 1. Disable feature flag (instant — no redeployment needed)
FEATURE_AGENT_REGISTRY_API_ENABLED=false

# 2. Remove seed data if needed
DELETE FROM agent_registry WHERE agent_id LIKE 'core.%';

# 3. Drop table if needed (staging only)
DROP TABLE IF EXISTS agent_registry;
```

---

## Next Steps After Phase 1

1. **Apply migration 007** to staging DB
2. **Run seed** with `npm run agents:seed:validate` then `npm run agents:seed`
3. **Run static harness** with `npm run cortex:test` — verify all static scenarios pass
4. **Enable read API** in staging: `FEATURE_AGENT_REGISTRY_API_ENABLED=true`
5. **Test API** — verify 12 agents returned, all `is_active=false`
6. **Begin Phase 2** — wire the first agent tool connections (non-LLM agents first)

---

## Verification Commands

```bash
# After any code change:
npm run check                          # Node.js syntax check
npm run security:secrets               # No secrets in new files
npm run cortex:test                    # Static harness — must stay 100%
npm run agents:seed:validate           # Validate 12 agent definitions (no DB write)
```

---

*Phase 0 (docs) → Phase 1 (registry foundation) → Phase 2 (first agent execution)*

# Vantro Code OS — Signal Map

## Purpose

Precise file-path and keyword-based signal detection. When a task mentions or touches a specific file path, Claude Code knows the exact domain and risk level instantly — no guessing.

This is the highest-precision routing layer. File paths are unambiguous. Keywords are supporting context.

---

## File-Path Signal Table

| File / Path Pattern | Primary Domain | Secondary Domains | Min Risk | Mandatory Agents |
|--------------------|---------------|------------------|----------|-----------------|
| `server.js` | backend | auth-security | medium | backend-api-engineer, security-sentinel, harness-x-verifier |
| `lib/services/agents/*.js` | ai-agents-orchestration | cashops-collections | medium | agent-mesh-architect, harness-x-verifier |
| `lib/services/orchestrator/policyGuard.service.js` | auth-security | ai-agents-orchestration | **critical** | security-sentinel, harness-x-verifier, compliance-risk-agent |
| `lib/services/orchestrator/promptGuard.service.js` | auth-security | ai-agents-orchestration | **critical** | security-sentinel, harness-x-verifier, compliance-risk-agent |
| `lib/services/orchestrator/audit.service.js` | ai-agents-orchestration | auth-security | high | security-sentinel, compliance-risk-agent |
| `lib/services/orchestrator/idempotency.service.js` | backend | auth-security | high | backend-api-engineer, security-sentinel |
| `lib/services/orchestrator/orchestrator.service.js` | ai-agents-orchestration | backend | high | agent-mesh-architect, chief-architect |
| `lib/services/orchestrator/llmPlanner.service.js` | ai-agents-orchestration | — | high | agent-mesh-architect, cost-engine-agent |
| `lib/services/orchestrator/*.service.js` | ai-agents-orchestration | backend | medium | agent-mesh-architect, harness-x-verifier |
| `lib/services/cortexCore/rustCore.service.js` | rust-infrastructure | backend | high | rust-systems-engineer, chief-architect |
| `lib/services/rustAutomation/rustAutomationClient.js` | rust-infrastructure | backend | high | rust-systems-engineer, chief-architect |
| `lib/services/PurchaseService.js` | backend | cashops-collections | medium | backend-api-engineer, cashops-domain-agent |
| `lib/services/SalesService.js` | backend | cashops-collections | medium | backend-api-engineer, cashops-domain-agent |
| `lib/featureFlags.js` | deployment | backend | high | chief-architect, launch-readiness-officer |
| `lib/cache/cache.service.js` | performance-cache | auth-security | high | chief-architect, security-sentinel |
| `lib/events/EventEngine.js` | ai-agents-orchestration | backend | medium | agent-mesh-architect, chief-architect |
| `lib/observability/logger.js` | deployment | — | low | observability-reliability-agent |
| `lib/observability/error-tracking.js` | deployment | — | low | observability-reliability-agent |
| `lib/config/supabaseClient.js` | database | auth-security | high | database-rls-guardian, security-sentinel |
| `lib/db/pg.js` | database | auth-security | high | database-rls-guardian, security-sentinel |
| `lib/businessContext.js` | backend | — | low | backend-api-engineer |
| `migrations/00*.sql` | database | auth-security | **critical** | database-rls-guardian, security-sentinel, harness-x-verifier |
| `migrations/006_cortex_rls.sql` | database | auth-security | **critical** | database-rls-guardian, security-sentinel — DO NOT APPLY without auth bridge |
| `supabase-schema.sql` | database | — | high | database-rls-guardian |
| `supabase-rls-rollout.sql` | database | auth-security | **critical** | database-rls-guardian, security-sentinel |
| `cortex-core-rs/src/*.rs` | rust-infrastructure | — | high | rust-systems-engineer |
| `vantro-automation-rs/src/auth.rs` | rust-infrastructure | auth-security | **critical** | rust-systems-engineer, security-sentinel |
| `vantro-automation-rs/src/cache/*.rs` | rust-infrastructure | auth-security | **critical** | rust-systems-engineer, security-sentinel |
| `vantro-automation-rs/src/cashops/*.rs` | rust-infrastructure | cashops-collections | high | rust-systems-engineer, cashops-domain-agent |
| `vantro-automation-rs/src/cortex/policy_guard.rs` | rust-infrastructure | auth-security | **critical** | rust-systems-engineer, security-sentinel |
| `vantro-automation-rs/src/cortex/cost_engine.rs` | rust-infrastructure | ai-agents-orchestration | high | rust-systems-engineer, cost-engine-agent |
| `vantro-automation-rs/tests/auth_cache_isolation.rs` | rust-infrastructure | auth-security | high | rust-systems-engineer, security-sentinel |
| `vantro-automation-rs/tests/policy_guard_fir_regression.rs` | rust-infrastructure | auth-security | high | rust-systems-engineer, security-sentinel |
| `cortex-lab/scenarios/ai-safety/*.json` | harness-testing | auth-security | high | harness-x-verifier, security-sentinel |
| `cortex-lab/scenarios/security/*.json` | harness-testing | auth-security | high | harness-x-verifier, security-sentinel |
| `cortex-lab/scenarios/collections/*.json` | harness-testing | cashops-collections | medium | harness-x-verifier, cashops-domain-agent |
| `cortex-lab/scenarios/risk/*.json` | harness-testing | cashops-collections | medium | harness-x-verifier, cashops-domain-agent |
| `cortex-lab/run.js` | harness-testing | — | low | harness-x-verifier |
| `cortex-lab/scenarios/**` | harness-testing | — | medium | harness-x-verifier |
| `scripts/sec_os/*.md` | deployment | auth-security | low | security-sentinel |
| `scripts/security-smoke-test.js` | deployment | auth-security | low | security-sentinel |
| `scripts/cross-user-security-test.js` | deployment | auth-security | medium | security-sentinel, database-rls-guardian |
| `.github/workflows/security*.yml` | deployment | auth-security | medium | security-sentinel |
| `.github/workflows/rust-*.yml` | rust-infrastructure | deployment | medium | rust-systems-engineer |
| `railway.toml` | deployment | — | high | launch-readiness-officer, security-sentinel |
| `nixpacks.toml` | deployment | rust-infrastructure | high | launch-readiness-officer, rust-systems-engineer |
| `Cargo.toml` | rust-infrastructure | — | medium | rust-systems-engineer |
| `Cargo.lock` | rust-infrastructure | — | low | rust-systems-engineer |
| `performance-lab/run.js` | performance-cache | — | low | observability-reliability-agent |
| `CLAUDE.md` | — (repo-brain only) | — | low | No app agents needed |
| `AGENTS.md` | — (repo-brain only) | — | low | No app agents needed |
| `.claude/**` | — (repo-brain only) | — | low | No app agents needed |

---

## Frontend File-Path Signals (`I:/Vantro/vantro-flow-frontend/`)

| File / Path Pattern | Primary Domain | Min Risk | Mandatory Agents |
|--------------------|---------------|----------|-----------------|
| `middleware.ts` | auth-security | high | security-sentinel, frontend-ux-engineer |
| `app/dashboard/page.tsx` | ux-ui | low | frontend-ux-engineer |
| `app/collections/page.tsx` | ux-ui | medium | frontend-ux-engineer, cashops-domain-agent |
| `app/ai-actions/page.tsx` | ux-ui | medium | frontend-ux-engineer, agent-mesh-architect |
| `app/whatsapp/page.tsx` | ux-ui | high | frontend-ux-engineer, compliance-risk-agent |
| `app/admin/**` | ux-ui | high | frontend-ux-engineer, security-sentinel |
| `app/login/page.tsx` | auth-security | high | security-sentinel, frontend-ux-engineer |
| `app/signup/page.tsx` | auth-security | high | security-sentinel, frontend-ux-engineer |
| `lib/api.ts` | backend | auth-security | medium | backend-api-engineer, security-sentinel |
| `lib/featureGating.ts` | deployment | — | medium | launch-readiness-officer |
| `components/layout/DashboardLayout.tsx` | ux-ui | low | frontend-ux-engineer |
| `components/layout/BottomNav.tsx` | ux-ui | low | frontend-ux-engineer |
| `next.config.js` | deployment | auth-security | high | security-sentinel, launch-readiness-officer |

---

## Keyword Signal Supplements

When file paths are not mentioned, use keywords. File paths always take priority over keywords.

| Keyword Group | Domain | Risk Boost |
|---------------|--------|-----------|
| `JWT_SECRET`, `SUPABASE_SERVICE_ROLE_KEY`, `API_KEY`, `SECRET` | auth-security | +40 to risk score |
| `req.body.user_id`, `req.params.id` (as user source) | auth-security | +50 to risk score — CRITICAL |
| `mark.paid`, `payment_received`, `invoice_amount` | backend | +40 to risk score |
| `FEATURE_EXTERNAL_MESSAGE_SENDING_ENABLED` | deployment | +35 to risk score |
| `RUST_CORTEX_CORE_ENABLED`, `RUST_AUTOMATION_API_ENABLED` | rust-infrastructure | +30 to risk score |
| `DROP TABLE`, `DELETE FROM`, `TRUNCATE` | database | +50 to risk score — CRITICAL |
| `promptGuard`, `policyGuard` disabled or bypassed | auth-security | +50 to risk score — CRITICAL |
| `.eq('user_id'` removed, `WHERE user_id` removed | auth-security | +50 to risk score — CRITICAL |
| `client.messages.create` (Twilio) | deployment | +35 to risk score |

---

## Signal Detection Priority Order

1. **File path match** (highest precision) → use file-path table above
2. **Keyword match in task description** → use keyword supplements
3. **Domain inference from context** → use agent-router.md routing table
4. **Ambiguous** → activate default agents + ask one clarifying question

Never skip step 1. File paths are truth. Task descriptions can be vague or misleading.

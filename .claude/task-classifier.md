# Vantro Code OS — Task Classifier

## Purpose

Before every meaningful task, Claude Code classifies the task and outputs a structured brief. This brief governs which agents activate, what files get inspected, what proof is required, and what the safe plan looks like.

---

## Task Domains

| Domain | Key Signals |
|--------|------------|
| `backend` | server.js, Express, routes, lib/services/, API, payments, Razorpay, Twilio |
| `frontend` | app/, components/, Next.js, Tailwind, pages, UI, UX, layout |
| `database` | migrations/, Supabase, SQL, schema, indexes, RLS, pg queries |
| `auth-security` | JWT, cookies, CSRF, CORS, permissions, secrets, tenant isolation |
| `rust-infrastructure` | cortex-core-rs/, vantro-automation-rs/, Cargo, SQLx, Rust flags |
| `cashops-collections` | collections, receivables, overdue, promises, credit risk, cashflow, tone, timing |
| `ai-agents-orchestration` | lib/services/agents/, lib/services/orchestrator/, LLM, prompts, policyGuard, promptGuard |
| `harness-testing` | cortex-lab/, scenarios/, npm run cortex:test |
| `performance-cache` | cache.service.js, latency, bootstrap, perf, prom-client |
| `deployment` | Railway, Vercel, env vars, railway.toml, nixpacks.toml, production |
| `ux-ui` | frontend pages, mobile, loading states, empty states, error states |
| `launch-readiness` | 22 June, launch checklist, production readiness, feature flags |
| `product-gtm` | pricing, positioning, HighRadius, onboarding, retention, referrals |
| `mixed-high-risk` | touches 3+ domains, financial data, cross-tenant, external messaging |

---

## Risk Levels

| Level | Definition | Examples |
|-------|-----------|---------|
| `low` | Read-only, no auth/payment/DB impact | Updating a UI label, adding a log line |
| `medium` | Modifies backend logic, non-financial | Adding a new API route, updating a service |
| `high` | Touches auth, payments, DB schema, or tenant data | JWT change, new migration, invoice logic |
| `critical` | Cross-tenant risk, financial mutation, WhatsApp send, Rust flag, RLS | Any of the escalation-rules.md triggers |

---

## Classification Output Template

Claude Code must output this before starting any meaningful task:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
VANTRO CODE OS — TASK CLASSIFICATION
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Task:              [one-line description of what was asked]

Primary domain:    [single domain from list above]
Secondary domains: [additional domains, or "none"]
Risk level:        [low / medium / high / critical]

Agents activated:
  ▶ [agent name]   ← lead
  ▶ [agent name]
  ▶ [agent name]

Files to inspect:
  - [file path]
  - [file path]

Files likely to edit:
  - [file path]
  - [file path]

Feature flags affected:
  - [flag name] (current: true/false) — [impact]
  or "none"

Proof gates required:
  - [command] — [what it verifies]
  - [command] — [what it verifies]

Escalation triggered:  YES / NO
  If YES: reason + escalation-rules.md applies

Safe plan: [2-3 sentence summary of smallest safe change]

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

---

## Classification Examples

### Example 1 — Backend route change

**Task**: "Add a new endpoint to get cashflow projection"

```
Task:              Add GET /api/cashflow/projection endpoint
Primary domain:    backend
Secondary domains: cashops-collections, ai-agents-orchestration
Risk level:        medium

Agents activated:
  ▶ vantro-backend-api-engineer   ← lead
  ▶ vantro-cashops-domain-agent
  ▶ vantro-security-sentinel
  ▶ vantro-harness-x-verifier
  ▶ vantro-chief-architect

Files to inspect:
  - server.js (existing route patterns)
  - lib/services/agents/cashflowAgent.js
  - lib/services/orchestrator/cashflow.service.js
  - lib/featureFlags.js

Files likely to edit:
  - server.js (new route)
  - lib/services/agents/cashflowAgent.js (if logic change needed)

Feature flags affected:
  - FEATURE_CASHFLOW_FORECAST (current: false) — must be true to serve

Proof gates required:
  - node --check server.js
  - npm run security:cross-user (new route must be user-scoped)
  - npm run cortex:test (cashflow scenarios)

Escalation triggered:  NO

Safe plan: Add authenticated route, call cashflowAgent.js, return risk-adjusted
  projection. Gate behind FEATURE_CASHFLOW_FORECAST flag. Scope by req.user.id only.
```

---

### Example 2 — Rust flag enablement

**Task**: "Enable RUST_AUTOMATION_API_ENABLED"

```
Task:              Enable RUST_AUTOMATION_API_ENABLED in production
Primary domain:    rust-infrastructure
Secondary domains: auth-security, deployment
Risk level:        critical

Agents activated:
  ▶ vantro-rust-systems-engineer   ← lead
  ▶ vantro-chief-architect
  ▶ vantro-security-sentinel
  ▶ vantro-harness-x-verifier
  ▶ vantro-observability-reliability-agent
  ▶ vantro-launch-readiness-officer

Files to inspect:
  - lib/featureFlags.js
  - lib/services/rustAutomation/rustAutomationClient.js
  - vantro-automation-rs/src/auth.rs
  - vantro-automation-rs/tests/auth_cache_isolation.rs
  - vantro-automation-rs/tests/policy_guard_fir_regression.rs

Proof gates required:
  - npm run automation:test (ALL must pass)
  - auth_cache_isolation.rs PASS
  - Bootstrap <500ms measurement
  - npm run cortex:test (must still be 100%)
  - Node fallback verified when sidecar DOWN
  - npm run security:cross-user

Escalation triggered:  YES — Rust production enablement is a critical trigger

Safe plan: Run full /rust-gate checklist first. Only enable if ALL gates pass.
  Bootstrap must be under 500ms. auth_cache_isolation must pass. Harness must
  still be 100% after flag flipped in dev.
```

---

## Classification Triggers for Escalation

Immediately escalate to `critical` risk and activate `vantro-security-sentinel` + `vantro-database-rls-guardian` if task involves:

- Any authentication or JWT change
- Any payment or invoice amount mutation
- Any database migration
- Any cross-user data access pattern
- Any secrets or env var change
- Any RLS policy change
- Any WhatsApp/Twilio message sending enablement
- Any Rust production flag enablement
- Any deletion or cancellation logic

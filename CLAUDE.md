# Vantro Code OS — Backend Brain

## Auto-Agent Router — Read This First

**Before every meaningful task, Claude Code must read in this order:**

1. `.claude/signal-map.md` — file-path based routing (highest precision)
2. `.claude/risk-matrix.md` — calculate numeric risk score (0-100)
3. `.claude/speed-tracks.md` — select FAST ⚡ / STANDARD / ESCALATED ⚠️
4. `.claude/preflight.md` — run 10-point pre-flight checklist
5. `.claude/agent-router.md` — activate correct agents for the domain
6. `.claude/task-classifier.md` — output full classification brief
7. `.claude/agent-council.md` — collaborate and produce ONE consolidated plan
8. `.claude/escalation-rules.md` — if risk score ≥ 61 or trigger detected

**Strengthened from a third-party swarm by:**
file-path routing + numeric risk scoring + three speed tracks + pre-flight + Security Sentinel peer review + authority hierarchy + 22 June deadline in every decision

**Claude Code must not wait for the user to name agents.** It must automatically route every task to the correct Vantro specialist agents based on file paths, task domain, risk level, and 22 June launch-readiness impact.

### Trigger Phrases — Activate Auto-Agent Router Immediately

If the user says any of these, invoke the full Auto-Agent Router:
- "use Vantro Code OS"
- "think multidimensional"
- "no blind spots"
- "do this safely"
- "act like my team"
- "make this production ready"
- "22 June"
- "launch ready"
- "ship safe"

### Slash Commands Available
| Command | Purpose |
|---------|---------|
| `/auto` | Full automatic: classify → agents → inspect → plan → implement → verify → report |
| `/route-agents` | Classify and route only — no file edits |
| `/invoke-war-room` | All 14 agents, for critical/multidimensional tasks |
| `/proof-gate` | Run correct verification commands, report PASS/FAIL/SKIPPED/BLOCKED |
| `/ship-safe` | Pre-ship verification checklist |
| `/launch-readiness` | Full 22 June audit |
| `/security-gate` | Security review before deploy |
| `/harness-proof` | Run Cortex Lab and prove a feature |
| `/fix-with-tests` | Fix bug + write scenario proof |
| `/review-multidimensional` | 30-dimension review |
| `/cashops-review` | Collections domain review |
| `/rust-gate` | Rust flag enablement checklist |
| `/agent-readiness` | Agent production readiness check |
| `/no-blindspots` | Adversarial review |

---

## Identity

Vantro Flow is an **AI Business Automation OS / CashOps OS** for Indian MSMEs. Not SaaS. Not a dashboard. A living automation layer that makes owners know who owes money, who breaks promises, what cash is at risk, and what to do today.

**22 June 2026** is the launch-readiness deadline. Today is 30 May. 23 days.

---

## This Repository

`I:/Vantro/vantro-flow-backend` — main backend git repo, deployed to Railway.

Companion: `I:/Vantro/vantro-flow-frontend` — Next.js 14 frontend, deployed to Vercel.

**Archive (do not use):** `C:\Users\Dell\vantro-flow` — old version, not the real project.

---

## Actual Stack (Verified from Code)

| Layer | What's Actually Here | Status |
|-------|---------------------|--------|
| Backend | Node.js + Express (server.js monolith) | Live on Railway |
| Auth | JWT (jsonwebtoken + bcryptjs), cookie support (ENABLE_AUTH_COOKIES flag) | Implemented |
| Rate Limiting | express-rate-limit | Implemented |
| DB — Supabase | @supabase/supabase-js (service role key) | Live |
| DB — Direct | pg (direct Postgres, DATABASE_URL) | Live |
| RLS | Migration 006 written, **NOT applied** | Blocked: needs auth bridge |
| Payments | Razorpay integrated | Integrated |
| Messaging | Twilio (WhatsApp) — **TWILIO_WHATSAPP_NUMBER not set in Railway** | Blocked in prod |
| Push | web-push (VAPID) | Integrated |
| Metrics | prom-client (Prometheus, gated by METRICS_TOKEN) | Integrated |
| Cron | node-cron (background jobs) | Integrated |
| Rust: Scoring | cortex-core-rs (CLI binary: bin/cortex-core.exe) | Built, **flag OFF** |
| Rust: Sidecar | vantro-automation-rs (Axum HTTP port 3002) | Built, **flag OFF** |
| Harness X | cortex-lab/ — 37 scenarios, **100% static pass** | Passing |
| CI | 6 GitHub Actions workflows | Active |
| Feature Flags | lib/featureFlags.js — env-driven, Cortex flags default OFF | Implemented |
| Observability | lib/observability/ (logger.js, error-tracking.js) | Implemented |
| Cache | lib/cache/cache.service.js | Implemented |
| Events | lib/events/EventEngine.js | Implemented |
| Orchestrator | lib/services/orchestrator/ (14 services) | Implemented |
| AI Agents | lib/services/agents/ (7 JS agents) | Implemented |
| Security Env | validateSecurityEnvironment() on startup — fails fast if JWT_SECRET missing | Implemented |

---

## Directory Map

```
vantro-flow-backend/
├── server.js                             # Express monolith — auth, routes, all middleware
├── lib/
│   ├── featureFlags.js                   # All feature flags (isEnabled, FLAGS)
│   ├── businessContext.js                # Business context loader
│   ├── cache/cache.service.js            # In-memory cache layer
│   ├── config/supabaseClient.js          # Supabase service role init
│   ├── db/pg.js                          # Direct Postgres via pg
│   ├── events/EventEngine.js             # Async event bus
│   ├── observability/
│   │   ├── logger.js                     # Structured logging
│   │   └── error-tracking.js             # Error capture + alerting
│   └── services/
│       ├── agents/                       # 7 JS AI agents
│       │   ├── briefingAgent.js          # Daily owner briefing
│       │   ├── cashflowAgent.js          # Cash projection
│       │   ├── collectionsAgent.js       # Priority scoring + recommendations
│       │   ├── creditRiskAgent.js        # Credit risk scoring
│       │   ├── dataQualityAgent.js       # Data quality scanning
│       │   ├── evaluationAgent.js        # Outcome evaluation / learning loop
│       │   └── inventoryAgent.js         # Inventory-cash pressure
│       ├── orchestrator/                 # 14 orchestrator services
│       │   ├── orchestrator.service.js   # Master orchestrator
│       │   ├── policyGuard.service.js    # Policy enforcement (safety layer)
│       │   ├── promptGuard.service.js    # Prompt injection / unsafe content defense
│       │   ├── aiPlanner.service.js      # AI plan generation
│       │   ├── llmPlanner.service.js     # LLM-backed planner (FEATURE_AGENT_PLANNER_ENABLED)
│       │   ├── action.service.js         # Action execution
│       │   ├── audit.service.js          # Audit event logging
│       │   ├── cashflow.service.js       # Cashflow calculation
│       │   ├── commandBus.service.js     # Command routing
│       │   ├── event.service.js          # Event handling
│       │   ├── idempotency.service.js    # Idempotency keys
│       │   ├── rules.service.js          # Business rules evaluation
│       │   ├── scoring.service.js        # Customer scoring
│       │   ├── simulationEngine.service.js  # Simulation (FEATURE_SIMULATION_ENGINE_ENABLED)
│       │   └── toolRegistry.service.js   # Agent tool definitions
│       ├── cortexCore/rustCore.service.js       # Node wrapper → Rust CLI binary
│       └── rustAutomation/rustAutomationClient.js  # Node wrapper → Rust Axum sidecar
├── cortex-core-rs/                       # Rust Milestone A: deterministic scoring
│   └── src/ errors.rs lib.rs main.rs policy.rs scoring.rs simulation.rs types.rs
├── vantro-automation-rs/                 # Rust Milestone B: Axum HTTP sidecar
│   ├── src/
│   │   ├── agents/ (mod.rs, registry.rs, types.rs)
│   │   ├── api/ (bootstrap, cost, health, policy, scoring, simulate)
│   │   ├── cache/ (keys.rs, memory.rs)
│   │   ├── cashops/ (collection_priority, credit_control, payment_behavior, timing_engine, tone_engine)
│   │   ├── cortex/ (action_engine, cost_engine, policy_guard, scoring, simulator)
│   │   ├── db/ (mod.rs, pool.rs, queries.rs)
│   │   ├── events/ (mod.rs, publisher.rs, types.rs)
│   │   ├── harness/ (assertions.rs)
│   │   ├── auth.rs, config.rs, error.rs, telemetry.rs, lib.rs, main.rs
│   └── tests/ auth_cache_isolation.rs, policy_guard_fir_regression.rs
├── cortex-lab/                           # Harness X proof system
│   ├── run.js                            # npm run cortex:test
│   ├── scenarios/                        # 37 JSON scenarios (8 domains)
│   │   ├── ai-safety/     (6 scenarios)
│   │   ├── cashflow/      (3 scenarios)
│   │   ├── collections/   (7 scenarios)
│   │   ├── inventory/     (3 scenarios)
│   │   ├── learning/      (5 scenarios)
│   │   ├── orchestration/ (5 scenarios)
│   │   ├── risk/          (4 scenarios)
│   │   └── security/      (4 scenarios)
│   ├── reports/latest.md                 # Last run: 100% static pass (2026-05-30)
│   └── results/latest.json
├── migrations/                           # 6 SQL migrations (applied sequentially)
│   ├── 001_cortex_foundation.sql
│   ├── 002_cortex_extension.sql
│   ├── 003_evaluation.sql
│   ├── 004_schema_repair.sql
│   ├── 005_cortex_x_extensions.sql
│   └── 006_cortex_rls.sql               # RLS — NOT applied (needs auth bridge)
├── scripts/
│   ├── sec_os/                           # 50+ security policy documents
│   ├── cross-user-security-test.js
│   ├── security-smoke-test.js
│   ├── security-secret-scan.js
│   └── rust-live-harness.js
├── .github/workflows/                    # 6 CI workflows
│   ├── node-fallback-ci.yml
│   ├── rust-automation-ci.yml
│   ├── rust-live-harness.yml
│   ├── rust-sqlx-validation.yml
│   ├── security-baseline.yml
│   ├── security.yml
│   └── smoke.yml
├── bin/cortex-core.exe                   # Built Rust binary
└── .claude/                              # Vantro Code OS repo-brain
    ├── agents/   (14 agent definitions)
    ├── skills/   (10 domain skills)
    └── commands/ (10 slash commands)
```

---

## Feature Flag Status (lib/featureFlags.js)

All flags default OFF unless explicitly set in Railway env. Enable without redeploying logic.

| Flag | Default | Gate to Enable |
|------|---------|---------------|
| FEATURE_CORTEX_ENABLED | OFF | When orchestrator verified in staging |
| FEATURE_AI_ACTION_CENTER | OFF | When UI wired + policy guard tested |
| FEATURE_CUSTOMER_SCORING | OFF | When scoring.service.js verified |
| FEATURE_PROMISE_CHECKER | OFF | When cron + promises table verified |
| FEATURE_CASHFLOW_FORECAST | OFF | When cashflow agent verified |
| FEATURE_LOW_STOCK_ALERTS | OFF | When inventory agent verified |
| FEATURE_CREDIT_RISK_WARNING | OFF | When credit risk agent verified |
| FEATURE_AI_MESSAGE_DRAFTS | OFF | When message drafts tested |
| FEATURE_MEMORY_ENABLED | OFF | When business_memory schema verified |
| FEATURE_AGENT_PLANNER_ENABLED | OFF | When LLM planner cost measured |
| FEATURE_SIMULATION_ENGINE_ENABLED | OFF | When simulation engine tested |
| FEATURE_EXTERNAL_MESSAGE_SENDING_ENABLED | **OFF** | After owner approval gate wired + TWILIO number set |
| FEATURE_CORTEX_LAB_ENABLED | OFF | Dev/staging only |
| FEATURE_PROMPT_GUARD_ENABLED | **ON** | Default ON — never disable |
| FEATURE_LEARNING_LOOP_ENABLED | OFF | When evaluation agent verified |
| FEATURE_WORKFLOW_RUNNER_ENABLED | OFF | When workflow_runs schema verified |
| RUST_CORTEX_CORE_ENABLED | **OFF** | cargo test + parity + harness pass |
| RUST_AUTOMATION_API_ENABLED | **ON (prod + staging)** | Enabled Phase 2C.15/2C.16; prod Node → dedicated `vantro-automation-prod` sidecar, staging Node → `vantro-automation-staging` |
| FEATURE_OWNER_BRIEFING_AGENT_ENABLED | **ON (production canary)** | Phase 2C.15 rollout; Phase 2C.16 dedicated prod Rust sidecar; **GA pending clean 24h canary** (Phase 2C.17). RAG Evidence Contract enforced; rollback = set this OFF |

---

## Harness X Status (cortex-lab/)

**Last run: 2026-05-30 | Mode: static | Score: 100/100**

| Category | Score | Tests | Gate |
|----------|-------|-------|------|
| policy_safety | 100% | 17 | 100% ✅ |
| ai_hallucination_block | 100% | 39 | 100% ✅ |
| event_audit_completeness | 100% | 37 | 95% ✅ |
| orchestration | N/A | 0 | needs live env |
| business_isolation | N/A | 0 | needs live env |
| approval_gate_safety | N/A | 0 | needs live env |
| financial_data_integrity | N/A | 0 | needs live env |
| learning_loop_quality | N/A | 0 | needs live env |
| action_quality | N/A | 0 | needs live env |

**To run Harness X:**
```bash
npm run cortex:test           # static (fast, no DB needed)
npm run cortex:test:dry       # dry-run (no DB writes)
npm run cortex:test:live      # live (needs TEST_BASE_URL + SUPABASE test creds)
npm run cortex:test:redteam   # adversarial
npm run cortex:test:all       # all modes
npm run cortex:harness:loop   # continuous loop
```

---

## Rust Status

**cortex-core-rs** (CLI binary, `bin/cortex-core.exe`):
- scoring.rs, simulation.rs, policy.rs, types.rs, errors.rs
- Node wrapper: `lib/services/cortexCore/rustCore.service.js`
- Flag: `RUST_CORTEX_CORE_ENABLED=false`
- Enable gate: `npm run cortex:rust:test` passes + parity test + harness pass

**vantro-automation-rs** (Axum HTTP sidecar, port 3002):
- cashops: collection_priority, credit_control, payment_behavior, timing_engine, tone_engine
- cortex: action_engine, cost_engine, policy_guard, scoring, simulator
- api: bootstrap, cost, health, policy, scoring, simulate
- Node wrapper: `lib/services/rustAutomation/rustAutomationClient.js`
- Flag: `RUST_AUTOMATION_API_ENABLED=false`
- Enable gate: `npm run automation:test` passes + bootstrap <500ms + harness pass

```bash
npm run cortex:rust:check     # cargo check cortex-core
npm run cortex:rust:test      # cargo test cortex-core
npm run automation:check      # cargo check vantro-automation
npm run automation:test       # cargo test vantro-automation
npm run rust:test:all         # cargo test entire workspace
npm run rust:build:all        # cargo build --release
```

---

## Critical Gaps (22 June Blockers)

| Gap | Impact | Fix |
|-----|--------|-----|
| TWILIO_WHATSAPP_NUMBER not set in Railway | WhatsApp completely blocked | Set in Railway env |
| RLS 006 not applied | Defence-in-depth gap | Design auth bridge first |
| Live Harness X not running | 5 N/A categories unverified | Set TEST_BASE_URL + test Supabase |
| Rust flags OFF | Cortex CPS/simulation not deterministic yet | cargo test + parity pass |
| FEATURE_EXTERNAL_MESSAGE_SENDING_ENABLED=false | No WhatsApp sends | Keep OFF until owner approval gate wired |
| Milestone C not started | Collections AI + Action Center not built | Priority work for June |

---

## Hard Engineering Rules

1. **Never trust user_id from the browser** — source ONLY from JWT payload (`req.user.id` from auth middleware)
2. **Protect tenant isolation** — every DB query scoped by `user_id = req.user.id`
3. **Never create fake green status** — no tests = UNKNOWN, not PASS
4. **Never delete migrations, env files, security configs** without explicit reason
5. **Never weaken auth, RLS, CSRF, CORS, JWT validation, or cache scoping**
6. **Prefer idempotent logic** for payments, invoices, reconciliation, AI actions
7. **No external message** (Twilio/WhatsApp) without `FEATURE_EXTERNAL_MESSAGE_SENDING_ENABLED=true` AND owner approval
8. **No Rust production enablement** without: cargo test pass + parity verified + harness pass + Node fallback confirmed
9. **No AI action** can mark payment received, change amount, delete records, or bypass policy
10. **Feature flags protect every risky feature** — never ship unguarded
11. **promptGuard.service.js gates all AI** — never bypass prompt guard
12. **policyGuard.service.js gates all risky actions** — every agent action goes through policy

---

## Decision Framework (Before Every Change)

1. Does this make Vantro launch-ready by 22 June?
2. Does this protect real business data and tenant isolation?
3. Does this improve owner workflow (action-first, mobile-first)?
4. Does this have tests or Harness X proof?
5. Does this break or require a feature flag change?
6. Is this a Rust change? Does it pass the Rust gate?
7. Is there a migration? Is it safe to apply without downtime?
8. Does this need a rollback path?
9. Does this accidentally enable external message sending?
10. Would this embarrass Vantro if a customer saw it fail in production?

---

## Domain Algorithms (Never Delete or Break)

- **Payment Behavior Engine** — scores how a customer pays
- **Collection Priority Index** — ranks who to call first
- **Credit Control Engine** — calculates credit risk
- **Tone Intelligence Engine** — selects message tone (tone_engine.rs)
- **Timing Intelligence Engine** — selects best contact time (timing_engine.rs)
- **Behavioral Receivables Graph** — maps customer payment patterns
- **Credit Exposure Simulation** — simulates credit limit risk
- **Cash Pressure Layer** — calculates owner's cash pressure from overdue
- **Dispute Safety Layer** — halts collection on disputed invoices
- **Learning Loop** — evaluationAgent feeds outcomes back to memory

---

## Behavior Metrics (Track Accurately, Never Approximate)

```
average_delay_days     max_delay_days         promise_reliability
broken_promise_count   broken_promise_velocity partial_payment_ratio
silence_days           response_speed          dispute_frequency
owner_call_dependency  polite_reminder_success firm_reminder_success
month_end_excuse_pattern  credit_abuse_risk    customer_value
relationship_risk      followup_fatigue        cash_pressure_sensitivity
best_reply_time        best_payment_day        preferred_channel
staff_vs_owner_response
```

---

## HighRadius Benchmark

HighRadius: enterprise autonomous finance / Order-to-Cash for CFO teams. Complex onboarding, expensive, email-first, built for finance teams.

Vantro must beat it on:
- Setup time: **<5 minutes** (vs HighRadius weeks)
- **WhatsApp-first** vs email-first
- **₹2,000-5,000/month** MSME pricing vs enterprise
- **Owner-led decisions** vs delegated finance team
- **Tally/CSV-first** onboarding vs complex integration
- **Behavior-aware** collections vs rule-based dunning
- **Daily habit loop** (/today page) vs quarterly reports

---

## npm Scripts Reference

```bash
# Harness X
npm run cortex:test           # static
npm run cortex:test:all       # all modes
npm run cortex:harness:loop   # continuous

# Rust
npm run cortex:rust:test      # cortex-core tests
npm run automation:test       # vantro-automation tests
npm run rust:test:all         # all workspace tests
npm run rust:build:all        # release build

# Security
npm run security:secrets      # scan for leaked secrets
npm run security:cross-user   # cross-tenant isolation test
npm run security:smoke        # smoke test auth/routes

# Performance
npm run perf:test             # performance-lab/run.js

# Dev
npm run dev                   # nodemon server.js
npm start                     # node server.js
npm run check                 # node --check server.js
```

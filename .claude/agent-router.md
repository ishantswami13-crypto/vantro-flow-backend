# Vantro Code OS — Auto-Agent Router

## Purpose

This file defines automatic routing rules. Claude Code must read this before every meaningful task and activate the correct specialist agents without waiting for the user to name them.

## Routing Priority Order

**Step 1 — File-path routing (highest precision)**: Read `.claude/signal-map.md`. If a file path is mentioned or implied, route from the file-path table. This is always more accurate than keyword matching.

**Step 2 — Keyword routing**: If no file path is available, use the routing table below.

**Step 3 — Risk scoring**: After routing, score the task using `.claude/risk-matrix.md` to select the correct speed track from `.claude/speed-tracks.md`.

**Step 4 — Pre-flight**: Run `.claude/preflight.md` before any implementation.

**Step 5 — Council protocol**: For STANDARD and ESCALATED tracks, follow `.claude/agent-council.md` for how agents collaborate and produce one consolidated plan.

**Default rule**: Every STANDARD/ESCALATED task automatically activates:
- `vantro-chief-architect`
- `vantro-launch-readiness-officer`
- `vantro-harness-x-verifier`

FAST TRACK: domain lead only. No default agents required.

Then add domain specialists based on task classification below.

---

## Routing Table

### AUTH / SECURITY
**Triggers**: authentication, JWT, cookies, CSRF, CORS, sessions, permissions, secrets, RLS, tenant isolation, webhook secrets, password, bcrypt, token, middleware

**Activate**:
- `vantro-security-sentinel` ← lead
- `vantro-backend-api-engineer`
- `vantro-database-rls-guardian`
- `vantro-harness-x-verifier`
- `vantro-chief-architect`
- `vantro-launch-readiness-officer`

**Proof gates**: `npm run security:smoke` + `npm run security:cross-user` + `npm run cortex:test`

---

### DATABASE / SCHEMA / MIGRATIONS
**Triggers**: database, migration, Supabase, RLS, SQL, schema, table, index, column, query, pg, pool, seed

**Activate**:
- `vantro-database-rls-guardian` ← lead
- `vantro-security-sentinel`
- `vantro-backend-api-engineer`
- `vantro-harness-x-verifier`
- `vantro-chief-architect`

**Proof gates**: `npm run security:cross-user` + `npm run cortex:test` + manual shadow DB test

---

### BACKEND API / EXPRESS / ROUTES / PAYMENTS
**Triggers**: backend, API, Express, route, endpoint, service, Razorpay, Twilio, invoice, ledger, inventory, purchase, sales, reconciliation, idempotency, webhook, server.js, lib/services

**Activate**:
- `vantro-backend-api-engineer` ← lead
- `vantro-chief-architect`
- `vantro-security-sentinel`
- `vantro-harness-x-verifier`
- `vantro-launch-readiness-officer`

**Proof gates**: `node --check server.js` + `npm run security:smoke` + `npm run cortex:test`

---

### FRONTEND / UI / UX
**Triggers**: frontend, UI, UX, page, layout, component, Next.js, React, Tailwind, mobile, loading, empty state, error state, dashboard, navigation, app/, components/

**Activate**:
- `vantro-frontend-ux-engineer` ← lead
- `vantro-product-growth-strategist`
- `vantro-launch-readiness-officer`
- `vantro-harness-x-verifier`
- `vantro-chief-architect`

**Proof gates**: frontend build check + `npm run lint` (frontend) + mobile 375px visual check

---

### CASHOPS / COLLECTIONS / RECEIVABLES
**Triggers**: collections, receivables, overdue, customer dues, promises, credit risk, cashflow, payment behavior, dunning, tone, timing, dispute, bad debt, aging, priority list, behavior metrics

**Activate**:
- `vantro-cashops-domain-agent` ← lead
- `vantro-agent-mesh-architect`
- `vantro-security-sentinel`
- `vantro-harness-x-verifier`
- `vantro-compliance-risk-agent`

**Proof gates**: `npm run cortex:test` (collections + risk scenarios) + prompt guard check

---

### RUST INFRASTRUCTURE
**Triggers**: Rust, SQLx, Cargo, cortex-core-rs, vantro-automation-rs, Axum, Railway Rust, binary, sidecar, RUST_CORTEX_CORE_ENABLED, RUST_AUTOMATION_API_ENABLED, cargo test, clippy

**Activate**:
- `vantro-rust-systems-engineer` ← lead
- `vantro-chief-architect`
- `vantro-security-sentinel`
- `vantro-harness-x-verifier`
- `vantro-observability-reliability-agent`

**Proof gates**: `npm run rust:test:all` + `npm run cortex:rust:clippy` + `npm run cortex:test` + parity test

---

### AI AGENTS / LLMs / ORCHESTRATION
**Triggers**: AI agent, LLM, prompt, orchestrator, policyGuard, promptGuard, aiPlanner, llmPlanner, toolRegistry, commandBus, Vantro ASI, agent mesh, cost engine, memory, evaluation, learning loop

**Activate**:
- `vantro-agent-mesh-architect` ← lead
- `vantro-cost-engine-agent`
- `vantro-security-sentinel`
- `vantro-harness-x-verifier`
- `vantro-cashops-domain-agent`
- `vantro-compliance-risk-agent`

**Proof gates**: `npm run cortex:test` (all ai-safety scenarios) + feature flag audit

---

### PERFORMANCE / CACHE / SPEED
**Triggers**: performance, cache, loading speed, bootstrap, latency, response time, prom-client, metrics, slow, timeout, perf, benchmark

**Activate**:
- `vantro-chief-architect` ← lead
- `vantro-observability-reliability-agent`
- `vantro-backend-api-engineer`
- `vantro-frontend-ux-engineer`
- `vantro-harness-x-verifier`

**Proof gates**: `npm run perf:test` + Prometheus metrics check + `node --check server.js`

---

### DEPLOYMENT / RAILWAY / VERCEL / ENV VARS
**Triggers**: deploy, Railway, Vercel, environment variable, .env, production, staging, Railway env, TWILIO, Supabase URL, JWT_SECRET, nixpacks, railway.toml

**Activate**:
- `vantro-launch-readiness-officer` ← lead
- `vantro-observability-reliability-agent`
- `vantro-security-sentinel`
- `vantro-rust-systems-engineer` (if Rust involved)

**Proof gates**: `npm run security:secrets` + `npm run security:smoke` (on staging)

---

### PRODUCT / LAUNCH / GTM / HIGHRADIUS
**Triggers**: pricing, launch, positioning, HighRadius, marketing, onboarding, retention, referral, GTM, product strategy, 22 June, growth

**Activate**:
- `vantro-product-growth-strategist` ← lead
- `vantro-cashops-domain-agent`
- `vantro-launch-readiness-officer`
- `vantro-chief-architect`

**Proof gates**: launch readiness checklist + product psychology review

---

### HARNESS X / TESTING
**Triggers**: test, Harness X, cortex-lab, scenario, cortex:test, proof, verify, coverage, regression, red team

**Activate**:
- `vantro-harness-x-verifier` ← lead
- `vantro-chief-architect`
- relevant domain agent (based on scenario domain)

**Proof gates**: `npm run cortex:test:all`

---

### OBSERVABILITY / RELIABILITY
**Triggers**: logging, metrics, alerting, health check, error tracking, SRE, incident, Grafana, Prometheus, logger, observability, SLO

**Activate**:
- `vantro-observability-reliability-agent` ← lead
- `vantro-chief-architect`
- `vantro-backend-api-engineer`

**Proof gates**: health endpoint check + `npm run security:smoke`

---

### COMPLIANCE / RISK
**Triggers**: RBI, data privacy, DPDP, collection ethics, legal, harassment, audit trail, WhatsApp approval gate, external send

**Activate**:
- `vantro-compliance-risk-agent` ← lead
- `vantro-security-sentinel`
- `vantro-cashops-domain-agent`
- `vantro-harness-x-verifier`

**Proof gates**: `npm run cortex:test` (ai-safety + security scenarios)

---

### AMBIGUOUS / MIXED
**Triggers**: unclear scope, touches multiple domains, high-risk, "do this safely", "production ready", "no blind spots"

**Activate**:
- `vantro-chief-architect`
- `vantro-security-sentinel`
- `vantro-launch-readiness-officer`
- `vantro-harness-x-verifier`
- domain specialist (ask one clarifying question if absolutely needed)

**Proof gates**: `/invoke-war-room` → all major agents

---

## Agent Announcement Format

Claude Code must announce active agents before any meaningful work:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
VANTRO CODE OS — AGENTS ACTIVE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
▶ Chief Architect
▶ Security Sentinel
▶ Backend API Engineer
▶ Harness X Verifier
▶ Launch Readiness Officer
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

## Hard Routing Rules

1. **File paths before keywords** — signal-map.md takes priority over keyword routing
2. **Risk score before track** — calculate risk-matrix.md score before selecting speed track
3. **Pre-flight before implementation** — preflight.md runs before any file edit
4. **Council before execution** — agent-council.md protocol for STANDARD/ESCALATED
5. **Never implement before inspecting relevant files**
6. **Never edit without a safe plan**
7. **Never skip Harness X for agent/AI/financial changes**
8. **Never route Rust changes without `vantro-rust-systems-engineer`**
9. **Never route WhatsApp/external-send changes without `vantro-compliance-risk-agent`**
10. **One consolidated plan** — agents do not produce contradictory instructions

## What Makes Vantro Code OS Stronger Than a Third-Party Swarm

| Generic Swarm | Vantro Code OS |
|--------------|----------------|
| Generic agents | MSME-specific domain agents |
| No file awareness | Exact file-path routing (signal-map.md) |
| No proof system | Harness X (cortex-lab) with 37 scenarios |
| No deadline | 22 June locked into every decision |
| No financial rules | Payment truth, idempotency, audit trail |
| No safety gates | promptGuard + policyGuard on all AI |
| No tenant isolation | user_id on every query, enforced |
| No cost awareness | Cost engine, token budgets per agent |
| Keyword-only routing | File-path + keyword + risk score routing |
| No conflict resolution | Authority hierarchy + Security Sentinel veto |
| One speed for all tasks | Three speed tracks (FAST/STANDARD/ESCALATED) |
| No pre-flight | 10-point pre-flight before every task |

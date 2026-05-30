# Vantro Architecture Skill

## Overview

Use this skill when designing new systems, reviewing architectural trade-offs, planning feature additions across layers, or evaluating technology choices for Vantro Flow.

Trigger: "design", "architect", "where should this logic live", "how should we structure", "what's the right pattern for", "planning Milestone C", "event-driven", "cache strategy", "feature flag design".

## What This Skill Does

1. **Reads current architecture reality** from real files (not assumptions)
2. **Identifies the smallest safe change** with highest impact
3. **Evaluates trade-offs** across Node / Rust / Frontend / DB / Agents
4. **States feature flag impact** — which flags needed, which flags must NOT change
5. **Produces deployment + rollback plan** before recommending any change

## Vantro Architecture Reality

**Backend monolith**: `I:/Vantro/vantro-flow-backend/server.js` — Express, JWT, rate limiting, Razorpay, Twilio, prom-client, node-cron, Supabase + pg

**Service layer**: `lib/services/`
- `orchestrator/` (14 services) — the intelligence backbone
- `agents/` (7 agents) — dedicated AI agents
- `cortexCore/` — Node wrapper for Rust CLI
- `rustAutomation/` — Node wrapper for Rust Axum sidecar

**Rust layer** (flags OFF): cortex-core-rs (CLI) + vantro-automation-rs (Axum HTTP)
**Database**: Supabase Postgres (service role key), 6 migrations applied
**Cache**: `lib/cache/cache.service.js` — in-memory (single instance)
**Events**: `lib/events/EventEngine.js`
**Feature flags**: `lib/featureFlags.js` — 18 flags, all Cortex flags OFF

**Frontend**: Next.js 14 App Router, TypeScript, Tailwind, React Query, 40+ pages, Cookie auth

## Architecture Principles

| Principle | Rule |
|-----------|------|
| React is control room | UI shows state and offers actions — it never owns business logic |
| Node is product backend | Express handles all API, orchestration, agent execution |
| Rust is deterministic layer | Scoring, simulation, policy — only when tested and gated |
| Postgres is source of truth | AI outputs are suggestions, DB is truth |
| Harness X is proof | No feature is done without cortex-lab scenario |
| Feature flags protect launch | Every risky feature off by default |
| Tenant isolation is absolute | user_id on every query, no exceptions |

## Layer Decision Guide

**Should this logic go in...**

| Logic Type | Layer | Why |
|-----------|-------|-----|
| Route handling, auth, CORS | server.js | Express owns HTTP |
| Business rules, DB queries | lib/services/ | Modular, testable |
| Complex scoring, simulation | cortex-core-rs | Rust when proven |
| HTTP sidecar features | vantro-automation-rs | Rust when proven |
| Agent orchestration | lib/services/orchestrator/ | Dedicated services |
| AI agent execution | lib/services/agents/ | Per-agent isolation |
| User-facing UI | Next.js app/ | Owner-first UX |
| Data fetching | React Query + lib/api.ts | Client state management |

## Milestone C Architecture

Next major build: **Collections AI + Action Center**

```
Daily cron OR owner trigger
  → orchestrator.service.js
  → collectionsAgent.js (score all overdue)
  → creditRiskAgent.js (flag credit blocks)
  → cashflowAgent.js (project impact)
  → briefingAgent.js (build action queue)
  → /api/ai-actions endpoint
  → app/ai-actions/page.tsx (owner sees and approves)
  → owner approves → action.service.js → (message drafted or sent)
  → evaluationAgent.js (tracks outcome)
```

Feature flags needed: FEATURE_AI_ACTION_CENTER, FEATURE_CORTEX_ENABLED

## Output Format

1. Current architecture state (from real files)
2. Biggest architectural risk to 22 June deadline
3. Recommended change (smallest safe, highest leverage)
4. What must be verified after change
5. Feature flags affected
6. Deployment + rollback safety
7. Verdict: RECOMMENDED / DEFER / DO NOT DO

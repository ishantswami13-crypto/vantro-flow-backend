# /agent-readiness

Review an agent for production readiness before enabling its feature flag.

## What This Command Does

Checks a specific agent against Vantro's agent readiness requirements. No agent goes live without all requirements met.

## Agent Readiness Checklist

For an agent at `lib/services/agents/[name]Agent.js`:

### Identity + Mission
- [ ] Single mission (not multi-purpose)
- [ ] `agent_id` defined and unique
- [ ] Mission statement in code comment

### Feature Flag Gate
- [ ] Corresponding flag in `lib/featureFlags.js`
- [ ] Agent returns null/no-op when flag is OFF
- [ ] Flag is `false` in Railway (default)

### Policy Guard
- [ ] Every risky action passes through `policyGuard.service.js`
- [ ] Blocked actions return structured response (not throw)
- [ ] Policy decisions logged to audit_logs

### Prompt Guard
- [ ] All raw user input through `promptGuard.service.js` before LLM call
- [ ] AI output validated before returning to caller
- [ ] FEATURE_PROMPT_GUARD_ENABLED respected

### Audit Trail
- [ ] Every action logged via `audit.service.js`
- [ ] Audit events: action_executed, action_blocked, action_failed at minimum
- [ ] `user_id` included in every audit event (from JWT, not from request body)

### Tenant Isolation
- [ ] All DB queries scoped by `user_id` from JWT
- [ ] No cross-tenant data in inputs or outputs
- [ ] `npm run security:cross-user` passes

### Cost Budget
- [ ] Max token budget defined per invocation
- [ ] LLM calls use appropriate model for task quality requirement
- [ ] Cost logged per invocation

### Idempotency (If Financial)
- [ ] Uses `idempotency.service.js` for financial actions
- [ ] Safe to call twice without double-execution

### Harness X Coverage
- [ ] At least one scenario in `cortex-lab/scenarios/` domain for this agent
- [ ] `npm run cortex:test` — scenario passes

### Node Fallback (If Rust-backed)
- [ ] Node JS implementation works when Rust flag is OFF
- [ ] Rust path is optional enhancement, not required dependency

## Agent Readiness Report

```
Agent: [agent file name]
Feature flag: FEATURE_[NAME]_ENABLED
Flag default: false ✅

Policy guard: WIRED / MISSING
Prompt guard: WIRED / MISSING
Audit events: COMPLETE / INCOMPLETE
Tenant isolation: VERIFIED / UNVERIFIED
Cost budget: DEFINED / MISSING
Idempotency: N/A / VERIFIED / MISSING
Harness X: [scenario name] — PASSING / MISSING

Agent verdict: READY / NOT READY
Blockers: [list or "none"]
Safe to enable feature flag: YES / NO
```

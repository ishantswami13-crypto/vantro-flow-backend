# Vantro Agentic Systems Skill

## Overview

Use this skill when building, reviewing, or debugging agents, the orchestrator, policyGuard, promptGuard, aiPlanner, toolRegistry, or planning new agent capabilities.

Trigger: "agent", "orchestrator", "policyGuard", "promptGuard", "toolRegistry", "action center", "agent mesh", "collections agent", "briefing agent", "Action Center", "Milestone C".

## What This Skill Does

1. Reviews agent design against Vantro's agent requirements
2. Verifies Policy Guard integration
3. Verifies Prompt Guard integration
4. Checks audit trail completeness
5. Checks feature flag gate
6. Verifies Harness X scenario exists
7. Issues AGENT READY / AGENT NOT READY verdict

## Agent Requirements Checklist

Every agent must have:
- [ ] Single mission (not multi-purpose)
- [ ] Feature flag gate (agent disabled when flag OFF)
- [ ] `policyGuard.service.js` check before any risky action
- [ ] `promptGuard.service.js` on all LLM input
- [ ] `audit.service.js` logging for all actions
- [ ] `toolRegistry.service.js` tool definitions
- [ ] `idempotency.service.js` for financial actions
- [ ] Cost budget defined and enforced
- [ ] At least one `cortex-lab/scenarios/` scenario
- [ ] Node fallback when Rust flag OFF

## Current Agents (lib/services/agents/)

| Agent | Flag | Status |
|-------|------|--------|
| briefingAgent.js | FEATURE_CORTEX_ENABLED | Implemented |
| cashflowAgent.js | FEATURE_CASHFLOW_FORECAST | Implemented |
| collectionsAgent.js | FEATURE_CUSTOMER_SCORING | Implemented |
| creditRiskAgent.js | FEATURE_CREDIT_RISK_WARNING | Implemented |
| dataQualityAgent.js | FEATURE_CORTEX_ENABLED | Implemented |
| evaluationAgent.js | FEATURE_LEARNING_LOOP_ENABLED | Implemented |
| inventoryAgent.js | FEATURE_LOW_STOCK_ALERTS | Implemented |

## Orchestrator Services (lib/services/orchestrator/)

Key services every agent must integrate with:
- `policyGuard.service.js` — gate all risky actions
- `promptGuard.service.js` — sanitize all AI input
- `audit.service.js` — log all actions
- `toolRegistry.service.js` — define agent tools
- `idempotency.service.js` — deduplicate financial actions
- `commandBus.service.js` — route commands

## Agent Action Pattern

```javascript
// Required pattern for every agent action
async function agentAction(context) {
  const { user_id } = context; // ALWAYS from JWT, never from request body

  // 1. Feature flag check
  if (!isEnabled('feature_flag_name')) return null;

  // 2. Policy check
  const decision = await policyGuard.check({ action: 'action_name', context });
  if (!decision.allowed) {
    await audit.log({ event: 'action_blocked', reason: decision.reason, user_id });
    return { blocked: true, reason: decision.reason };
  }

  // 3. Prompt sanitization (if LLM call follows)
  const safeInput = await promptGuard.sanitize(context.rawInput);

  // 4. Execute
  const result = await performLogic(safeInput, context);

  // 5. Audit
  await audit.log({ event: 'action_executed', result, user_id, agent_id: 'agent-name' });

  return result;
}
```

## Milestone C: Action Center Pattern

```
FEATURE_AI_ACTION_CENTER=true + FEATURE_CORTEX_ENABLED=true

POST /api/orchestrate/run-daily-analysis
  → collectionsAgent (score all overdue)
  → creditRiskAgent (flag blocks)
  → cashflowAgent (project impact)
  → briefingAgent (build action queue)
  → store in ai_actions table

GET /api/ai-actions
  → return action queue for /ai-actions page

POST /api/ai-actions/:id/approve
  → policyGuard.check({ action: 'approve_message' })
  → action.service.execute()
  → audit.log({ event: 'action_approved' })
  → (if FEATURE_EXTERNAL_MESSAGE_SENDING_ENABLED=true) → Twilio send
```

## Verdict Format

Agent: READY / NOT READY
Missing: [list any missing requirements]
Policy guard: WIRED / MISSING
Prompt guard: WIRED / MISSING
Audit: COMPLETE / INCOMPLETE
Harness X: COVERED / UNCOVERED
Feature flag: SET / MISSING
Safe to enable flag: YES / NO

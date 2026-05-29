// FILE: lib/services/orchestrator/orchestrator.service.js
// The Vantro Orchestration Engine — main pipeline facade.
//
// Every business command flows through runCommand():
//   user action → businessLogicFn() → persist event → evaluate rules → create actions → audit log
//
// Milestone A: dark mode — only runs if FEATURE_CORTEX_ENABLED=true.
//              businessLogicFn executes regardless (no behaviour change to live code).
// Milestone B: adds real DB transactions via pg.js withTransaction().
//
// IMPORTANT: orchestrator side-effects (events, rules, actions, audit) must NEVER throw
// back to the caller — they are fire-and-observe. Business logic errors still propagate.

const eventService   = require('./event.service');
const auditService   = require('./audit.service');
const policyGuard    = require('./policyGuard.service');
const actionService  = require('./action.service');
const rulesService   = require('./rules.service');
const { isEnabled }  = require('../../featureFlags');
const { safeLog }    = require('../../observability/logger');

/**
 * Run a business command through the full orchestration pipeline.
 *
 * @param {string}   userId         - Authenticated user/tenant ID
 * @param {string}   commandType    - e.g. 'SALE_CREATED', 'PAYMENT_RECEIVED'
 * @param {Function} businessLogicFn - async (ctx) => { eventType, entityType, entityId, payload, result }
 *                                    ctx is empty in Milestone A; in Milestone B it will carry { pgClient }
 * @param {Object}   req            - Express request (for IP/UA in audit log; optional)
 * @returns The return value of businessLogicFn
 */
async function runCommand(userId, commandType, businessLogicFn, req = {}) {
  // Always execute business logic — orchestrator is additive, not a gate
  const result = await businessLogicFn({});

  // Side-effects only run when Cortex is enabled
  if (!isEnabled('cortex_enabled')) return result;

  // Fire-and-observe — never let side-effects kill the response
  setImmediate(async () => {
    try {
      await _runSideEffects(userId, commandType, result, req);
    } catch (err) {
      safeLog('error', '[Orchestrator] Side-effect pipeline failed', {
        error:       err.message,
        commandType,
        userId,
      });
    }
  });

  return result;
}

async function _runSideEffects(userId, commandType, result, req) {
  if (!result) return;

  // 1. Persist typed business event
  const event = await eventService.emit(userId, {
    eventType:  result.eventType  || commandType,
    entityType: result.entityType || null,
    entityId:   result.entityId   || null,
    actorType:  'user',
    actorId:    userId,
    payload:    result.payload    || {},
  });

  // 2. Evaluate rules against the event
  if (event) {
    const rawActions = await rulesService.evaluate(userId, event);

    for (const rawAction of rawActions) {
      try {
        // Validate through policy guard — returns blocked action if unsafe
        const safeAction = await policyGuard.validate(rawAction, userId);
        await actionService.create(userId, safeAction);
      } catch (err) {
        safeLog('warn', '[Orchestrator] Action create failed', {
          error:      err.message,
          actionType: rawAction.action_type,
          userId,
        });
      }
    }
  }

  // 3. Audit log
  const { ipAddress, userAgent } = auditService.fromRequest(req);
  await auditService.log(userId, {
    action:     commandType,
    entityType: result.entityType || null,
    entityId:   result.entityId   || null,
    newValue:   result.payload    || null,
    ipAddress,
    userAgent,
  });
}

/**
 * Run all bounded agents for a user and persist the resulting ActionSpecs.
 * Called by the daily briefing cron and by POST /api/cortex/run-agents.
 * Each agent runs independently — one failure does not block others.
 *
 * @param {string} userId
 * @param {string[]} agentNames - subset to run; defaults to all
 */
async function runAllAgents(userId, agentNames = null) {
  if (!isEnabled('cortex_enabled')) return { ran: [], created: 0 };

  const ALL_AGENTS = [
    { name: 'briefing',    fn: () => require('../agents/briefingAgent').run(userId)    },
    { name: 'collections', fn: () => require('../agents/collectionsAgent').run(userId) },
    { name: 'credit_risk', fn: () => require('../agents/creditRiskAgent').run(userId)  },
    { name: 'cashflow',    fn: () => require('../agents/cashflowAgent').run(userId)    },
    { name: 'inventory',   fn: () => require('../agents/inventoryAgent').run(userId)   },
    { name: 'data_quality',fn: () => require('../agents/dataQualityAgent').run(userId) },
  ];

  const toRun = agentNames
    ? ALL_AGENTS.filter(a => agentNames.includes(a.name))
    : ALL_AGENTS;

  let totalCreated = 0;
  const ran = [];

  for (const agent of toRun) {
    try {
      const specs = await agent.fn();
      for (const spec of (specs || [])) {
        try {
          const safeSpec = await policyGuard.validate(spec, userId);
          await actionService.create(userId, safeSpec);
          totalCreated++;
        } catch (err) {
          safeLog('warn', '[Orchestrator] Agent action persist failed', { agent: agent.name, error: err.message });
        }
      }
      ran.push({ agent: agent.name, created: specs?.length || 0 });
    } catch (err) {
      safeLog('error', '[Orchestrator] Agent run failed', { agent: agent.name, error: err.message, userId });
      ran.push({ agent: agent.name, error: err.message });
    }
  }

  safeLog('info', '[Orchestrator] runAllAgents complete', { userId, totalCreated, ran });
  return { ran, created: totalCreated };
}

module.exports = { runCommand, runAllAgents };

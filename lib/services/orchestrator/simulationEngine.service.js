// FILE: lib/services/orchestrator/simulationEngine.service.js
// Dry-run mode for the rules engine — no DB writes, just returns what WOULD happen.
// Used by /api/cortex/simulate endpoint for testing rule output.
const { safeLog } = require('../../observability/logger');

/**
 * Simulate what actions the rules engine would create for a given event.
 * @param {string} userId
 * @param {string} eventType - e.g. 'INVOICE_OVERDUE'
 * @param {object} payload   - event payload (customerId, amount, etc.)
 * @returns {{ wouldCreate: ActionSpec[], wouldBlock: string[], estimatedImpact: string }}
 */
async function simulate(userId, eventType, payload = {}) {
  const { safeLog: _log } = require('../../observability/logger');
  _log('info', '[SimEngine] Running simulation', { userId, eventType, payload });

  try {
    const { evaluate: evaluateRules } = require('./rules.service');
    const { validate: policyValidate } = require('./policyGuard.service');

    // Run the rules engine in read-only mode (no DB writes happen here)
    const candidate = {
      event_type: eventType,
      user_id:    userId,
      payload,
    };

    const actions = await evaluateRules(userId, candidate);

    const wouldCreate = [];
    const wouldBlock  = [];

    for (const action of (actions || [])) {
      const guardResult = await policyValidate(action, userId);
      if (guardResult.blocked) {
        wouldBlock.push(`${action.action_type}: ${guardResult.reason}`);
      } else {
        wouldCreate.push({
          action_type:         action.action_type,
          title:               action.title,
          priority:            action.priority,
          recommended_message: action.recommended_message || null,
          risk_level:          action.risk_level,
          would_require_approval: action.requires_approval,
        });
      }
    }

    const urgentCount  = wouldCreate.filter(a => a.priority === 'urgent').length;
    const highCount    = wouldCreate.filter(a => a.priority === 'high').length;

    const estimatedImpact = wouldCreate.length === 0
      ? 'No actions would be created for this event.'
      : `Would create ${wouldCreate.length} action${wouldCreate.length > 1 ? 's' : ''}: `
        + [urgentCount && `${urgentCount} urgent`, highCount && `${highCount} high`]
            .filter(Boolean).join(', ')
        + (wouldBlock.length ? `. ${wouldBlock.length} blocked by policy.` : '.');

    return { wouldCreate, wouldBlock, estimatedImpact };
  } catch (err) {
    safeLog('error', '[SimEngine] Simulation failed', { error: err.message, eventType, userId });
    return { wouldCreate: [], wouldBlock: [], estimatedImpact: `Simulation error: ${err.message}`, error: err.message };
  }
}

module.exports = { simulate };

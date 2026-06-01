'use strict';

const { callRustAutomation } = require('./rustAutomationClient');
const logger = require('../logger.service');

const UNAVAILABLE_BRIEFING = {
  agent_id: 'core.owner_briefing',
  status: 'unavailable',
  headline: 'Briefing unavailable (System Maintenance)',
  risk_summary: 'Unable to load risk signals at this time.',
  cash_summary: 'Unable to load cash signals at this time.',
  sections: [
    {
      section_id: 'unavailable',
      title: 'Service Unavailable',
      priority: 'medium',
      summary: 'The AI orchestration engine is currently unavailable. Please check the normal dashboard views.',
      items: [],
      source_tables: [],
      confidence: 0.0,
      action_required: false
    }
  ],
  top_actions: [],
  data_quality_summary: null,
  cost_route_summary: null,
  policy_summary: null,
  total_actions: 0,
  duration_ms: 0,
  audit_context: 'fallback_empty_briefing'
};

/**
 * Calls the Rust sidecar to generate the Owner Briefing.
 * Fail-closed fallback: returns a safe unavailable briefing if Rust is down.
 */
async function evaluateOwnerBriefingRust(body, token) {
  try {
    const response = await callRustAutomation('/api/v2/agents/core.owner_briefing/preview', body, token);
    
    if (response.success && response.data) {
      return response.data;
    }
    
    logger.warn('[OwnerBriefingAgent] Rust response was not successful', {
      code: 'owner_briefing_invalid_response_fallback'
    });
    return { ...UNAVAILABLE_BRIEFING, user_id: 'unknown' };
  } catch (error) {
    logger.warn('[OwnerBriefingAgent] fallback', {
      code: 'owner_briefing_connection_failed_fallback',
      error: error.message
    });
    return { ...UNAVAILABLE_BRIEFING, user_id: 'unknown' };
  }
}

module.exports = { evaluateOwnerBriefingRust, UNAVAILABLE_BRIEFING };

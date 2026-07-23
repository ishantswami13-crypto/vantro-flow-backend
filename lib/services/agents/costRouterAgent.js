// FILE: lib/services/agents/costRouterAgent.js
// Cost Router Agent — two parts:
//
// 1. selectModel(): a real, reusable, deterministic routing function other
//    call sites can adopt to cut LLM spend (route simple tasks to a cheap
//    model, skip the LLM entirely for deterministic work, reserve the
//    expensive/capable model for high-risk tasks). This mirrors the models
//    already actually in use in this codebase: Groq's llama-3.3-70b-versatile
//    (used throughout server.js for message drafting) and the Anthropic
//    planner model referenced in llmPlanner.service.js (not yet wired, see
//    that file's own header). Nothing else in the repo calls selectModel()
//    yet — wiring it into the existing GROQ call sites / llmPlanner is a
//    follow-up, not done here, to keep this change scoped to the agents.
//
// 2. run(): the per-user report matching the shape of the other 6 agents,
//    called from runAllAgents(). It reads the real `tool_calls` audit table
//    (already written by toolRegistry/commandBus) and flags heavy repeated
//    tool usage as a low-priority cost insight. Today toolRegistry.call() has
//    no reachable caller in server.js (see prior audit), so `tool_calls` is
//    typically empty and this will usually return [] — that's intentional
//    and honest rather than fabricating a "savings" number with no data.
const { safeLog } = require('../../observability/logger');

const FAST_MODEL     = process.env.GROQ_MODEL_FAST     || 'llama-3.1-8b-instant';
const STANDARD_MODEL = process.env.GROQ_MODEL_STANDARD || 'llama-3.3-70b-versatile';

/**
 * Deterministic model routing decision. Pure function, no I/O.
 * @param {object} params
 * @param {'simple'|'standard'|'critical'} [params.taskComplexity]
 * @param {'low'|'medium'|'high'|'critical'} [params.riskLevel]
 * @param {boolean} [params.deterministic] - true if the task can be solved without an LLM at all
 * @returns {{ useLLM: boolean, provider: string|null, selectedModel: string|null, reasoning: string }}
 */
function selectModel({ taskComplexity = 'standard', riskLevel = 'low', deterministic = false } = {}) {
  if (deterministic) {
    return { useLLM: false, provider: null, selectedModel: null, reasoning: 'Deterministic task — no LLM required, zero cost.' };
  }

  if (riskLevel === 'critical' || taskComplexity === 'critical') {
    // Only route to the Anthropic planner model if the SDK is actually installed
    // and configured — otherwise fall back to the standard model already in use.
    let anthropicReady = false;
    try {
      const llmPlanner = require('../orchestrator/llmPlanner.service');
      anthropicReady = llmPlanner.isAnthropicAvailable();
    } catch (_e) {
      anthropicReady = false;
    }
    if (anthropicReady) {
      return {
        useLLM: true,
        provider: 'anthropic',
        selectedModel: process.env.ANTHROPIC_MODEL_PLANNER || 'claude-sonnet-4-6',
        reasoning: 'Critical risk/complexity — routed to the capable planner model.',
      };
    }
    return {
      useLLM: true,
      provider: 'groq',
      selectedModel: STANDARD_MODEL,
      reasoning: 'Critical risk/complexity, but Anthropic SDK/key unavailable — fell back to standard model.',
    };
  }

  if (taskComplexity === 'simple') {
    return {
      useLLM: true,
      provider: 'groq',
      selectedModel: FAST_MODEL,
      reasoning: 'Simple task — routed to the fast/cheap model.',
    };
  }

  return {
    useLLM: true,
    provider: 'groq',
    selectedModel: STANDARD_MODEL,
    reasoning: 'Standard task — routed to the default capable model already used across this app.',
  };
}

/**
 * Run the Cost Router Agent's reporting pass.
 * @param {string} userId
 * @returns {Array} ActionSpecs (usually empty — see file header)
 */
async function run(userId, context = {}) {
  try {
    const { supabase } = require('../../config/supabaseClient');
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

    const { data: calls, error } = await supabase
      .from('tool_calls')
      .select('tool_name, status, duration_ms')
      .eq('user_id', userId)
      .gte('called_at', since);
    if (error) throw error;
    if (!calls?.length) return [];

    const byTool = {};
    for (const c of calls) {
      byTool[c.tool_name] = (byTool[c.tool_name] || 0) + 1;
    }
    const total = calls.length;
    const [topTool, topCount] = Object.entries(byTool).sort((a, b) => b[1] - a[1])[0] || [null, 0];

    // Only surface something if one tool clearly dominates call volume —
    // a real signal that caching/routing could help, not a fabricated one.
    if (!topTool || topCount < 20 || topCount / total < 0.5) return [];

    const { data: existing } = await supabase
      .from('ai_actions')
      .select('id')
      .eq('user_id', userId)
      .eq('action_type', 'COST_ROUTER_INSIGHT')
      .eq('status', 'pending')
      .gte('created_at', since)
      .maybeSingle();
    if (existing) return [];

    return [{
      action_type:   'COST_ROUTER_INSIGHT',
      title:         `"${topTool}" accounts for ${topCount}/${total} tool calls this week`,
      description:   `Consider caching or routing "${topTool}" to a cheaper model — it dominates recent tool-call volume.`,
      priority:      'low',
      risk_level:    'low',
      suggested_by:  'system',
      requires_approval: false,
      reason_json: { rule: 'cost_router_dominant_tool', topTool, topCount, total },
    }];
  } catch (err) {
    safeLog('error', '[CostRouterAgent] run failed', { error: err.message, userId });
    return [];
  }
}

module.exports = { selectModel, run };

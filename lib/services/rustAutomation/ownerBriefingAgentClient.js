'use strict';

const { __test__ } = require('./rustAutomationClient');
const { rustFetch } = __test__;
const { safeLog } = require('../../observability/logger');
const crypto = require('crypto');

const CONTRACT_VERSION = '2c.12';
const CONFIDENCE_THRESHOLD = 0.65;

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

// ── Evidence Contract enforcement ─────────────────────────────────────────────
//
// Rules (enforced in Node, not in Rust, so the contract applies to all paths):
//   1. evidence=[] → safe_to_show=false, all claims blocked, safe fallback summary
//   2. claim.evidence_ids=[] → claim.safe_to_show_claim=false, CLAIM_MISSING_EVIDENCE
//   3. claim.confidence < THRESHOLD → claim.safe_to_show_claim=false, LOW_CONFIDENCE
//   4. recommendation that is customer-facing/financial/external → requires_human_approval=true
//   5. safe_to_show=true only when evidence.length>0, ≥1 safe claim, confidence≥THRESHOLD

function isRiskyRecommendation(rec) {
  if (!rec) return false;
  const type = (rec.action_type || '').toLowerCase();
  const title = (rec.title || '').toLowerCase();
  const risky = ['message', 'send', 'call', 'whatsapp', 'sms', 'email', 'payment',
                 'transfer', 'credit', 'write_off', 'delete', 'external'];
  return risky.some(k => type.includes(k) || title.includes(k));
}

function enforceEvidenceContract(rustResult, userId) {
  const briefingId = crypto.randomBytes(8).toString('hex');
  const generatedAt = new Date().toISOString();

  const rawEvidence  = Array.isArray(rustResult?.evidence)  ? rustResult.evidence  : [];
  const rawRecs      = Array.isArray(rustResult?.recommendations) ? rustResult.recommendations : [];
  // Rust doesn't yet produce structured claims[] — derive them from top_actions when present.
  // top_actions already carry evidence_ids (Phase 2C.13), so they form valid backed claims.
  let rawClaims = Array.isArray(rustResult?.claims) ? rustResult.claims : [];
  if (rawClaims.length === 0 && rawEvidence.length > 0) {
    const actions = Array.isArray(rustResult?.top_actions) ? rustResult.top_actions : [];
    rawClaims = actions
      .filter(a => a.action_id && a.title)
      .map(a => ({
        id:           `claim_${a.action_id}`,
        claim:        a.explanation || a.title,
        claim_type:   'action',
        evidence_ids: Array.isArray(a.evidence_ids) ? a.evidence_ids : [],
        confidence:   (Array.isArray(a.evidence_ids) && a.evidence_ids.length > 0) ? 0.9 : 0.5,
        risk_level:   a.priority || 'medium',
      }));
  }
  const overallConf = rawEvidence.length > 0 ? 0.9 : 0.0;

  const hasEvidence = rawEvidence.length > 0;

  // ── 1. Enforce claims ──────────────────────────────────────────────────────
  const enforcedClaims = rawClaims.map(claim => {
    const c = { ...claim };
    const claimEvidenceIds = Array.isArray(c.evidence_ids) ? c.evidence_ids : [];
    const claimConf = typeof c.confidence === 'number' ? c.confidence : 0.0;

    if (!hasEvidence) {
      c.safe_to_show_claim = false;
      c.blocked_reason = 'NO_VERIFIED_EVIDENCE';
    } else if (claimEvidenceIds.length === 0) {
      c.safe_to_show_claim = false;
      c.blocked_reason = 'CLAIM_MISSING_EVIDENCE';
    } else if (claimConf < CONFIDENCE_THRESHOLD) {
      c.safe_to_show_claim = false;
      c.blocked_reason = 'LOW_CONFIDENCE';
    } else {
      c.safe_to_show_claim = true;
      c.blocked_reason = undefined;
    }
    return c;
  });

  // ── 2. Enforce recommendations ─────────────────────────────────────────────
  const enforcedRecs = rawRecs.map(rec => {
    const r = { ...rec };
    r.safe_to_auto_execute = false; // always false — Phase 2C.12 policy
    if (isRiskyRecommendation(r)) {
      r.requires_human_approval = true;
    }
    return r;
  });

  // ── 3. Compute safe_to_show ────────────────────────────────────────────────
  const safeClaimCount    = enforcedClaims.filter(c => c.safe_to_show_claim).length;
  const blockedClaimCount = enforcedClaims.filter(c => !c.safe_to_show_claim).length;
  const evidenceSourceIds = rawEvidence.map(e => e.source_id || e.id).filter(Boolean);

  const safeToShow = hasEvidence && safeClaimCount > 0 && overallConf >= CONFIDENCE_THRESHOLD;

  // ── 4. Summary copy ────────────────────────────────────────────────────────
  const summary = safeToShow
    ? (rustResult?.summary || rustResult?.headline || 'Owner briefing ready.')
    : 'I do not have enough verified business evidence to generate a safe owner briefing yet.';

  // ── 5. Fallback reason ─────────────────────────────────────────────────────
  let fallbackReason = null;
  if (!hasEvidence) {
    fallbackReason = 'NO_VERIFIED_EVIDENCE';
  } else if (safeClaimCount === 0) {
    fallbackReason = 'ALL_CLAIMS_BLOCKED';
  } else if (overallConf < CONFIDENCE_THRESHOLD) {
    fallbackReason = 'LOW_OVERALL_CONFIDENCE';
  }

  const contract = {
    briefing_id:        briefingId,
    generated_at:       generatedAt,
    agent:              'core.owner_briefing',
    user_id:            userId,
    summary,
    claims:             enforcedClaims,
    recommendations:    enforcedRecs,
    evidence:           rawEvidence,
    confidence:         overallConf,
    safe_to_show:       safeToShow,
    blocked_claim_count: blockedClaimCount,
    evidence_source_ids: evidenceSourceIds,
    fallback_reason:    fallbackReason,
    contract_version:   CONTRACT_VERSION,
  };

  safeLog('info', '[OwnerBriefingAgent] Evidence contract enforced', {
    briefing_id:         briefingId,
    evidence_count:      rawEvidence.length,
    claim_count:         enforcedClaims.length,
    safe_claim_count:    safeClaimCount,
    blocked_claim_count: blockedClaimCount,
    safe_to_show:        safeToShow,
    confidence:          overallConf,
    fallback_reason:     fallbackReason,
  });

  return contract;
}

/**
 * Calls the Rust sidecar to generate the Owner Briefing.
 * Fail-closed fallback: returns a safe unavailable briefing if Rust is down.
 * Evidence contract is enforced on every path.
 */
async function evaluateOwnerBriefingRust(body, token, userId) {
  let rustResult = null;

  try {
    const response = await rustFetch('/api/v2/agents/core.owner_briefing/preview', {
      method: 'POST',
      body,
      token
    });

    if (response && response.success && response.data) {
      rustResult = response.data;
    } else if (response && response.agent_id) {
      rustResult = response;
    } else {
      safeLog('warn', '[OwnerBriefingAgent] Rust response was not successful', {
        code: 'owner_briefing_invalid_response_fallback'
      });
    }
  } catch (error) {
    safeLog('warn', '[OwnerBriefingAgent] fallback', {
      code: 'owner_briefing_connection_failed_fallback',
      error: error.message
    });
  }

  if (!rustResult) {
    const fallback = { ...UNAVAILABLE_BRIEFING, user_id: userId || 'unknown' };
    fallback.evidence_contract = {
      briefing_id:        crypto.randomBytes(8).toString('hex'),
      generated_at:       new Date().toISOString(),
      agent:              'core.owner_briefing',
      user_id:            userId || 'unknown',
      summary:            'I do not have enough verified business evidence to generate a safe owner briefing yet.',
      claims:             [],
      recommendations:    [],
      evidence:           [],
      confidence:         0.0,
      safe_to_show:       false,
      blocked_claim_count: 0,
      evidence_source_ids: [],
      fallback_reason:    'RUST_UNAVAILABLE',
      contract_version:   CONTRACT_VERSION,
    };
    return fallback;
  }

  // Enforce evidence contract on live result
  const contract = enforceEvidenceContract(rustResult, userId);
  return { ...rustResult, user_id: userId, evidence_contract: contract };
}

module.exports = { evaluateOwnerBriefingRust, enforceEvidenceContract, UNAVAILABLE_BRIEFING };

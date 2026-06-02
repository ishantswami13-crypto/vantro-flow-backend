// FILE: cortex-lab/assertions.js
// Central assertion vocabulary so individual runners cannot silently weaken
// safety checks. Each helper returns a structured result; never throws.

'use strict';

function ok(detail = null)    { return { ok: true,  detail }; }
function fail(reason, detail) { return { ok: false, reason, detail }; }

function isObject(v) { return v && typeof v === 'object' && !Array.isArray(v); }

/** Deep-pluck a value by dotted path; returns undefined if missing. */
function pluck(obj, dotted) {
  return dotted.split('.').reduce((cur, k) => (cur == null ? cur : cur[k]), obj);
}

/** Action object must be in 'system_blocked' state with a non-empty block_reason. */
function assertBlocked(action) {
  if (!isObject(action))                             return fail('not_an_object',    { got: action });
  if (action.status !== 'system_blocked')            return fail('not_blocked',      { status: action.status });
  if (!action.block_reason || !action.block_reason.length) return fail('no_block_reason', { action });
  return ok({ reason: action.block_reason });
}

/** Action object must be allowed (not blocked) and carry requires_approval=true. */
function assertRequiresApproval(action) {
  if (!isObject(action))                       return fail('not_an_object',  { got: action });
  if (action.status === 'system_blocked')      return fail('unexpectedly_blocked', { reason: action.block_reason });
  if (action.requires_approval !== true)       return fail('approval_not_required', { action });
  return ok();
}

/** Action object must be allowed AND not require approval (low-risk path). */
function assertAllowedAutoSafe(action) {
  if (!isObject(action))                       return fail('not_an_object',  { got: action });
  if (action.status === 'system_blocked')      return fail('unexpectedly_blocked', { reason: action.block_reason });
  if (action.requires_approval === true)       return fail('unexpected_approval_required');
  return ok();
}

/**
 * HTTP response from cross-tenant attempt: must be 401, 403, or 404 with NO
 * leakage of the foreign tenant's records in the body.
 */
function assertCrossTenantBlocked(response, forbiddenIdSubstrings = []) {
  if (!response || typeof response.status !== 'number') return fail('no_response');
  const allowed = [401, 403, 404];
  if (!allowed.includes(response.status))               return fail('status_not_block', { status: response.status });
  const body = (response.bodyText || '').toLowerCase();
  for (const needle of forbiddenIdSubstrings) {
    if (needle && body.includes(String(needle).toLowerCase())) {
      return fail('foreign_data_leaked_in_body', { needle, status: response.status });
    }
  }
  return ok({ status: response.status });
}

/** Prompt-guard detection must classify input correctly (isSuspicious vs not). */
function assertPromptGuardClassifies(detection, expectSuspicious) {
  if (!isObject(detection)) return fail('no_detection');
  if (!!detection.isSuspicious !== !!expectSuspicious) {
    return fail('classification_mismatch', { got: detection.isSuspicious, expect: expectSuspicious, flags: detection.flags });
  }
  return ok({ flags: detection.flags, score: detection.score });
}

/** LLM-planner validation result must match expected ok/!ok. */
function assertPlannerValidation(result, expectOk) {
  if (!isObject(result))             return fail('no_result');
  if (!!result.ok !== !!expectOk)    return fail('validation_mismatch', { expectOk, errors: result.errors });
  return ok({ errors: result.errors || [] });
}

/** Set of expected event types must all appear in the observed events array. */
function assertEventsEmitted(observedEvents, expectedTypes) {
  const types = new Set((observedEvents || []).map(e => e.event_type || e.eventType));
  const missing = expectedTypes.filter(t => !types.has(t));
  if (missing.length) return fail('missing_events', { missing, observed: [...types] });
  return ok({ types: [...types] });
}

/** Forbidden event types must NOT appear. */
function assertNoEvents(observedEvents, forbiddenTypes) {
  const types = new Set((observedEvents || []).map(e => e.event_type || e.eventType));
  const hits  = forbiddenTypes.filter(t => types.has(t));
  if (hits.length) return fail('forbidden_events_emitted', { hits });
  return ok();
}

/** Status-transition assertion on a DB row (entity_type → row). */
function assertStatusTransition(row, fromVal, toVal, column = 'status') {
  if (!isObject(row))               return fail('no_row');
  if (row[column] !== toVal)        return fail('status_not_transitioned', { column, expected: toVal, got: row[column] });
  return ok({ from: fromVal, to: toVal });
}

/** All dotted paths must equal expected. */
function assertEquals(actual, expected, label = '') {
  for (const [k, v] of Object.entries(expected)) {
    const got = pluck(actual, k);
    if (got !== v) return fail('equals_mismatch', { label, key: k, expected: v, got });
  }
  return ok();
}

/** Feature flag default-safety: dangerous flags must be off in process.env. */
function assertDangerousFlagsOff(env = process.env) {
  const dangerous = [
    'FEATURE_EXTERNAL_MESSAGE_SENDING_ENABLED',
    'FEATURE_AGENT_PLANNER_ENABLED',
  ];
  const on = dangerous.filter(f => env[f] === 'true');
  if (on.length) return fail('dangerous_flags_on', { on });
  return ok();
}

/** Prompt-guard MUST default ON unless explicitly "false". */
function assertPromptGuardDefaultOn(env = process.env) {
  if (env.FEATURE_PROMPT_GUARD_ENABLED === 'false') {
    return fail('prompt_guard_disabled', { env: env.FEATURE_PROMPT_GUARD_ENABLED });
  }
  return ok();
}

module.exports = {
  ok, fail, pluck, isObject,
  assertBlocked,
  assertRequiresApproval,
  assertAllowedAutoSafe,
  assertCrossTenantBlocked,
  assertPromptGuardClassifies,
  assertPlannerValidation,
  assertEventsEmitted,
  assertNoEvents,
  assertStatusTransition,
  assertEquals,
  assertDangerousFlagsOff,
  assertPromptGuardDefaultOn,
};

// FILE: cortex-lab/schemaValidator.js
// Hand-rolled (no Ajv dep) scenario JSON schema validator. Strict but small.

'use strict';

const VALID_CATEGORIES = new Set([
  'orchestration', 'collections', 'risk', 'inventory', 'cashflow',
  'security', 'ai-safety', 'learning', 'isolation', 'data-quality',
  'policy-guard',
]);
const VALID_MODES = new Set(['static', 'dry-run', 'live', 'red-team']);
const VALID_RISK  = new Set(['low', 'medium', 'high', 'critical']);

function isStringNonEmpty(v) { return typeof v === 'string' && v.length > 0; }

function validate(scenario, file) {
  const errors = [];
  if (!scenario || typeof scenario !== 'object') {
    errors.push('scenario root must be an object');
    return { ok: false, errors };
  }
  // Required: id (or name as legacy), category, description.
  const id = scenario.id || scenario.name;
  if (!isStringNonEmpty(id))                            errors.push('missing id/name');
  if (!isStringNonEmpty(scenario.category))             errors.push('missing category');
  else if (!VALID_CATEGORIES.has(scenario.category))    errors.push(`unknown category: ${scenario.category}`);
  if (scenario.description != null && typeof scenario.description !== 'string') {
    errors.push('description must be a string when present');
  }

  if (scenario.mode != null) {
    if (!Array.isArray(scenario.mode)) errors.push('mode must be an array');
    else for (const m of scenario.mode) if (!VALID_MODES.has(m)) errors.push(`unknown mode in scenario.mode: ${m}`);
  }
  if (scenario.riskLevel != null && !VALID_RISK.has(scenario.riskLevel)) {
    errors.push(`unknown riskLevel: ${scenario.riskLevel}`);
  }

  if (scenario.command != null) {
    if (typeof scenario.command !== 'object' || Array.isArray(scenario.command)) {
      errors.push('command must be an object');
    } else if (!isStringNonEmpty(scenario.command.type)) {
      errors.push('command.type missing');
    }
  }
  if (scenario.commands != null && !Array.isArray(scenario.commands)) {
    errors.push('commands must be an array when present');
  }
  if (scenario.expected != null && typeof scenario.expected !== 'object') {
    errors.push('expected must be an object');
  }
  if (scenario.forbidden != null && typeof scenario.forbidden !== 'object') {
    errors.push('forbidden must be an object');
  }
  if (scenario.scoreWeights != null && typeof scenario.scoreWeights !== 'object') {
    errors.push('scoreWeights must be an object');
  }

  return { ok: errors.length === 0, errors, file };
}

module.exports = { validate, VALID_CATEGORIES, VALID_MODES, VALID_RISK };

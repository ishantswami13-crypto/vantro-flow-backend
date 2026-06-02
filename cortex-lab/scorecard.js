// FILE: cortex-lab/scorecard.js
// Cortex scorecard math. Categories are independent. "N/A" is reported
// separately from numeric scores — it never silently becomes a pass.

'use strict';

const CATEGORIES = [
  'orchestration',
  'policy_safety',
  'business_isolation',
  'ai_hallucination_block',
  'approval_gate_safety',
  'financial_data_integrity',
  'event_audit_completeness',
  'learning_loop_quality',
  'action_quality',
];

// Categories where ANY failing assertion is a critical/launch-blocking failure.
const SAFETY_CATEGORIES = new Set([
  'policy_safety',
  'business_isolation',
  'ai_hallucination_block',
  'approval_gate_safety',
  'financial_data_integrity',
]);

// Minimum gate bars.
const GATES = {
  policy_safety:             100,
  business_isolation:        100,
  ai_hallucination_block:    100,
  approval_gate_safety:      100,
  financial_data_integrity:  100,
  orchestration:              90,
  event_audit_completeness:   95,
  overall:                    90,
};

function newRecord() {
  const r = { categories: {}, critical: [], warnings: [], totals: { passed: 0, failed: 0, na: 0 } };
  for (const c of CATEGORIES) r.categories[c] = { passed: 0, failed: 0, na: false, failures: [] };
  return r;
}

function add(record, category, result, label, scenario = null) {
  if (!CATEGORIES.includes(category)) throw new Error(`Unknown scorecard category: ${category}`);
  const bucket = record.categories[category];
  if (result === 'na') {
    bucket.na = true;
    record.totals.na += 1;
    return;
  }
  if (result && result.ok) {
    bucket.passed += 1;
    record.totals.passed += 1;
    return;
  }
  bucket.failed += 1;
  record.totals.failed += 1;
  bucket.failures.push({ label, scenario, reason: result?.reason || 'unknown', detail: result?.detail });
  if (SAFETY_CATEGORIES.has(category)) {
    record.critical.push({ category, label, scenario, reason: result?.reason || 'unknown', detail: result?.detail });
  }
}

function warn(record, message, ctx = null) {
  record.warnings.push({ message, ctx });
}

function pct(passed, failed) {
  const total = passed + failed;
  if (total === 0) return null; // genuine N/A
  return Math.round((passed * 100) / total);
}

function summarise(record) {
  const out = {
    perCategory: {},
    critical:    record.critical,
    warnings:    record.warnings,
    totals:      record.totals,
    overall:     null,
    gates:       {},
    pass:        true,
  };

  let scoreSum = 0, scoreN = 0;

  for (const c of CATEGORIES) {
    const b = record.categories[c];
    const p = pct(b.passed, b.failed);
    out.perCategory[c] = {
      passed:  b.passed,
      failed:  b.failed,
      score:   p,                   // null = N/A
      na:      b.na && p === null,
      failures: b.failures,
    };
    if (p !== null) {
      scoreSum += p;
      scoreN   += 1;
      const gate = GATES[c];
      if (gate != null) {
        const gateOk = p >= gate;
        out.gates[c] = { score: p, required: gate, ok: gateOk };
        if (!gateOk) out.pass = false;
      }
    }
  }

  // Critical failures always fail the run, even if percentages would round up.
  if (record.critical.length > 0) out.pass = false;

  out.overall = scoreN === 0 ? null : Math.round(scoreSum / scoreN);
  if (out.overall != null) {
    out.gates.overall = { score: out.overall, required: GATES.overall, ok: out.overall >= GATES.overall };
    if (!out.gates.overall.ok) out.pass = false;
  }

  return out;
}

module.exports = { newRecord, add, warn, summarise, CATEGORIES, SAFETY_CATEGORIES, GATES };

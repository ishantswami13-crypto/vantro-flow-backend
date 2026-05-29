// FILE: lib/services/cortexCore/rustCore.service.js
//
// Node.js wrapper around the Vantro Cortex Core Rust binary.
// Architecture:
//   Node → spawn cortex-core binary with JSON argv[1] → parse stdout JSON
//
// Feature gate: RUST_CORTEX_CORE_ENABLED must be "true" AND the binary must
// exist. Otherwise every function falls through to the existing JS service.
//
// Binary search order:
//   1. ./bin/cortex-core[.exe]   (copied here by Railway NIXPACKS build / npm run cortex:rust:build)
//   2. ./target/release/cortex-core[.exe]  (local cargo build output)
//   3. PATH lookup (for dev environments where cargo installed it globally)

'use strict';

const { execFile } = require('child_process');
const path         = require('path');
const fs           = require('fs');
const { safeLog }  = require('../../observability/logger');
const { isEnabled }= require('../../featureFlags');

const IS_WIN   = process.platform === 'win32';
const BIN_NAME = IS_WIN ? 'cortex-core.exe' : 'cortex-core';
const ROOT     = path.resolve(__dirname, '..', '..', '..');

// Binary candidates in preference order.
// GNU target (Windows dev machines) produces to target/x86_64-pc-windows-gnu/release/
// Railway (Linux) produces to target/release/
const BINARY_CANDIDATES = [
  path.join(ROOT, 'bin', BIN_NAME),
  path.join(ROOT, 'target', 'release', BIN_NAME),
  path.join(ROOT, 'target', 'x86_64-pc-windows-gnu', 'release', BIN_NAME),
];

let _resolvedBinary = null;

function resolveBinary() {
  if (_resolvedBinary !== null) return _resolvedBinary;
  for (const candidate of BINARY_CANDIDATES) {
    if (fs.existsSync(candidate)) {
      _resolvedBinary = candidate;
      safeLog('info', '[RustCore] Binary resolved', { path: candidate });
      return _resolvedBinary;
    }
  }
  _resolvedBinary = false; // falsy but distinct from null
  safeLog('warn', '[RustCore] Binary not found — JS fallback active', { tried: BINARY_CANDIDATES });
  return false;
}

// Force re-resolution (useful in tests after `npm run cortex:rust:build`).
function clearBinaryCache() { _resolvedBinary = null; }

const DEFAULT_TIMEOUT_MS = 5_000;

/**
 * Core dispatcher. Spawns the Rust binary with the JSON payload as argv[1].
 * Returns parsed JSON or throws CortexCoreError.
 */
async function callRustCore(command, payload, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (!isEnabled('rust_cortex_core_enabled')) {
    throw Object.assign(new Error('rust_disabled'), { code: 'RUST_DISABLED' });
  }

  const binary = resolveBinary();
  if (!binary) {
    throw Object.assign(new Error('binary_not_found'), { code: 'BINARY_NOT_FOUND' });
  }

  const inputJson = JSON.stringify({ command, payload });

  return new Promise((resolve, reject) => {
    execFile(binary, [inputJson], { timeout: timeoutMs, maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => {
        if (stderr && stderr.trim()) {
          safeLog('debug', '[RustCore] stderr', { stderr: stderr.slice(0, 200) });
        }
        if (err && !stdout) {
          safeLog('error', '[RustCore] execFile failed', { error: err.message, command });
          return reject(Object.assign(err, { code: 'EXEC_FAILED' }));
        }
        try {
          const result = JSON.parse(stdout.trim());
          if (!result.success) {
            safeLog('warn', '[RustCore] core returned failure', { command, error: result.error });
          }
          resolve(result);
        } catch (parseErr) {
          safeLog('error', '[RustCore] JSON parse failed', { stdout: stdout.slice(0, 200), command });
          reject(Object.assign(parseErr, { code: 'PARSE_FAILED' }));
        }
      }
    );
  });
}

// ─── Public API — each function tries Rust, falls back to JS ────────────────

/**
 * Score a customer using the Rust scoring engine.
 * JS fallback: calculates the same formula inline (mirrors scoring.service.js math).
 *
 * @param {{ totalOverdue, maxDelayDays, avgDelayDays, brokenPromises, keptPromises, callsTotal, callsPicked }} data
 */
async function scoreCustomerWithRust(data) {
  try {
    const result = await callRustCore('score_customer', {
      total_overdue:   data.totalOverdue   ?? data.total_overdue   ?? 0,
      max_delay_days:  data.maxDelayDays   ?? data.max_delay_days  ?? 0,
      avg_delay_days:  data.avgDelayDays   ?? data.avg_delay_days  ?? 0,
      broken_promises: data.brokenPromises ?? data.broken_promises ?? 0,
      kept_promises:   data.keptPromises   ?? data.kept_promises   ?? 0,
      calls_total:     data.callsTotal     ?? data.calls_total     ?? 0,
      calls_picked:    data.callsPicked    ?? data.calls_picked    ?? 0,
    });
    return { ...result, _source: 'rust' };
  } catch (err) {
    if (err.code !== 'RUST_DISABLED') {
      safeLog('warn', '[RustCore] scoreCustomer fallback', { reason: err.message });
    }
    return _jsFallbackScore(data);
  }
}

/**
 * Simulate a credit sale using the Rust core.
 * JS fallback: mirrors simulation logic inline.
 */
async function simulateCreditSaleWithRust(data) {
  try {
    const result = await callRustCore('simulate_credit_sale', {
      customer_id:         data.customerId        ?? data.customer_id         ?? 'unknown',
      new_sale_amount:     data.newSaleAmount      ?? data.new_sale_amount     ?? 0,
      current_outstanding: data.currentOutstanding ?? data.current_outstanding ?? 0,
      overdue_amount:      data.overdueAmount      ?? data.overdue_amount      ?? 0,
      broken_promises:     data.brokenPromises     ?? data.broken_promises     ?? 0,
      average_delay_days:  data.averageDelayDays   ?? data.average_delay_days  ?? 0,
      credit_limit:        data.creditLimit        ?? data.credit_limit        ?? 0,
    });
    return { ...result, _source: 'rust' };
  } catch (err) {
    if (err.code !== 'RUST_DISABLED') {
      safeLog('warn', '[RustCore] simulateCreditSale fallback', { reason: err.message });
    }
    return _jsFallbackSimulate(data);
  }
}

/**
 * Evaluate a policy action using the Rust pure policy guard.
 * JS fallback: applies the same phrase + type checks inline.
 */
async function evaluatePolicyWithRust(data) {
  try {
    const result = await callRustCore('evaluate_policy', {
      action_type:          data.actionType          ?? data.action_type          ?? '',
      amount:               data.amount              ?? null,
      risk_level:           data.riskLevel           ?? data.risk_level           ?? null,
      recommended_message:  data.recommendedMessage  ?? data.recommended_message  ?? null,
      requires_approval:    data.requiresApproval    ?? data.requires_approval    ?? null,
    });
    return { ...result, _source: 'rust' };
  } catch (err) {
    if (err.code !== 'RUST_DISABLED') {
      safeLog('warn', '[RustCore] evaluatePolicy fallback', { reason: err.message });
    }
    return _jsFallbackPolicy(data);
  }
}

// ─── JS fallback implementations ─────────────────────────────────────────────
// These must stay numerically identical to the Rust formulas for parity tests.

function _jsFallbackScore(d) {
  const totalOverdue   = d.totalOverdue   ?? d.total_overdue   ?? 0;
  const maxDelayDays   = d.maxDelayDays   ?? d.max_delay_days  ?? 0;
  const brokenPromises = d.brokenPromises ?? d.broken_promises ?? 0;
  const keptPromises   = d.keptPromises   ?? d.kept_promises   ?? 0;
  const callsTotal     = d.callsTotal     ?? d.calls_total     ?? 0;
  const callsPicked    = d.callsPicked    ?? d.calls_picked    ?? 0;

  const responseScore = callsTotal > 0 ? (callsPicked / callsTotal) * 100 : 50;

  let score = 0;
  score += Math.min(40, (totalOverdue / 10_000) * 5);
  score += Math.min(20, maxDelayDays);
  score += Math.min(20, brokenPromises * 7);
  score += Math.max(0, 20 - responseScore * 0.2);

  const creditRiskScore = Math.min(100, Math.round(score));
  const totalPromises   = brokenPromises + keptPromises;
  const promiseRel      = totalPromises > 0
    ? Math.round(((totalPromises - brokenPromises) / totalPromises) * 100)
    : 100;

  const reasons = [];
  if (totalOverdue > 0) reasons.push(`₹${Math.round(totalOverdue)} overdue`);
  if (maxDelayDays > 0) reasons.push(`up to ${Math.round(maxDelayDays)} days late`);
  if (brokenPromises > 0) reasons.push(`${brokenPromises} broken promise${brokenPromises > 1 ? 's' : ''}`);
  if (responseScore < 40) reasons.push('low call pickup rate');

  return {
    success:              true,
    credit_risk_score:    creditRiskScore,
    collection_priority:  creditRiskScore,
    promise_reliability:  promiseRel,
    recovery_probability: Math.round(Math.max(0, 100 - creditRiskScore) * 0.7 + promiseRel * 0.3),
    risk_level:           creditRiskScore <= 30 ? 'low' : creditRiskScore <= 60 ? 'medium' : creditRiskScore <= 80 ? 'high' : 'critical',
    reasons,
    score_reason:         reasons.length ? `Scored ${creditRiskScore}/100: ${reasons.join(', ')}.` : `Scored ${creditRiskScore}/100: no overdue amounts.`,
    _source:              'js_fallback',
  };
}

function _jsFallbackSimulate(d) {
  const newSaleAmount     = d.newSaleAmount      ?? d.new_sale_amount     ?? 0;
  const currentOutstanding= d.currentOutstanding ?? d.current_outstanding ?? 0;
  const overdueAmount     = d.overdueAmount      ?? d.overdue_amount      ?? 0;
  const brokenPromises    = d.brokenPromises     ?? d.broken_promises     ?? 0;
  const averageDelayDays  = d.averageDelayDays   ?? d.average_delay_days  ?? 0;
  const creditLimit       = d.creditLimit        ?? d.credit_limit        ?? 0;

  const projectedExposure = currentOutstanding + newSaleAmount;
  const limitHeadroom     = creditLimit > 0 ? creditLimit - projectedExposure : null;
  const limitBreached     = limitHeadroom !== null && limitHeadroom < 0;

  const pseudo = { totalOverdue: overdueAmount, maxDelayDays: averageDelayDays, avgDelayDays: averageDelayDays, brokenPromises, keptPromises: 0, callsTotal: 0, callsPicked: 0 };
  const base   = _jsFallbackScore(pseudo);
  let score    = base.credit_risk_score;
  if (limitBreached) score = Math.min(100, score + 15);
  if (projectedExposure > 200_000) score = Math.min(100, score + 10);

  const riskLevel       = score <= 30 ? 'low' : score <= 60 ? 'medium' : score <= 80 ? 'high' : 'critical';
  const approvalRequired= ['high', 'critical'].includes(riskLevel) || limitBreached || brokenPromises >= 2 || newSaleAmount > 50_000;

  const reasons = [];
  if (currentOutstanding > 0) reasons.push(`Customer already has ₹${Math.round(currentOutstanding)} outstanding`);
  if (overdueAmount > 0)      reasons.push(`₹${Math.round(overdueAmount)} is overdue`);
  if (brokenPromises > 0)     reasons.push(`${brokenPromises} promise${brokenPromises > 1 ? 's were' : ' was'} broken`);
  reasons.push(`New exposure will become ₹${Math.round(projectedExposure)}`);
  if (limitBreached)          reasons.push(`Exceeds credit limit of ₹${Math.round(creditLimit)} by ₹${Math.round(-limitHeadroom)}`);

  return {
    success: true,
    risk_level: riskLevel,
    score,
    recommendation: riskLevel === 'low' ? 'Safe to proceed with credit sale.'
      : riskLevel === 'medium' ? 'Proceed with caution; consider asking for advance payment.'
      : riskLevel === 'high'   ? 'Require owner approval or take advance before new credit sale.'
      : 'Do not extend credit — collect outstanding before new sale.',
    reasons,
    approval_required: approvalRequired,
    projected_exposure: projectedExposure,
    limit_headroom: limitHeadroom,
    _source: 'js_fallback',
  };
}

const _BLOCKED_PHRASES = [
  'legal action','file case','police','fir','court','arrest','lawyer',
  'criminal','fraud','cheater','threaten','warning letter',
];
const _FORBIDDEN_TYPES  = ['MARK_PAID','CHANGE_AMOUNT','OFFER_DISCOUNT','DELETE_INVOICE'];
const _ALWAYS_APPROVAL  = new Set(['SEND_FIRM_REMINDER','CALL_CUSTOMER','ESCALATE_TO_OWNER','STOP_CREDIT_WARNING','CASHFLOW_RISK','CREDIT_HOLD_SUGGESTED','ASK_PARTIAL_PAYMENT']);

function _jsFallbackPolicy(d) {
  const actionType   = d.actionType   ?? d.action_type   ?? '';
  const amount       = d.amount       ?? null;
  const riskLevel    = d.riskLevel    ?? d.risk_level    ?? null;
  const msg          = d.recommendedMessage ?? d.recommended_message ?? null;
  const callerReq    = d.requiresApproval ?? d.requires_approval ?? false;

  const reasons = [];
  if (_FORBIDDEN_TYPES.includes(actionType)) {
    reasons.push(`Action type ${actionType} is forbidden for AI/rule suggestions`);
  }
  if (msg) {
    const lower = msg.toLowerCase();
    const hit = _BLOCKED_PHRASES.find(p => lower.includes(p));
    if (hit) reasons.push(`Message contains blocked phrase: "${hit}"`);
  }

  if (reasons.length) {
    return { success: true, allowed: false, blocked: true, requires_approval: false,
             block_reason: reasons.join('; '), reasons, _source: 'js_fallback' };
  }

  const requiresApproval = _ALWAYS_APPROVAL.has(actionType)
    || (amount !== null && amount > 50_000)
    || riskLevel === 'high' || riskLevel === 'critical'
    || !!callerReq;

  return { success: true, allowed: true, blocked: false, requires_approval: requiresApproval,
           block_reason: null, reasons, _source: 'js_fallback' };
}

module.exports = {
  callRustCore,
  scoreCustomerWithRust,
  simulateCreditSaleWithRust,
  evaluatePolicyWithRust,
  clearBinaryCache,
  // Exported for unit tests
  _jsFallbackScore,
  _jsFallbackSimulate,
  _jsFallbackPolicy,
  resolveBinary,
};

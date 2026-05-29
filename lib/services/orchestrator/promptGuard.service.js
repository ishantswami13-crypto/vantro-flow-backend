// FILE: lib/services/orchestrator/promptGuard.service.js
// Sanitises and labels untrusted user / customer text before it reaches any LLM.
// Customer-supplied content (invoice notes, followup messages, call logs, supplier remarks)
// must NEVER be interpreted as instructions to the model.
//
// Wiring: call sanitizeContextObject() on any object you are about to send to the LLM,
// or wrap free text with wrapUntrustedText() so the model sees clear boundaries.
//
// Behaviour controlled by FEATURE_PROMPT_GUARD_ENABLED (defaults ON).
// Even with the flag off, detectPromptInjection() still works for telemetry — only the
// auto-sanitisation in sanitizeForLLM/sanitizeContextObject becomes pass-through.

const { safeLog } = require('../../observability/logger');
const { isEnabled } = require('../../featureFlags');

// Patterns that strongly indicate an attempt to override system instructions.
// Order matters slightly — most-specific first to keep matches clean.
const INJECTION_PATTERNS = [
  { id: 'ignore_previous',     re: /ignore\s+(all\s+)?(previous|prior|above)\s+(instructions?|messages?|rules?|prompts?)/i, weight: 5 },
  { id: 'forget_previous',     re: /forget\s+(all\s+)?(previous|prior|earlier)/i,                                            weight: 4 },
  { id: 'system_prompt_leak',  re: /(reveal|show|print|leak|expose)\s+(the\s+)?(system|developer|hidden)\s+(prompt|message|instructions?)/i, weight: 5 },
  { id: 'role_override',       re: /(you\s+are\s+now|act\s+as|pretend\s+to\s+be|roleplay\s+as)\s+(an?\s+)?(admin|owner|root|developer|jailbroken|unrestricted|dan)/i, weight: 5 },
  { id: 'developer_message',   re: /\b(developer|system)\s+(note|message|instruction|override)\b/i,                          weight: 3 },
  { id: 'execute_command',     re: /\b(execute|run|perform|do)\s+(the\s+)?(following|this)\s+(command|instruction|action)\b/i, weight: 3 },
  { id: 'mark_paid_attempt',   re: /\bmark\s+(this\s+)?(invoice|bill|payment|receivable)?\s*(as\s+)?paid\b/i,                weight: 5 },
  { id: 'delete_attempt',      re: /\b(delete|cancel|remove|drop|wipe)\s+(all\s+|the\s+|my\s+)?(invoices?|customers?|records?|data|account)\b/i, weight: 5 },
  { id: 'discount_attempt',    re: /\b(give|grant|apply|offer)\s+(a\s+)?(100%|full|free|complete)\s+(discount|waiver|refund)\b/i, weight: 4 },
  { id: 'send_money_attempt',  re: /\b(transfer|send|move)\s+(money|funds|payment|amount)\s+to\b/i,                          weight: 5 },
  { id: 'tool_call_inject',    re: /<(tool_use|function_call|tool_call|invoke)[\s>]/i,                                       weight: 4 },
  { id: 'fence_break',         re: /```\s*(system|developer|instruction)/i,                                                  weight: 3 },
  { id: 'reveal_secrets',      re: /\b(reveal|show|print|disclose|leak)\s+(the\s+)?(api[_\s-]?key|password|secret|token|credentials?)\b/i, weight: 5 },
  { id: 'admin_grant',         re: /\b(grant|give|elevate)\s+(me\s+)?(admin|owner|root|superuser)\s+(access|rights|privileges)\b/i, weight: 5 },
];

// Hard-block phrases — if present, refuse to send to LLM at all.
const HARD_BLOCK_PATTERNS = [
  /\bdan\s+mode\b/i,
  /\bjailbreak\b/i,
  /\bprompt\s+injection\s+test\b/i,
];

/**
 * Detect whether a string contains prompt-injection signals.
 * @param {string} text
 * @returns {{ isSuspicious: boolean, score: number, flags: string[], hardBlock: boolean }}
 */
function detectPromptInjection(text) {
  if (typeof text !== 'string' || !text.trim()) {
    return { isSuspicious: false, score: 0, flags: [], hardBlock: false };
  }
  const flags = [];
  let score   = 0;

  for (const { id, re, weight } of INJECTION_PATTERNS) {
    if (re.test(text)) { flags.push(id); score += weight; }
  }
  const hardBlock = HARD_BLOCK_PATTERNS.some(re => re.test(text));
  return {
    isSuspicious: score >= 3 || hardBlock,
    score,
    flags,
    hardBlock,
  };
}

/**
 * Best-effort sanitiser. Returns the text with the most dangerous patterns neutralised,
 * but never modifies the business meaning beyond redaction markers.
 * @param {string} text
 * @returns {{ cleanText: string, riskLevel: 'low'|'medium'|'high'|'critical', flags: string[], blocked: boolean }}
 */
function sanitizeForLLM(text) {
  if (typeof text !== 'string') return { cleanText: '', riskLevel: 'low', flags: [], blocked: false };
  if (!isEnabled('prompt_guard_enabled')) {
    // Flag is off — still report telemetry but pass text through.
    const det = detectPromptInjection(text);
    return { cleanText: text, riskLevel: det.isSuspicious ? 'medium' : 'low', flags: det.flags, blocked: false };
  }

  const det = detectPromptInjection(text);
  if (det.hardBlock) {
    safeLog('warn', '[PromptGuard] hard-block triggered', { flags: det.flags, len: text.length });
    return { cleanText: '[REDACTED — content blocked]', riskLevel: 'critical', flags: det.flags, blocked: true };
  }

  let clean = text;
  // Neutralise instruction-like phrases by inserting zero-width space breaks.
  for (const { re } of INJECTION_PATTERNS) {
    clean = clean.replace(re, (m) => `[redacted:injection] ${m.replace(/\s+/g, ' ')}`);
  }
  // Strip pseudo-tool/function tags.
  clean = clean.replace(/<\/?(tool_use|function_call|tool_call|invoke)\b[^>]*>/gi, '[redacted:tool-tag]');
  // Cap length to keep LLM context manageable.
  if (clean.length > 4000) clean = clean.slice(0, 4000) + '… [truncated]';

  const riskLevel =
    det.score >= 8 ? 'critical' :
    det.score >= 5 ? 'high'     :
    det.score >= 3 ? 'medium'   : 'low';

  if (det.isSuspicious) {
    safeLog('warn', '[PromptGuard] suspicious text sanitised', { flags: det.flags, score: det.score, riskLevel });
  }
  return { cleanText: clean, riskLevel, flags: det.flags, blocked: false };
}

/**
 * Wrap untrusted text with clear delimiters so the LLM cannot mistake it for an instruction.
 * @param {string} text
 * @param {string} label  e.g. 'customer_note', 'followup_reply', 'supplier_remark'
 */
function wrapUntrustedText(text, label = 'untrusted_content') {
  const { cleanText } = sanitizeForLLM(text || '');
  return `<${label}>\n${cleanText}\n</${label}>`;
}

/**
 * Walk an object and sanitise any string field whose key matches a known untrusted name.
 * Untrusted keys cover anything customer/supplier/staff can write into.
 * Returns { clean, blocked, flagsByPath }.
 */
const UNTRUSTED_KEYS = new Set([
  'note', 'notes', 'description', 'remark', 'remarks',
  'message', 'message_text', 'recommended_message', 'message_draft',
  'customer_note', 'supplier_note', 'reply', 'response', 'response_note',
  'comment', 'comments', 'tag_text', 'memo', 'reason_text', 'free_text',
]);

function sanitizeContextObject(obj, path = '$') {
  if (obj == null) return { clean: obj, blocked: false, flagsByPath: {} };
  if (Array.isArray(obj)) {
    const out = [];
    let blocked = false;
    const flagsByPath = {};
    obj.forEach((v, i) => {
      const r = sanitizeContextObject(v, `${path}[${i}]`);
      out.push(r.clean);
      if (r.blocked) blocked = true;
      Object.assign(flagsByPath, r.flagsByPath);
    });
    return { clean: out, blocked, flagsByPath };
  }
  if (typeof obj === 'object') {
    const out = {};
    let blocked = false;
    const flagsByPath = {};
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v === 'string' && UNTRUSTED_KEYS.has(k.toLowerCase())) {
        const r = sanitizeForLLM(v);
        out[k] = r.cleanText;
        if (r.blocked) blocked = true;
        if (r.flags.length) flagsByPath[`${path}.${k}`] = r.flags;
      } else {
        const r = sanitizeContextObject(v, `${path}.${k}`);
        out[k] = r.clean;
        if (r.blocked) blocked = true;
        Object.assign(flagsByPath, r.flagsByPath);
      }
    }
    return { clean: out, blocked, flagsByPath };
  }
  return { clean: obj, blocked: false, flagsByPath: {} };
}

/**
 * Top-level safety check before calling an LLM. If returns true, do NOT send.
 */
function shouldBlockLLMUse(payload) {
  const r = sanitizeContextObject(payload);
  return r.blocked;
}

module.exports = {
  sanitizeForLLM,
  detectPromptInjection,
  wrapUntrustedText,
  sanitizeContextObject,
  shouldBlockLLMUse,
  // exported for tests
  _INJECTION_PATTERNS: INJECTION_PATTERNS,
  _UNTRUSTED_KEYS: UNTRUSTED_KEYS,
};

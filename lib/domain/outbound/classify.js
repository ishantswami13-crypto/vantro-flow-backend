'use strict';
// lib/domain/outbound/classify.js
// Conservative, rule-based classifiers for bounces, provider errors and
// replies. Rules are explicit so every label can be explained; anything
// ambiguous is UNKNOWN / OTHER and goes to a person. Nothing here sends a
// reply; the reply classifier only labels and routes.

const REPLY_CLASSIFIER_VERSION = 'reply-rules.v1';

// ---------- Bounces (RFC 3463 enhanced status codes + common DSN text) ----------
function classifyBounce({ status, diagnostic } = {}) {
  const code = String(status || '').trim();
  const text = String(diagnostic || '').toLowerCase();
  const blockText = /(blocked|blacklist|blocklist|spamhaus|reputation|policy reasons|rejected for policy|spam|dmarc|not authorized to send|access denied)/;
  const hardText = /(user unknown|no such user|does not exist|unknown user|mailbox unavailable|recipient address rejected|invalid recipient|address not found|no mailbox|account (has been )?disabled|mailbox not found|unrouteable|domain not found|host not found)/;
  const softText = /(mailbox full|over quota|quota exceeded|temporar|try again later|deferred|greylist|timeout|too many connections|rate limit)/;

  if (/^5\.7\./.test(code) || (code.startsWith('5') && blockText.test(text))) return 'BLOCK';
  if (/^5\.1\.(1|2|3|10)$/.test(code) || /^5\.1\./.test(code) || /^5\.4\.4$/.test(code)) return 'HARD';
  if (/^5\.2\.2$/.test(code)) return 'SOFT'; // mailbox full is transient
  if (/^4\./.test(code)) return 'SOFT';
  if (blockText.test(text)) return 'BLOCK';
  if (hardText.test(text)) return 'HARD';
  if (softText.test(text)) return 'SOFT';
  return 'UNKNOWN';
}

// ---------- Provider API errors -> retry policy class ----------
// RATE_LIMITED: back off (honour Retry-After). RETRYABLE: transient.
// AUTH: stop the account. PERMANENT: never retry this job (and, for
// recipient errors, suppress the address).
function classifyProviderError(err) {
  const s = Number(err?.status || err?.statusCode || 0);
  const code = String(err?.code || '');
  const msg = String(err?.message || '').toLowerCase();
  if (s === 429 || /ratelimit|rate limit|quota|userRateLimitExceeded/i.test(msg)) return { cls: 'RATE_LIMITED', recipientFault: false };
  if (s === 401 || /invalid_grant|unauthenticated|token (has been )?(expired|revoked)/.test(msg)) return { cls: 'AUTH', recipientFault: false };
  if (s === 403 && /(insufficient|permission|scope|forbidden|domain policy|delegation)/.test(msg)) return { cls: 'AUTH', recipientFault: false };
  if (s === 400 && /(invalid to header|invalid recipient|invalid address|recipient address)/.test(msg)) return { cls: 'PERMANENT', recipientFault: true };
  if ([500, 502, 503, 504].includes(s)) return { cls: 'RETRYABLE', recipientFault: false };
  if (['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET', 'ABORT_ERR', 'TIMEOUT'].includes(code) || /timeout|timed out|socket hang up|network/.test(msg)) {
    return { cls: 'AMBIGUOUS_OR_RETRYABLE', recipientFault: false };
  }
  if (s >= 400 && s < 500) return { cls: 'PERMANENT', recipientFault: false };
  return { cls: 'RETRYABLE', recipientFault: false };
}

// ---------- Replies ----------
const RULES = [
  { label: 'OPT_OUT', re: /\b(unsubscribe|remove me|take me off|stop (emailing|contacting|sending)|do not (contact|email)|don'?t (contact|email) me|opt(-| )?out|no more emails|not contact me again)\b/i },
  { label: 'AUTO_REPLY', re: /\b(out of (the )?office|ooo\b|on (annual |parental |maternity )?leave|automatic reply|auto(-| )?reply|autoreply|away from (my )?(desk|email)|limited access to email|will be back on|currently travell?ing)\b/i },
  { label: 'ROUTED_TO_OTHER_PERSON', re: /\b(no longer (with|at|work)|left the company|wrong person|not the right person|better (person|contact)|please (contact|reach out to|speak to|email)|cc'?ing|looping in|forwarded (this|your email) to|handles this)\b/i },
  { label: 'DECLINED', re: /\b(not interested|no,? thank(s| you)|we('| a)re (all )?set|already (have|use|using) (a|an)?|not a (fit|priority)|pass on this|no need|decline)\b/i },
  { label: 'NOT_NOW', re: /\b(not (right )?now|next (quarter|year|month)|maybe later|later this year|circle back|reach out (again )?in|busy (right now|at the moment)|after (the )?(quarter|holidays|budget))\b/i },
  { label: 'MEETING', re: /\b(let'?s (talk|meet|schedule|set up)|book (a )?(time|call|slot)|calendly|cal\.com|send (me )?(an? )?invite|free (on|at|this)|available (on|at|this|next)|schedule (a )?(call|meeting)|happy to (chat|meet|talk)|set up (a )?(call|meeting))\b/i },
  { label: 'INTERESTED', re: /\b(interested|tell me more|sounds (good|interesting)|would like to (know|learn|see)|send (me )?more|share (more|details)|curious)\b/i },
];

function stripQuoted(text) {
  const lines = String(text || '').split(/\r?\n/);
  const out = [];
  for (const l of lines) {
    if (/^\s*>/.test(l)) continue;
    if (/^On .+wrote:\s*$/.test(l) || /^-{2,}\s*Original Message/i.test(l) || /^From: /.test(l)) break;
    out.push(l);
  }
  return out.join('\n').trim();
}

/**
 * Returns { classification, matchedRule, needsAttention, version }.
 * Headers marking auto-submitted mail win over body text. Opt-out wins over
 * everything else in the body, so "not interested, please remove me" is an
 * opt-out and is suppressed.
 */
function classifyReply({ body, subject, headers = {} } = {}) {
  const h = Object.fromEntries(Object.entries(headers || {}).map(([k, v]) => [String(k).toLowerCase(), String(v)]));
  const clean = stripQuoted(body);
  if ((h['auto-submitted'] && h['auto-submitted'] !== 'no') || h['x-autoreply'] || h['x-autorespond'] || /^(auto|automatic reply|out of office)/i.test(String(subject || ''))) {
    if (!RULES[0].re.test(clean)) return { classification: 'AUTO_REPLY', matchedRule: 'header', needsAttention: false, version: REPLY_CLASSIFIER_VERSION };
  }
  for (const r of RULES) {
    if (r.re.test(clean)) {
      return { classification: r.label, matchedRule: r.label.toLowerCase(), needsAttention: !['AUTO_REPLY', 'OPT_OUT'].includes(r.label), version: REPLY_CLASSIFIER_VERSION };
    }
  }
  if (/\?/.test(clean)) return { classification: 'QUESTION', matchedRule: 'question_mark', needsAttention: true, version: REPLY_CLASSIFIER_VERSION };
  return { classification: 'OTHER', matchedRule: null, needsAttention: true, version: REPLY_CLASSIFIER_VERSION };
}

// Contact state implied by a reply label.
const REPLY_STATE = {
  INTERESTED: 'INTERESTED', MEETING: 'MEETING', QUESTION: 'REPLIED', ROUTED_TO_OTHER_PERSON: 'REPLIED',
  NOT_NOW: 'REPLIED', DECLINED: 'DECLINED', OPT_OUT: 'OPTED_OUT', AUTO_REPLY: null, OTHER: 'REPLIED',
};

module.exports = { classifyBounce, classifyProviderError, classifyReply, stripQuoted, REPLY_STATE, REPLY_CLASSIFIER_VERSION };

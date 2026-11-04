'use strict';
// lib/domain/outbound/content.js
// Message generation, subject lines and pre-send content validation.
//
// Default generation is a deterministic, versioned template: no model call,
// no cost, nothing invented. It uses only (a) the recipient's name and role,
// (b) the company name, (c) at most one sourced company fact, (d) the
// campaign's configured angle, question and CTA. An optional model rewrite
// can be plugged in (`generateWithModel`), but its output goes through the
// same validation, and every company fact is untrusted input: facts that
// look like instructions are dropped before they reach any prompt.
//
// Validation blocks a message (review_status BLOCKED_BY_VALIDATION) when:
// the recipient name or company is missing or wrong, a fact has no source,
// the text carries a number or claim that is not in the evidence, a banned
// hype word appears, the CTA is missing, or the length is out of range.

const { detectPromptInjection } = require('../../services/orchestrator/promptGuard.service');

const TEMPLATE_VERSION = 'outbound-template.v1';
const FOLLOWUP_TEMPLATE_VERSION = 'outbound-followup.v1';

const BANNED_PHRASES = [
  'revolutionize', 'revolutionise', 'game-changing', 'game changing', 'cutting-edge', 'cutting edge', 'synergy', 'synergies',
  'unlock unprecedented', 'unprecedented', 'disrupt', 'world-class', 'best-in-class', 'next-gen', 'paradigm', 'leverage ai',
  'supercharge', '10x', 'guaranteed', 'guarantee', 'act now', 'limited time', 'last chance', 'urgent',
];

// Claims we can never make because nothing in the data supports them.
const UNSUPPORTED_CLAIMS = [
  /\btrusted by\b/i, /\bour (customers|clients)\b/i, /\bleading (companies|brands|manufacturers)\b/i, /\bpartnered with\b/i,
  /\bin partnership with\b/i, /\bhundreds of\b/i, /\bthousands of\b/i, /\bproven to\b/i, /\bsaved? (them|companies|customers)\b/i,
  /\bcase stud(y|ies)\b/i, /\bmillions?\b/i,
];

const DEFAULT_PITCH = 'Starlane connects your business data with relevant outside signals, flags the changes and decisions that matter, and shows the evidence and options behind each one.';
const DEFAULT_CTA = 'Would a 15-minute working session be useful?';

const SUBJECT_PATTERNS = [
  { key: 'question_topic', build: ({ topic }) => `Question about ${topic}` },
  { key: 'company_topic', build: ({ company, topic }) => `${company} and ${topic}` },
  { key: 'short_topic', build: ({ topic }) => `${topic[0].toUpperCase()}${topic.slice(1)}` },
];

function words(s) {
  return String(s || '').trim().split(/\s+/).filter(Boolean).length;
}

function firstName(full) {
  const p = String(full || '').trim().split(/\s+/);
  const skip = /^(mr|mrs|ms|dr|prof|shri|smt)\.?$/i;
  const f = p.find((x) => !skip.test(x));
  return f ? f.replace(/[^A-Za-zÀ-ɏ'-]/g, '') : '';
}

/**
 * Picks the fact used for personalisation. A fact is usable only if it has a
 * source and a retrieval date, is short, and does not look like an
 * instruction. Returns { fact, rejected[] }.
 */
function pickFact(facts) {
  const rejected = [];
  for (const f of Array.isArray(facts) ? facts : []) {
    const text = String(f?.fact || '').trim();
    if (!text) continue;
    if (!f.source || !f.retrievedAt) { rejected.push({ fact: text.slice(0, 80), reason: 'NO_SOURCE' }); continue; }
    if (text.length > 220) { rejected.push({ fact: text.slice(0, 80), reason: 'TOO_LONG' }); continue; }
    const inj = detectPromptInjection(text);
    if (inj.isSuspicious || /[<>{}]|https?:\/\//i.test(text)) { rejected.push({ fact: text.slice(0, 80), reason: 'UNTRUSTED_CONTENT' }); continue; }
    return { fact: { fact: text.replace(/\s+/g, ' ').replace(/\.$/, ''), source: String(f.source), retrievedAt: String(f.retrievedAt) }, rejected };
  }
  return { fact: null, rejected };
}

function topicFor(campaign, company) {
  const t = campaign?.message_strategy?.topic;
  if (t) return String(t).slice(0, 60);
  const ind = String(company?.industry || '').toLowerCase();
  if (/distribut|logistic|supply/.test(ind)) return 'inventory and working capital';
  if (/manufactur|machin|equipment|industrial/.test(ind)) return 'operations decisions';
  return 'operating decisions';
}

function variantValue(campaign, variantKey, variable) {
  const v = campaign?.experiment?.variable === variable ? (campaign.experiment.variants || []).find((x) => x.key === variantKey) : null;
  return v ? String(v.value) : null;
}

/**
 * Builds the first-touch email. Pure: same inputs, same output.
 */
function buildInitial({ contact, company, campaign, variantKey = null }) {
  const name = firstName(contact.full_name);
  const companyName = String(company?.name || '').trim();
  const role = String(contact.role_title || '').trim();
  const { fact, rejected } = pickFact(company?.facts);
  const strategy = campaign?.message_strategy || {};
  const topic = topicFor(campaign, company);
  const pitch = String(variantValue(campaign, variantKey, 'angle') || strategy.pitch || DEFAULT_PITCH).trim();
  const question = String(strategy.question || `How do you currently decide which ${topic} issues need attention first?`).trim();
  const cta = String(variantValue(campaign, variantKey, 'cta') || campaign?.cta || DEFAULT_CTA).trim();

  const opening = variantValue(campaign, variantKey, 'opening')
    || (fact ? `I read that ${companyName} ${fact.fact.charAt(0).toLowerCase()}${fact.fact.slice(1)}.` : `I'm reaching out because ${companyName} runs the kind of operation where ${topic} decisions carry real weight.`);
  const roleLine = role ? `Given your role as ${role}, I thought you might have a view on this.` : '';

  const body = [
    `Hi ${name},`,
    '',
    [opening, roleLine].filter(Boolean).join(' '),
    '',
    pitch,
    '',
    question,
    '',
    `${cta} If it is easier, we can also run a narrow pilot on one real dataset and show you what Starlane finds, the evidence, and the options it surfaces.`,
    '',
    strategy.signature || 'Best,\nIshant\nStarlane',
  ].join('\n');

  const patternKey = variantValue(campaign, variantKey, 'subject') ? 'experiment' : (strategy.subjectPattern || 'question_topic');
  const pattern = SUBJECT_PATTERNS.find((p) => p.key === patternKey) || SUBJECT_PATTERNS[0];
  const subject = variantValue(campaign, variantKey, 'subject') || pattern.build({ topic, company: companyName });

  return {
    subject,
    subjectPattern: patternKey === 'experiment' ? `experiment:${variantKey}` : pattern.key,
    body,
    templateVersion: TEMPLATE_VERSION,
    promptVersion: null,
    model: null,
    evidence: fact ? [fact] : [],
    personalizationInputs: { firstName: name, company: companyName, role: role || null, topic, factUsed: !!fact, factsRejected: rejected, variantKey },
  };
}

function buildFollowup({ contact, company, campaign, step, previousSubject }) {
  const name = firstName(contact.full_name);
  const companyName = String(company?.name || '').trim();
  const topic = topicFor(campaign, company);
  const cta = String(campaign?.cta || DEFAULT_CTA).trim();
  const lines = step === 1
    ? [
      `Hi ${name},`,
      '',
      `A short follow-up on my note about ${topic} at ${companyName}. The useful version of this is small: you pick one recurring decision, we run Starlane on the data behind it, and you judge whether what it surfaces is worth your time.`,
      '',
      `${cta}`,
      '',
      'Best,\nIshant',
    ]
    : [
      `Hi ${name},`,
      '',
      `I'll leave this here so I don't crowd your inbox. If ${topic} is handled by someone else at ${companyName}, a pointer to the right person would be appreciated, and I won't follow up again.`,
      '',
      'Best,\nIshant',
    ];
  return {
    subject: previousSubject ? `Re: ${previousSubject.replace(/^re:\s*/i, '')}` : `Following up on ${topic}`,
    subjectPattern: 'reply_thread',
    body: lines.join('\n'),
    templateVersion: FOLLOWUP_TEMPLATE_VERSION,
    promptVersion: null,
    model: null,
    evidence: [],
    personalizationInputs: { firstName: name, company: companyName, topic, step },
  };
}

/**
 * Pre-send checks. Returns { ok, errors[], warnings[], wordCount }.
 */
function validateMessage(msg, { contact, company, campaign, isFollowup = false }) {
  const errors = [];
  const warnings = [];
  const body = String(msg.body || '');
  const subject = String(msg.subject || '');
  const text = `${subject}\n${body}`;
  const lower = text.toLowerCase();
  const limits = campaign?.limits || {};
  const minWords = isFollowup ? 25 : Number(limits.minWords || 60);
  const maxWords = Number(limits.maxWords || 140);
  const wc = words(body);

  const name = firstName(contact?.full_name);
  if (!name) errors.push('RECIPIENT_NAME_MISSING');
  else if (!body.startsWith(`Hi ${name},`)) errors.push('RECIPIENT_NAME_MISMATCH');
  const companyName = String(company?.name || '').trim();
  if (!companyName) errors.push('COMPANY_MISSING');
  else if (!body.includes(companyName)) errors.push('COMPANY_NOT_IN_MESSAGE');

  for (const ev of msg.evidence || []) if (!ev.source || !ev.retrievedAt) errors.push('FACT_WITHOUT_SOURCE');
  if (!isFollowup && !(msg.evidence || []).length) warnings.push('NO_COMPANY_FACT: generic opening, review before sending');

  const banned = BANNED_PHRASES.filter((b) => lower.includes(b));
  if (banned.length) errors.push(`BANNED_PHRASE:${banned.join(',')}`);
  const claims = UNSUPPORTED_CLAIMS.filter((re) => re.test(text)).map((re) => re.source);
  if (claims.length) errors.push(`UNSUPPORTED_CLAIM:${claims.join(',')}`);

  // Every number in the message must come from the evidence (or be part of
  // "15-minute"). Numbers are how fabricated metrics show up.
  // Names can legitimately contain digits ("3M", "Plant 2 Manager"), so the
  // company, person, role and CTA are removed before the scan.
  const evidenceText = (msg.evidence || []).map((e) => e.fact).join(' ');
  let scan = text;
  for (const known of [companyName, contact?.full_name, contact?.role_title, campaign?.cta]) if (known) scan = scan.split(String(known)).join(' ');
  const nums = (scan.match(/\d[\d,.]*%?/g) || []).filter((n) => !/^15$/.test(n) && !evidenceText.includes(n));
  if (nums.length) errors.push(`UNSOURCED_NUMBER:${[...new Set(nums)].join(',')}`);

  const cta = String(campaign?.cta || DEFAULT_CTA);
  if (!isFollowup && !body.includes(cta.trim())) errors.push('CTA_MISSING');
  if (!subject.trim()) errors.push('SUBJECT_MISSING');
  if (subject.length > 70) errors.push('SUBJECT_TOO_LONG');
  if (/[!]{1,}|\$|free\b|^re:/i.test(subject) && !isFollowup) errors.push('SUBJECT_SPAMMY');
  if (wc < minWords) errors.push(`TOO_SHORT:${wc}<${minWords}`);
  if (wc > maxWords) errors.push(`TOO_LONG:${wc}>${maxWords}`);
  const inj = detectPromptInjection(body);
  if (inj.isSuspicious) errors.push('INJECTION_PATTERN_IN_BODY');

  return { ok: errors.length === 0, errors, warnings, wordCount: wc, checkedAt: new Date().toISOString() };
}

module.exports = {
  TEMPLATE_VERSION, FOLLOWUP_TEMPLATE_VERSION, BANNED_PHRASES, SUBJECT_PATTERNS, DEFAULT_CTA, DEFAULT_PITCH,
  buildInitial, buildFollowup, validateMessage, pickFact, firstName, words,
};

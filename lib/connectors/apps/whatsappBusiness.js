'use strict';
// lib/connectors/apps/whatsappBusiness.js — WhatsApp Business Platform
// (Meta Cloud API), receive-only.
//
// The owner pastes a permanent access token (a System User token from Meta
// Business Settings) and the phone number id of their WhatsApp Business
// number. Starlane checks both with one read of that number and then
// receives the customer messages Meta delivers to Starlane's webhook
// (/api/connectors/whatsapp_business/webhook), each stored once as a
// connection event and matched to a customer by phone number.
//
// Sending is not part of this connector at all: it declares SUBSCRIBE only,
// so the SDK refuses any send, and no code here calls Meta's messages
// endpoint. Sending reminders stays behind FEATURE_EXTERNAL_MESSAGE_SENDING_ENABLED
// and the owner's approval, elsewhere.
//
// Webhook deliveries are verified with Meta's X-Hub-Signature-256 (HMAC-SHA256
// of the raw body with META_APP_SECRET); the subscription handshake checks
// WHATSAPP_WEBHOOK_VERIFY_TOKEN.

const crypto = require('crypto');
const { defineConnector } = require('../sdk');
const { vendorRequest, base } = require('./http');

const ID = 'whatsapp_business';
const GRAPH_VERSION = 'v21.0';
const PHONE_ID_RE = /^\d{6,25}$/;
const BODY_LIMIT = 4000;

const graph = () => `${base('metaGraph', 'https://graph.facebook.com')}/${GRAPH_VERSION}`;

function makeClient({ credentials }) {
  return async (path, query = {}) => (await vendorRequest(`${graph()}${path}?${new URLSearchParams(query)}`, {
    headers: { Authorization: `Bearer ${credentials.accessToken}` }, label: 'WhatsApp (Meta)',
  })).json || {};
}

const fields = [
  { name: 'phoneNumberId', label: 'Phone number ID', secret: false, placeholder: '1234567890…', help: 'Meta App Dashboard › WhatsApp › API Setup, under your business number.' },
  { name: 'accessToken', label: 'Permanent access token', secret: true, placeholder: 'EAAG…', help: 'A System User token from Meta Business Settings with whatsapp_business_messaging. Starlane encrypts it and never shows it again.' },
];

async function verify(input = {}) {
  const phoneNumberId = String(input.phoneNumberId || '').trim();
  const accessToken = String(input.accessToken || '').trim();
  if (!PHONE_ID_RE.test(phoneNumberId)) throw Object.assign(new Error('The phone number ID is the long number under your business number in API Setup (not the phone number itself).'), { status: 400 });
  if (accessToken.length < 20 || accessToken.length > 1000) throw Object.assign(new Error('Paste the permanent access token.'), { status: 400 });
  const get = makeClient({ credentials: { accessToken } });
  let n;
  try {
    n = await get(`/${phoneNumberId}`, { fields: 'display_phone_number,verified_name,quality_rating' });
  } catch (err) {
    if (err.kind === 'AUTH_EXPIRED' || err.kind === 'PERMANENT') throw Object.assign(new Error('Meta did not accept that token for that phone number ID.'), { status: 400 });
    throw err;
  }
  return {
    credentials: { accessToken },
    config: { displayPhoneNumber: n.display_phone_number || null, verifiedName: n.verified_name || null, qualityRating: n.quality_rating || null },
    externalAccountId: phoneNumberId,
    label: [n.verified_name, n.display_phone_number].filter(Boolean).join(' · ') || 'WhatsApp Business number',
  };
}

/** Meta's signature over the exact bytes received. */
function signatureValid(rawBody, header, appSecret = process.env.META_APP_SECRET) {
  if (!appSecret || !header) return false;
  const expected = `sha256=${crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex')}`;
  const a = Buffer.from(expected);
  const b = Buffer.from(String(header).trim().toLowerCase());
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Pure: a webhook body → the inbound messages in it, per phone number id. */
function inboundMessages(body) {
  const out = [];
  for (const entry of (body && body.entry) || []) {
    for (const change of entry.changes || []) {
      if (change.field !== 'messages') continue;
      const v = change.value || {};
      const phoneNumberId = v.metadata?.phone_number_id ? String(v.metadata.phone_number_id) : null;
      const names = new Map((v.contacts || []).map((c) => [String(c.wa_id), c.profile?.name || null]));
      for (const m of v.messages || []) {
        const text = m.text?.body || m.button?.text || m.interactive?.button_reply?.title || m.interactive?.list_reply?.title || m.image?.caption || m.document?.caption || '';
        out.push({
          phoneNumberId,
          messageId: String(m.id || ''),
          from: String(m.from || ''),
          fromName: names.get(String(m.from)) || null,
          type: m.type || 'unknown',
          text: String(text).slice(0, BODY_LIMIT),
          receivedAt: m.timestamp ? new Date(Number(m.timestamp) * 1000).toISOString() : new Date().toISOString(),
          contextMessageId: m.context?.id || null,
        });
      }
    }
  }
  return out.filter((m) => m.phoneNumberId && m.messageId);
}

const connector = defineConnector({
  id: ID,
  provider: 'Meta',
  version: '1.0.0',
  mode: 'webhook',
  authType: 'api_key',
  capabilities: ['SUBSCRIBE'],
  async test({ credentials }) {
    await credentials.get(`/${credentials.phoneNumberId}`, { fields: 'id' });
    return { ok: true };
  },
  async subscribe() {
    return { webhook: '/api/connectors/whatsapp_business/webhook', fields: ['messages'] };
  },
});

module.exports = {
  id: ID,
  authKind: 'api_key',
  flag: 'FEATURE_CONNECTOR_WHATSAPP_BUSINESS_ENABLED',
  requiresEnv: ['META_APP_SECRET', 'WHATSAPP_WEBHOOK_VERIFY_TOKEN', 'OUTBOUND_CREDENTIALS_KEY'],
  entities: [],
  fields, verify, makeClient, connector,
  signatureValid, inboundMessages, PHONE_ID_RE,
};

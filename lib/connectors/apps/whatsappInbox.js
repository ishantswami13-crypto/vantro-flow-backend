'use strict';
// lib/connectors/apps/whatsappInbox.js — customer messages Meta delivers to
// Starlane's WhatsApp webhook.
//
// The tenant comes only from the phone number id in the delivery, looked up
// among connected WhatsApp Business accounts; a number nobody connected is
// ignored. Each message is stored once (starlane_connection_events,
// source 'whatsapp', keyed on Meta's message id, so Meta's retries are
// harmless) with the customer it came from when the sender's number matches
// a customer's phone. Nothing is sent back.

const wa = require('./whatsappBusiness');
const { isLive } = require('./index');

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

/** The subscription handshake (GET). Returns the challenge to echo. */
function verifySubscription(query = {}) {
  const token = process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN;
  if (!token || query['hub.mode'] !== 'subscribe' || String(query['hub.verify_token'] || '') !== token) throw httpError(403, 'verification failed');
  return String(query['hub.challenge'] || '');
}

async function receive(pool, rawBody, signatureHeader) {
  if (!isLive('whatsapp_business')) throw httpError(404, 'not enabled');
  const raw = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody || ''), 'utf8');
  if (!wa.signatureValid(raw, signatureHeader)) throw httpError(401, 'bad signature');
  let body;
  try { body = JSON.parse(raw.toString('utf8') || '{}'); } catch { throw httpError(400, 'not JSON'); }
  const messages = wa.inboundMessages(body);
  const out = { received: messages.length, stored: 0, duplicates: 0, unknownNumber: 0 };
  const accounts = new Map();
  for (const m of messages) {
    if (!accounts.has(m.phoneNumberId)) {
      const r = await pool.query(`SELECT id, user_id FROM app_connector_accounts WHERE connector_id = 'whatsapp_business' AND external_account_id = $1 AND status = 'CONNECTED'`, [m.phoneNumberId]);
      accounts.set(m.phoneNumberId, r.rows[0] || null);
    }
    const account = accounts.get(m.phoneNumberId);
    if (!account) { out.unknownNumber++; continue; }
    const last10 = m.from.replace(/\D/g, '').slice(-10);
    const customer = last10.length === 10 ? (await pool.query(
      `SELECT id, name FROM customers WHERE user_id = $1 AND right(regexp_replace(COALESCE(phone,''), '\\D', '', 'g'), 10) = $2 ORDER BY created_at LIMIT 1`,
      [account.user_id, last10])).rows[0] || null : null;
    const payload = { ...m, customerId: customer?.id || null, customerName: customer?.name || null };
    const ins = await pool.query(
      `INSERT INTO starlane_connection_events (user_id, source, external_id, payload) VALUES ($1,'whatsapp',$2,$3)
       ON CONFLICT (user_id, source, external_id) DO NOTHING RETURNING id`,
      [account.user_id, `${m.phoneNumberId}:${m.messageId}`, JSON.stringify(payload)]);
    if (ins.rows[0]) {
      out.stored++;
      await pool.query('UPDATE app_connector_accounts SET last_sync_at = now(), last_success_at = now() WHERE id = $1 AND user_id = $2', [account.id, account.user_id]);
    } else out.duplicates++;
  }
  return out;
}

module.exports = { verifySubscription, receive };

// Phone-number sign-in for existing accounts: a 6-digit code by SMS through
// Twilio. Off unless AUTH_SMS_ENABLED=true and Twilio SMS is configured
// (TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_PHONE_NUMBER or
// TWILIO_MESSAGING_SERVICE_SID). This only ever texts the account holder their
// own sign-in code; it is not customer messaging.
'use strict';

/** "+91 98765 43210", "098765 43210", "9876543210" -> "919876543210" (digits, with country code). */
function normalizePhone(raw) {
  let d = String(raw || '').replace(/\D/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  if (d.length === 10) d = `91${d}`; // a bare 10-digit number is Indian
  return d.length >= 11 && d.length <= 15 ? d : '';
}

function smsConfigured() {
  const e = process.env;
  return e.AUTH_SMS_ENABLED === 'true' && !!e.TWILIO_ACCOUNT_SID && !!e.TWILIO_AUTH_TOKEN && !!(e.TWILIO_PHONE_NUMBER || e.TWILIO_MESSAGING_SERVICE_SID);
}

async function sendSignInCode(phoneDigits, code) {
  const e = process.env;
  const twilio = require('twilio')(e.TWILIO_ACCOUNT_SID, e.TWILIO_AUTH_TOKEN);
  const msg = { to: `+${phoneDigits}`, body: `${code} is your Starlane sign-in code. It expires in 10 minutes. Never share it.` };
  if (e.TWILIO_MESSAGING_SERVICE_SID) msg.messagingServiceSid = e.TWILIO_MESSAGING_SERVICE_SID; else msg.from = e.TWILIO_PHONE_NUMBER;
  await twilio.messages.create(msg);
}

module.exports = { normalizePhone, smsConfigured, sendSignInCode };

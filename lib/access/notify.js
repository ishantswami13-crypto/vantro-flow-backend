// FILE: lib/access/notify.js
// Transactional email for the access flow via Resend (same provider as OTP
// email in server.js). Returns true only when the provider accepted it, so
// callers can tell admins honestly whether the applicant was emailed.
async function sendAccessEmail({ to, subject, text }) {
  const key = process.env.RESEND_API_KEY;
  if (!key || !to) return false;
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ from: process.env.ACCESS_EMAIL_FROM || process.env.EMAIL_FROM || 'Starlane <onboarding@resend.dev>', to, subject, text }),
      signal: AbortSignal.timeout(8000),
    });
    const data = await res.json().catch(() => ({}));
    return Boolean(res.ok && data.id);
  } catch {
    return false;
  }
}

module.exports = { sendAccessEmail };

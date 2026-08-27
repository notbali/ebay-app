const fetch = require('node-fetch');

// Thin wrapper around Resend's REST API (no SDK dependency - consistent with this app's
// zero-extra-deps approach, node-fetch is already a dependency for eBay/AI calls).
// Without a verified sending domain on the Resend account, "from" must stay onboarding@resend.dev
// and mail can only be delivered to the address that owns the Resend account - fine for a single
// admin inbox, see README if a real sending domain gets added later.
async function sendEmail({ to, subject, text }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error('RESEND_API_KEY is not set');

  const from = process.env.FEEDBACK_FROM_EMAIL || 'onboarding@resend.dev';

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ from, to, subject, text }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Resend API error ${res.status}: ${body}`);
  }
}

module.exports = { sendEmail };

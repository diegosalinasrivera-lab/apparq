/* Shared email sender — Gmail API (primary) | Resend (fallback)
   Usage: await sendEmail({ to, subject, html }, env)
   Gmail env vars: GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN
   Resend fallback: RESEND_API_KEY
*/

function encodeSubject(s) {
  const bytes = new TextEncoder().encode(s);
  let b = '';
  for (const byte of bytes) b += String.fromCharCode(byte);
  return `=?UTF-8?B?${btoa(b)}?=`;
}

async function sendEmailGmail({ to, subject, html }, env) {
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `client_id=${encodeURIComponent(env.GMAIL_CLIENT_ID)}&client_secret=${encodeURIComponent(env.GMAIL_CLIENT_SECRET)}&refresh_token=${encodeURIComponent(env.GMAIL_REFRESH_TOKEN)}&grant_type=refresh_token`,
  });
  const tokenData = await tokenRes.json();
  const access_token = tokenData.access_token;
  if (!access_token) { console.error('Gmail auth failed:', JSON.stringify(tokenData)); return; }

  const toStr = Array.isArray(to) ? to.join(', ') : String(to);
  const rawMsg =
    `From: APPARQ <hola@apparq.cl>\r\n` +
    `To: ${toStr}\r\n` +
    `Subject: ${encodeSubject(subject)}\r\n` +
    `MIME-Version: 1.0\r\n` +
    `Content-Type: text/html; charset=UTF-8\r\n` +
    `\r\n` +
    html;

  const bytes = new TextEncoder().encode(rawMsg);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const encoded = btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${access_token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw: encoded }),
  });
  if (!res.ok) console.error('Gmail send error:', await res.text());
}

async function sendEmailResend({ to, subject, html }, env) {
  const key = env.RESEND_API_KEY || 're_RRVTgGik_GtaRwK2p9jimrkemYTY4Uew6';
  const toStr = Array.isArray(to) ? to.join(',') : String(to);
  const from = toStr.includes('hola@apparq.cl') ? 'APPARQ <no-reply@apparq.cl>' : 'APPARQ <hola@apparq.cl>';
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to, subject, html }),
  });
  if (!res.ok) console.error('Resend error:', await res.text());
}

export async function sendEmail({ to, subject, html }, env) {
  if (!env) return;
  try {
    if (env.GMAIL_REFRESH_TOKEN) {
      await sendEmailGmail({ to, subject, html }, env);
    } else {
      await sendEmailResend({ to, subject, html }, env);
    }
  } catch (err) {
    console.error('sendEmail error:', err);
  }
}

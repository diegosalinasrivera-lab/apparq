/* ══════════════════════════════════════════════════
   APPARQ — Netlify Function: portal-client-send
   El cliente envía un mensaje al arquitecto
   Verifica que el proyecto le pertenece por email
   POST /.netlify/functions/portal-client-send
   Body: { project_number, email, content }
══════════════════════════════════════════════════ */

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

function filterContent(text) {
  return text
    .replace(/(\+?56)?[\s\-]?9[\s\-]?\d{4}[\s\-]?\d{4}/g, '[número bloqueado]')
    .replace(/\b\d{9,}\b/g, '[número bloqueado]')
    .replace(/[^\s@]+@[^\s@]+\.[^\s@]+/g, '[email bloqueado]')
    .replace(/(https?:\/\/[^\s]+)/g, '[enlace bloqueado]')
    .replace(/instagram|whatsapp|telegram|wa\.me/gi, '[plataforma bloqueada]');
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Método no permitido' }) };
  }

  try {
    const { project_number, email, content } = JSON.parse(event.body || '{}');

    if (!project_number || !email || !content?.trim()) {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Faltan datos' }) };
    }

    const emailLower = email.trim().toLowerCase();
    const numUpper   = project_number.trim().toUpperCase();

    /* Verificar que el proyecto le pertenece a este email */
    const checkRes = await fetch(
      `${SUPABASE_URL}/rest/v1/projects?project_number=eq.${encodeURIComponent(numUpper)}&client_email=eq.${encodeURIComponent(emailLower)}&select=id&limit=1`,
      { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
    );
    const checkData = await checkRes.json();
    if (!checkData.length) {
      return { statusCode: 403, headers: CORS, body: JSON.stringify({ error: 'Proyecto no encontrado' }) };
    }

    const clean = filterContent(content.trim());

    const msgRes = await fetch(`${SUPABASE_URL}/rest/v1/messages`, {
      method: 'POST',
      headers: {
        'apikey':        SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type':  'application/json',
        'Prefer':        'return=representation',
      },
      body: JSON.stringify({
        project_number:    numUpper,
        sender_email:      emailLower,
        sender_role:       'client',
        content:           clean,
        read_by_client:    true,
        read_by_architect: false,
      }),
    });

    if (!msgRes.ok) {
      return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Error al enviar mensaje' }) };
    }

    return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, content: clean }) };

  } catch (err) {
    console.error('portal-client-send error:', err);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Error interno' }) };
  }
};

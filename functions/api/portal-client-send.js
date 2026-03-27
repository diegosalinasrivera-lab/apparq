/* ══════════════════════════════════════════════════
   APPARQ — Cloudflare Pages Function: portal-client-send
   El cliente envía un mensaje al arquitecto
   Verifica que el proyecto le pertenece por email
   POST /api/portal-client-send
   Body: { project_number, email, content }
══════════════════════════════════════════════════ */

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

function corsResponse(body, status = 200) {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: CORS });
}

function filterContent(text) {
  return text
    .replace(/(\+?56)?[\s\-]?9[\s\-]?\d{4}[\s\-]?\d{4}/g, '[número bloqueado]')
    .replace(/\b\d{9,}\b/g, '[número bloqueado]')
    .replace(/[^\s@]+@[^\s@]+\.[^\s@]+/g, '[email bloqueado]')
    .replace(/(https?:\/\/[^\s]+)/g, '[enlace bloqueado]')
    .replace(/instagram|whatsapp|telegram|wa\.me/gi, '[plataforma bloqueada]');
}

export async function onRequest(context) {
  const { request, env } = context;
  const SUPABASE_URL = env.SUPABASE_URL || 'https://ibdafnzlsufsshczqvoa.supabase.co';
  const SUPABASE_KEY = env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImliZGFmbnpsc3Vmc3NoY3pxdm9hIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM5Njg0NjYsImV4cCI6MjA4OTU0NDQ2Nn0.ucEjCcnSbaz-OeMrLbUbgcKacvg9J2Csg2VzrWVtVHA';

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }
  if (request.method !== 'POST') {
    return corsResponse({ error: 'Método no permitido' }, 405);
  }

  try {
    const { project_number, email, content } = await request.json();

    if (!project_number || !email || !content?.trim()) {
      return corsResponse({ error: 'Faltan datos' }, 400);
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
      return corsResponse({ error: 'Proyecto no encontrado' }, 403);
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
      return corsResponse({ error: 'Error al enviar mensaje' }, 500);
    }

    return corsResponse({ ok: true, content: clean });

  } catch (err) {
    console.error('portal-client-send error:', err);
    return corsResponse({ error: 'Error interno' }, 500);
  }
}

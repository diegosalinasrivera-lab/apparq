/* ══════════════════════════════════════════════════
   APPARQ — Cloudflare Pages Function: portal-client-send
   El cliente envía un mensaje al arquitecto
   Verifica que el proyecto le pertenece por email
   POST /api/portal-client-send
   Body: { project_number, email, content }
══════════════════════════════════════════════════ */

const CORS = {
  'Access-Control-Allow-Origin': 'https://apparq.cl',
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

async function sendEmail({ to, subject, html }, RESEND_API_KEY) {
  if (!RESEND_API_KEY) return;
  try {
    const toStr = Array.isArray(to) ? to.join(',') : String(to);
    const from = toStr.includes('hola@apparq.cl') ? 'APPARQ <no-reply@apparq.cl>' : 'APPARQ <hola@apparq.cl>';
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to, subject, html }),
    });
    if (!res.ok) console.error('Resend error (client-send):', await res.text());
  } catch (e) { console.error('sendEmail error (client-send):', e); }
}

export async function onRequest(context) {
  const { request, env } = context;
  const SUPABASE_URL   = env.SUPABASE_URL || 'https://ibdafnzlsufsshczqvoa.supabase.co';
  const SUPABASE_KEY   = env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImliZGFmbnpsc3Vmc3NoY3pxdm9hIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM5Njg0NjYsImV4cCI6MjA4OTU0NDQ2Nn0.ucEjCcnSbaz-OeMrLbUbgcKacvg9J2Csg2VzrWVtVHA';
  const RESEND_API_KEY = env.RESEND_API_KEY || 're_RRVTgGik_GtaRwK2p9jimrkemYTY4Uew6';

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

    /* Verificar que el proyecto le pertenece a este email (y obtener datos para email) */
    const checkRes = await fetch(
      `${SUPABASE_URL}/rest/v1/projects?project_number=eq.${encodeURIComponent(numUpper)}&client_email=eq.${encodeURIComponent(emailLower)}&select=id,client_nombre,client_apellido,architect_nombre,architect_apellido,architect_email,service_type,commune&limit=1`,
      { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
    );
    const checkData = await checkRes.json();
    if (!checkData.length) {
      return corsResponse({ error: 'Proyecto no encontrado' }, 403);
    }
    const proj = checkData[0];

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

    /* Notificar a hola@apparq.cl */
    const svcLabels = { regularizacion:'Regularización', ampliacion:'Ampliación', 'obra-nueva':'Obra Nueva', informe:'Informe', 'declaracion-jurada':'Declaración Jurada', 'ley-del-mono':'Ley del Mono' };
    const svcName   = svcLabels[proj.service_type] || proj.service_type;
    const clientName = `${proj.client_nombre} ${proj.client_apellido}`.trim();
    const fechaHora  = new Date().toLocaleString('es-CL', {
      timeZone: 'America/Santiago', day: '2-digit', month: 'long', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
    await sendEmail({
      to:      'hola@apparq.cl',
      subject: `💬 Mensaje de cliente — ${numUpper} · ${clientName}`,
      html: `
        <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#1a1a2e">
          <div style="background:#1a1a2e;padding:22px 32px;border-radius:8px 8px 0 0">
            <h2 style="color:#fff;margin:0;font-size:17px">APPARQ — Mensaje del cliente</h2>
          </div>
          <div style="background:#EEF2FF;border:2px solid #C7D2FE;padding:12px 32px">
            <p style="margin:0;font-size:14px;font-weight:700;color:#3730A3">💬 El cliente <strong>${clientName}</strong> envió un mensaje al arquitecto</p>
          </div>
          <div style="background:#fff;padding:22px 32px;border:1px solid #e2e8f0;border-radius:0 0 8px 8px">
            <table style="width:100%;border-collapse:collapse;font-size:13px;margin-bottom:14px">
              <tr style="background:#f7fafc"><td style="padding:7px 10px;color:#718096;width:40%">N° Trámite</td><td style="padding:7px 10px;font-weight:700;color:#E8503A">${numUpper}</td></tr>
              <tr><td style="padding:7px 10px;color:#718096">Cliente</td><td style="padding:7px 10px">${clientName} · ${emailLower}</td></tr>
              <tr style="background:#f7fafc"><td style="padding:7px 10px;color:#718096">Arquitecto</td><td style="padding:7px 10px">${proj.architect_nombre} ${proj.architect_apellido} · ${proj.architect_email || '—'}</td></tr>
              <tr><td style="padding:7px 10px;color:#718096">Servicio</td><td style="padding:7px 10px">${svcName} · ${proj.commune}</td></tr>
              <tr style="background:#f7fafc"><td style="padding:7px 10px;color:#718096">Hora</td><td style="padding:7px 10px">${fechaHora}</td></tr>
            </table>
            <div style="background:#EEF2FF;border:1.5px solid #C7D2FE;border-radius:8px;padding:13px 18px">
              <p style="margin:0 0 4px;font-size:11px;color:#4338CA;font-weight:700;text-transform:uppercase">Mensaje</p>
              <p style="margin:0;font-size:13px;color:#1e1b4b;line-height:1.6">${clean}</p>
            </div>
            <div style="text-align:center;margin-top:16px">
              <a href="https://apparq.cl/admin" style="display:inline-block;background:#E8503A;color:#fff;text-decoration:none;font-weight:700;font-size:13px;padding:9px 24px;border-radius:6px">Ver en Admin</a>
            </div>
          </div>
        </div>`,
    }, RESEND_API_KEY);

    return corsResponse({ ok: true, content: clean });

  } catch (err) {
    console.error('portal-client-send error:', err);
    return corsResponse({ error: 'Error interno' }, 500);
  }
}

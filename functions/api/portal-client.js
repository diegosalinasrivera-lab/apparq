/* ══════════════════════════════════════════════════
   APPARQ — Cloudflare Pages Function: portal-client
   Consulta el proyecto de un cliente por número + email
   No requiere autenticación (el par proyecto+email es el verificador)
   POST /api/portal-client
   Body: { action?, project_number, email, nota? }
   Actions: (none) = get-project | get-updates | send-note
══════════════════════════════════════════════════ */

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
};

function corsResponse(body, status = 200) {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: CORS });
}

const STAGE_LABELS = {
  levantamiento:     { label: 'Levantamiento en terreno',   pct: 20, desc: 'Tu arquitecto coordinará la visita' },
  elaboracion:       { label: 'Elaboración de planos',       pct: 40, desc: 'En preparación' },
  ingreso_dom:       { label: 'Ingreso a la DOM',            pct: 60, desc: 'Documentación ingresada' },
  tramitacion:       { label: 'Tramitación municipal',       pct: 80, desc: 'En revisión por la municipalidad' },
  completado:        { label: '🎉 Trámite completado',       pct: 100, desc: 'Recepción Final aprobada' },
  visita:            { label: 'Visita a terreno',            pct: 33, desc: 'Coordinando con tu arquitecto' },
  elaboracion_inf:   { label: 'Elaboración del informe',     pct: 66, desc: 'En preparación' },
  entrega_informe:   { label: '🎉 Informe entregado',        pct: 100, desc: 'Informe listo' },
};

async function sendEmail({ to, subject, html }, RESEND_API_KEY) {
  if (!RESEND_API_KEY) return;
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: 'APPARQ <hola@apparq.cl>', to, subject, html }),
  });
  if (!res.ok) console.error('Resend error:', await res.text());
}

/* Verifica que el par proyecto+email corresponde al cliente */
async function verifyProject(numUpper, emailLower, SUPABASE_URL, SUPABASE_KEY) {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/projects?project_number=eq.${encodeURIComponent(numUpper)}&client_email=eq.${encodeURIComponent(emailLower)}&select=*&limit=1`,
    { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
  );
  if (!res.ok) return null;
  const data = await res.json();
  return data.length ? data[0] : null;
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
    const body         = await request.json();
    const action       = body.action || 'get-project';
    const project_number = body.project_number;
    const email          = body.email;

    if (!project_number) {
      return corsResponse({ error: 'Se requiere número de proyecto' }, 400);
    }

    const numUpper = project_number.trim().toUpperCase();

    /* ── GET-UPDATES (no requiere email) ────────── */
    if (action === 'get-updates') {
      const updRes = await fetch(
        `${SUPABASE_URL}/rest/v1/project_updates?project_number=eq.${encodeURIComponent(numUpper)}&order=created_at.asc`,
        { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
      );
      const updates = updRes.ok ? await updRes.json() : [];
      return corsResponse({ updates });
    }

    /* Acciones que requieren verificación email */
    if (!email) {
      return corsResponse({ error: 'Se requiere email' }, 400);
    }
    const emailLower = email.trim().toLowerCase();
    const project    = await verifyProject(numUpper, emailLower, SUPABASE_URL, SUPABASE_KEY);

    if (!project) {
      return corsResponse({ error: 'No se encontró el proyecto. Verifica el número y el email.' }, 404);
    }

    /* ── SEND-NOTE ──────────────────────────────── */
    if (action === 'send-note') {
      const nota = (body.nota || '').trim();
      if (!nota) {
        return corsResponse({ error: 'La consulta no puede estar vacía' }, 400);
      }

      /* Guardar en project_updates */
      await fetch(`${SUPABASE_URL}/rest/v1/project_updates`, {
        method: 'POST',
        headers: {
          'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`,
          'Content-Type': 'application/json', 'Prefer': 'return=minimal',
        },
        body: JSON.stringify({
          project_number: numUpper,
          author:         'client',
          nota,
        }),
      });

      const fecha    = new Date().toLocaleDateString('es-CL', { day:'2-digit', month:'long', year:'numeric' });
      const svcLabel = { regularizacion:'Regularización', ampliacion:'Ampliación', 'obra-nueva':'Obra Nueva', informe:'Informe de Propiedad' };
      const svcName  = svcLabel[project.service_type] || project.service_type;
      const clientName = `${project.client_nombre} ${project.client_apellido}`.trim();

      /* Email al arquitecto */
      if (project.architect_email) {
        await sendEmail({
          to:      project.architect_email,
          subject: `📩 Consulta del cliente — ${numUpper} · ${svcName}`,
          html: `
            <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#1a1a2e">
              <div style="background:#1a1a2e;padding:24px 32px;border-radius:8px 8px 0 0">
                <h1 style="color:#fff;margin:0;font-size:20px">APPARQ — Consulta del cliente</h1>
              </div>
              <div style="background:#fff;padding:28px 32px;border:1px solid #e2e8f0;border-radius:0 0 8px 8px">
                <p style="font-size:14px;color:#4a5568;">El cliente <strong>${clientName}</strong> envió una consulta sobre su trámite:</p>
                <div style="background:#EEF2FF;border:1.5px solid #C7D2FE;border-radius:8px;padding:14px 20px;margin:16px 0;">
                  <p style="margin:0;font-size:13px;color:#1e1b4b;line-height:1.6;">${nota}</p>
                </div>
                <table style="width:100%;border-collapse:collapse;font-size:13px;margin-top:16px">
                  <tr style="background:#f7fafc"><td style="padding:8px 10px;color:#718096;width:40%">N° Trámite</td><td style="padding:8px 10px;font-weight:700;color:#E8503A">${numUpper}</td></tr>
                  <tr><td style="padding:8px 10px;color:#718096">Servicio</td><td style="padding:8px 10px">${svcName} · ${project.commune}</td></tr>
                  <tr style="background:#f7fafc"><td style="padding:8px 10px;color:#718096">Fecha</td><td style="padding:8px 10px">${fecha}</td></tr>
                </table>
                <p style="font-size:12px;color:#a0aec0;margin-top:20px;">Para responder, actualiza el avance del trámite en <a href="https://apparq.cl" style="color:#E8503A">apparq.cl → Soy Arquitecto</a></p>
              </div>
            </div>`,
        }, RESEND_API_KEY);
      }

      /* Email a hola@apparq.cl */
      await sendEmail({
        to:      'hola@apparq.cl',
        subject: `📩 Consulta cliente — ${numUpper} — ${clientName}`,
        html: `<div style="font-family:Arial,sans-serif;font-size:13px;max-width:500px;">
          <p><strong>Trámite:</strong> ${numUpper} · ${svcName} · ${project.commune}</p>
          <p><strong>Cliente:</strong> ${clientName} · ${emailLower}</p>
          <p><strong>Arquitecto:</strong> ${project.architect_nombre} ${project.architect_apellido}</p>
          <div style="background:#EEF2FF;border:1px solid #C7D2FE;border-radius:8px;padding:12px 16px;margin:12px 0;">
            <p style="margin:0;line-height:1.6;">${nota}</p>
          </div>
        </div>`,
      }, RESEND_API_KEY);

      return corsResponse({ ok: true });
    }

    /* ── GET-PROJECT (default) ──────────────────── */
    const stageInfo = STAGE_LABELS[project.stage] || { label: project.stage, pct: 0, desc: '' };

    return corsResponse({
      project: {
        ...project,
        stage_label: stageInfo.label,
        stage_pct:   stageInfo.pct,
        stage_desc:  stageInfo.desc,
      },
    });

  } catch (err) {
    console.error('portal-client error:', err);
    return corsResponse({ error: 'Error interno' }, 500);
  }
}

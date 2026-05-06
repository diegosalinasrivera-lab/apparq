/* ══════════════════════════════════════════════════
   APPARQ — Cloudflare Pages Function: check-contacts
   Cron interno: detecta trámites donde el arquitecto
   no ha marcado "cliente contactado" en 24h hábiles
   y envía alerta a hola@apparq.cl.

   GET /api/check-contacts
   Header requerido: X-Cron-Token: <CRON_SECRET>
   (o llamada interna sin header si CRON_SECRET no está configurado)
══════════════════════════════════════════════════ */

const SUPABASE_URL  = 'https://ibdafnzlsufsshczqvoa.supabase.co';
const ADMIN_EMAIL   = 'hola@apparq.cl';

/* Horario hábil: lunes–viernes 09:00–18:00 CLT (UTC-3) */
const BIZ_START_UTC = 12; /* 09:00 CLT = 12:00 UTC */
const BIZ_END_UTC   = 21; /* 18:00 CLT = 21:00 UTC */
const BIZ_THRESHOLD = 24; /* horas hábiles para alerta */

function businessHoursElapsed(createdAt) {
  const start = new Date(createdAt);
  const now   = new Date();
  let elapsed = 0;
  const cursor = new Date(start);

  while (cursor < now) {
    const dow = cursor.getUTCDay(); // 0=Sun, 6=Sat
    const h   = cursor.getUTCHours();
    if (dow >= 1 && dow <= 5 && h >= BIZ_START_UTC && h < BIZ_END_UTC) {
      elapsed++;
    }
    cursor.setUTCHours(cursor.getUTCHours() + 1);
  }
  return elapsed;
}

function clpFmt(n) {
  return '$' + Math.round(n).toLocaleString('es-CL');
}

async function sendEmail({ to, subject, html }, RESEND_API_KEY) {
  if (!RESEND_API_KEY) return false;
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: 'APPARQ <hola@apparq.cl>', to, subject, html }),
  });
  return res.ok;
}

export async function onRequest(context) {
  const { request, env } = context;

  /* ── Auth: token secreto opcional ─────────── */
  const CRON_SECRET    = env.CRON_SECRET;
  const RESEND_API_KEY = env.RESEND_API_KEY;
  const SERVICE_KEY    = env.SUPABASE_SERVICE_KEY || env.SUPABASE_SVC;

  if (CRON_SECRET) {
    const token = request.headers.get('X-Cron-Token') || new URL(request.url).searchParams.get('token');
    if (token !== CRON_SECRET) {
      return new Response(JSON.stringify({ error: 'No autorizado' }), { status: 403 });
    }
  }

  if (!SERVICE_KEY) {
    return new Response(JSON.stringify({ error: 'SERVICE_KEY no configurada' }), { status: 503 });
  }

  /* ── Obtener trámites activos sin contacto confirmado ── */
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/projects` +
    `?select=id,project_number,client_nombre,client_apellido,client_email,` +
    `architect_nombre,architect_apellido,architect_email,` +
    `service_type,address,commune,total_clp,stage,created_at,` +
    `cliente_contactado,cliente_contactado_at,contacto_alerta_enviada` +
    `&cliente_contactado=eq.false` +
    `&stage=neq.completado` +
    `&architect_email=not.is.null` +
    `&order=created_at.asc`,
    { headers: { 'apikey': SERVICE_KEY, 'Authorization': `Bearer ${SERVICE_KEY}` } }
  );

  if (!res.ok) {
    const err = await res.text();
    return new Response(JSON.stringify({ error: 'Error Supabase', detail: err }), { status: 500 });
  }

  const projects = await res.json();
  const alerts   = [];
  const skipped  = [];

  for (const p of projects) {
    const bizHours = businessHoursElapsed(p.created_at);

    if (bizHours < BIZ_THRESHOLD) {
      skipped.push({ project_number: p.project_number, bizHours });
      continue;
    }

    /* Ya se envió alerta — no volver a enviar */
    if (p.contacto_alerta_enviada) {
      skipped.push({ project_number: p.project_number, bizHours, ya_alertado: true });
      continue;
    }

    const svcLabels = {
      regularizacion:       'Regularización',
      ampliacion:           'Ampliación',
      'declaracion-jurada': 'Declaración Jurada',
      'obra-nueva':         'Obra Nueva',
      informe:              'Informe de Propiedad',
      'ley-del-mono':       'Ley del Mono',
    };
    const svcName    = svcLabels[p.service_type] || p.service_type;
    const clientName = `${p.client_nombre || ''} ${p.client_apellido || ''}`.trim();
    const archName   = `${p.architect_nombre || ''} ${p.architect_apellido || ''}`.trim();
    const bizDays    = Math.floor(bizHours / 9);
    const bizRem     = bizHours % 9;

    const ok = await sendEmail({
      to:      ADMIN_EMAIL,
      subject: `🚨 Arquitecto no contactó al cliente · ${p.project_number} · ${archName} · ${bizHours}h hábiles`,
      html: `
        <div style="font-family:Arial,sans-serif;max-width:620px;margin:0 auto;color:#1a1a2e">
          <div style="background:#7F1D1D;padding:24px 32px;border-radius:8px 8px 0 0">
            <h1 style="color:#fff;margin:0;font-size:20px">⚠️ APPARQ — Alerta: arquitecto no contactó al cliente</h1>
            <p style="color:#FCA5A5;margin:6px 0 0;font-size:13px">Han transcurrido más de ${BIZ_THRESHOLD} horas hábiles sin confirmar contacto</p>
          </div>
          <div style="background:#fff;padding:28px 32px;border:1px solid #e2e8f0;border-radius:0 0 8px 8px">

            <div style="background:#FEF2F2;border:2px solid #F87171;border-radius:8px;padding:16px 20px;margin-bottom:20px;text-align:center">
              <p style="margin:0 0 4px;font-size:12px;color:#991B1B;font-weight:700;text-transform:uppercase;">N° Trámite</p>
              <p style="margin:0;font-size:28px;font-weight:900;color:#DC2626;letter-spacing:2px">${p.project_number}</p>
              <p style="margin:8px 0 0;font-size:13px;color:#991B1B;font-weight:600">${bizHours} horas hábiles sin contacto confirmado</p>
            </div>

            <table style="width:100%;border-collapse:collapse;font-size:13px;margin-bottom:20px">
              <tr style="background:#f7fafc"><td style="padding:7px 10px;color:#718096;width:42%">Arquitecto</td><td style="padding:7px 10px;font-weight:700;color:#DC2626">${archName}</td></tr>
              <tr><td style="padding:7px 10px;color:#718096">Email arquitecto</td><td style="padding:7px 10px">${p.architect_email || '—'}</td></tr>
              <tr style="background:#f7fafc"><td style="padding:7px 10px;color:#718096">Cliente</td><td style="padding:7px 10px;font-weight:700">${clientName}</td></tr>
              <tr><td style="padding:7px 10px;color:#718096">Email cliente</td><td style="padding:7px 10px">${p.client_email || '—'}</td></tr>
              <tr style="background:#f7fafc"><td style="padding:7px 10px;color:#718096">Servicio</td><td style="padding:7px 10px">${svcName}</td></tr>
              <tr><td style="padding:7px 10px;color:#718096">Dirección</td><td style="padding:7px 10px">${p.address || '—'}, ${p.commune || '—'}</td></tr>
              <tr style="background:#f7fafc"><td style="padding:7px 10px;color:#718096">Valor total</td><td style="padding:7px 10px;font-weight:700">${clpFmt(p.total_clp || 0)}</td></tr>
              <tr><td style="padding:7px 10px;color:#718096">Inicio trámite</td><td style="padding:7px 10px">${new Date(p.created_at).toLocaleString('es-CL', { timeZone: 'America/Santiago' })}</td></tr>
              <tr style="background:#f7fafc"><td style="padding:7px 10px;color:#718096">Horas hábiles</td><td style="padding:7px 10px;font-weight:700;color:#DC2626">${bizHours}h (${bizDays} día${bizDays !== 1 ? 's' : ''} + ${bizRem}h)</td></tr>
            </table>

            <div style="background:#FEF3C7;border:1.5px solid #FCD34D;border-radius:8px;padding:14px 18px;margin-bottom:16px">
              <p style="margin:0;font-size:13px;font-weight:700;color:#92400E">📋 Acciones recomendadas</p>
              <ol style="margin:8px 0 0;padding-left:20px;font-size:12px;color:#78350F;line-height:2">
                <li>Contactar directamente al arquitecto: <strong>${p.architect_email}</strong></li>
                <li>Si no responde, reasignar el trámite desde el panel admin</li>
                <li>Según contrato (cláusula 7b + 14): APPARQ puede reasignar sin previo aviso</li>
              </ol>
            </div>

            <a href="https://apparq.cl/admin" style="display:inline-block;background:#E8503A;color:#fff;text-decoration:none;font-weight:700;font-size:13px;padding:10px 24px;border-radius:6px;">Ir al panel admin →</a>

            <hr style="border:none;border-top:1px solid #e2e8f0;margin:24px 0 12px">
            <p style="font-size:11px;color:#a0aec0;margin:0">APPARQ · Alerta automática · Sistema de seguimiento de trámites</p>
          </div>
        </div>
      `,
    }, RESEND_API_KEY);

    if (ok) {
      /* Marcar alerta enviada en la DB */
      await fetch(
        `${SUPABASE_URL}/rest/v1/projects?id=eq.${p.id}`,
        {
          method: 'PATCH',
          headers: {
            'apikey':        SERVICE_KEY,
            'Authorization': `Bearer ${SERVICE_KEY}`,
            'Content-Type':  'application/json',
            'Prefer':        'return=minimal',
          },
          body: JSON.stringify({ contacto_alerta_enviada: true }),
        }
      );
      alerts.push({ project_number: p.project_number, bizHours, architect: archName });
    }
  }

  return new Response(JSON.stringify({
    ok:      true,
    checked: projects.length,
    alerts:  alerts.length,
    detail:  { alerts, skipped },
    ts:      new Date().toISOString(),
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

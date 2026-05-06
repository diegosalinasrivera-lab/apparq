/* ══════════════════════════════════════════════════
   APPARQ — Cloudflare Pages Function: check-contacts
   Cron interno: detecta trámites donde el arquitecto
   no contactó al cliente en el plazo contractual.

   Umbral 1 — 24h continuas: aviso al arquitecto
     "tienes 5 horas más o el trámite será reasignado"
   Umbral 2 — 29h continuas: reasignación automática
     + email al nuevo arquitecto + alerta a APPARQ

   GET /api/check-contacts
   (sin auth requerida — solo lectura + emails internos)
══════════════════════════════════════════════════ */

const SUPABASE_URL  = 'https://ibdafnzlsufsshczqvoa.supabase.co';
const ADMIN_EMAIL   = 'hola@apparq.cl';
const WARN_HOURS    = 24;   /* aviso al arquitecto          */
const GRACE_HOURS   = 5;    /* plazo adicional tras aviso   */
const REASSIGN_HOURS = WARN_HOURS + GRACE_HOURS; /* 29h → reasignar */

function hoursElapsed(createdAt) {
  return (Date.now() - new Date(createdAt).getTime()) / 3_600_000;
}

function clpFmt(n) {
  return '$' + Math.round(n).toLocaleString('es-CL');
}

function deadlineFmt(createdAt, totalHours) {
  const d = new Date(new Date(createdAt).getTime() + totalHours * 3_600_000);
  return d.toLocaleString('es-CL', {
    timeZone: 'America/Santiago',
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
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

/* ── Busca el mejor arquitecto alternativo ─────── */
async function findReplacementArchitect(SERVICE_KEY, commune, svc, excludeEmail) {
  const SVC_LABEL_MAP = {
    'ley-del-mono': 'Ley del Mono', regularizacion: 'Regularización',
    ampliacion: 'Ampliación', 'declaracion-jurada': 'Declaración Jurada',
    'obra-nueva': 'Obra Nueva', informe: 'Informe',
  };
  const svcLabel = SVC_LABEL_MAP[svc] || svc;

  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/architects?activo=eq.true&no_auto_assign=eq.false&select=id,nombre,apellido,email,tramites,comunas,patente`,
    { headers: { 'apikey': SERVICE_KEY, 'Authorization': `Bearer ${SERVICE_KEY}` } }
  );
  if (!res.ok) return null;
  const all = await res.json();

  /* Filtrar: opera en la comuna, hace el servicio, no es el mismo */
  const eligible = all.filter(a =>
    a.email !== excludeEmail &&
    Array.isArray(a.comunas) && a.comunas.includes(commune) &&
    Array.isArray(a.tramites) && a.tramites.includes(svcLabel)
  );
  if (!eligible.length) return null;

  /* Contar trámites activos por arquitecto */
  const countRes = await fetch(
    `${SUPABASE_URL}/rest/v1/projects?select=architect_email&stage=neq.completado&architect_email=not.is.null`,
    { headers: { 'apikey': SERVICE_KEY, 'Authorization': `Bearer ${SERVICE_KEY}` } }
  );
  const active = countRes.ok ? await countRes.json() : [];
  const load   = {};
  active.forEach(p => { load[p.architect_email] = (load[p.architect_email] || 0) + 1; });

  eligible.sort((a, b) => (load[a.email] || 0) - (load[b.email] || 0));
  return eligible[0];
}

export async function onRequest(context) {
  const { env } = context;
  const RESEND_API_KEY = env.RESEND_API_KEY;
  const SERVICE_KEY    = env.SUPABASE_SERVICE_KEY || env.SUPABASE_SVC;

  if (!SERVICE_KEY) {
    return new Response(JSON.stringify({ error: 'SERVICE_KEY no configurada' }), { status: 503 });
  }

  /* ── Obtener trámites activos sin contacto confirmado ── */
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/projects` +
    `?select=id,project_number,client_nombre,client_apellido,client_email,` +
    `architect_nombre,architect_apellido,architect_email,` +
    `service_type,address,commune,m2,total_clp,stage,created_at,` +
    `cliente_contactado,contacto_alerta_enviada` +
    `&cliente_contactado=eq.false` +
    `&stage=neq.completado` +
    `&architect_email=not.is.null` +
    `&order=created_at.asc`,
    { headers: { 'apikey': SERVICE_KEY, 'Authorization': `Bearer ${SERVICE_KEY}` } }
  );

  if (!res.ok) {
    return new Response(JSON.stringify({ error: 'Error Supabase', detail: await res.text() }), { status: 500 });
  }

  const projects   = await res.json();
  const warned     = [];
  const reassigned = [];
  const skipped    = [];

  for (const p of projects) {
    const hours    = hoursElapsed(p.created_at);
    const archName = `${p.architect_nombre || ''} ${p.architect_apellido || ''}`.trim();
    const clientName = `${p.client_nombre || ''} ${p.client_apellido || ''}`.trim();
    const svcLabels = {
      regularizacion: 'Regularización', ampliacion: 'Ampliación',
      'declaracion-jurada': 'Declaración Jurada', 'obra-nueva': 'Obra Nueva',
      informe: 'Informe de Propiedad', 'ley-del-mono': 'Ley del Mono',
    };
    const svcName = svcLabels[p.service_type] || p.service_type;

    /* ── UMBRAL 2: 29h → reasignación automática ── */
    if (hours >= REASSIGN_HOURS) {
      const replacement = await findReplacementArchitect(
        SERVICE_KEY, p.commune, p.service_type, p.architect_email
      );

      if (replacement) {
        /* Reasignar en DB */
        const patchRes = await fetch(`${SUPABASE_URL}/rest/v1/projects?id=eq.${p.id}`, {
          method: 'PATCH',
          headers: {
            'apikey': SERVICE_KEY, 'Authorization': `Bearer ${SERVICE_KEY}`,
            'Content-Type': 'application/json', 'Prefer': 'return=minimal',
          },
          body: JSON.stringify({
            architect_email:    replacement.email,
            architect_nombre:   replacement.nombre,
            architect_apellido: replacement.apellido,
            cliente_contactado: false,
            contacto_alerta_enviada: false,
          }),
        });

        if (patchRes.ok) {
          /* Email al arquitecto anterior */
          await sendEmail({
            to: p.architect_email,
            subject: `APPARQ · Trámite ${p.project_number} reasignado`,
            html: `<div style="font-family:Arial,sans-serif;max-width:580px;margin:0 auto;color:#1a1a2e">
              <div style="background:#1a1a2e;padding:24px 28px;border-radius:8px 8px 0 0">
                <h1 style="color:#fff;margin:0;font-size:18px">APPARQ · Reasignación de trámite</h1>
              </div>
              <div style="background:#fff;padding:28px;border:1px solid #e2e8f0;border-radius:0 0 8px 8px">
                <p style="font-size:14px;color:#4a5568;line-height:1.7">Hola ${p.architect_nombre},<br><br>
                El trámite <strong>${p.project_number}</strong> ha sido reasignado a otro arquitecto porque no se confirmó el contacto con el cliente dentro del plazo contractual de 24 horas (cláusula 7b).</p>
                <p style="font-size:13px;color:#718096">Si tienes alguna consulta, escríbenos a <a href="mailto:hola@apparq.cl">hola@apparq.cl</a>.</p>
                <hr style="border:none;border-top:1px solid #e2e8f0;margin:20px 0 12px">
                <p style="font-size:11px;color:#a0aec0;margin:0">APPARQ · DSR ARQ SPA · RUT 76.341.206-7</p>
              </div>
            </div>`,
          }, RESEND_API_KEY);

          /* Email al nuevo arquitecto */
          await sendEmail({
            to: replacement.email,
            subject: `🏗 Nuevo trámite asignado — ${p.project_number} · ${p.commune} — APPARQ`,
            html: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#1a1a2e">
              <div style="background:#1a1a2e;padding:32px;text-align:center;border-radius:8px 8px 0 0">
                <h1 style="color:#fff;margin:0;font-size:26px">APPARQ</h1>
                <p style="color:#a0aec0;margin:8px 0 0;font-size:13px">Se te ha asignado un nuevo trámite</p>
              </div>
              <div style="background:#fff;padding:32px;border:1px solid #e2e8f0;border-radius:0 0 8px 8px">
                <h2 style="margin-top:0">¡Hola ${replacement.nombre}! 🎉</h2>
                <div style="background:#FFF7ED;border:2px solid #E8503A;border-radius:8px;padding:14px 20px;margin:0 0 20px;text-align:center">
                  <p style="margin:0 0 4px;font-size:12px;color:#92400E;font-weight:700;text-transform:uppercase">N° de Trámite</p>
                  <p style="margin:0;font-size:28px;font-weight:900;color:#E8503A;letter-spacing:2px">${p.project_number}</p>
                </div>
                <table style="width:100%;border-collapse:collapse;font-size:13px">
                  <tr style="background:#f7fafc"><td style="padding:8px 10px;color:#718096;width:42%">Servicio</td><td style="padding:8px 10px;font-weight:700">${svcName}</td></tr>
                  <tr><td style="padding:8px 10px;color:#718096">Cliente</td><td style="padding:8px 10px">${clientName}</td></tr>
                  <tr style="background:#f7fafc"><td style="padding:8px 10px;color:#718096">Email cliente</td><td style="padding:8px 10px">${p.client_email || '—'}</td></tr>
                  <tr><td style="padding:8px 10px;color:#718096">Dirección</td><td style="padding:8px 10px">${p.address || '—'}, ${p.commune || '—'}</td></tr>
                  <tr style="background:#f7fafc"><td style="padding:8px 10px;color:#718096">Superficie</td><td style="padding:8px 10px">${p.m2 ? p.m2 + ' m²' : '—'}</td></tr>
                </table>
                <p style="margin:20px 0 4px;font-size:13px;color:#DC2626;font-weight:700">⚠️ Contacta a la cliente en las próximas 24 horas.</p>
                <div style="text-align:center;margin:20px 0">
                  <a href="https://apparq.cl" style="display:inline-block;background:#E8503A;color:#fff;text-decoration:none;font-weight:700;font-size:14px;padding:12px 32px;border-radius:6px;">apparq.cl → Soy Arquitecto</a>
                </div>
                <hr style="border:none;border-top:1px solid #e2e8f0;margin:20px 0 12px">
                <p style="font-size:11px;color:#a0aec0;margin:0">APPARQ · DSR ARQ SPA · RUT 76.341.206-7 · <a href="mailto:hola@apparq.cl" style="color:#667eea">hola@apparq.cl</a></p>
              </div>
            </div>`,
          }, RESEND_API_KEY);

          /* Email a APPARQ */
          await sendEmail({
            to: ADMIN_EMAIL,
            subject: `🔄 Reasignación automática · ${p.project_number} · ${archName} → ${replacement.nombre} ${replacement.apellido}`,
            html: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#1a1a2e">
              <div style="background:#1a1a2e;padding:24px 28px;border-radius:8px 8px 0 0">
                <h1 style="color:#fff;margin:0;font-size:18px">APPARQ · Reasignación automática ejecutada</h1>
              </div>
              <div style="background:#fff;padding:28px;border:1px solid #e2e8f0;border-radius:0 0 8px 8px">
                <table style="width:100%;border-collapse:collapse;font-size:13px">
                  <tr style="background:#f7fafc"><td style="padding:7px 10px;color:#718096;width:42%">Trámite</td><td style="padding:7px 10px;font-weight:700;color:#E8503A">${p.project_number}</td></tr>
                  <tr><td style="padding:7px 10px;color:#718096">Servicio</td><td style="padding:7px 10px">${svcName}</td></tr>
                  <tr style="background:#f7fafc"><td style="padding:7px 10px;color:#718096">Cliente</td><td style="padding:7px 10px">${clientName}</td></tr>
                  <tr><td style="padding:7px 10px;color:#718096">Arq. anterior</td><td style="padding:7px 10px;color:#DC2626;font-weight:700">${archName} (${p.architect_email})</td></tr>
                  <tr style="background:#f7fafc"><td style="padding:7px 10px;color:#718096">Arq. nuevo</td><td style="padding:7px 10px;color:#059669;font-weight:700">${replacement.nombre} ${replacement.apellido} (${replacement.email})</td></tr>
                  <tr><td style="padding:7px 10px;color:#718096">Horas sin contacto</td><td style="padding:7px 10px;font-weight:700">${Math.round(hours)}h</td></tr>
                </table>
                <hr style="border:none;border-top:1px solid #e2e8f0;margin:20px 0 12px">
                <p style="font-size:11px;color:#a0aec0;margin:0">APPARQ · Reasignación automática por incumplimiento cláusula 7b</p>
              </div>
            </div>`,
          }, RESEND_API_KEY);

          reassigned.push({ project_number: p.project_number, from: archName, to: `${replacement.nombre} ${replacement.apellido}`, hours: Math.round(hours) });
        }
      } else {
        /* Sin reemplazo disponible — alerta manual a APPARQ */
        await sendEmail({
          to: ADMIN_EMAIL,
          subject: `🚨 Reasignar manualmente · ${p.project_number} · Sin arquitecto disponible · ${Math.round(hours)}h sin contacto`,
          html: `<div style="font-family:Arial,sans-serif;max-width:580px;margin:0 auto"><div style="background:#7F1D1D;padding:20px 28px;border-radius:8px 8px 0 0"><h1 style="color:#fff;margin:0;font-size:17px">🚨 Reasignar manualmente — sin arquitecto disponible</h1></div><div style="background:#fff;padding:24px 28px;border:1px solid #e2e8f0;border-radius:0 0 8px 8px"><p style="font-size:13px;color:#4a5568">El trámite <strong>${p.project_number}</strong> lleva <strong>${Math.round(hours)} horas</strong> sin confirmar contacto con el cliente. No se encontró arquitecto alternativo para la comuna <strong>${p.commune}</strong> con el servicio <strong>${svcName}</strong>. Requiere reasignación manual desde el panel admin.</p><a href="https://apparq.cl/admin" style="display:inline-block;margin-top:12px;background:#E8503A;color:#fff;text-decoration:none;font-weight:700;font-size:13px;padding:10px 24px;border-radius:6px;">Ir al admin →</a></div></div>`,
        }, RESEND_API_KEY);
        skipped.push({ project_number: p.project_number, reason: 'sin_reemplazo', hours: Math.round(hours) });
      }
      continue;
    }

    /* ── UMBRAL 1: 24h → aviso al arquitecto ────── */
    if (hours >= WARN_HOURS && !p.contacto_alerta_enviada) {
      const reassignDeadline = deadlineFmt(p.created_at, REASSIGN_HOURS);

      const ok = await sendEmail({
        to: p.architect_email,
        subject: `⚠️ URGENTE · ${p.project_number} — Debes confirmar contacto con el cliente antes de las ${reassignDeadline}`,
        html: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#1a1a2e">
          <div style="background:#7F1D1D;padding:28px 32px;text-align:center;border-radius:8px 8px 0 0">
            <h1 style="color:#fff;margin:0;font-size:20px">⚠️ APPARQ — Acción requerida urgente</h1>
            <p style="color:#FCA5A5;margin:8px 0 0;font-size:13px">${p.project_number} · ${svcName}</p>
          </div>
          <div style="background:#fff;padding:32px;border:1px solid #e2e8f0;border-radius:0 0 8px 8px">
            <p style="font-size:14px;line-height:1.7">Hola <strong>${p.architect_nombre}</strong>,<br><br>
            Han transcurrido más de <strong>24 horas</strong> desde que se te asignó el trámite <strong>${p.project_number}</strong> y aún no has confirmado el contacto con el/la cliente en la plataforma.</p>
            <div style="background:#FEF2F2;border:2px solid #F87171;border-radius:8px;padding:16px 20px;margin:20px 0;text-align:center">
              <p style="margin:0 0 6px;font-size:12px;color:#991B1B;font-weight:700;text-transform:uppercase">Plazo máximo para confirmar contacto</p>
              <p style="margin:0;font-size:26px;font-weight:900;color:#DC2626">${reassignDeadline}</p>
              <p style="margin:10px 0 0;font-size:13px;color:#991B1B">Tienes <strong>${GRACE_HOURS} horas</strong> para confirmar el contacto.<br>Si no lo haces, el trámite será <strong>reasignado automáticamente</strong>.</p>
            </div>
            <table style="width:100%;border-collapse:collapse;font-size:13px;margin:16px 0">
              <tr style="background:#f7fafc"><td style="padding:8px 10px;color:#718096;width:42%">Cliente</td><td style="padding:8px 10px;font-weight:700">${clientName}</td></tr>
              <tr><td style="padding:8px 10px;color:#718096">Email cliente</td><td style="padding:8px 10px">${p.client_email || '—'}</td></tr>
              <tr style="background:#f7fafc"><td style="padding:8px 10px;color:#718096">Dirección</td><td style="padding:8px 10px">${p.address || '—'}, ${p.commune || '—'}</td></tr>
            </table>
            <div style="background:#EEF2FF;border:1.5px solid #C7D2FE;border-radius:8px;padding:14px 18px;margin-bottom:20px">
              <p style="margin:0 0 6px;font-size:13px;font-weight:700;color:#3730A3">Cómo confirmar el contacto:</p>
              <ol style="margin:0;padding-left:20px;font-size:13px;color:#3730A3;line-height:2">
                <li>Ingresa a <strong>apparq.cl → Soy Arquitecto</strong></li>
                <li>Selecciona el trámite <strong>${p.project_number}</strong></li>
                <li>Haz clic en <strong>"Confirmar que contacté al cliente"</strong></li>
              </ol>
            </div>
            <div style="text-align:center;margin-bottom:20px">
              <a href="https://apparq.cl" style="display:inline-block;background:#E8503A;color:#fff;text-decoration:none;font-weight:700;font-size:15px;padding:14px 36px;border-radius:8px;">Ir a la plataforma →</a>
            </div>
            <p style="font-size:11px;color:#a0aec0;margin:0">APPARQ · DSR ARQ SPA · RUT 76.341.206-7 · <a href="mailto:hola@apparq.cl" style="color:#667eea">hola@apparq.cl</a></p>
          </div>
        </div>`,
      }, RESEND_API_KEY);

      if (ok) {
        /* Marcar alerta enviada */
        await fetch(`${SUPABASE_URL}/rest/v1/projects?id=eq.${p.id}`, {
          method: 'PATCH',
          headers: {
            'apikey': SERVICE_KEY, 'Authorization': `Bearer ${SERVICE_KEY}`,
            'Content-Type': 'application/json', 'Prefer': 'return=minimal',
          },
          body: JSON.stringify({ contacto_alerta_enviada: true }),
        });
        warned.push({ project_number: p.project_number, hours: Math.round(hours), architect: archName });
      }
      continue;
    }

    skipped.push({ project_number: p.project_number, hours: Math.round(hours), reason: 'dentro_plazo' });
  }

  return new Response(JSON.stringify({
    ok: true, checked: projects.length,
    warned: warned.length, reassigned: reassigned.length,
    detail: { warned, reassigned, skipped },
    ts: new Date().toISOString(),
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

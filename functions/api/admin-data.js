/* ══════════════════════════════════════════════════
   APPARQ — Cloudflare Pages Function: admin-data
   Admin-only API: verifica JWT, opera con service role.
   GET  /api/admin-data?section=architects|projects|payments
   POST /api/admin-data  body: { action, ...params }
══════════════════════════════════════════════════ */

const SUPABASE_URL     = 'https://ibdafnzlsufsshczqvoa.supabase.co';
const SUPABASE_ANON    = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImliZGFmbnpsc3Vmc3NoY3pxdm9hIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM5Njg0NjYsImV4cCI6MjA4OTU0NDQ2Nn0.ucEjCcnSbaz-OeMrLbUbgcKacvg9J2Csg2VzrWVtVHA';
/* SERVICE_KEY se carga exclusivamente desde variables de entorno de Cloudflare — nunca hardcodeada */
const ADMIN_EMAIL      = 'diegosalinasrivera@gmail.com';

const CORS = {
  'Access-Control-Allow-Origin': 'https://apparq.cl',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Content-Type': 'application/json',
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: CORS });
}

function clpFmt(n) {
  return '$' + Math.round(n).toLocaleString('es-CL');
}

async function sendEmail({ to, subject, html }, RESEND_API_KEY) {
  if (!RESEND_API_KEY) return;
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: 'APPARQ <hola@apparq.cl>', to, subject, html }),
  });
  if (!res.ok) console.error('Resend error admin-data:', await res.text());
}

/* ── Envía emails de pago al arquitecto + recordatorio a APPARQ ── */
async function sendPaymentEmails({ project, architect, RESEND_API_KEY }) {
  const clp        = project.total_clp || 0;
  const e1         = project.e1_clp    || 0;
  const svc        = project.service_type || '';
  const pnum       = project.project_number || '—';
  const svcLabels  = { regularizacion:'Regularización', ampliacion:'Ampliación', 'declaracion-jurada':'Declaración Jurada', 'obra-nueva':'Obra Nueva', informe:'Informe de Propiedad', 'ley-del-mono':'Ley del Mono' };
  const svcName    = svcLabels[svc] || svc;
  const esInforme  = svc === 'informe';
  const esDJ       = svc === 'declaracion-jurada';
  const is2stages  = esInforme || esDJ;

  const ARQ_PCT    = architect.patente ? 0.80 : 0.70;
  const arqTotal   = Math.round(clp * ARQ_PCT);

  const payDue     = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000);
  const payDueFmt  = payDue.toLocaleDateString('es-CL', { day:'2-digit', month:'long', year:'numeric' });

  const clientName = `${project.client_nombre || ''} ${project.client_apellido || ''}`.trim();

  /* Bloque etapas para email arquitecto */
  const etapasArqBlock = is2stages
    ? `<tr><td style="padding:8px 10px;color:#718096">E1 · Inicio (ya pagado)</td><td style="padding:8px 10px;font-weight:700;color:#059669">${clpFmt(Math.round(clp*0.50*ARQ_PCT))} ✓</td></tr>
       <tr style="background:#f7fafc"><td style="padding:8px 10px;color:#718096">E2 · ${esInforme ? 'Entrega informe' : 'Cierre DJ'}</td><td style="padding:8px 10px;font-weight:700">${clpFmt(Math.round(clp*0.50*ARQ_PCT))}</td></tr>`
    : `<tr><td style="padding:8px 10px;color:#718096">E1 · Levantamiento (ya pagado)</td><td style="padding:8px 10px;font-weight:700;color:#059669">${clpFmt(Math.round(e1*ARQ_PCT))} ✓</td></tr>
       <tr style="background:#f7fafc"><td style="padding:8px 10px;color:#718096">E2 · Elaboración de planos</td><td style="padding:8px 10px;font-weight:700">${clpFmt(Math.round(clp*0.30*ARQ_PCT))}</td></tr>
       <tr><td style="padding:8px 10px;color:#718096">E3 · Ingreso DOM</td><td style="padding:8px 10px;font-weight:700">${clpFmt(Math.round(clp*0.30*ARQ_PCT))}</td></tr>
       <tr style="background:#f7fafc"><td style="padding:8px 10px;color:#718096">E4 · Recepción final</td><td style="padding:8px 10px;font-weight:700">${clpFmt(Math.round(clp*0.20*ARQ_PCT))}</td></tr>`;

  /* Bloque etapas para email admin */
  const e1archPct  = is2stages ? 0.50 : 0.20;
  const etapasAdminBlock = is2stages
    ? `<tr><td style="padding:6px 10px;color:#718096">E1 · Inicio</td><td style="padding:6px 10px;font-weight:700;color:#059669">${clpFmt(Math.round(clp*0.50*ARQ_PCT))}</td><td style="padding:6px 10px;font-weight:700;color:#E8503A">${payDueFmt}</td></tr>
       <tr style="background:#f7fafc"><td style="padding:6px 10px;color:#718096">E2 · ${esInforme ? 'Entrega informe' : 'Cierre DJ'}</td><td style="padding:6px 10px;font-weight:700">${clpFmt(Math.round(clp*0.50*ARQ_PCT))}</td><td style="padding:6px 10px;color:#718096">Al pagar cliente E2</td></tr>`
    : `<tr><td style="padding:6px 10px;color:#718096">E1 · Levantamiento</td><td style="padding:6px 10px;font-weight:700;color:#059669">${clpFmt(Math.round(clp*0.20*ARQ_PCT))}</td><td style="padding:6px 10px;font-weight:700;color:#E8503A">${payDueFmt}</td></tr>
       <tr style="background:#f7fafc"><td style="padding:6px 10px;color:#718096">E2 · Planos</td><td style="padding:6px 10px;font-weight:700">${clpFmt(Math.round(clp*0.30*ARQ_PCT))}</td><td style="padding:6px 10px;color:#718096">Al pagar cliente E2</td></tr>
       <tr><td style="padding:6px 10px;color:#718096">E3 · Ingreso DOM</td><td style="padding:6px 10px;font-weight:700">${clpFmt(Math.round(clp*0.30*ARQ_PCT))}</td><td style="padding:6px 10px;color:#718096">Al pagar cliente E3</td></tr>
       <tr style="background:#f7fafc"><td style="padding:6px 10px;color:#718096">E4 · Recepción</td><td style="padding:6px 10px;font-weight:700">${clpFmt(Math.round(clp*0.20*ARQ_PCT))}</td><td style="padding:6px 10px;color:#718096">Al pagar cliente E4</td></tr>`;

  /* Email al arquitecto */
  await sendEmail({
    to:      architect.email,
    subject: `🏗 Te asignaron un trámite — ${pnum} · ${svcName} · ${project.commune || ''} — APPARQ`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#1a1a2e">
        <div style="background:#1a1a2e;padding:32px;text-align:center;border-radius:8px 8px 0 0">
          <h1 style="color:#fff;margin:0;font-size:26px;letter-spacing:-0.5px">APPARQ</h1>
          <p style="color:#a0aec0;margin:8px 0 0;font-size:13px">Se te ha asignado un nuevo trámite</p>
        </div>
        <div style="background:#fff;padding:32px;border:1px solid #e2e8f0;border-radius:0 0 8px 8px">
          <h2 style="margin-top:0;color:#1a1a2e">¡Hola ${architect.nombre}! Te asignaron un trámite 🎉</h2>
          <p style="color:#4a5568;font-size:14px;line-height:1.7;margin:0 0 20px;">Un cliente completó su pago y quedas a cargo de este proyecto. Contáctalo dentro de las próximas <strong>24 horas</strong> para coordinar la visita de levantamiento.</p>

          <div style="background:#FFF7ED;border:2px solid #E8503A;border-radius:8px;padding:14px 20px;margin:0 0 20px;text-align:center">
            <p style="margin:0 0 4px;font-size:12px;color:#92400E;font-weight:700;text-transform:uppercase;">N° de Trámite</p>
            <p style="margin:0;font-size:28px;font-weight:900;color:#E8503A;letter-spacing:2px">${pnum}</p>
          </div>

          <table style="width:100%;border-collapse:collapse;font-size:13px;margin-bottom:16px">
            <tr style="background:#f7fafc"><td style="padding:7px 10px;color:#718096;width:42%">Servicio</td><td style="padding:7px 10px;font-weight:700">${svcName}</td></tr>
            <tr><td style="padding:7px 10px;color:#718096">Dirección</td><td style="padding:7px 10px">${project.address || '—'}, ${project.commune || '—'}</td></tr>
            <tr style="background:#f7fafc"><td style="padding:7px 10px;color:#718096">Superficie</td><td style="padding:7px 10px">${project.m2 ? project.m2 + ' m²' : '—'}</td></tr>
          </table>

          <div style="background:#EFF6FF;border:2px solid #93C5FD;border-radius:8px;padding:18px 20px;margin:0 0 20px">
            <p style="margin:0 0 10px;font-size:13px;font-weight:800;color:#1E40AF">📞 Datos de contacto del cliente</p>
            <table style="width:100%;border-collapse:collapse;font-size:13px">
              <tr><td style="padding:5px 0;color:#3B82F6;width:36%">Nombre</td><td style="padding:5px 0;font-weight:700;color:#1E3A8A">${clientName}</td></tr>
              ${project.client_email ? `<tr><td style="padding:5px 0;color:#3B82F6">Email</td><td style="padding:5px 0"><a href="mailto:${project.client_email}" style="color:#1E40AF;font-weight:700">${project.client_email}</a></td></tr>` : ''}
              ${project.client_phone ? `<tr><td style="padding:5px 0;color:#3B82F6">Teléfono</td><td style="padding:5px 0;font-weight:700"><a href="tel:${project.client_phone}" style="color:#1E40AF">${project.client_phone}</a></td></tr>` : ''}
            </table>
          </div>

          <div style="background:#f0fdf4;border:1.5px solid #86efac;border-radius:8px;padding:16px 20px;margin:20px 0">
            <p style="margin:0 0 10px;font-size:13px;font-weight:800;color:#15803d;">💰 Tus honorarios netos (${Math.round(ARQ_PCT*100)}%)</p>
            <table style="width:100%;border-collapse:collapse;font-size:13px">
              ${etapasArqBlock}
              <tr style="border-top:2px solid #86efac">
                <td style="padding:10px;color:#15803d;font-weight:800">TOTAL a recibir</td>
                <td style="padding:10px;font-weight:900;color:#15803d;font-size:15px">${clpFmt(arqTotal)}</td>
              </tr>
            </table>
            <p style="margin:10px 0 0;font-size:11px;color:#4ade80;">* Pago dentro de los 5 días hábiles tras la confirmación de pago del cliente, contra boleta de honorarios.</p>
          </div>

          <div style="background:#FEF3C7;border:1.5px solid #FCD34D;border-radius:8px;padding:14px 18px;margin-bottom:20px">
            <p style="margin:0 0 4px;font-size:13px;font-weight:700;color:#92400E">⏰ Primer pago — E1</p>
            <p style="margin:0;font-size:13px;color:#78350F;">Monto: <strong>${clpFmt(Math.round(clp*e1archPct*ARQ_PCT))}</strong> &nbsp;·&nbsp; Vence: <strong>${payDueFmt}</strong></p>
          </div>

          <h3 style="color:#1a1a2e;font-size:14px;margin-top:24px">🧾 Datos para emitir tu boleta de honorarios</h3>
          <table style="width:100%;border-collapse:collapse;font-size:13px">
            <tr style="background:#f7fafc"><td style="padding:8px 10px;color:#718096;width:42%">Razón Social</td><td style="padding:8px 10px;font-weight:700">DSR ARQ SPA</td></tr>
            <tr><td style="padding:8px 10px;color:#718096">RUT</td><td style="padding:8px 10px;font-weight:700">76.341.206-7</td></tr>
            <tr style="background:#f7fafc"><td style="padding:8px 10px;color:#718096">Giro</td><td style="padding:8px 10px">Arquitectura y servicios conexos</td></tr>
            <tr><td style="padding:8px 10px;color:#718096">Correo boleta</td><td style="padding:8px 10px">hola@apparq.cl</td></tr>
          </table>
          <p style="color:#4a5568;font-size:12px;margin:8px 0 0;line-height:1.6">Envía la boleta a <strong>hola@apparq.cl</strong> para que procesemos el pago. Sin boleta no se puede efectuar la transferencia.</p>

          <div style="background:#F0FDF4;border:1.5px solid #86EFAC;border-radius:8px;padding:16px 18px;margin-top:16px">
            <p style="margin:0 0 8px;font-size:13px;font-weight:700;color:#15803D">📤 Envíanos tus datos de transferencia</p>
            <ul style="margin:0;padding-left:18px;font-size:12px;color:#166534;line-height:2">
              <li>Banco</li><li>Tipo de cuenta (corriente / vista / ahorro)</li>
              <li>Número de cuenta</li><li>Nombre del titular</li>
              <li>RUT del titular</li><li>Email para comprobante</li>
            </ul>
            <p style="margin:8px 0 0;font-size:12px;color:#166534">Responde este correo o escríbenos a <strong>hola@apparq.cl</strong></p>
          </div>

          <hr style="border:none;border-top:1px solid #e2e8f0;margin:28px 0 16px">
          <p style="font-size:11px;color:#a0aec0;margin:0">APPARQ · DSR ARQ SPA · RUT 76.341.206-7<br>
          ¿Consultas? <a href="mailto:hola@apparq.cl" style="color:#667eea">hola@apparq.cl</a></p>
        </div>
      </div>
    `,
  }, RESEND_API_KEY);

  /* Email a APPARQ (recordatorio de pago) */
  await sendEmail({
    to:      'hola@apparq.cl',
    subject: `⚠️ Pagar arquitecto · ${pnum} · ${architect.nombre} ${architect.apellido} · E1 vence ${payDueFmt}`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:620px;margin:0 auto;color:#1a1a2e">
        <div style="background:#1a1a2e;padding:24px 32px;border-radius:8px 8px 0 0">
          <h1 style="color:#fff;margin:0;font-size:20px">APPARQ · Pago pendiente a arquitecto</h1>
          <p style="color:#a0aec0;margin:6px 0 0;font-size:13px">Recordatorio automático</p>
        </div>
        <div style="background:#fff;padding:28px 32px;border:1px solid #e2e8f0;border-radius:0 0 8px 8px">
          <table style="width:100%;border-collapse:collapse;font-size:13px;margin-bottom:20px">
            <tr style="background:#f7fafc"><td style="padding:7px 10px;color:#718096;width:40%">N° Trámite</td><td style="padding:7px 10px;font-weight:700;color:#E8503A">${pnum}</td></tr>
            <tr><td style="padding:7px 10px;color:#718096">Servicio</td><td style="padding:7px 10px">${svcName}</td></tr>
            <tr style="background:#f7fafc"><td style="padding:7px 10px;color:#718096">Arquitecto</td><td style="padding:7px 10px;font-weight:700">${architect.nombre} ${architect.apellido} — ${architect.email}</td></tr>
            <tr><td style="padding:7px 10px;color:#718096">% honorarios</td><td style="padding:7px 10px">${Math.round(ARQ_PCT*100)}% ${architect.patente ? '(con patente)' : '(sin patente)'}</td></tr>
            <tr style="background:#f7fafc"><td style="padding:7px 10px;color:#718096">Cliente</td><td style="padding:7px 10px">${clientName}</td></tr>
            <tr><td style="padding:7px 10px;color:#718096">Total cliente</td><td style="padding:7px 10px">${clpFmt(clp)}</td></tr>
            <tr style="background:#f7fafc"><td style="padding:7px 10px;color:#718096">Total arquitecto</td><td style="padding:7px 10px;font-weight:700">${clpFmt(arqTotal)}</td></tr>
          </table>
          <h3 style="font-size:13px;color:#1a1a2e;margin-bottom:8px">📅 Calendario de pagos</h3>
          <table style="width:100%;border-collapse:collapse;font-size:12.5px">
            <thead><tr style="background:#1a1a2e;color:#fff">
              <th style="padding:7px 10px;text-align:left">Etapa</th>
              <th style="padding:7px 10px;text-align:left">Monto arquitecto</th>
              <th style="padding:7px 10px;text-align:left">Fecha estimada</th>
            </tr></thead>
            <tbody>${etapasAdminBlock}
              <tr style="border-top:2px solid #e2e8f0">
                <td style="padding:8px 10px;font-weight:800">TOTAL</td>
                <td style="padding:8px 10px;font-weight:800">${clpFmt(arqTotal)}</td><td></td>
              </tr>
            </tbody>
          </table>
          <div style="background:#FEF3C7;border:1.5px solid #FCD34D;border-radius:8px;padding:14px 18px;margin-top:20px">
            <p style="margin:0;font-size:13px;font-weight:700;color:#92400E">⚠️ Pago E1 — vence ${payDueFmt} — ${clpFmt(Math.round(clp*e1archPct*ARQ_PCT))}</p>
            <p style="margin:6px 0 0;font-size:12px;color:#78350F;line-height:1.6">Verificar que el arquitecto envíe datos bancarios y boleta de honorarios antes de transferir.</p>
          </div>
          <hr style="border:none;border-top:1px solid #e2e8f0;margin:20px 0 10px">
          <p style="font-size:11px;color:#a0aec0;margin:0">APPARQ · Sistema de notificaciones internas</p>
        </div>
      </div>
    `,
  }, RESEND_API_KEY);
}

/* ── Verify JWT and return user email ─────────── */
async function verifyAdmin(authHeader) {
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  const token = authHeader.slice(7);

  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: {
      'apikey':        SUPABASE_ANON,
      'Authorization': `Bearer ${token}`,
    },
  });

  if (!res.ok) return null;
  const user = await res.json();
  if (!user || !user.email) return null;
  if (user.email.toLowerCase() !== ADMIN_EMAIL) return null;
  return user.email;
}

/* ── Supabase Storage helpers (admin) ─────────── */
async function storageList(SUPABASE_URL, serviceKey, prefix) {
  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/list/tramite-files`, {
    method: 'POST',
    headers: {
      'apikey':        serviceKey,
      'Authorization': `Bearer ${serviceKey}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify({ prefix, limit: 200, offset: 0, sortBy: { column: 'created_at', order: 'desc' } }),
  });
  if (!res.ok) return [];
  const data = await res.json();
  return Array.isArray(data) ? data : [];
}

async function storageSignUrl(SUPABASE_URL, serviceKey, path, expiresIn = 7200) {
  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/sign/tramite-files/${path}`, {
    method: 'POST',
    headers: {
      'apikey':        serviceKey,
      'Authorization': `Bearer ${serviceKey}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify({ expiresIn }),
  });
  if (!res.ok) return null;
  const data = await res.json();
  if (!data.signedURL) return null;
  return `${SUPABASE_URL}/storage/v1${data.signedURL}`;
}

/* ── Supabase REST helper (service role) ──────── */
function makeSb(serviceKey) {
  return async function sb(path, opts = {}) {
    const url = `${SUPABASE_URL}/rest/v1${path}`;
    const res = await fetch(url, {
      ...opts,
      headers: {
        'apikey':        serviceKey,
        'Authorization': `Bearer ${serviceKey}`,
        'Content-Type':  'application/json',
        'Prefer':        opts.prefer || 'return=representation',
        ...(opts.headers || {}),
      },
    });
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch(_) { data = text; }
    return { ok: res.ok, status: res.status, data };
  };
}

/* ══════════════════════════════════════════════════
   MAIN HANDLER
══════════════════════════════════════════════════ */
export async function onRequest(context) {
  const { request, env } = context;
  const SERVICE_KEY = env.SUPABASE_SERVICE_KEY || env.SUPABASE_SVC;
  const sb = makeSb(SERVICE_KEY);

  /* CORS preflight */
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }

  /* notify_assignment — pre-auth bypass con service key.
     Solo envía 2 correos: asignación al cliente + nuevo trámite al arquitecto. */
  if (request.method === 'POST') {
    let preBody;
    try { preBody = await request.clone().json(); } catch(_) {}
    if (preBody?.action === 'notify_assignment') {
      const svcKey = env.SUPABASE_SERVICE_KEY || env.SUPABASE_SVC;
      if (!svcKey || preBody.svc_key !== svcKey) return json({ error: 'No autorizado' }, 403);
      const { project_id } = preBody;
      if (!project_id) return json({ error: 'project_id requerido' }, 400);
      const RESEND_API_KEY = env.RESEND_API_KEY;
      const projRes = await sb(`/projects?id=eq.${project_id}&select=project_number,client_email,client_nombre,client_apellido,client_telefono,service_type,servicio_subtipo,address,commune,m2,total_clp,e1_clp,architect_email&limit=1`);
      const project = projRes.ok && Array.isArray(projRes.data) && projRes.data[0] ? projRes.data[0] : null;
      if (!project) return json({ error: 'Proyecto no encontrado' }, 404);
      const archRes = project.architect_email ? await sb(`/architects?email=eq.${encodeURIComponent(project.architect_email)}&select=nombre,apellido,email,patente,telefono&limit=1`) : null;
      const architect = archRes?.ok && Array.isArray(archRes.data) && archRes.data[0] ? archRes.data[0] : null;
      if (!architect) return json({ error: 'Arquitecto no encontrado' }, 404);
      const svcLabels  = { regularizacion:'Regularización', ampliacion:'Ampliación', 'declaracion-jurada':'Declaración Jurada', 'obra-nueva':'Obra Nueva', informe:'Informe de Propiedad', 'ley-del-mono':'Ley del Mono' };
      const subtipo    = project.servicio_subtipo || '';
      const clientName = `${project.client_nombre || ''} ${project.client_apellido || ''}`.trim();
      const pnum       = project.project_number || '—';
      const svcName    = svcLabels[project.service_type] || project.service_type;
      const esFactib   = subtipo === 'factibilidad';
      if (RESEND_API_KEY) {
        /* 1 — Email al cliente: arquitecto asignado */
        await sendEmail({
          to: project.client_email,
          subject: `Tu arquitecta APPARQ — ${pnum} ✅`,
          html: `<div style="font-family:sans-serif;max-width:600px;margin:0 auto;color:#1a1a2e;">
            <div style="background:#E8503A;padding:24px 32px;border-radius:12px 12px 0 0;"><h1 style="color:#fff;margin:0;font-size:1.4rem;">¡${clientName || 'Hola'}, tu trámite está en marcha!</h1></div>
            <div style="background:#fff;border:1px solid #e2e8f0;border-top:none;padding:28px 32px;border-radius:0 0 12px 12px;">
              <p style="margin-top:0;">Hola <strong>${clientName}</strong>, tu trámite ya tiene arquitecta asignada y todo está listo para comenzar.</p>
              <div style="background:#f0fdf4;border:1.5px solid #bbf7d0;border-radius:10px;padding:16px 20px;margin:20px 0;">
                <div style="font-size:0.8rem;color:#718096;">N° de trámite</div><div style="font-size:1.1rem;font-weight:700;color:#E8503A;">${pnum}</div>
                <div style="font-size:0.8rem;color:#718096;margin-top:12px;">Servicio</div><div style="font-weight:600;">${svcName}${subtipo ? ' · '+subtipo.charAt(0).toUpperCase()+subtipo.slice(1) : ''} · ${project.commune || ''}</div>
                <div style="font-size:0.8rem;color:#718096;margin-top:12px;">Arquitecta asignada</div><div style="font-weight:700;font-size:1.05rem;">${architect.nombre} ${architect.apellido}${architect.patente ? ' · Patente '+architect.patente : ''}</div>
              </div>
              <p><strong>¿Qué sigue?</strong></p>
              <ul style="padding-left:20px;line-height:1.9;">
                <li>La arquitecta <strong>${architect.nombre} ${architect.apellido}</strong> te contactará para ${esFactib ? 'coordinar la visita a terreno' : 'los próximos pasos'}.</li>
                <li>Plazo estimado: <strong>${esFactib ? 'aproximadamente 2 semanas desde la visita' : '5 a 7 días hábiles'}</strong>.</li>
              </ul>
              <p>Seguimiento en <a href="https://apparq.cl/portal" style="color:#E8503A;">apparq.cl/portal</a> con tu email.</p>
              <p style="margin-bottom:0;font-size:0.85rem;color:#718096;">Consultas: <a href="mailto:hola@apparq.cl" style="color:#E8503A;">hola@apparq.cl</a></p>
            </div></div>`,
        }, RESEND_API_KEY);
        /* 2 — Email al arquitecto: nuevo trámite asignado */
        await sendEmail({
          to: architect.email,
          subject: `🏗 Nuevo trámite asignado — ${pnum}`,
          html: `<div style="font-family:sans-serif;max-width:600px;margin:0 auto;color:#1a1a2e;">
            <div style="background:#1a1a2e;padding:24px 32px;border-radius:12px 12px 0 0;"><h1 style="color:#fff;margin:0;font-size:1.4rem;">Nuevo trámite asignado · APPARQ</h1></div>
            <div style="background:#fff;border:1px solid #e2e8f0;border-top:none;padding:28px 32px;border-radius:0 0 12px 12px;">
              <p style="margin-top:0;">Hola <strong>${architect.nombre}</strong>, se te ha asignado un nuevo trámite:</p>
              <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:16px 20px;margin:20px 0;">
                <div style="font-size:0.8rem;color:#718096;">N° de trámite</div><div style="font-size:1.1rem;font-weight:700;color:#E8503A;">${pnum}</div>
                <div style="font-size:0.8rem;color:#718096;margin-top:12px;">Servicio</div><div style="font-weight:600;">${svcName}${subtipo ? ' · '+subtipo.charAt(0).toUpperCase()+subtipo.slice(1) : ''} · ${project.commune || ''}</div>
                <div style="font-size:0.8rem;color:#718096;margin-top:12px;">Cliente</div><div style="font-weight:600;">${clientName}</div>
                <div style="font-size:0.8rem;color:#718096;margin-top:12px;">Contacto</div>
                <div>📧 ${project.client_email}</div>
                ${project.client_telefono ? `<div>📱 +56 ${project.client_telefono}</div>` : ''}
              </div>
              <p><strong>Próximos pasos:</strong></p>
              <ul style="padding-left:20px;line-height:1.9;">
                <li>Contacta al cliente para ${esFactib ? 'coordinar la visita a terreno' : 'los próximos pasos'}.</li>
                <li>Plazo estimado: <strong>${esFactib ? 'aproximadamente 2 semanas desde la visita' : '5 a 7 días hábiles'}</strong>.</li>
              </ul>
              <p>Portal: <a href="https://apparq.cl/portal-arquitecto" style="color:#E8503A;">apparq.cl/portal-arquitecto</a></p>
              <p style="margin-bottom:0;font-size:0.85rem;color:#718096;">Dudas: <a href="mailto:hola@apparq.cl" style="color:#E8503A;">hola@apparq.cl</a></p>
            </div></div>`,
        }, RESEND_API_KEY);
      }
      return json({ success: true, emails_sent: 2, project: pnum, architect: `${architect.nombre} ${architect.apellido}` });
    }
  }

  /* Auth check */
  const adminEmail = await verifyAdmin(request.headers.get('Authorization'));
  if (!adminEmail) {
    return json({ error: 'No autorizado' }, 403);
  }

  /* ── GET ──────────────────────────────────────── */
  if (request.method === 'GET') {
    const section = new URL(request.url).searchParams.get('section');

    /* Diagnóstico — solo visible para admin autenticado */
    if (section === 'ping') {
      const testRes = await sb('/architects?select=id&limit=1');
      return json({
        ok: true,
        service_key_present: !!SERVICE_KEY,
        service_key_prefix: SERVICE_KEY ? SERVICE_KEY.slice(0, 12) + '...' : 'MISSING',
        supabase_ok: testRes.ok,
        supabase_status: testRes.status,
        supabase_data: testRes.data,
      });
    }

    if (section === 'architects') {
      const { ok, data } = await sb(
        '/architects?select=id,nombre,apellido,email,telefono,rut,patente,tramites,comunas,activo,created_at,foto_url&order=created_at.desc'
      );
      if (!ok) return json({ error: 'Error al obtener arquitectos' }, 500);
      return json({ architects: data });
    }

    if (section === 'projects') {
      const [projResult, descartesResult] = await Promise.all([
        sb('/projects?select=id,project_number,client_email,client_nombre,client_apellido,client_telefono,client_rut,architect_email,architect_nombre,architect_apellido,service_type,address,commune,m2,total_clp,e1_clp,stage,created_at,cliente_contactado,descarte_estado,descarte_motivo,descarte_via_propuesta,descarte_fecha_visita,descarte_revisado_at,descarte_notas_admin,arq_pago_e1,arq_pago_e2,arq_pago_e3,arq_pago_e4,arq_pago_e1_at,arq_pago_e2_at,arq_pago_e3_at,arq_pago_e4_at&order=created_at.desc&limit=200'),
        sb('/projects?descarte_estado=eq.pendiente&select=id,project_number,architect_nombre,architect_apellido,architect_email,service_type,commune,descarte_motivo,descarte_via_propuesta,descarte_fecha_visita,created_at&order=created_at.desc'),
      ]);
      if (!projResult.ok) return json({ error: 'Error al obtener trámites' }, 500);
      return json({
        projects: projResult.data,
        descartes_pendientes: descartesResult.ok && Array.isArray(descartesResult.data) ? descartesResult.data : [],
      });
    }

    if (section === 'payments') {
      const { ok, data } = await sb(
        '/payments?select=id,mp_payment_id,external_ref,status,amount,currency,payer_email,payment_method,created_at&order=created_at.desc&limit=200'
      );
      if (!ok) return json({ error: 'Error al obtener pagos' }, 500);
      return json({ payments: data });
    }

    if (section === 'arq_payments') {
      /* Proyectos con arquitecto asignado (excluye pendiente_pago y sin arq) */
      const [projRes, archRes] = await Promise.all([
        sb('/projects?architect_email=neq.&stage=neq.pendiente_pago&select=id,project_number,client_nombre,client_apellido,service_type,servicio_subtipo,commune,total_clp,e1_clp,stage,architect_email,arq_pago_e1,arq_pago_e2,arq_pago_e3,arq_pago_e4,arq_pago_e1_at,arq_pago_e2_at,arq_pago_e3_at,arq_pago_e4_at&order=created_at.desc&limit=500'),
        sb('/architects?select=nombre,apellido,email,patente&activo=eq.true'),
      ]);
      if (!projRes.ok) return json({ error: 'Error al obtener proyectos' }, 500);
      const projects   = Array.isArray(projRes.data) ? projRes.data : [];
      const architects = Array.isArray(archRes.data)  ? archRes.data  : [];
      const archMap    = {};
      architects.forEach(a => { archMap[a.email] = a; });

      /* Agrupar por arquitecto y calcular montos */
      const byArq = {};
      for (const p of projects) {
        if (!p.architect_email) continue;
        if (!byArq[p.architect_email]) {
          const a = archMap[p.architect_email] || {};
          byArq[p.architect_email] = {
            email:    p.architect_email,
            nombre:   a.nombre   || p.architect_email,
            apellido: a.apellido || '',
            patente:  a.patente  || null,
            projects: [],
          };
        }
        const pct      = archMap[p.architect_email]?.patente ? 0.80 : 0.70;
        const clp      = p.total_clp || 0;
        const e1c      = p.e1_clp   || 0;
        const is2      = p.service_type === 'informe' || p.service_type === 'declaracion-jurada';
        const etapas   = is2
          ? [
              { key:'e1', label:'E1 · Inicio',         monto: Math.round(clp*0.50*pct), pagado: p.arq_pago_e1, at: p.arq_pago_e1_at },
              { key:'e2', label:'E2 · Cierre',          monto: Math.round(clp*0.50*pct), pagado: p.arq_pago_e2, at: p.arq_pago_e2_at },
            ]
          : [
              { key:'e1', label:'E1 · Levantamiento',   monto: Math.round(e1c*pct),      pagado: p.arq_pago_e1, at: p.arq_pago_e1_at },
              { key:'e2', label:'E2 · Elaboración',     monto: Math.round(clp*0.30*pct), pagado: p.arq_pago_e2, at: p.arq_pago_e2_at },
              { key:'e3', label:'E3 · Ingreso DOM',     monto: Math.round(clp*0.30*pct), pagado: p.arq_pago_e3, at: p.arq_pago_e3_at },
              { key:'e4', label:'E4 · Recepción final', monto: Math.round(clp*0.20*pct), pagado: p.arq_pago_e4, at: p.arq_pago_e4_at },
            ];
        byArq[p.architect_email].projects.push({
          id:           p.id,
          project_number: p.project_number,
          client:       `${p.client_nombre || ''} ${p.client_apellido || ''}`.trim(),
          service_type: p.service_type,
          servicio_subtipo: p.servicio_subtipo,
          commune:      p.commune,
          stage:        p.stage,
          pct:          Math.round(pct * 100),
          etapas,
        });
      }
      return json({ arq_payments: Object.values(byArq) });
    }

    if (section === 'funnel') {
      const { ok, data } = await sb(
        '/funnel_events?select=id,event_type,svc,commune,clp,email,created_at&order=created_at.desc&limit=500'
      );
      if (!ok) return json({ error: 'Error al obtener funnel' }, 500);
      return json({ events: data });
    }

    if (section === 'leads') {
      const { ok, data } = await sb(
        '/leads?select=id,email,svc,servicio_subtipo,m2,commune,uf,clp,created_at,converted&order=created_at.desc&limit=500'
      );
      if (!ok) return json({ error: 'Error al obtener leads' }, 500);
      return json({ leads: data });
    }

    if (section === 'dashboard') {
      /* Fetch all in parallel */
      const [archRes, projRes, payRes, leadRes, funnelRes] = await Promise.all([
        sb('/architects?select=id,activo'),
        sb('/projects?select=id,project_number,client_nombre,client_apellido,client_email,service_type,commune,address,architect_nombre,architect_apellido,architect_email,stage,total_clp,created_at,cliente_contactado&order=created_at.desc&limit=500'),
        sb('/payments?select=id,amount,status,payer_email,payment_method,created_at&order=created_at.desc&limit=500'),
        sb('/leads?select=id,converted,created_at'),
        sb('/funnel_events?select=event_type,created_at'),
      ]);

      const architects   = archRes.ok   && Array.isArray(archRes.data)   ? archRes.data   : [];
      const projects     = projRes.ok   && Array.isArray(projRes.data)   ? projRes.data   : [];
      const payments     = payRes.ok    && Array.isArray(payRes.data)    ? payRes.data    : [];
      const leads        = leadRes.ok   && Array.isArray(leadRes.data)   ? leadRes.data   : [];
      const funnelEvents = funnelRes.ok && Array.isArray(funnelRes.data) ? funnelRes.data : [];

      const now        = new Date();
      const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

      const totalArchitectos   = architects.length;
      const tramitesActivos    = projects.filter(p => p.stage && p.stage !== 'completado').length;
      const recaudadoTotal     = payments.filter(p => p.status === 'approved').reduce((s, p) => s + (p.amount || 0), 0);
      const tramitesMes        = projects.filter(p => p.created_at >= monthStart).length;
      const totalLeads         = leads.length;
      const leadsNoConvertidos = leads.filter(l => !l.converted).length;

      /* Funnel */
      const ctaClicks         = funnelEvents.filter(e => e.event_type === 'cta_click').length;
      const inscripIniciadas  = funnelEvents.filter(e => e.event_type === 'inscripcion_iniciada').length;
      const inscripCompletadas = projects.length;                                           /* confirm-tramite = pagaron */
      const abandonos         = inscripIniciadas - inscripCompletadas > 0
                                  ? inscripIniciadas - inscripCompletadas : 0;

      /* Last 10 projects + last 5 payments for recent tables */
      const recentProjects = projects.slice(0, 10);
      const recentPayments = payments.slice(0, 5);

      return json({ totalArchitectos, tramitesActivos, recaudadoTotal, tramitesMes, totalLeads, leadsNoConvertidos, ctaClicks, inscripIniciadas, inscripCompletadas, abandonos, recentProjects, recentPayments });
    }

    if (section === 'project-detail') {
      const pnum = new URL(request.url).searchParams.get('project_number');
      if (!pnum) return json({ error: 'project_number requerido' }, 400);
      const numUpper = pnum.trim().toUpperCase();

      /* Fetch updates, messages and storage folders in parallel */
      const [updRes, msgRes, clientFiles, archFiles] = await Promise.all([
        sb(`/project_updates?project_number=eq.${encodeURIComponent(numUpper)}&order=created_at.asc`),
        sb(`/messages?project_number=eq.${encodeURIComponent(numUpper)}&order=created_at.asc`),
        storageList(SUPABASE_URL, SERVICE_KEY, `${numUpper}/cliente`),
        storageList(SUPABASE_URL, SERVICE_KEY, `${numUpper}/arquitecto`),
      ]);

      const updates  = updRes.ok && Array.isArray(updRes.data) ? updRes.data : [];
      const messages = msgRes.ok && Array.isArray(msgRes.data) ? msgRes.data : [];

      const placeholder = '.emptyFolderPlaceholder';
      const toFile = (f, uploader) => ({
        name:       f.name.replace(/^\d+_/, ''),
        rawName:    f.name,
        path:       `${numUpper}/${uploader}/${f.name}`,
        size:       f.metadata?.size    || 0,
        mimetype:   f.metadata?.mimetype || '',
        created_at: f.created_at        || '',
        uploader,
      });

      const allFiles = [
        ...clientFiles.filter(f => f.name && f.name !== placeholder).map(f => toFile(f, 'cliente')),
        ...archFiles.filter(f   => f.name && f.name !== placeholder).map(f => toFile(f, 'arquitecto')),
      ];

      const filesWithUrls = await Promise.all(allFiles.map(async f => ({
        ...f,
        downloadUrl: await storageSignUrl(SUPABASE_URL, SERVICE_KEY, f.path),
      })));

      return json({ updates, messages, files: filesWithUrls });
    }

    return json({ error: 'Sección no válida' }, 400);
  }

  /* ── POST ─────────────────────────────────────── */
  if (request.method === 'POST') {
    let body;
    try { body = await request.json(); } catch(_) { return json({ error: 'Body inválido' }, 400); }

    const { action } = body;

    /* add_architect */
    if (action === 'add_architect') {
      const { nombre, apellido, email, telefono, rut, patente, comunas, tramites } = body;
      if (!nombre || !apellido || !email) {
        return json({ error: 'nombre, apellido y email son obligatorios' }, 400);
      }
      const { ok, data } = await sb('/architects', {
        method: 'POST',
        body: JSON.stringify({ nombre, apellido, email: email.toLowerCase(), telefono, rut, patente, comunas: comunas || [], tramites: tramites || [], activo: true }),
        prefer: 'return=representation',
      });
      if (!ok) return json({ error: 'Error al crear arquitecto', detail: data }, 500);
      return json({ success: true, architect: Array.isArray(data) ? data[0] : data });
    }

    /* delete_tramite */
    if (action === 'delete_tramite') {
      const { id } = body;
      if (!id) return json({ error: 'id requerido' }, 400);
      const { ok, data } = await sb(`/projects?id=eq.${id}`, {
        method: 'DELETE',
        prefer: 'return=minimal',
      });
      if (!ok) return json({ error: 'Error al eliminar trámite', detail: data }, 500);
      return json({ success: true });
    }

    /* delete_architect */
    if (action === 'delete_architect') {
      const { id } = body;
      if (!id) return json({ error: 'id requerido' }, 400);
      const { ok, data } = await sb(`/architects?id=eq.${id}`, {
        method: 'DELETE',
        prefer: 'return=minimal',
      });
      if (!ok) return json({ error: 'Error al eliminar arquitecto', detail: data }, 500);
      return json({ success: true });
    }

    /* toggle_architect_activo */
    if (action === 'toggle_architect') {
      const { id, activo } = body;
      if (id === undefined || activo === undefined) return json({ error: 'id y activo requeridos' }, 400);
      const { ok, data } = await sb(`/architects?id=eq.${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ activo }),
        prefer: 'return=representation',
      });
      if (!ok) return json({ error: 'Error al actualizar arquitecto', detail: data }, 500);
      return json({ success: true, architect: Array.isArray(data) ? data[0] : data });
    }

    /* assign_tramite / reassign_tramite */
    if (action === 'assign_tramite' || action === 'reassign_tramite') {
      const { project_id, architect_email, architect_nombre, architect_apellido } = body;
      if (!project_id || !architect_email) {
        return json({ error: 'project_id y architect_email requeridos' }, 400);
      }
      const { ok, data } = await sb(`/projects?id=eq.${project_id}`, {
        method: 'PATCH',
        body: JSON.stringify({ architect_email, architect_nombre: architect_nombre || '', architect_apellido: architect_apellido || '', cliente_contactado: false }),
        prefer: 'return=representation',
      });
      if (!ok) return json({ error: 'Error al asignar arquitecto', detail: data }, 500);

      /* Enviar emails de pago al arquitecto + recordatorio a APPARQ + notificación al cliente */
      const RESEND_API_KEY = env.RESEND_API_KEY;
      if (RESEND_API_KEY) {
        const [projRes, archRes] = await Promise.all([
          sb(`/projects?id=eq.${project_id}&select=project_number,client_email,client_phone,client_nombre,client_apellido,service_type,address,commune,m2,total_clp,e1_clp&limit=1`),
          sb(`/architects?email=eq.${encodeURIComponent(architect_email)}&select=nombre,apellido,email,patente,telefono&limit=1`),
        ]);
        const project   = projRes.ok && Array.isArray(projRes.data) && projRes.data[0] ? projRes.data[0] : null;
        const architect = archRes.ok && Array.isArray(archRes.data) && archRes.data[0] ? archRes.data[0] : null;
        if (project && architect) {
          /* Email arquitecto + recordatorio APPARQ */
          sendPaymentEmails({ project, architect, RESEND_API_KEY }).catch(e => console.error('sendPaymentEmails error:', e));

          /* Email cliente — notificar nuevo/reasignado arquitecto */
          if (project.client_email) {
            const svcLabels = { regularizacion:'Regularización', ampliacion:'Ampliación', 'declaracion-jurada':'Declaración Jurada', 'obra-nueva':'Obra Nueva', informe:'Informe de Propiedad', 'ley-del-mono':'Ley del Mono' };
            const svcName   = svcLabels[project.service_type] || project.service_type;
            const clientName = `${project.client_nombre || ''} ${project.client_apellido || ''}`.trim();
            const pnum = project.project_number || '—';
            sendEmail({
              to: project.client_email,
              subject: `👤 Tu arquitecto APPARQ — ${pnum}`,
              html: `
                <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#1a1a2e">
                  <div style="background:#1a1a2e;padding:32px;text-align:center;border-radius:8px 8px 0 0">
                    <h1 style="color:#fff;margin:0;font-size:26px;letter-spacing:-0.5px">APPARQ</h1>
                    <p style="color:#a0aec0;margin:8px 0 0;font-size:13px">Actualización de tu trámite</p>
                  </div>
                  <div style="background:#fff;padding:32px;border:1px solid #e2e8f0;border-radius:0 0 8px 8px">
                    <h2 style="margin-top:0;color:#1a1a2e">Hola ${clientName || 'cliente'} 👋</h2>
                    <p style="color:#4a5568;font-size:14px;line-height:1.7;">Queremos informarte que el arquitecto asignado a tu trámite ha sido actualizado. A partir de ahora, el profesional a cargo de tu proyecto es:</p>

                    <div style="background:#F0FDF4;border:2px solid #86EFAC;border-radius:8px;padding:20px 24px;margin:20px 0;text-align:center">
                      <p style="margin:0 0 6px;font-size:12px;font-weight:700;color:#15803D;text-transform:uppercase">Tu arquitecto</p>
                      <p style="margin:0;font-size:22px;font-weight:900;color:#1a1a2e">${architect.nombre} ${architect.apellido}</p>
                      ${architect.telefono ? `<p style="margin:8px 0 0;font-size:14px;color:#4a5568">📞 <a href="tel:${architect.telefono}" style="color:#E8503A;font-weight:700">${architect.telefono}</a></p>` : ''}
                      <p style="margin:6px 0 0;font-size:13px;color:#4a5568">✉️ <a href="mailto:${architect.email}" style="color:#E8503A">${architect.email}</a></p>
                    </div>

                    <table style="width:100%;border-collapse:collapse;font-size:13px;margin-bottom:20px">
                      <tr style="background:#f7fafc"><td style="padding:7px 10px;color:#718096;width:42%">N° Trámite</td><td style="padding:7px 10px;font-weight:700;color:#E8503A">${pnum}</td></tr>
                      <tr><td style="padding:7px 10px;color:#718096">Servicio</td><td style="padding:7px 10px">${svcName}</td></tr>
                      <tr style="background:#f7fafc"><td style="padding:7px 10px;color:#718096">Dirección</td><td style="padding:7px 10px">${project.address || '—'}, ${project.commune || '—'}</td></tr>
                    </table>

                    <p style="color:#4a5568;font-size:14px;line-height:1.7;">Tu arquitecto te contactará a la brevedad para coordinar los próximos pasos. Si tienes alguna consulta, escríbenos a <a href="mailto:hola@apparq.cl" style="color:#E8503A">hola@apparq.cl</a>.</p>

                    <hr style="border:none;border-top:1px solid #e2e8f0;margin:24px 0 14px">
                    <p style="font-size:11px;color:#a0aec0;margin:0">APPARQ · DSR ARQ SPA · RUT 76.341.206-7<br>
                    <a href="mailto:hola@apparq.cl" style="color:#667eea">hola@apparq.cl</a></p>
                  </div>
                </div>
              `,
            }, RESEND_API_KEY).catch(e => console.error('sendClientReassignEmail error:', e));
          }
        }
      }

      return json({ success: true, project: Array.isArray(data) ? data[0] : data });
    }

    /* update_architect (comunas + tramites) */
    if (action === 'update_architect') {
      const { id, comunas, tramites } = body;
      if (!id) return json({ error: 'id requerido' }, 400);
      const { ok, data } = await sb(`/architects?id=eq.${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ comunas: comunas || [], tramites: tramites || [] }),
        prefer: 'return=representation',
      });
      if (!ok) return json({ error: 'Error al actualizar arquitecto', detail: data }, 500);
      return json({ success: true, architect: Array.isArray(data) ? data[0] : data });
    }

    /* mark_lead_converted */
    if (action === 'mark_lead_converted') {
      const { id, converted } = body;
      if (!id) return json({ error: 'id requerido' }, 400);
      const { ok, data } = await sb(`/leads?id=eq.${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ converted: converted !== false }),
        prefer: 'return=representation',
      });
      if (!ok) return json({ error: 'Error al actualizar lead', detail: data }, 500);
      return json({ success: true });
    }

    /* review-descarte */
    if (action === 'review-descarte') {
      const { project_id, decision, notas } = body;
      if (!project_id || !['aprobado', 'rechazado'].includes(decision)) {
        return json({ error: 'project_id y decision (aprobado|rechazado) requeridos' }, 400);
      }

      /* PATCH projects */
      const patchResult = await sb(`/projects?id=eq.${project_id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          descarte_estado:      decision,
          descarte_revisado_at: new Date().toISOString(),
          descarte_notas_admin: notas || null,
        }),
        prefer: 'return=representation',
      });
      if (!patchResult.ok) return json({ error: 'Error al actualizar descarte', detail: patchResult.data }, 500);

      /* Obtener datos del proyecto para notificar al arquitecto */
      const projResult = await sb(`/projects?id=eq.${project_id}&select=project_number,architect_email,architect_nombre,architect_apellido,service_type,commune,descarte_via_propuesta&limit=1`);
      const p = projResult.ok && Array.isArray(projResult.data) && projResult.data[0] ? projResult.data[0] : null;

      if (p && p.architect_email) {
        const RESEND_API_KEY = env.RESEND_API_KEY;
        const svcLabels = { regularizacion:'Regularización', ampliacion:'Ampliación', 'obra-nueva':'Obra Nueva', informe:'Informe de Propiedad' };
        const viaLabels = { regularizacion:'Regularización', ampliacion:'Ampliación', 'obra-nueva':'Obra Nueva', no_regularizable:'No regularizable' };
        const svcName  = svcLabels[p.service_type] || p.service_type;
        const viaLabel = viaLabels[p.descarte_via_propuesta] || p.descarte_via_propuesta || '—';

        if (decision === 'aprobado') {
          await sendEmail({
            to: p.architect_email,
            subject: `✅ Descarte aprobado — ${p.project_number}`,
            html: `
              <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#1a1a2e">
                <div style="background:#1a1a2e;padding:24px 32px;border-radius:8px 8px 0 0">
                  <h1 style="color:#fff;margin:0;font-size:18px">APPARQ — Descarte aprobado</h1>
                </div>
                <div style="background:#D1FAE5;border:2px solid #6EE7B7;padding:14px 32px">
                  <p style="margin:0;font-size:14px;font-weight:700;color:#065F46">✅ Tu declaración de descarte fue aprobada por APPARQ</p>
                </div>
                <div style="background:#fff;padding:28px 32px;border:1px solid #e2e8f0;border-radius:0 0 8px 8px">
                  <p style="font-size:14px;color:#4a5568;line-height:1.7;">Hola <strong>${p.architect_nombre}</strong>, tu descarte para el trámite <strong>${p.project_number}</strong> fue revisado y aprobado.</p>
                  <p style="font-size:14px;color:#4a5568;line-height:1.7;"><strong>Ya puedes contactar al cliente e informarle el cambio de vía:</strong> ${viaLabel}.</p>
                  <table style="width:100%;border-collapse:collapse;font-size:13px;margin-top:16px">
                    <tr style="background:#f7fafc"><td style="padding:8px 10px;color:#718096;width:40%">N° Trámite</td><td style="padding:8px 10px;font-weight:700;color:#E8503A">${p.project_number}</td></tr>
                    <tr><td style="padding:8px 10px;color:#718096">Servicio</td><td style="padding:8px 10px">${svcName} · ${p.commune}</td></tr>
                    <tr style="background:#f7fafc"><td style="padding:8px 10px;color:#718096">Vía propuesta aprobada</td><td style="padding:8px 10px;font-weight:700;color:#059669">${viaLabel}</td></tr>
                  </table>
                  ${notas ? `<div style="background:#F0F9FF;border:1.5px solid #BAE6FD;border-radius:8px;padding:14px 18px;margin-top:16px"><p style="margin:0 0 4px;font-size:12px;color:#0369A1;font-weight:700">NOTAS DE APPARQ</p><p style="margin:0;font-size:13px;color:#0C4A6E">${notas}</p></div>` : ''}
                  <div style="text-align:center;margin-top:20px"><a href="https://apparq.cl" style="display:inline-block;background:#E8503A;color:#fff;text-decoration:none;font-weight:700;font-size:14px;padding:10px 28px;border-radius:6px">Ir a mi portal</a></div>
                  <hr style="border:none;border-top:1px solid #e2e8f0;margin:24px 0 14px">
                  <p style="font-size:11px;color:#a0aec0;margin:0">APPARQ · DSR ARQ SPA · hola@apparq.cl</p>
                </div>
              </div>`,
          }, RESEND_API_KEY);
        } else {
          await sendEmail({
            to: p.architect_email,
            subject: `❌ Descarte rechazado — ${p.project_number}`,
            html: `
              <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#1a1a2e">
                <div style="background:#1a1a2e;padding:24px 32px;border-radius:8px 8px 0 0">
                  <h1 style="color:#fff;margin:0;font-size:18px">APPARQ — Descarte rechazado</h1>
                </div>
                <div style="background:#FEF2F2;border:2px solid #FECACA;padding:14px 32px">
                  <p style="margin:0;font-size:14px;font-weight:700;color:#991B1B">❌ Tu declaración de descarte fue revisada y rechazada</p>
                </div>
                <div style="background:#fff;padding:28px 32px;border:1px solid #e2e8f0;border-radius:0 0 8px 8px">
                  <p style="font-size:14px;color:#4a5568;line-height:1.7;">Hola <strong>${p.architect_nombre}</strong>, APPARQ revisó tu declaración de descarte para el trámite <strong>${p.project_number}</strong> y fue rechazada.</p>
                  <p style="font-size:14px;color:#4a5568;">El trámite continúa en la vía original: <strong>${svcName}</strong>.</p>
                  <table style="width:100%;border-collapse:collapse;font-size:13px;margin-top:16px">
                    <tr style="background:#f7fafc"><td style="padding:8px 10px;color:#718096;width:40%">N° Trámite</td><td style="padding:8px 10px;font-weight:700;color:#E8503A">${p.project_number}</td></tr>
                    <tr><td style="padding:8px 10px;color:#718096">Servicio</td><td style="padding:8px 10px">${svcName} · ${p.commune}</td></tr>
                  </table>
                  ${notas ? `<div style="background:#FEF2F2;border:1.5px solid #FECACA;border-radius:8px;padding:14px 18px;margin-top:16px"><p style="margin:0 0 4px;font-size:12px;color:#991B1B;font-weight:700">MOTIVO DEL RECHAZO</p><p style="margin:0;font-size:13px;color:#7F1D1D;line-height:1.6">${notas}</p></div>` : ''}
                  <p style="font-size:13px;color:#4a5568;margin-top:16px;">Si tienes dudas, contáctanos a <a href="mailto:hola@apparq.cl" style="color:#E8503A">hola@apparq.cl</a>.</p>
                  <div style="text-align:center;margin-top:20px"><a href="https://apparq.cl" style="display:inline-block;background:#E8503A;color:#fff;text-decoration:none;font-weight:700;font-size:14px;padding:10px 28px;border-radius:6px">Ir a mi portal</a></div>
                  <hr style="border:none;border-top:1px solid #e2e8f0;margin:24px 0 14px">
                  <p style="font-size:11px;color:#a0aec0;margin:0">APPARQ · DSR ARQ SPA · hola@apparq.cl</p>
                </div>
              </div>`,
          }, RESEND_API_KEY);
        }
      }

      return json({ ok: true });
    }

    /* update_stage */
    if (action === 'update_stage') {
      const { project_id, stage } = body;
      if (!project_id || !stage) return json({ error: 'project_id y stage requeridos' }, 400);
      const { ok, data } = await sb(`/projects?id=eq.${project_id}`, {
        method: 'PATCH',
        body: JSON.stringify({ stage }),
        prefer: 'return=representation',
      });
      if (!ok) return json({ error: 'Error al actualizar etapa', detail: data }, 500);
      return json({ success: true, project: Array.isArray(data) ? data[0] : data });
    }

    /* mark_arq_payment */
    if (action === 'mark_arq_payment') {
      const { project_id, etapa } = body;
      if (!project_id || !etapa) return json({ error: 'project_id y etapa requeridos' }, 400);
      const validEtapas = ['e1', 'e2', 'e3', 'e4'];
      if (!validEtapas.includes(etapa)) return json({ error: 'Etapa inválida' }, 400);

      const field   = `arq_pago_${etapa}`;
      const fieldAt = `arq_pago_${etapa}_at`;
      const { ok, data } = await sb(`/projects?id=eq.${project_id}`, {
        method: 'PATCH',
        body: JSON.stringify({ [field]: true, [fieldAt]: new Date().toISOString() }),
        prefer: 'return=minimal',
      });
      if (!ok) return json({ error: 'Error al marcar pago', detail: data }, 500);
      return json({ ok: true });
    }

    /* resend_arq_email — reenvía email de asignación al arquitecto */
    if (action === 'resend_arq_email') {
      const { project_id } = body;
      if (!project_id) return json({ error: 'project_id requerido' }, 400);
      const RESEND_API_KEY = env.RESEND_API_KEY;
      if (!RESEND_API_KEY) return json({ error: 'RESEND_API_KEY no configurada' }, 500);

      const [projRes, archRes_raw] = await Promise.all([
        sb(`/projects?id=eq.${project_id}&select=project_number,client_nombre,client_apellido,client_email,client_phone,service_type,address,commune,m2,total_clp,e1_clp,architect_email&limit=1`),
        sb(`/projects?id=eq.${project_id}&select=architect_email&limit=1`),
      ]);
      const project = projRes.ok && Array.isArray(projRes.data) && projRes.data[0] ? projRes.data[0] : null;
      if (!project) return json({ error: 'Proyecto no encontrado' }, 404);
      if (!project.architect_email) return json({ error: 'Proyecto sin arquitecto asignado' }, 400);

      const archRes = await sb(`/architects?email=eq.${encodeURIComponent(project.architect_email)}&select=nombre,apellido,email,patente,telefono&limit=1`);
      const architect = archRes.ok && Array.isArray(archRes.data) && archRes.data[0] ? archRes.data[0] : null;
      if (!architect) return json({ error: 'Arquitecto no encontrado' }, 404);

      await sendPaymentEmails({ project, architect, RESEND_API_KEY });
      return json({ ok: true });
    }

    /* invite_architect — genera link de acceso/recuperación vía Supabase admin API y lo envía por email */
    if (action === 'invite_architect') {
      const { email } = body;
      if (!email) return json({ error: 'email requerido' }, 400);
      const RESEND_API_KEY = env.RESEND_API_KEY;
      if (!RESEND_API_KEY) return json({ error: 'RESEND_API_KEY no configurada' }, 500);
      if (!SERVICE_KEY)    return json({ error: 'SUPABASE_SERVICE_KEY no configurada' }, 500);

      const emailLow = email.toLowerCase().trim();

      /* 1. Buscar datos del arquitecto */
      const archRes = await sb(`/architects?email=eq.${encodeURIComponent(emailLow)}&select=nombre,apellido&limit=1`);
      const arch    = archRes.ok && Array.isArray(archRes.data) && archRes.data[0] ? archRes.data[0] : null;
      const nombre  = arch?.nombre || 'Arquitecta/o';

      const adminHeaders = {
        'apikey':        SERVICE_KEY,
        'Authorization': `Bearer ${SERVICE_KEY}`,
        'Content-Type':  'application/json',
      };

      /* 2. Intentar recovery link (usuario ya existe) */
      let actionLink = null;
      let linkType   = 'recovery';

      const recRes  = await fetch(`${SUPABASE_URL}/auth/v1/admin/generate_link`, {
        method: 'POST', headers: adminHeaders,
        body: JSON.stringify({ type: 'recovery', email: emailLow, options: { redirect_to: 'https://apparq.cl' } }),
      });
      const recData = await recRes.json();

      if (recRes.ok && !recData.error) {
        actionLink = recData.action_link || recData.properties?.action_link;
      } else {
        /* 3. Usuario no existe → crear cuenta con email confirmado */
        const createRes  = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
          method: 'POST', headers: adminHeaders,
          body: JSON.stringify({ email: emailLow, email_confirm: true }),
        });
        const createData = await createRes.json();
        if (!createRes.ok || createData.error) {
          return json({ error: 'Error al crear cuenta', detail: createData }, 500);
        }

        /* 4. Ahora sí generar recovery link */
        const recRes2  = await fetch(`${SUPABASE_URL}/auth/v1/admin/generate_link`, {
          method: 'POST', headers: adminHeaders,
          body: JSON.stringify({ type: 'recovery', email: emailLow, options: { redirect_to: 'https://apparq.cl' } }),
        });
        const recData2 = await recRes2.json();
        if (!recRes2.ok || recData2.error) {
          return json({ error: 'Error al generar link', detail: recData2 }, 500);
        }
        actionLink = recData2.action_link || recData2.properties?.action_link;
      }

      if (!actionLink) return json({ error: 'No se pudo generar el link de acceso' }, 500);

      /* 5. Enviar email con el link */
      await sendEmail({
        to:      emailLow,
        subject: '🔑 Acceso a tu Portal Arquitecto — APPARQ',
        html: `
          <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#1a1a2e">
            <div style="background:#1a1a2e;padding:24px 32px;border-radius:8px 8px 0 0">
              <h1 style="color:#fff;margin:0;font-size:20px;letter-spacing:-0.5px">APPARQ</h1>
              <p style="color:#94a3b8;margin:4px 0 0;font-size:13px">Portal Arquitecto</p>
            </div>
            <div style="background:#fff;padding:28px 32px;border:1px solid #e2e8f0;border-radius:0 0 8px 8px">
              <p style="font-size:15px;color:#1a1a2e;font-weight:700;margin:0 0 8px">Hola ${nombre},</p>
              <p style="font-size:14px;color:#4a5568;line-height:1.7;margin:0 0 20px">
                Usa el botón de abajo para acceder a tu Portal Arquitecto y crear o restablecer tu contraseña.
                El link es de un solo uso y expira en <strong>1 hora</strong>.
              </p>
              <div style="text-align:center;margin:28px 0">
                <a href="${actionLink}" style="display:inline-block;background:#E8503A;color:#fff;text-decoration:none;font-weight:700;font-size:15px;padding:14px 36px;border-radius:8px;letter-spacing:0.2px">
                  Acceder al portal →
                </a>
              </div>
              <p style="font-size:12px;color:#94a3b8;line-height:1.6;margin:0">
                Si no solicitaste este acceso, ignora este mensaje.<br>
                Al hacer clic serás llevado a <strong>apparq.cl</strong> donde podrás crear tu contraseña.
              </p>
              <hr style="border:none;border-top:1px solid #e2e8f0;margin:20px 0 14px">
              <p style="font-size:11px;color:#a0aec0;margin:0">APPARQ · DSR ARQ SPA · hola@apparq.cl</p>
            </div>
          </div>`,
      }, RESEND_API_KEY);

      return json({ ok: true, type: linkType, email: emailLow });
    }

    /* send_custom_email — uso interno admin */
    if (action === 'send_custom_email') {
      const { to, cc, subject, html } = body;
      if (!to || !subject || !html) return json({ error: 'to, subject y html requeridos' }, 400);
      const RESEND_API_KEY = env.RESEND_API_KEY;
      if (!RESEND_API_KEY) return json({ error: 'RESEND_API_KEY no configurada' }, 500);
      const payload = { from: 'APPARQ <hola@apparq.cl>', to, subject, html };
      if (cc) payload.cc = cc;
      const r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!r.ok) {
        const err = await r.text();
        return json({ error: 'Error Resend', detail: err }, 500);
      }
      return json({ ok: true });
    }

    return json({ error: 'Acción no reconocida' }, 400);
  }

  return json({ error: 'Método no permitido' }, 405);
}

/* ══════════════════════════════════════════════════
   APPARQ — Cloudflare Pages Function: portal-architect
   Portal del arquitecto: ver y gestionar sus proyectos
   Requiere token de autenticación (Supabase Auth)
   POST /api/portal-architect
   Body: { action, token, ... }
   Actions: get-projects | update-stage | declare-inviable |
            reject-tramite | toggle-availability | update-photo
══════════════════════════════════════════════════ */

const CORS = {
  'Access-Control-Allow-Origin': 'https://apparq.cl',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
};

function corsResponse(body, status = 200) {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: CORS });
}

async function sendEmail({ to, subject, html }, RESEND_API_KEY) {
  if (!RESEND_API_KEY) return;
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: 'APPARQ <hola@apparq.cl>', to, subject, html }),
  });
  if (!res.ok) console.error('Resend error:', await res.text());
}

const STAGES_NORMAL  = ['levantamiento','elaboracion','ingreso_dom','tramitacion','completado'];
const STAGES_INFORME = ['visita','elaboracion_inf','entrega_informe'];
const STAGE_LABELS   = {
  levantamiento:    'Levantamiento en terreno',
  elaboracion:      'Elaboración de planos',
  ingreso_dom:      'Ingreso a la DOM',
  tramitacion:      'Tramitación municipal',
  completado:       'Trámite completado',
  visita:           'Visita a terreno',
  elaboracion_inf:  'Elaboración del informe',
  entrega_informe:  'Informe entregado',
  no_viable:        'Trámite no viable',
};

/* Verifica token con Supabase Auth y devuelve el email */
async function verifyToken(token, SUPABASE_URL, SUPABASE_KEY) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: {
      'apikey':        SUPABASE_KEY,
      'Authorization': `Bearer ${token}`,
    },
  });
  if (!res.ok) return null;
  const user = await res.json();
  return user.email?.toLowerCase() || null;
}

/* Mapa de comunas adyacentes para reasignación */
const COMUNAS_ADJ = {
  'Santiago':['Providencia','Independencia','Recoleta','Ñuñoa','San Miguel','Cerrillos','Quinta Normal','Estación Central'],
  'Providencia':['Santiago','Las Condes','Ñuñoa','La Reina'],
  'Las Condes':['Providencia','Vitacura','La Reina','Lo Barnechea'],
  'Vitacura':['Las Condes','Lo Barnechea','Providencia'],
  'Lo Barnechea':['Vitacura','Las Condes'],
  'La Reina':['Las Condes','Providencia','Ñuñoa','Peñalolén'],
  'Ñuñoa':['Providencia','La Reina','Peñalolén','Macul','San Joaquín','Santiago'],
  'Peñalolén':['La Reina','Ñuñoa','Macul','La Florida'],
  'La Florida':['Peñalolén','Macul','San Joaquín','El Bosque','La Granja','La Pintana'],
  'Macul':['Ñuñoa','Peñalolén','La Florida','San Joaquín'],
  'San Joaquín':['Ñuñoa','Macul','La Florida','La Granja','San Miguel'],
  'La Granja':['San Joaquín','La Florida','La Pintana','El Bosque','San Ramón'],
  'La Pintana':['La Granja','La Florida','El Bosque','San Ramón'],
  'El Bosque':['La Florida','La Granja','La Pintana','San Ramón','Pedro Aguirre Cerda'],
  'San Ramón':['La Granja','La Pintana','El Bosque','Pedro Aguirre Cerda'],
  'Pedro Aguirre Cerda':['San Miguel','San Ramón','El Bosque','Lo Espejo','La Cisterna'],
  'San Miguel':['Santiago','San Joaquín','La Cisterna','Pedro Aguirre Cerda'],
  'La Cisterna':['San Miguel','Pedro Aguirre Cerda','Lo Espejo','El Bosque'],
  'Lo Espejo':['Pedro Aguirre Cerda','La Cisterna','San Ramón'],
  'Cerrillos':['Santiago','Maipú','Estación Central'],
  'Estación Central':['Santiago','Cerrillos','Maipú','Pudahuel','Quinta Normal'],
  'Maipú':['Cerrillos','Estación Central','Pudahuel'],
  'Pudahuel':['Estación Central','Maipú','Renca','Quilicura','Lo Prado','Cerro Navia'],
  'Lo Prado':['Pudahuel','Quinta Normal','Cerro Navia'],
  'Quinta Normal':['Santiago','Estación Central','Lo Prado','Cerro Navia','Independencia'],
  'Cerro Navia':['Lo Prado','Quinta Normal','Pudahuel','Renca'],
  'Renca':['Cerro Navia','Pudahuel','Quilicura','Huechuraba','Conchalí'],
  'Quilicura':['Renca','Pudahuel','Huechuraba'],
  'Huechuraba':['Renca','Quilicura','Conchalí','Recoleta'],
  'Conchalí':['Renca','Huechuraba','Recoleta','Independencia'],
  'Recoleta':['Santiago','Independencia','Conchalí','Huechuraba'],
  'Independencia':['Santiago','Recoleta','Conchalí','Quinta Normal'],
};

function findBestArchitectExcluding(commune, architects, excludeEmail) {
  const pool = architects.filter(a => a.email?.toLowerCase() !== excludeEmail);
  if (!pool.length) return null;
  const rand = arr => arr[Math.floor(Math.random() * arr.length)];
  const inC = c => pool.filter(a => Array.isArray(a.comunas) && a.comunas.includes(c));
  const exact = inC(commune);
  if (exact.length) return rand(exact);
  for (const adj of (COMUNAS_ADJ[commune] || [])) { const m = inC(adj); if (m.length) return rand(m); }
  for (const adj of (COMUNAS_ADJ[commune] || [])) {
    for (const adj2 of (COMUNAS_ADJ[adj] || [])) {
      if (adj2 === commune) continue;
      const m = inC(adj2); if (m.length) return rand(m);
    }
  }
  return pool.length ? rand(pool) : null;
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
    const { action, token, ...rest } = await request.json();

    if (!token) {
      return corsResponse({ error: 'No autenticado' }, 401);
    }

    const email = await verifyToken(token, SUPABASE_URL, SUPABASE_KEY);
    if (!email) {
      return corsResponse({ error: 'Sesión expirada. Vuelve a ingresar.' }, 401);
    }

    /* Verificar que el email existe en architects */
    const arqRes = await fetch(
      `${SUPABASE_URL}/rest/v1/architects?email=eq.${encodeURIComponent(email)}&select=id,nombre,apellido,foto_url,activo,tramites,comunas&limit=1`,
      { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
    );
    const arqData = await arqRes.json();
    if (!arqData.length) {
      return corsResponse({ error: 'No tienes acceso de arquitecto.' }, 403);
    }
    const architect = arqData[0];

    /* ── GET-PROJECTS ─────────────────────────── */
    if (action === 'get-projects') {
      const projRes = await fetch(
        `${SUPABASE_URL}/rest/v1/projects?architect_email=eq.${encodeURIComponent(email)}&order=created_at.desc`,
        { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
      );
      const projects = projRes.ok ? await projRes.json() : [];
      const enriched = projects.map(p => ({ ...p, stage_label: STAGE_LABELS[p.stage] || p.stage }));

      return corsResponse({ projects: enriched, architect });
    }

    /* ── UPDATE-STAGE ─────────────────────────── */
    if (action === 'update-stage') {
      const { project_number, new_stage, nota } = rest;
      if (!project_number || !new_stage) {
        return corsResponse({ error: 'Faltan datos' }, 400);
      }

      /* Verificar que el proyecto le pertenece */
      const checkRes = await fetch(
        `${SUPABASE_URL}/rest/v1/projects?project_number=eq.${encodeURIComponent(project_number)}&architect_email=eq.${encodeURIComponent(email)}&select=id,service_type&limit=1`,
        { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
      );
      const checkData = await checkRes.json();
      if (!checkData.length) {
        return corsResponse({ error: 'Proyecto no encontrado' }, 403);
      }

      /* Validar que la etapa es válida para el tipo de servicio */
      const svc      = checkData[0].service_type;
      const validStages = svc === 'informe' ? STAGES_INFORME : STAGES_NORMAL;
      if (!validStages.includes(new_stage)) {
        return corsResponse({ error: 'Etapa inválida para este tipo de trámite' }, 400);
      }

      /* Actualizar etapa */
      const updRes = await fetch(
        `${SUPABASE_URL}/rest/v1/projects?project_number=eq.${encodeURIComponent(project_number)}`,
        {
          method: 'PATCH',
          headers: {
            'apikey':        SUPABASE_KEY,
            'Authorization': `Bearer ${SUPABASE_KEY}`,
            'Content-Type':  'application/json',
            'Prefer':        'return=representation',
          },
          body: JSON.stringify({ stage: new_stage, updated_at: new Date().toISOString() }),
        }
      );

      if (!updRes.ok) {
        return corsResponse({ error: 'Error al actualizar etapa' }, 500);
      }

      /* Guardar avance en project_updates para el historial del cliente */
      await fetch(`${SUPABASE_URL}/rest/v1/project_updates`, {
        method: 'POST',
        headers: {
          'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`,
          'Content-Type': 'application/json', 'Prefer': 'return=minimal',
        },
        body: JSON.stringify({
          project_number: project_number,
          author:         'architect',
          stage:          new_stage,
          stage_label:    STAGE_LABELS[new_stage] || new_stage,
          nota:           nota || `Etapa actualizada: ${STAGE_LABELS[new_stage] || new_stage}`,
        }),
      });

      /* Enviar email a hola@apparq.cl con la actualización */
      try {
        const projRes2 = await fetch(
          `${SUPABASE_URL}/rest/v1/projects?project_number=eq.${encodeURIComponent(project_number)}&select=*&limit=1`,
          { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
        );
        const projData = projRes2.ok ? await projRes2.json() : [];
        if (projData.length) {
          const p = projData[0];
          const fecha = new Date().toLocaleDateString('es-CL', { day: '2-digit', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' });
          const svcLabels = { regularizacion:'Regularización', ampliacion:'Ampliación', 'obra-nueva':'Obra Nueva', informe:'Informe de Propiedad' };
          const svcName   = svcLabels[p.service_type] || p.service_type;
          const notaBlock = nota
            ? `<div style="background:#FFF7ED;border:1.5px solid #FED7AA;border-radius:8px;padding:14px 18px;margin:16px 0;">
                 <p style="margin:0 0 4px;font-size:12px;color:#92400E;font-weight:700">NOTA DEL ARQUITECTO</p>
                 <p style="margin:0;font-size:13px;color:#78350F;line-height:1.6;">${nota}</p>
               </div>`
            : '';

          const tableBase = `
            <table style="width:100%;border-collapse:collapse;font-size:13px">
              <tr style="background:#f7fafc"><td style="padding:8px 10px;color:#718096;width:40%">N° Trámite</td><td style="padding:8px 10px;font-weight:700;color:#E8503A">${project_number}</td></tr>
              <tr><td style="padding:8px 10px;color:#718096">Nueva etapa</td><td style="padding:8px 10px;font-weight:700;color:#059669">${STAGE_LABELS[new_stage]}</td></tr>
              <tr style="background:#f7fafc"><td style="padding:8px 10px;color:#718096">Servicio</td><td style="padding:8px 10px">${svcName}</td></tr>
              <tr><td style="padding:8px 10px;color:#718096">Dirección</td><td style="padding:8px 10px">${p.address || '—'}, ${p.commune}</td></tr>
              <tr style="background:#f7fafc"><td style="padding:8px 10px;color:#718096">Fecha</td><td style="padding:8px 10px">${fecha}</td></tr>
            </table>`;

          /* Email al cliente */
          if (p.client_email) {
            await sendEmail({
              to: p.client_email,
              subject: `📊 Avance de tu trámite ${project_number} — ${STAGE_LABELS[new_stage]}`,
              html: `
                <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#1a1a2e">
                  <div style="background:#1a1a2e;padding:28px 32px;text-align:center;border-radius:8px 8px 0 0">
                    <h1 style="color:#fff;margin:0;font-size:22px">APPARQ</h1>
                    <p style="color:#a0aec0;margin:6px 0 0;font-size:13px">Actualización de tu trámite</p>
                  </div>
                  <div style="background:#fff;padding:28px 32px;border:1px solid #e2e8f0;border-radius:0 0 8px 8px">
                    <h2 style="margin-top:0;color:#1a1a2e;">Hola ${p.client_nombre}, tu trámite avanzó</h2>
                    <p style="color:#4a5568;font-size:14px;">Tu arquitecto <strong>${p.architect_nombre} ${p.architect_apellido}</strong> ha registrado un nuevo avance:</p>
                    <div style="background:#f0fdf4;border:1.5px solid #bbf7d0;border-radius:8px;padding:14px 20px;margin:16px 0;">
                      <p style="margin:0 0 4px;font-size:12px;color:#718096;font-weight:700">NUEVA ETAPA</p>
                      <p style="margin:0;font-size:20px;font-weight:900;color:#059669;">${STAGE_LABELS[new_stage]}</p>
                    </div>
                    ${notaBlock}
                    ${tableBase}
                    <div style="text-align:center;margin-top:20px;">
                      <a href="https://apparq.cl" style="display:inline-block;background:#E8503A;color:#fff;text-decoration:none;font-weight:700;font-size:14px;padding:10px 28px;border-radius:6px;">Ver detalle en apparq.cl</a>
                    </div>
                    <hr style="border:none;border-top:1px solid #e2e8f0;margin:24px 0 14px">
                    <p style="font-size:11px;color:#a0aec0;margin:0">APPARQ · DSR ARQ SPA · hola@apparq.cl</p>
                  </div>
                </div>`,
            }, RESEND_API_KEY);
          }

          /* Email a hola@apparq.cl */
          await sendEmail({
            to: 'hola@apparq.cl',
            subject: `📊 Avance de trámite — ${project_number} → ${STAGE_LABELS[new_stage]}`,
            html: `
              <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#1a1a2e">
                <div style="background:#1a1a2e;padding:24px 32px;border-radius:8px 8px 0 0">
                  <h1 style="color:#fff;margin:0;font-size:18px">APPARQ — Actualización de trámite</h1>
                </div>
                <div style="background:#fff;padding:28px 32px;border:1px solid #e2e8f0;border-radius:0 0 8px 8px">
                  ${tableBase}
                  ${notaBlock}
                  <table style="width:100%;border-collapse:collapse;font-size:13px;margin-top:16px">
                    <tr style="background:#f7fafc"><td style="padding:8px 10px;color:#718096;width:40%">Cliente</td><td style="padding:8px 10px">${p.client_nombre} ${p.client_apellido} · ${p.client_email}</td></tr>
                    <tr><td style="padding:8px 10px;color:#718096">Arquitecto</td><td style="padding:8px 10px">${p.architect_nombre} ${p.architect_apellido} · ${p.architect_email}</td></tr>
                  </table>
                </div>
              </div>`,
          }, RESEND_API_KEY);
        }
      } catch (emailErr) {
        console.warn('Error enviando email de avance:', emailErr);
      }

      return corsResponse({ ok: true, stage_label: STAGE_LABELS[new_stage] });
    }

    /* ── DECLARE-INVIABLE ─────────────────────── */
    if (action === 'declare-inviable') {
      const { project_number, informe } = rest;
      if (!project_number || !informe?.trim()) {
        return corsResponse({ error: 'Debes ingresar el informe técnico de inviabilidad' }, 400);
      }

      /* Verificar que el proyecto pertenece al arquitecto */
      const checkRes = await fetch(
        `${SUPABASE_URL}/rest/v1/projects?project_number=eq.${encodeURIComponent(project_number)}&architect_email=eq.${encodeURIComponent(email)}&select=*&limit=1`,
        { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
      );
      const checkData = await checkRes.json();
      if (!checkData.length) {
        return corsResponse({ error: 'Proyecto no encontrado' }, 403);
      }
      const p = checkData[0];

      /* Actualizar stage a no_viable y guardar informe */
      await fetch(
        `${SUPABASE_URL}/rest/v1/projects?project_number=eq.${encodeURIComponent(project_number)}`,
        {
          method: 'PATCH',
          headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ stage: 'no_viable', inviabilidad_informe: informe.trim(), updated_at: new Date().toISOString() }),
        }
      );

      const fecha   = new Date().toLocaleDateString('es-CL', { day:'2-digit', month:'long', year:'numeric' });
      const svcLabels = { regularizacion:'Regularización', ampliacion:'Ampliación', 'obra-nueva':'Obra Nueva', informe:'Informe de Propiedad' };
      const svcName = svcLabels[p.service_type] || p.service_type;

      /* Email al cliente */
      if (p.client_email) {
        await sendEmail({
          to: p.client_email,
          subject: `⚠️ Informe de inviabilidad — Trámite ${project_number} — APPARQ`,
          html: `
            <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#1a1a2e">
              <div style="background:#1a1a2e;padding:28px 32px;text-align:center;border-radius:8px 8px 0 0">
                <h1 style="color:#fff;margin:0;font-size:22px">APPARQ</h1>
                <p style="color:#a0aec0;margin:6px 0 0;font-size:13px">Informe de inviabilidad técnica</p>
              </div>
              <div style="background:#fff;padding:28px 32px;border:1px solid #e2e8f0;border-radius:0 0 8px 8px">
                <h2 style="margin-top:0;color:#1a1a2e;">Estimado/a ${p.client_nombre},</h2>
                <p style="color:#4a5568;font-size:14px;line-height:1.7;">El arquitecto asignado a tu trámite ha determinado que la propiedad no es viable para la tramitación solicitada. A continuación el informe técnico:</p>

                <div style="background:#FEF2F2;border:1.5px solid #FECACA;border-radius:8px;padding:16px 20px;margin:16px 0;">
                  <p style="margin:0 0 6px;font-size:12px;color:#991B1B;font-weight:700;">INFORME TÉCNICO DE INVIABILIDAD</p>
                  <p style="margin:0;font-size:13px;color:#7F1D1D;line-height:1.7;">${informe.trim()}</p>
                </div>

                <table style="width:100%;border-collapse:collapse;font-size:13px;margin-top:16px">
                  <tr style="background:#f7fafc"><td style="padding:8px 10px;color:#718096;width:40%">N° Trámite</td><td style="padding:8px 10px;font-weight:700;color:#E8503A">${project_number}</td></tr>
                  <tr><td style="padding:8px 10px;color:#718096">Servicio</td><td style="padding:8px 10px">${svcName}</td></tr>
                  <tr style="background:#f7fafc"><td style="padding:8px 10px;color:#718096">Dirección</td><td style="padding:8px 10px">${p.address || '—'}, ${p.commune}</td></tr>
                  <tr><td style="padding:8px 10px;color:#718096">Arquitecto</td><td style="padding:8px 10px">${p.architect_nombre} ${p.architect_apellido}</td></tr>
                  <tr style="background:#f7fafc"><td style="padding:8px 10px;color:#718096">Fecha</td><td style="padding:8px 10px">${fecha}</td></tr>
                </table>

                <div style="background:#FFF7ED;border:1.5px solid #FED7AA;border-radius:8px;padding:14px 18px;margin-top:20px">
                  <p style="margin:0 0 6px;font-size:12px;color:#92400E;font-weight:700;">⚠️ Política de reembolsos (Cláusula 10)</p>
                  <p style="margin:0;font-size:12px;color:#78350F;line-height:1.6;">El pago E1 no es reembolsable, ya que cubre los costos del diagnóstico profesional y trabajo ejecutado hasta esta etapa, conforme a las condiciones del contrato firmado digitalmente en apparq.cl.</p>
                </div>

                <p style="font-size:13px;color:#4a5568;margin-top:16px;">Si tienes dudas o deseas más información, contáctanos a <a href="mailto:hola@apparq.cl" style="color:#E8503A">hola@apparq.cl</a>.</p>
                <hr style="border:none;border-top:1px solid #e2e8f0;margin:24px 0 14px">
                <p style="font-size:11px;color:#a0aec0;margin:0">APPARQ · DSR ARQ SPA · hola@apparq.cl</p>
              </div>
            </div>`,
        }, RESEND_API_KEY);
      }

      /* Email a hola@apparq.cl */
      await sendEmail({
        to: 'hola@apparq.cl',
        subject: `⚠️ Trámite declarado no viable — ${project_number}`,
        html: `
          <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#1a1a2e">
            <div style="background:#1a1a2e;padding:24px 32px;border-radius:8px 8px 0 0">
              <h1 style="color:#fff;margin:0;font-size:18px">APPARQ — Trámite no viable</h1>
            </div>
            <div style="background:#fff;padding:28px 32px;border:1px solid #e2e8f0;border-radius:0 0 8px 8px">
              <div style="background:#FEF2F2;border:1.5px solid #FECACA;border-radius:8px;padding:14px 18px;margin-bottom:20px">
                <p style="margin:0 0 6px;font-size:12px;color:#991B1B;font-weight:700;">INFORME TÉCNICO</p>
                <p style="margin:0;font-size:13px;color:#7F1D1D;line-height:1.7;">${informe.trim()}</p>
              </div>
              <table style="width:100%;border-collapse:collapse;font-size:13px">
                <tr style="background:#f7fafc"><td style="padding:8px 10px;color:#718096;width:40%">N° Trámite</td><td style="padding:8px 10px;font-weight:700;color:#E8503A">${project_number}</td></tr>
                <tr><td style="padding:8px 10px;color:#718096">Servicio</td><td style="padding:8px 10px">${svcName}</td></tr>
                <tr style="background:#f7fafc"><td style="padding:8px 10px;color:#718096">Cliente</td><td style="padding:8px 10px">${p.client_nombre} ${p.client_apellido} · ${p.client_email}</td></tr>
                <tr><td style="padding:8px 10px;color:#718096">Arquitecto</td><td style="padding:8px 10px">${p.architect_nombre} ${p.architect_apellido} · ${p.architect_email}</td></tr>
                <tr style="background:#f7fafc"><td style="padding:8px 10px;color:#718096">Dirección</td><td style="padding:8px 10px">${p.address || '—'}, ${p.commune}</td></tr>
                <tr><td style="padding:8px 10px;color:#718096">Fecha</td><td style="padding:8px 10px">${fecha}</td></tr>
              </table>
            </div>
          </div>`,
      }, RESEND_API_KEY);

      return corsResponse({ ok: true });
    }

    /* ── TOGGLE-AVAILABILITY ──────────────────── */
    if (action === 'toggle-availability') {
      const { activo } = rest;   /* boolean: true = disponible, false = no disponible */
      await fetch(
        `${SUPABASE_URL}/rest/v1/architects?email=eq.${encodeURIComponent(email)}`,
        {
          method: 'PATCH',
          headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ activo: activo !== false }),
        }
      );
      /* Notificar a hola@apparq.cl del cambio de estado */
      await sendEmail({
        to: 'hola@apparq.cl',
        subject: `🔔 Arquitecto ${activo ? 'disponible' : 'no disponible'} — ${architect.nombre} ${architect.apellido}`,
        html: `<p style="font-family:Arial,sans-serif;font-size:13px;">
          El arquitecto <strong>${architect.nombre} ${architect.apellido}</strong> (${email}) ha cambiado su estado a
          <strong>${activo ? '🟢 Disponible' : '🔴 No disponible'}</strong>.<br><br>
          ${activo ? 'Puede recibir nuevas asignaciones.' : 'No recibirá nuevas asignaciones hasta que reactive su disponibilidad.'}
        </p>`,
      }, RESEND_API_KEY);
      return corsResponse({ ok: true, activo: activo !== false });
    }

    /* ── REJECT-TRAMITE ───────────────────────── */
    if (action === 'reject-tramite') {
      const { project_number, motivo } = rest;
      if (!project_number) {
        return corsResponse({ error: 'Falta número de proyecto' }, 400);
      }

      /* Verificar propiedad del proyecto */
      const checkRes = await fetch(
        `${SUPABASE_URL}/rest/v1/projects?project_number=eq.${encodeURIComponent(project_number)}&architect_email=eq.${encodeURIComponent(email)}&select=*&limit=1`,
        { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
      );
      const checkData = await checkRes.json();
      if (!checkData.length) {
        return corsResponse({ error: 'Proyecto no encontrado' }, 403);
      }
      const p = checkData[0];

      /* Buscar arquitectos disponibles excluyendo el actual */
      const allArqRes = await fetch(
        `${SUPABASE_URL}/rest/v1/architects?select=id,nombre,apellido,email,comunas,tramites,foto_url,calificacion,activo`,
        { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
      );
      const allArqRaw = allArqRes.ok ? await allArqRes.json() : [];
      const availableArqs = allArqRaw
        .filter(a => a.activo !== false)
        .map(a => ({
          ...a,
          comunas: Array.isArray(a.comunas) ? a.comunas : (a.comunas ? String(a.comunas).split(',').map(s=>s.trim()).filter(Boolean) : []),
        }));

      const newArq = findBestArchitectExcluding(p.commune, availableArqs, email);

      const fecha = new Date().toLocaleDateString('es-CL', { day:'2-digit', month:'long', year:'numeric' });
      const svcLabels = { regularizacion:'Regularización', ampliacion:'Ampliación', 'obra-nueva':'Obra Nueva', informe:'Informe de Propiedad' };
      const svcName = svcLabels[p.service_type] || p.service_type;

      if (newArq) {
        /* Reasignar proyecto al nuevo arquitecto */
        await fetch(
          `${SUPABASE_URL}/rest/v1/projects?project_number=eq.${encodeURIComponent(project_number)}`,
          {
            method: 'PATCH',
            headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              architect_email:    newArq.email,
              architect_nombre:   newArq.nombre,
              architect_apellido: newArq.apellido,
              stage:              'levantamiento',
              updated_at:         new Date().toISOString(),
            }),
          }
        );

        /* Email al cliente: nuevo arquitecto asignado */
        if (p.client_email) {
          await sendEmail({
            to: p.client_email,
            subject: `🔄 Tu trámite ${project_number} tiene un nuevo arquitecto asignado — APPARQ`,
            html: `
              <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#1a1a2e">
                <div style="background:#1a1a2e;padding:28px 32px;text-align:center;border-radius:8px 8px 0 0">
                  <h1 style="color:#fff;margin:0;font-size:22px">APPARQ</h1>
                  <p style="color:#a0aec0;margin:6px 0 0;font-size:13px">Actualización de tu trámite</p>
                </div>
                <div style="background:#fff;padding:28px 32px;border:1px solid #e2e8f0;border-radius:0 0 8px 8px">
                  <h2 style="margin-top:0;color:#1a1a2e;">Hola ${p.client_nombre}, tu trámite fue reasignado</h2>
                  <p style="color:#4a5568;font-size:14px;line-height:1.7;">
                    El arquitecto anterior no pudo continuar con tu trámite. APPARQ ha asignado un nuevo profesional de forma automática:
                  </p>
                  <div style="background:#f0fdf4;border:1.5px solid #bbf7d0;border-radius:8px;padding:16px 20px;margin:16px 0;">
                    <p style="margin:0 0 4px;font-size:12px;color:#718096;font-weight:700">NUEVO ARQUITECTO ASIGNADO</p>
                    <p style="margin:0;font-size:18px;font-weight:800;color:#1a1a2e;">👷 ${newArq.nombre} ${newArq.apellido}</p>
                  </div>
                  <table style="width:100%;border-collapse:collapse;font-size:13px;margin-bottom:20px">
                    <tr style="background:#f7fafc"><td style="padding:8px 10px;color:#718096;width:40%">N° Trámite</td><td style="padding:8px 10px;font-weight:700;color:#E8503A">${project_number}</td></tr>
                    <tr><td style="padding:8px 10px;color:#718096">Servicio</td><td style="padding:8px 10px">${svcName}</td></tr>
                    <tr style="background:#f7fafc"><td style="padding:8px 10px;color:#718096">Dirección</td><td style="padding:8px 10px">${p.address || '—'}, ${p.commune}</td></tr>
                  </table>
                  <p style="color:#4a5568;font-size:13px;">El nuevo arquitecto se pondrá en contacto contigo pronto a través de <strong>apparq.cl</strong>. No es necesario que hagas nada adicional.</p>
                  <div style="text-align:center;margin-top:16px;">
                    <a href="https://apparq.cl" style="display:inline-block;background:#E8503A;color:#fff;text-decoration:none;font-weight:700;font-size:14px;padding:10px 28px;border-radius:6px;">Ver mi trámite</a>
                  </div>
                  <hr style="border:none;border-top:1px solid #e2e8f0;margin:24px 0 14px">
                  <p style="font-size:11px;color:#a0aec0;margin:0">APPARQ · DSR ARQ SPA · hola@apparq.cl</p>
                </div>
              </div>`,
          }, RESEND_API_KEY);
        }

        /* Email al nuevo arquitecto */
        if (newArq.email) {
          await sendEmail({
            to: newArq.email,
            subject: `🏗 Nuevo trámite asignado — ${svcName} en ${p.commune} — APPARQ`,
            html: `
              <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#1a1a2e">
                <div style="background:#1a1a2e;padding:28px 32px;text-align:center;border-radius:8px 8px 0 0">
                  <h1 style="color:#fff;margin:0;font-size:22px">APPARQ</h1>
                  <p style="color:#a0aec0;margin:6px 0 0;font-size:13px">Portal del arquitecto</p>
                </div>
                <div style="background:#fff;padding:28px 32px;border:1px solid #e2e8f0;border-radius:0 0 8px 8px">
                  <h2 style="margin-top:0;color:#1a1a2e;">¡Hola ${newArq.nombre}! Se te ha reasignado un trámite</h2>
                  <p style="color:#4a5568;font-size:14px;line-height:1.7;">Un arquitecto anterior rechazó este trámite. APPARQ te lo ha asignado a ti como siguiente disponible.</p>
                  <div style="background:#FFF7ED;border:2px solid #E8503A;border-radius:8px;padding:14px 20px;margin:16px 0;text-align:center">
                    <p style="margin:0 0 4px;font-size:12px;color:#92400E;font-weight:700">N° DE TRÁMITE</p>
                    <p style="margin:0;font-size:24px;font-weight:900;color:#E8503A;letter-spacing:2px">${project_number}</p>
                  </div>
                  <table style="width:100%;border-collapse:collapse;font-size:13px">
                    <tr style="background:#f7fafc"><td style="padding:8px 10px;color:#718096;width:40%">Servicio</td><td style="padding:8px 10px;font-weight:700">${svcName}</td></tr>
                    <tr><td style="padding:8px 10px;color:#718096">Dirección</td><td style="padding:8px 10px">${p.address || '—'}, ${p.commune}</td></tr>
                    <tr style="background:#f7fafc"><td style="padding:8px 10px;color:#718096">Cliente</td><td style="padding:8px 10px">${p.client_nombre} ${p.client_apellido}</td></tr>
                    <tr><td style="padding:8px 10px;color:#718096">Superficie</td><td style="padding:8px 10px">${p.m2} m²</td></tr>
                    <tr style="background:#f7fafc"><td style="padding:8px 10px;color:#718096">Fecha</td><td style="padding:8px 10px">${fecha}</td></tr>
                  </table>
                  <div style="text-align:center;margin-top:20px;">
                    <a href="https://apparq.cl" style="display:inline-block;background:#E8503A;color:#fff;text-decoration:none;font-weight:700;font-size:14px;padding:10px 28px;border-radius:6px;">Ir a mi portal</a>
                  </div>
                  <hr style="border:none;border-top:1px solid #e2e8f0;margin:24px 0 14px">
                  <p style="font-size:11px;color:#a0aec0;margin:0">APPARQ · DSR ARQ SPA · hola@apparq.cl</p>
                </div>
              </div>`,
          }, RESEND_API_KEY);
        }

        /* Email a hola@apparq.cl */
        await sendEmail({
          to: 'hola@apparq.cl',
          subject: `🔄 Trámite rechazado y reasignado — ${project_number}`,
          html: `
            <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#1a1a2e">
              <div style="background:#1a1a2e;padding:24px 32px;border-radius:8px 8px 0 0">
                <h1 style="color:#fff;margin:0;font-size:18px">APPARQ — Trámite reasignado</h1>
              </div>
              <div style="background:#fff;padding:28px 32px;border:1px solid #e2e8f0;border-radius:0 0 8px 8px">
                <table style="width:100%;border-collapse:collapse;font-size:13px">
                  <tr style="background:#f7fafc"><td style="padding:8px 10px;color:#718096;width:40%">N° Trámite</td><td style="padding:8px 10px;font-weight:700;color:#E8503A">${project_number}</td></tr>
                  <tr><td style="padding:8px 10px;color:#718096">Motivo rechazo</td><td style="padding:8px 10px">${motivo || 'No especificado'}</td></tr>
                  <tr style="background:#f7fafc"><td style="padding:8px 10px;color:#718096">Arq. anterior</td><td style="padding:8px 10px">${p.architect_nombre} ${p.architect_apellido} · ${email}</td></tr>
                  <tr><td style="padding:8px 10px;color:#718096">Arq. nuevo</td><td style="padding:8px 10px;font-weight:700;color:#059669">${newArq.nombre} ${newArq.apellido} · ${newArq.email}</td></tr>
                  <tr style="background:#f7fafc"><td style="padding:8px 10px;color:#718096">Servicio</td><td style="padding:8px 10px">${svcName} · ${p.commune}</td></tr>
                  <tr><td style="padding:8px 10px;color:#718096">Cliente</td><td style="padding:8px 10px">${p.client_nombre} ${p.client_apellido} · ${p.client_email}</td></tr>
                </table>
              </div>
            </div>`,
        }, RESEND_API_KEY);

        return corsResponse({ ok: true, reassigned: true, new_arq: `${newArq.nombre} ${newArq.apellido}` });

      } else {
        /* Sin arquitecto disponible — dejar sin asignar y avisar a APPARQ */
        await fetch(
          `${SUPABASE_URL}/rest/v1/projects?project_number=eq.${encodeURIComponent(project_number)}`,
          {
            method: 'PATCH',
            headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ architect_email: null, architect_nombre: '', architect_apellido: '', updated_at: new Date().toISOString() }),
          }
        );

        if (p.client_email) {
          await sendEmail({
            to: p.client_email,
            subject: `🔄 Actualización de tu trámite ${project_number} — APPARQ`,
            html: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:28px 32px;color:#1a1a2e">
              <h2>Hola ${p.client_nombre},</h2>
              <p style="font-size:14px;color:#4a5568;line-height:1.7;">El arquitecto asignado a tu trámite <strong>${project_number}</strong> no puede continuar. APPARQ asignará un nuevo profesional en las próximas 2 horas hábiles y te avisaremos por email.</p>
              <p style="font-size:12px;color:#a0aec0;">¿Tienes dudas? Escríbenos a hola@apparq.cl</p>
            </div>`,
          }, RESEND_API_KEY);
        }

        await sendEmail({
          to: 'hola@apparq.cl',
          subject: `⚠️ Trámite rechazado sin reasignación posible — ${project_number}`,
          html: `<p style="font-family:Arial,sans-serif;font-size:13px;">El trámite <strong>${project_number}</strong> fue rechazado por ${p.architect_nombre} ${p.architect_apellido} (${email}) y no hay arquitectos disponibles para reasignar. Asignación manual requerida.<br>Motivo: ${motivo || 'No especificado'}</p>`,
        }, RESEND_API_KEY);

        return corsResponse({ ok: true, reassigned: false });
      }
    }

    /* ── UPDATE-TRAMITES ─────────────────────── */
    if (action === 'update-tramites') {
      const { tramites } = rest;
      if (!Array.isArray(tramites)) {
        return corsResponse({ error: 'tramites debe ser un array' }, 400);
      }
      const updRes = await fetch(
        `${SUPABASE_URL}/rest/v1/architects?email=eq.${encodeURIComponent(email)}`,
        {
          method: 'PATCH',
          headers: {
            'apikey':        SUPABASE_KEY,
            'Authorization': `Bearer ${SUPABASE_KEY}`,
            'Content-Type':  'application/json',
          },
          body: JSON.stringify({ tramites }),
        }
      );
      if (!updRes.ok) {
        return corsResponse({ error: 'Error al guardar servicios' }, 500);
      }
      return corsResponse({ ok: true });
    }

    /* ── UPDATE-PHOTO ─────────────────────────── */
    if (action === 'update-photo') {
      const { foto_url } = rest;
      if (!foto_url) {
        return corsResponse({ error: 'Falta foto_url' }, 400);
      }
      const updRes = await fetch(
        `${SUPABASE_URL}/rest/v1/architects?email=eq.${encodeURIComponent(email)}`,
        {
          method: 'PATCH',
          headers: {
            'apikey':        SUPABASE_KEY,
            'Authorization': `Bearer ${SUPABASE_KEY}`,
            'Content-Type':  'application/json',
          },
          body: JSON.stringify({ foto_url }),
        }
      );
      if (!updRes.ok) {
        return corsResponse({ error: 'Error al guardar foto' }, 500);
      }
      return corsResponse({ ok: true });
    }

    return corsResponse({ error: 'Acción no reconocida' }, 400);

  } catch (err) {
    console.error('portal-architect error:', err);
    return corsResponse({ error: 'Error interno' }, 500);
  }
}

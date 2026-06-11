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
  const toStr = Array.isArray(to) ? to.join(',') : String(to);
  const from = toStr.includes('hola@apparq.cl') ? 'APPARQ <no-reply@apparq.cl>' : 'APPARQ <hola@apparq.cl>';
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to, subject, html }),
  });
  if (!res.ok) console.error('Resend error:', await res.text());
}

const STAGES_NORMAL              = ['levantamiento','elaboracion','ingreso_dom','tramitacion','completado'];
const STAGES_INFORME             = ['visita','entrega_informe'];              /* factibilidad / compraventa */
const STAGES_INFORME_EVALUACION  = ['elaboracion_inf','entrega_informe'];     /* evaluacion normativa */
const STAGE_LABELS   = {
  levantamiento:    'Levantamiento en terreno',
  elaboracion:      'Elaboración de planos',
  ingreso_dom:      'Ingreso a la DOM',
  tramitacion:      'Tramitación municipal',
  completado:       'Trámite completado',
  visita:           'Visita a terreno',
  elaboracion_inf:  'Análisis normativo',
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
  /* Usar service key para REST queries (bypasa RLS); anon key solo para Auth */
  const SUPABASE_KEY   = env.SUPABASE_SERVICE_KEY || env.SUPABASE_SVC || env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImliZGFmbnpsc3Vmc3NoY3pxdm9hIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM5Njg0NjYsImV4cCI6MjA4OTU0NDQ2Nn0.ucEjCcnSbaz-OeMrLbUbgcKacvg9J2Csg2VzrWVtVHA';
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
      `${SUPABASE_URL}/rest/v1/architects?email=eq.${encodeURIComponent(email)}&select=id,nombre,apellido,foto_url,activo,tramites,comunas,patente&limit=1`,
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
      const arqPct    = architect.patente ? 0.80 : 0.70;
      const pctCom    = architect.patente ? 20 : 30;
      const RETENCION = 0.1525; /* 15,25% — Ley 21.133 vigente 2026 */

      function mkPago(etapa, label, valorCliente, pagado, at) {
        const vCli           = Math.round(valorCliente);
        const brutoBoleta    = Math.round(vCli * arqPct);
        const retencion      = Math.round(brutoBoleta * RETENCION);
        const netoArquitecto = brutoBoleta - retencion;
        const comisionAPPARQ = vCli - brutoBoleta;
        return { etapa, label, valorCliente: vCli, monto: brutoBoleta,
                 brutoBoleta, retencion, netoArquitecto, comisionAPPARQ, pctCom, pagado, at };
      }

      const enriched = projects.map(p => {
        const is2stages = p.service_type === 'informe' || p.service_type === 'declaracion-jurada';
        const clp  = p.total_clp || 0;
        const e1c  = p.e1_clp   || 0;
        const pagos = is2stages ? [
          mkPago('e1', 'E1 · Inicio',         clp * 0.50, p.arq_pago_e1 || false, p.arq_pago_e1_at),
          mkPago('e2', p.service_type === 'informe' ? 'E2 · Entrega informe' : 'E2 · Cierre DJ',
                       clp * 0.50, p.arq_pago_e2 || false, p.arq_pago_e2_at),
        ] : [
          mkPago('e1', 'E1 · Levantamiento',   e1c,        p.arq_pago_e1 || false, p.arq_pago_e1_at),
          mkPago('e2', 'E2 · Elaboración',     clp * 0.30, p.arq_pago_e2 || false, p.arq_pago_e2_at),
          mkPago('e3', 'E3 · Ingreso DOM',     clp * 0.30, p.arq_pago_e3 || false, p.arq_pago_e3_at),
          mkPago('e4', 'E4 · Recepción final', clp * 0.20, p.arq_pago_e4 || false, p.arq_pago_e4_at),
        ];
        return { ...p, stage_label: STAGE_LABELS[p.stage] || p.stage, pagos };
      });

      /* Obtener cobros adicionales de todos los proyectos del arquitecto */
      let cobrosByProject = {};
      try {
        const cobrosRes = await fetch(
          `${SUPABASE_URL}/rest/v1/cobros_adicionales?arquitecto_email=eq.${encodeURIComponent(email)}&order=fecha_creacion.desc`,
          { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
        );
        const cobrosAll = cobrosRes.ok ? await cobrosRes.json() : [];
        for (const c of cobrosAll) {
          if (!cobrosByProject[c.tramite_id]) cobrosByProject[c.tramite_id] = [];
          cobrosByProject[c.tramite_id].push(c);
        }
      } catch(_) {}

      const withCobros = enriched.map(p => ({
        ...p,
        cobros: cobrosByProject[p.project_number] || [],
      }));

      return corsResponse({ projects: withCobros, architect });
    }

    /* ── UPDATE-STAGE ─────────────────────────── */
    if (action === 'update-stage') {
      const { project_number, new_stage, nota } = rest;
      if (!project_number || !new_stage) {
        return corsResponse({ error: 'Faltan datos' }, 400);
      }

      /* Verificar que el proyecto le pertenece */
      const checkRes = await fetch(
        `${SUPABASE_URL}/rest/v1/projects?project_number=eq.${encodeURIComponent(project_number)}&architect_email=eq.${encodeURIComponent(email)}&select=id,service_type,servicio_subtipo,cliente_contactado&limit=1`,
        { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
      );
      const checkData = await checkRes.json();
      if (!checkData.length) {
        return corsResponse({ error: 'Proyecto no encontrado' }, 403);
      }

      /* Validar que la etapa es válida para el tipo de servicio y subtipo */
      const svc      = checkData[0].service_type;
      const subtipo  = checkData[0].servicio_subtipo;
      const validStages = svc === 'informe'
        ? (subtipo === 'evaluacion' ? STAGES_INFORME_EVALUACION : STAGES_INFORME)
        : STAGES_NORMAL;
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

      /* Si el arquitecto aún no había confirmado contacto, marcarlo automáticamente */
      if (!checkData[0].cliente_contactado) {
        await fetch(
          `${SUPABASE_URL}/rest/v1/projects?project_number=eq.${encodeURIComponent(project_number)}&architect_email=eq.${encodeURIComponent(email)}`,
          {
            method: 'PATCH',
            headers: {
              'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`,
              'Content-Type': 'application/json', 'Prefer': 'return=minimal',
            },
            body: JSON.stringify({ cliente_contactado: true, cliente_contactado_at: new Date().toISOString() }),
          }
        );
      }

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
                    <p style="font-size:11px;color:#a0aec0;margin:0">APPARQ SpA · RUT 78.441.391-8 · hola@apparq.cl</p>
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

    /* ── MARK-CONTACTED ──────────────────────── */
    if (action === 'mark-contacted') {
      const { project_number } = rest;
      if (!project_number) return corsResponse({ error: 'Falta project_number' }, 400);

      /* Verificar que el proyecto pertenece al arquitecto */
      const checkRes = await fetch(
        `${SUPABASE_URL}/rest/v1/projects?project_number=eq.${project_number}&architect_email=eq.${encodeURIComponent(email)}&select=id,client_nombre,client_apellido,client_email,service_type,commune,cliente_contactado`,
        { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
      );
      const checkData = checkRes.ok ? await checkRes.json() : [];
      if (!checkData.length) return corsResponse({ error: 'Proyecto no encontrado' }, 404);
      const proj = checkData[0];
      if (proj.cliente_contactado) return corsResponse({ ok: true, already: true });

      /* Marcar contactado */
      await fetch(
        `${SUPABASE_URL}/rest/v1/projects?project_number=eq.${project_number}`,
        {
          method: 'PATCH',
          headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
          body: JSON.stringify({ cliente_contactado: true, cliente_contactado_at: new Date().toISOString() }),
        }
      );

      /* Email a hola@apparq.cl */
      const svcLabels = { regularizacion:'Regularización', ampliacion:'Ampliación', 'declaracion-jurada':'Declaración Jurada', 'obra-nueva':'Obra Nueva', informe:'Informe', 'ley-del-mono':'Ley del Mono' };
      const svcName   = svcLabels[proj.service_type] || proj.service_type;
      const fechaHora = new Date().toLocaleString('es-CL', { timeZone: 'America/Santiago', day:'2-digit', month:'long', year:'numeric', hour:'2-digit', minute:'2-digit' });
      try {
        await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            from: 'APPARQ <no-reply@apparq.cl>',
            to: ['hola@apparq.cl'],
            subject: `✅ Cliente contactado — ${project_number} · ${architect.nombre} ${architect.apellido}`,
            html: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto">
              <div style="background:#1a1a2e;padding:24px 32px;border-radius:8px 8px 0 0">
                <h2 style="color:#fff;margin:0;font-size:18px">APPARQ — Cliente contactado</h2>
              </div>
              <div style="background:#D1FAE5;border:2px solid #6EE7B7;padding:14px 32px">
                <p style="margin:0;font-size:14px;font-weight:700;color:#065F46">✅ El arquitecto confirmó que contactó al cliente</p>
              </div>
              <div style="background:#fff;padding:24px 32px;border:1px solid #e2e8f0;border-radius:0 0 8px 8px">
                <table style="width:100%;border-collapse:collapse;font-size:13px">
                  <tr style="background:#f7fafc"><td style="padding:8px 10px;color:#718096;width:40%">N° Trámite</td><td style="padding:8px 10px;font-weight:900;color:#E8503A">${project_number}</td></tr>
                  <tr><td style="padding:8px 10px;color:#718096">Servicio</td><td style="padding:8px 10px;font-weight:700">${svcName} · ${proj.commune}</td></tr>
                  <tr style="background:#f7fafc"><td style="padding:8px 10px;color:#718096">Cliente</td><td style="padding:8px 10px">${proj.client_nombre} ${proj.client_apellido} (${proj.client_email})</td></tr>
                  <tr><td style="padding:8px 10px;color:#718096">Arquitecto</td><td style="padding:8px 10px">${architect.nombre} ${architect.apellido} (${email})</td></tr>
                  <tr style="background:#f7fafc"><td style="padding:8px 10px;color:#718096">Confirmado el</td><td style="padding:8px 10px">${fechaHora}</td></tr>
                </table>
              </div>
            </div>`,
          }),
        });
      } catch(e) { console.warn('Error email mark-contacted:', e); }

      return corsResponse({ ok: true });
    }

    /* ── MARK-VISITA-TERRENO ────────────────── */
    if (action === 'mark-visita-terreno') {
      const { project_number } = rest;
      if (!project_number) return corsResponse({ error: 'Falta project_number' }, 400);

      /* Verificar que el proyecto pertenece al arquitecto */
      const checkRes = await fetch(
        `${SUPABASE_URL}/rest/v1/projects?project_number=eq.${project_number}&architect_email=eq.${encodeURIComponent(email)}&select=id,client_nombre,client_apellido,service_type,commune,visita_terreno`,
        { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
      );
      const checkData = checkRes.ok ? await checkRes.json() : [];
      if (!checkData.length) return corsResponse({ error: 'Proyecto no encontrado' }, 404);
      const proj = checkData[0];
      if (proj.visita_terreno) return corsResponse({ ok: true, already: true });

      /* Marcar visita a terreno */
      await fetch(
        `${SUPABASE_URL}/rest/v1/projects?project_number=eq.${project_number}`,
        {
          method: 'PATCH',
          headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
          body: JSON.stringify({ visita_terreno: true, visita_terreno_at: new Date().toISOString() }),
        }
      );

      /* Email a hola@apparq.cl */
      const svcLabelsVT = { regularizacion:'Regularización', ampliacion:'Ampliación', 'declaracion-jurada':'Declaración Jurada', 'obra-nueva':'Obra Nueva', informe:'Informe', 'ley-del-mono':'Ley del Mono' };
      const svcNameVT   = svcLabelsVT[proj.service_type] || proj.service_type;
      const fechaHoraVT = new Date().toLocaleString('es-CL', { timeZone: 'America/Santiago', day:'2-digit', month:'long', year:'numeric', hour:'2-digit', minute:'2-digit' });
      try {
        await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            from: 'APPARQ <no-reply@apparq.cl>',
            to: ['hola@apparq.cl'],
            subject: `🏠 Visita a terreno realizada — ${project_number} · ${architect.nombre} ${architect.apellido}`,
            html: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto">
              <div style="background:#1a1a2e;padding:24px 32px;border-radius:8px 8px 0 0">
                <h2 style="color:#fff;margin:0;font-size:18px">APPARQ — Visita a terreno realizada</h2>
              </div>
              <div style="background:#EDE9FE;border:2px solid #C4B5FD;padding:14px 32px">
                <p style="margin:0;font-size:14px;font-weight:700;color:#5B21B6">🏠 El arquitecto realizó la visita a terreno</p>
              </div>
              <div style="background:#fff;padding:24px 32px;border:1px solid #e2e8f0;border-radius:0 0 8px 8px">
                <table style="width:100%;border-collapse:collapse;font-size:13px">
                  <tr style="background:#f7fafc"><td style="padding:8px 10px;color:#718096;width:40%">N° Trámite</td><td style="padding:8px 10px;font-weight:900;color:#E8503A">${project_number}</td></tr>
                  <tr><td style="padding:8px 10px;color:#718096">Servicio</td><td style="padding:8px 10px;font-weight:700">${svcNameVT} · ${proj.commune}</td></tr>
                  <tr style="background:#f7fafc"><td style="padding:8px 10px;color:#718096">Cliente</td><td style="padding:8px 10px">${proj.client_nombre} ${proj.client_apellido}</td></tr>
                  <tr><td style="padding:8px 10px;color:#718096">Arquitecto</td><td style="padding:8px 10px">${architect.nombre} ${architect.apellido} (${email})</td></tr>
                  <tr style="background:#f7fafc"><td style="padding:8px 10px;color:#718096">Realizada el</td><td style="padding:8px 10px">${fechaHoraVT}</td></tr>
                </table>
              </div>
            </div>`,
          }),
        });
      } catch(e) { console.warn('Error email mark-visita-terreno:', e); }

      return corsResponse({ ok: true });
    }

    /* ── SUBMIT-DESCARTE ─────────────────────── */
    if (action === 'submit-descarte') {
      const { project_number, fecha_visita, requisitos, via_propuesta, observaciones } = rest;
      if (!project_number || !Array.isArray(requisitos) || !requisitos.length || !via_propuesta) {
        return corsResponse({ error: 'Faltan campos obligatorios del formulario de descarte' }, 400);
      }

      /* Detectar si es reporte de tipo incorrecto (no requiere fecha_visita obligatoria) */
      const esTipoIncorrecto = requisitos.some(r => r.tipo === 'tipo_incorrecto');

      if (!esTipoIncorrecto && !fecha_visita) {
        return corsResponse({ error: 'La fecha de visita a terreno es obligatoria' }, 400);
      }

      /* fecha_visita no puede ser futura */
      if (fecha_visita) {
        const today = new Date(); today.setHours(23, 59, 59, 999);
        if (new Date(fecha_visita) > today) {
          return corsResponse({ error: 'La fecha de visita no puede ser futura' }, 400);
        }
      }

      /* Verificar que el proyecto le pertenece */
      const checkRes = await fetch(
        `${SUPABASE_URL}/rest/v1/projects?project_number=eq.${encodeURIComponent(project_number)}&architect_email=eq.${encodeURIComponent(email)}&select=*&limit=1`,
        { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
      );
      const checkData = await checkRes.json();
      if (!checkData.length) {
        return corsResponse({ error: 'Proyecto no encontrado' }, 403);
      }
      const p = checkData[0];

      /* Verificar que no hay descarte pendiente o ya aprobado */
      if (p.descarte_estado === 'pendiente') {
        return corsResponse({ error: 'Ya hay un descarte pendiente de revisión para este trámite' }, 400);
      }
      if (p.descarte_estado === 'aprobado') {
        return corsResponse({ error: 'El descarte ya fue aprobado' }, 400);
      }

      /* PATCH projects con datos del descarte */
      const patchRes = await fetch(
        `${SUPABASE_URL}/rest/v1/projects?project_number=eq.${encodeURIComponent(project_number)}`,
        {
          method: 'PATCH',
          headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
          body: JSON.stringify({
            descarte_estado:        'pendiente',
            descarte_motivo:        JSON.stringify(requisitos),
            descarte_via_propuesta: via_propuesta,
            descarte_fecha_visita:  fecha_visita,
            updated_at:             new Date().toISOString(),
          }),
        }
      );
      if (!patchRes.ok) {
        return corsResponse({ error: 'Error al registrar el descarte' }, 500);
      }

      /* Construir descripción de requisitos para el email */
      const REQUISITO_LABELS = {
        sup_excede:         'Superficie real excede límite normativo',
        avaluo_excede:      'Avalúo fiscal excede límite en UF',
        fecha_construccion: 'Fecha de construcción fuera del período regularizable',
        permisos_previos:   'Problemas con permisos previos',
        otro_motivo:        'Otro motivo',
        tipo_incorrecto:    'Tipo de trámite contratado incorrecto',
      };
      const svcLabels2 = { 'ley-del-mono':'Ley del Mono', regularizacion:'Regularización', ampliacion:'Ampliación', 'obra-nueva':'Obra Nueva', informe:'Informe de Propiedad', 'declaracion-jurada':'Declaración Jurada' };
      const viaLabels  = { 'ley-del-mono':'Ley del Mono', regularizacion:'Regularización', ampliacion:'Ampliación', 'obra-nueva':'Obra Nueva', informe:'Informe de Propiedad', no_regularizable:'No regularizable' };
      const svcName2   = svcLabels2[p.service_type] || p.service_type;
      const viaOriginal = svcName2;
      const viaPropuesta = viaLabels[via_propuesta] || via_propuesta;
      const fecha2 = new Date().toLocaleDateString('es-CL', { day:'2-digit', month:'long', year:'numeric' });

      const reqRows = requisitos.map(r => {
        const label = REQUISITO_LABELS[r.tipo] || r.tipo;
        let detalle = r.valor ? r.valor : (r.descripcion ? r.descripcion : '');
        if (r.tipo === 'tipo_incorrecto' && r.tipo_correcto) detalle = `Tipo correcto propuesto: ${svcLabels2[r.tipo_correcto] || r.tipo_correcto}. ${detalle}`;
        return `<tr><td style="padding:6px 10px;color:#718096;width:35%">${label}</td><td style="padding:6px 10px">${detalle || 'Ver adjuntos'}</td></tr>`;
      }).join('');

      const emailSubject = esTipoIncorrecto
        ? `🔄 Tipo de trámite incorrecto — ${project_number}`
        : `⚠️ Descarte pendiente revisión — ${project_number}`;
      const emailBanner = esTipoIncorrecto
        ? `<div style="background:#FFF7ED;border:2px solid #FED7AA;padding:14px 32px"><p style="margin:0;font-size:13px;font-weight:700;color:#92400E">🔄 Un arquitecto indica que el tipo de trámite contratado no corresponde. Requiere gestión de cambio de tipo.</p></div>`
        : `<div style="background:#FEF3C7;border:2px solid #FCD34D;padding:14px 32px"><p style="margin:0;font-size:13px;font-weight:700;color:#92400E">⚠️ Un arquitecto declaró no viabilidad. Requiere revisión antes de notificar al cliente.</p></div>`;
      const emailTitle = esTipoIncorrecto ? 'APPARQ — Tipo de Trámite Incorrecto' : 'APPARQ — Protocolo de Descarte';

      await sendEmail({
        to: 'hola@apparq.cl',
        subject: emailSubject,
        html: `
          <div style="font-family:Arial,sans-serif;max-width:620px;margin:0 auto;color:#1a1a2e">
            <div style="background:#1a1a2e;padding:24px 32px;border-radius:8px 8px 0 0">
              <h1 style="color:#fff;margin:0;font-size:18px">${emailTitle}</h1>
            </div>
            ${emailBanner}
            <div style="background:#fff;padding:28px 32px;border:1px solid #e2e8f0;border-radius:0 0 8px 8px">
              <table style="width:100%;border-collapse:collapse;font-size:13px;margin-bottom:20px">
                <tr style="background:#f7fafc"><td style="padding:8px 10px;color:#718096;width:35%">N° Trámite</td><td style="padding:8px 10px;font-weight:700;color:#E8503A">${project_number}</td></tr>
                <tr><td style="padding:8px 10px;color:#718096">Arquitecto</td><td style="padding:8px 10px">${p.architect_nombre} ${p.architect_apellido} · ${p.architect_email}</td></tr>
                <tr style="background:#f7fafc"><td style="padding:8px 10px;color:#718096">Cliente</td><td style="padding:8px 10px">${p.client_nombre} ${p.client_apellido} · ${p.client_email}</td></tr>
                <tr><td style="padding:8px 10px;color:#718096">Dirección</td><td style="padding:8px 10px">${p.address || '—'}, ${p.commune}</td></tr>
                <tr style="background:#f7fafc"><td style="padding:8px 10px;color:#718096">Tipo contratado</td><td style="padding:8px 10px">${viaOriginal}</td></tr>
                <tr><td style="padding:8px 10px;color:#718096">${esTipoIncorrecto ? 'Tipo correcto propuesto' : 'Vía propuesta'}</td><td style="padding:8px 10px;font-weight:700;color:#7C3AED">${viaPropuesta}</td></tr>
                ${!esTipoIncorrecto && fecha_visita ? `<tr style="background:#f7fafc"><td style="padding:8px 10px;color:#718096">Fecha visita</td><td style="padding:8px 10px">${fecha_visita}</td></tr>` : ''}
                <tr${!esTipoIncorrecto && fecha_visita ? '' : ' style="background:#f7fafc"'}><td style="padding:8px 10px;color:#718096">Fecha declaración</td><td style="padding:8px 10px">${fecha2}</td></tr>
              </table>
              <h3 style="font-size:13px;color:#1a1a2e;margin-bottom:8px">${esTipoIncorrecto ? 'Motivo declarado' : 'Requisitos incumplidos declarados'}</h3>
              <table style="width:100%;border-collapse:collapse;font-size:13px;border:1px solid #e2e8f0;border-radius:6px;overflow:hidden">
                ${reqRows}
              </table>
              ${observaciones ? `<div style="background:#F0F9FF;border:1.5px solid #BAE6FD;border-radius:8px;padding:14px 18px;margin-top:16px"><p style="margin:0 0 4px;font-size:12px;color:#0369A1;font-weight:700">OBSERVACIONES DEL ARQUITECTO</p><p style="margin:0;font-size:13px;color:#0C4A6E;line-height:1.6">${observaciones}</p></div>` : ''}
              <div style="background:${esTipoIncorrecto ? '#FFF7ED' : '#FEF2F2'};border:1.5px solid ${esTipoIncorrecto ? '#FED7AA' : '#FECACA'};border-radius:8px;padding:14px 18px;margin-top:20px">
                <p style="margin:0;font-size:13px;font-weight:700;color:${esTipoIncorrecto ? '#92400E' : '#991B1B'}">${esTipoIncorrecto ? 'El cliente NO ha sido notificado. Gestiona el cambio de tipo desde el Admin (botón "🔄 Cambiar tipo").' : 'El cliente NO ha sido notificado. Debes aprobar o rechazar antes de que el arquitecto pueda comunicar cualquier cambio.'}</p>
              </div>
              <div style="text-align:center;margin-top:20px">
                <a href="https://apparq.cl/admin" style="display:inline-block;background:#E8503A;color:#fff;text-decoration:none;font-weight:700;font-size:14px;padding:10px 28px;border-radius:6px">Revisar en el Admin</a>
              </div>
            </div>
          </div>`,
      }, RESEND_API_KEY);

      return corsResponse({ ok: true });
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

      /* Verificar que el descarte fue aprobado por APPARQ */
      if (p.descarte_estado !== 'aprobado') {
        return corsResponse({ error: 'Debes completar el Protocolo de Descarte y obtener aprobación de APPARQ antes de declarar el trámite no viable.' }, 403);
      }

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
                <p style="font-size:11px;color:#a0aec0;margin:0">APPARQ SpA · RUT 78.441.391-8 · hola@apparq.cl</p>
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
                  <p style="font-size:11px;color:#a0aec0;margin:0">APPARQ SpA · RUT 78.441.391-8 · hola@apparq.cl</p>
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
                  <p style="font-size:11px;color:#a0aec0;margin:0">APPARQ SpA · RUT 78.441.391-8 · hola@apparq.cl</p>
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

    /* ── MARK-PAYMENT ────────────────────────── */
    if (action === 'mark-payment') {
      const { project_number, etapa } = rest;
      if (!project_number || !etapa) return corsResponse({ error: 'Faltan datos' }, 400);
      const validEtapas = ['e1', 'e2', 'e3', 'e4'];
      if (!validEtapas.includes(etapa)) return corsResponse({ error: 'Etapa inválida' }, 400);

      /* Verificar que el proyecto pertenece al arquitecto */
      const checkRes = await fetch(
        `${SUPABASE_URL}/rest/v1/projects?project_number=eq.${encodeURIComponent(project_number)}&architect_email=eq.${encodeURIComponent(email)}&select=id&limit=1`,
        { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
      );
      const checkData = checkRes.ok ? await checkRes.json() : [];
      if (!checkData.length) return corsResponse({ error: 'Proyecto no encontrado' }, 403);

      const field   = `arq_pago_${etapa}`;
      const fieldAt = `arq_pago_${etapa}_at`;
      const patchRes = await fetch(
        `${SUPABASE_URL}/rest/v1/projects?project_number=eq.${encodeURIComponent(project_number)}&architect_email=eq.${encodeURIComponent(email)}`,
        {
          method: 'PATCH',
          headers: {
            'apikey':        SUPABASE_KEY,
            'Authorization': `Bearer ${SUPABASE_KEY}`,
            'Content-Type':  'application/json',
            'Prefer':        'return=minimal',
          },
          body: JSON.stringify({ [field]: true, [fieldAt]: new Date().toISOString() }),
        }
      );
      if (!patchRes.ok) return corsResponse({ error: 'Error al marcar pago' }, 500);
      return corsResponse({ ok: true });
    }

    /* ── REQUEST-PAYMENT ─────────────────────── */
    if (action === 'request-payment') {
      const { project_number, etapa } = rest;
      if (!project_number || !etapa || !['e2','e3','e4'].includes(etapa)) {
        return corsResponse({ error: 'Faltan datos o etapa inválida' }, 400);
      }

      /* 1. Verificar que el proyecto pertenece al arquitecto */
      const checkRes = await fetch(
        `${SUPABASE_URL}/rest/v1/projects?project_number=eq.${encodeURIComponent(project_number)}&architect_email=eq.${encodeURIComponent(email)}&select=*&limit=1`,
        { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
      );
      const checkData = checkRes.ok ? await checkRes.json() : [];
      if (!checkData.length) {
        return corsResponse({ error: 'Proyecto no encontrado' }, 403);
      }
      const p = checkData[0];

      /* 2. Calcular monto del cliente */
      const is2stages = p.service_type === 'informe' || p.service_type === 'declaracion-jurada';
      const clp = p.total_clp || 0;
      let monto;
      if (is2stages) {
        monto = Math.round(clp * 0.50);
      } else {
        const pcts = { e2: 0.30, e3: 0.20, e4: 0.30 };
        monto = Math.round(clp * pcts[etapa]);
      }

      /* 3. Verificar que esa etapa no fue ya solicitada en las últimas 2h */
      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
      const dupRes = await fetch(
        `${SUPABASE_URL}/rest/v1/project_updates?project_number=eq.${encodeURIComponent(project_number)}&stage=eq.solicitud_pago_${etapa}&created_at=gte.${twoHoursAgo}&select=id&limit=1`,
        { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
      );
      const dupData = dupRes.ok ? await dupRes.json() : [];
      if (dupData.length) {
        return corsResponse({ ok: true, already_sent: true, link: null });
      }

      /* 4. Llamar /api/create-payment internamente */
      const svcLabels = { regularizacion:'Regularización', ampliacion:'Ampliación', 'obra-nueva':'Obra Nueva', informe:'Informe de Propiedad', 'ley-del-mono':'Ley del Mono', 'declaracion-jurada':'Declaración Jurada' };
      const svcName = svcLabels[p.service_type] || p.service_type;
      const clpFmt = n => '$ ' + Math.round(n).toLocaleString('es-CL');

      const cpRes = await fetch('https://apparq.cl/api/create-payment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          amount:      monto,
          description: `APPARQ · ${project_number} · Pago ${etapa.toUpperCase()} · ${svcName}`,
          email:       p.client_email,
          reference:   `${project_number}-${etapa.toUpperCase()}`,
        }),
      });
      if (!cpRes.ok) {
        const errTxt = await cpRes.text();
        console.error('Error create-payment:', errTxt);
        return corsResponse({ error: 'Error al generar link de pago' }, 500);
      }
      const cpData = await cpRes.json();
      const init_point = cpData.init_point;
      if (!init_point) {
        return corsResponse({ error: 'No se obtuvo link de pago' }, 500);
      }

      /* 5. Insertar en project_updates */
      await fetch(`${SUPABASE_URL}/rest/v1/project_updates`, {
        method: 'POST',
        headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
        body: JSON.stringify({
          project_number: project_number,
          author:         'architect',
          stage:          `solicitud_pago_${etapa}`,
          stage_label:    `Solicitud pago ${etapa.toUpperCase()} enviada`,
          nota:           `Solicitud de pago ${etapa.toUpperCase()} enviada al cliente. Monto: ${clpFmt(monto)}`,
        }),
      });

      /* 6. Email al cliente con el link de pago */
      if (p.client_email) {
        await sendEmail({
          to: p.client_email,
          subject: `💳 Pago ${etapa.toUpperCase()} de tu trámite ${project_number} — APPARQ`,
          html: `
            <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#1a1a2e">
              <div style="background:#1a1a2e;padding:28px 32px;text-align:center;border-radius:8px 8px 0 0">
                <h1 style="color:#fff;margin:0;font-size:22px">APPARQ</h1>
                <p style="color:#a0aec0;margin:6px 0 0;font-size:13px">Pago de etapa de tu trámite</p>
              </div>
              <div style="background:#fff;padding:28px 32px;border:1px solid #e2e8f0;border-radius:0 0 8px 8px">
                <h2 style="margin-top:0;color:#1a1a2e;">Hola ${p.client_nombre}, hay un nuevo pago pendiente</h2>
                <p style="color:#4a5568;font-size:14px;line-height:1.7;">Tu arquitecto <strong>${p.architect_nombre} ${p.architect_apellido}</strong> ha completado la etapa <strong>${etapa.toUpperCase()}</strong> de tu trámite. Para continuar, realiza el siguiente pago:</p>
                <div style="background:#FFF7ED;border:2px solid #E8503A;border-radius:8px;padding:16px 20px;margin:20px 0;text-align:center;">
                  <p style="margin:0 0 4px;font-size:12px;color:#92400E;font-weight:700;">MONTO A PAGAR — ${etapa.toUpperCase()}</p>
                  <p style="margin:0;font-size:30px;font-weight:900;color:#E8503A;">${clpFmt(monto)}</p>
                  <p style="margin:6px 0 0;font-size:11px;color:#78350F;">${svcName} · ${project_number}</p>
                </div>
                <div style="text-align:center;margin:24px 0;">
                  <a href="${init_point}" style="display:inline-block;background:#E8503A;color:#fff;text-decoration:none;font-weight:700;font-size:15px;padding:14px 36px;border-radius:8px;letter-spacing:0.5px;">PAGAR AHORA →</a>
                </div>
                <table style="width:100%;border-collapse:collapse;font-size:13px;margin-top:12px">
                  <tr style="background:#f7fafc"><td style="padding:8px 10px;color:#718096;width:40%">N° Trámite</td><td style="padding:8px 10px;font-weight:700;color:#E8503A">${project_number}</td></tr>
                  <tr><td style="padding:8px 10px;color:#718096">Etapa</td><td style="padding:8px 10px;font-weight:700">${etapa.toUpperCase()} · ${svcName}</td></tr>
                  <tr style="background:#f7fafc"><td style="padding:8px 10px;color:#718096">Dirección</td><td style="padding:8px 10px">${p.address || '—'}, ${p.commune}</td></tr>
                  <tr><td style="padding:8px 10px;color:#718096">Arquitecto</td><td style="padding:8px 10px">${p.architect_nombre} ${p.architect_apellido}</td></tr>
                </table>
                <div style="background:#EEF2FF;border:1.5px solid #C7D2FE;border-radius:8px;padding:14px 18px;margin-top:20px">
                  <p style="margin:0;font-size:12px;color:#3730A3;font-weight:700;">💡 Puedes pagar en cuotas con Mercado Pago</p>
                  <p style="margin:4px 0 0;font-size:12px;color:#4338CA;line-height:1.5;">Selecciona la opción de cuotas con tu tarjeta de crédito directamente en Mercado Pago.</p>
                </div>
                <hr style="border:none;border-top:1px solid #e2e8f0;margin:24px 0 14px">
                <p style="font-size:11px;color:#a0aec0;margin:0">APPARQ SpA · RUT 78.441.391-8 · hola@apparq.cl · Todos los pagos deben realizarse exclusivamente a través de apparq.cl</p>
              </div>
            </div>`,
        }, RESEND_API_KEY);
      }

      /* 7. Email interno a hola@apparq.cl */
      await sendEmail({
        to: 'hola@apparq.cl',
        subject: `💳 Arquitecto solicitó pago ${etapa.toUpperCase()} — ${project_number}`,
        html: `
          <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#1a1a2e">
            <div style="background:#1a1a2e;padding:24px 32px;border-radius:8px 8px 0 0">
              <h1 style="color:#fff;margin:0;font-size:18px">APPARQ — Solicitud de pago de etapa</h1>
            </div>
            <div style="background:#fff;padding:28px 32px;border:1px solid #e2e8f0;border-radius:0 0 8px 8px">
              <table style="width:100%;border-collapse:collapse;font-size:13px">
                <tr style="background:#f7fafc"><td style="padding:8px 10px;color:#718096;width:40%">N° Trámite</td><td style="padding:8px 10px;font-weight:700;color:#E8503A">${project_number}</td></tr>
                <tr><td style="padding:8px 10px;color:#718096">Etapa</td><td style="padding:8px 10px;font-weight:700">${etapa.toUpperCase()}</td></tr>
                <tr style="background:#f7fafc"><td style="padding:8px 10px;color:#718096">Monto cliente</td><td style="padding:8px 10px;font-weight:700;color:#E8503A">${clpFmt(monto)}</td></tr>
                <tr><td style="padding:8px 10px;color:#718096">Cliente</td><td style="padding:8px 10px">${p.client_nombre} ${p.client_apellido} · ${p.client_email}</td></tr>
                <tr style="background:#f7fafc"><td style="padding:8px 10px;color:#718096">Arquitecto</td><td style="padding:8px 10px">${p.architect_nombre} ${p.architect_apellido} · ${email}</td></tr>
                <tr><td style="padding:8px 10px;color:#718096">Link de pago</td><td style="padding:8px 10px;word-break:break-all;font-size:11px"><a href="${init_point}" style="color:#E8503A">${init_point}</a></td></tr>
              </table>
            </div>
          </div>`,
      }, RESEND_API_KEY);

      /* 8. Retornar */
      return corsResponse({ ok: true, link: init_point, monto });
    }

    return corsResponse({ error: 'Acción no reconocida' }, 400);

  } catch (err) {
    console.error('portal-architect error:', err);
    return corsResponse({ error: 'Error interno' }, 500);
  }
}

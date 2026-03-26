/* ══════════════════════════════════════════════════
   APPARQ — Netlify Function: portal-architect
   Portal del arquitecto: ver y gestionar sus proyectos
   Requiere token de autenticación (Supabase Auth)
   POST /.netlify/functions/portal-architect
   Body: { action, token, ... }
   Actions: 'get-projects' | 'update-stage' | 'send-message' | 'get-messages'
══════════════════════════════════════════════════ */

const SUPABASE_URL   = process.env.SUPABASE_URL;
const SUPABASE_KEY   = process.env.SUPABASE_ANON_KEY;
const RESEND_API_KEY = process.env.RESEND_API_KEY;

async function sendEmail({ to, subject, html }) {
  if (!RESEND_API_KEY) return;
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: 'APPARQ <hola@apparq.cl>', to, subject, html }),
  });
  if (!res.ok) console.error('Resend error:', await res.text());
}

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
};

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
async function verifyToken(token) {
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


exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Método no permitido' }) };
  }

  try {
    const { action, token, ...rest } = JSON.parse(event.body || '{}');

    if (!token) {
      return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'No autenticado' }) };
    }

    const email = await verifyToken(token);
    if (!email) {
      return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Sesión expirada. Vuelve a ingresar.' }) };
    }

    /* Verificar que el email existe en architects */
    const arqRes = await fetch(
      `${SUPABASE_URL}/rest/v1/architects?email=eq.${encodeURIComponent(email)}&select=id,nombre,apellido,foto_url&limit=1`,
      { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
    );
    const arqData = await arqRes.json();
    if (!arqData.length) {
      return { statusCode: 403, headers: CORS, body: JSON.stringify({ error: 'No tienes acceso de arquitecto.' }) };
    }
    const architect = arqData[0];

    /* ── GET-PROJECTS ─────────────────────────── */
    if (action === 'get-projects') {
      const projRes = await fetch(
        `${SUPABASE_URL}/rest/v1/projects?architect_email=eq.${encodeURIComponent(email)}&order=created_at.desc`,
        { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
      );
      const projects = projRes.ok ? await projRes.json() : [];

      /* Contar mensajes no leídos por proyecto */
      const enriched = await Promise.all(projects.map(async (p) => {
        const msgRes = await fetch(
          `${SUPABASE_URL}/rest/v1/messages?project_number=eq.${encodeURIComponent(p.project_number)}&sender_role=eq.client&read_by_architect=eq.false&select=id`,
          { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
        );
        const unread = msgRes.ok ? (await msgRes.json()).length : 0;
        return { ...p, stage_label: STAGE_LABELS[p.stage] || p.stage, unread_messages: unread };
      }));

      return {
        statusCode: 200,
        headers: CORS,
        body: JSON.stringify({ projects: enriched, architect }),
      };
    }

    /* ── UPDATE-STAGE ─────────────────────────── */
    if (action === 'update-stage') {
      const { project_number, new_stage, nota } = rest;
      if (!project_number || !new_stage) {
        return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Faltan datos' }) };
      }

      /* Verificar que el proyecto le pertenece */
      const checkRes = await fetch(
        `${SUPABASE_URL}/rest/v1/projects?project_number=eq.${encodeURIComponent(project_number)}&architect_email=eq.${encodeURIComponent(email)}&select=id,service_type&limit=1`,
        { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
      );
      const checkData = await checkRes.json();
      if (!checkData.length) {
        return { statusCode: 403, headers: CORS, body: JSON.stringify({ error: 'Proyecto no encontrado' }) };
      }

      /* Validar que la etapa es válida para el tipo de servicio */
      const svc      = checkData[0].service_type;
      const validStages = svc === 'informe' ? STAGES_INFORME : STAGES_NORMAL;
      if (!validStages.includes(new_stage)) {
        return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Etapa inválida para este tipo de trámite' }) };
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
        return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Error al actualizar etapa' }) };
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
                    <p style="font-size:11px;color:#a0aec0;margin:0">APPARQ · DSR ARQ SPA · hola@apparq.cl</p>
                  </div>
                </div>`,
            });
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
          });
        }
      } catch (emailErr) {
        console.warn('Error enviando email de avance:', emailErr);
      }

      return {
        statusCode: 200,
        headers: CORS,
        body: JSON.stringify({ ok: true, stage_label: STAGE_LABELS[new_stage] }),
      };
    }

    /* ── DECLARE-INVIABLE ─────────────────────── */
    if (action === 'declare-inviable') {
      const { project_number, informe } = rest;
      if (!project_number || !informe?.trim()) {
        return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Debes ingresar el informe técnico de inviabilidad' }) };
      }

      /* Verificar que el proyecto pertenece al arquitecto */
      const checkRes = await fetch(
        `${SUPABASE_URL}/rest/v1/projects?project_number=eq.${encodeURIComponent(project_number)}&architect_email=eq.${encodeURIComponent(email)}&select=*&limit=1`,
        { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
      );
      const checkData = await checkRes.json();
      if (!checkData.length) {
        return { statusCode: 403, headers: CORS, body: JSON.stringify({ error: 'Proyecto no encontrado' }) };
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
        });
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
      });

      return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true }) };
    }

    /* ── UPDATE-PHOTO ─────────────────────────── */
    if (action === 'update-photo') {
      const { foto_url } = rest;
      if (!foto_url) {
        return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Falta foto_url' }) };
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
        return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Error al guardar foto' }) };
      }
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true }) };
    }

    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Acción no reconocida' }) };

  } catch (err) {
    console.error('portal-architect error:', err);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Error interno' }) };
  }
};

/* ══════════════════════════════════════════════════
   APPARQ — Cloudflare Pages Function: confirm-tramite
   Recibe los datos del trámite confirmado (pago + arquitecto)
   y envía emails a cliente y a hola@apparq.cl
   POST /api/confirm-tramite
══════════════════════════════════════════════════ */

const CORS = {
  'Access-Control-Allow-Origin': 'https://apparq.cl',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

function corsResponse(body, status = 200) {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: CORS });
}

async function sendEmail({ to, subject, html }, RESEND_API_KEY) {
  if (!RESEND_API_KEY) { console.warn('Sin RESEND_API_KEY'); return; }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${RESEND_API_KEY}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify({ from: 'APPARQ <hola@apparq.cl>', to, subject, html }),
  });
  if (!res.ok) console.error('Resend error:', await res.text());
  else         console.log('Email enviado a:', to);
}

function clpFmt(n) {
  return '$' + Math.round(n).toLocaleString('es-CL');
}

/* ══════════════════════════════════════════════════
   AUTO-ASIGNACIÓN DE ARQUITECTO
   Busca el arquitecto activo que opere en la comuna
   y realice el tipo de trámite, con menor carga actual.
══════════════════════════════════════════════════ */
async function autoAssignArchitect(SUPABASE_URL, SERVICE_KEY, commune, svc) {
  const SVC_LABEL_MAP = {
    'ley-del-mono':       'Ley del Mono',
    regularizacion:       'Regularización',
    ampliacion:           'Ampliación',
    'declaracion-jurada': 'Declaración Jurada',  /* Ley 21.718 — reemplaza amp-ley21718 */
    'obra-nueva':         'Obra Nueva',
    informe:              'Informe',
  };
  const svcLabel = SVC_LABEL_MAP[svc] || svc;

  try {
    /* 1 — Obtener todos los arquitectos activos */
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/architects?activo=eq.true&select=id,nombre,apellido,email,tramites,comunas,foto_url,calificacion,habilitado_declaracion_jurada,patente`,
      { headers: { 'apikey': SERVICE_KEY, 'Authorization': `Bearer ${SERVICE_KEY}` } }
    );
    if (!res.ok) { console.error('Error obteniendo arquitectos:', await res.text()); return null; }
    const all = await res.json();

    /* 2 — Filtrar por comuna y tipo de trámite
       Para Declaración Jurada: además se requiere habilitado_declaracion_jurada = true */
    const isDJ = svc === 'declaracion-jurada';
    const matching = all.filter(a => {
      const comunas  = Array.isArray(a.comunas)  ? a.comunas  : [];
      const tramites = Array.isArray(a.tramites)  ? a.tramites : [];
      const habDJ    = a.habilitado_declaracion_jurada === true;
      return comunas.includes(commune)
          && tramites.includes(svcLabel)
          && (!isDJ || habDJ);
    });
    if (!matching.length) {
      console.warn(`Sin arquitecto disponible para ${commune} / ${svcLabel}`);
      return null;
    }

    /* 3 — Contar proyectos activos por cada arquitecto candidato */
    const withLoad = await Promise.all(matching.map(async a => {
      const pr = await fetch(
        `${SUPABASE_URL}/rest/v1/projects?architect_email=eq.${encodeURIComponent(a.email)}&stage=neq.completado&select=id`,
        { headers: { 'apikey': SERVICE_KEY, 'Authorization': `Bearer ${SERVICE_KEY}`, 'Prefer': 'count=exact' } }
      );
      const count = parseInt(pr.headers.get('content-range')?.split('/')[1] || '0', 10);
      return { ...a, activeProjects: count };
    }));

    /* 4 — Asignar al de menor carga */
    withLoad.sort((a, b) => a.activeProjects - b.activeProjects);
    const assigned = withLoad[0];
    console.log(`Auto-asignado: ${assigned.nombre} ${assigned.apellido} (${assigned.activeProjects} proyectos activos)`);
    return assigned;

  } catch (e) {
    console.error('Error en autoAssignArchitect:', e);
    return null;
  }
}

export async function onRequest(context) {
  const { request, env } = context;
  const RESEND_API_KEY = env.RESEND_API_KEY || 're_RRVTgGik_GtaRwK2p9jimrkemYTY4Uew6';
  const SUPABASE_URL   = env.SUPABASE_URL || 'https://ibdafnzlsufsshczqvoa.supabase.co';
  const SERVICE_KEY    = env.SUPABASE_SERVICE_KEY || env.SUPABASE_SVC;
  const SUPABASE_KEY   = SERVICE_KEY || env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImliZGFmbnpsc3Vmc3NoY3pxdm9hIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM5Njg0NjYsImV4cCI6MjA4OTU0NDQ2Nn0.ucEjCcnSbaz-OeMrLbUbgcKacvg9J2Csg2VzrWVtVHA';

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }
  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  try {
    const body = await request.json();
    const {
      nombre, apellido, email, telefono, rut, direccion,
      svc, servicio_subtipo, m2, commune, clp, e1,
      firma_data,   /* base64 PNG de la firma del cliente */
      payment_id,   /* ID de pago de Mercado Pago */
    } = body;

    /* ── Idempotencia: si el webhook ya procesó el proyecto, devolver datos existentes ── */
    if (email && SUPABASE_URL && SUPABASE_KEY) {
      try {
        const emailLower = email.trim().toLowerCase();
        /* Buscar proyecto activo (no pendiente_pago) para este email */
        const existRes = await fetch(
          `${SUPABASE_URL}/rest/v1/projects?client_email=eq.${encodeURIComponent(emailLower)}&stage=neq.pendiente_pago&select=id,project_number,stage&order=created_at.desc&limit=1`,
          { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
        );
        if (existRes.ok) {
          const existing = await existRes.json();
          if (existing.length > 0 && existing[0].stage !== 'pendiente_pago') {
            console.log('Proyecto ya procesado por webhook, devolviendo:', existing[0].project_number);
            return corsResponse({ ok: true, project_number: existing[0].project_number, already_processed: true });
          }
        }
      } catch (idempErr) {
        console.warn('Error en check idempotencia confirm-tramite:', idempErr);
      }
    }

    /* ── Auto-asignación de arquitecto (desactivada — asignación manual hasta nuevo aviso) ── */
    const AUTO_ASSIGN_ENABLED = false;
    let arquitecto = body.arquitecto || null;
    if (AUTO_ASSIGN_ENABLED && !arquitecto && SERVICE_KEY && commune && svc) {
      arquitecto = await autoAssignArchitect(SUPABASE_URL, SERVICE_KEY, commune, svc);
    }
    console.log('Arquitecto asignado:', arquitecto ? `${arquitecto.nombre} ${arquitecto.apellido}` : 'Sin asignar');

    /* ── Crear proyecto en Supabase ─────────────── */
    let projectNumber = null;
    if (SUPABASE_URL && SUPABASE_KEY && email) {
      try {
        /* Generar número secuencial: tomar el máximo existente + 1, mínimo 100 */
        const maxRes = await fetch(
          `${SUPABASE_URL}/rest/v1/projects?select=project_number&order=project_number.desc&limit=1`,
          { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
        );
        const maxData = await maxRes.json();
        let nextSeq = 100;
        if (Array.isArray(maxData) && maxData.length > 0 && maxData[0].project_number) {
          const match = maxData[0].project_number.match(/(\d+)$/);
          if (match) nextSeq = Math.max(parseInt(match[1], 10) + 1, 100);
        }
        projectNumber = `ARQ-${new Date().getFullYear()}-${String(nextSeq).padStart(6, '0')}`;

        const architect_email = arquitecto ? (arquitecto.email || null) : null;

        await fetch(`${SUPABASE_URL}/rest/v1/projects`, {
          method: 'POST',
          headers: {
            'apikey':        SUPABASE_KEY,
            'Authorization': `Bearer ${SUPABASE_KEY}`,
            'Content-Type':  'application/json',
            'Prefer':        'return=minimal',
          },
          body: JSON.stringify({
            project_number:     projectNumber,
            client_email:       email.trim().toLowerCase(),
            client_nombre:      nombre   || '',
            client_apellido:    apellido || '',
            client_telefono:    telefono || '',
            client_rut:         rut      || '',
            architect_email:    architect_email,
            architect_nombre:   arquitecto?.nombre   || '',
            architect_apellido: arquitecto?.apellido || '',
            service_type:       svc      || '',
            /* Declaración Jurada: sub-tipo (piscina_privada, pergola_sombreadero, demolicion) */
            servicio_subtipo:   servicio_subtipo || null,
            /* num_etapas_pago: 2 para DJ e Informe, 4 para el resto */
            num_etapas_pago:    (svc === 'declaracion-jurada' || svc === 'informe') ? 2 : 4,
            address:            direccion || '',
            commune:            commune   || '',
            m2:                 m2        || 0,
            total_clp:          clp       || 0,
            e1_clp:             e1        || 0,
            stage:              arquitecto ? 'levantamiento' : 'en_espera',
          }),
        });
      } catch (projErr) {
        console.warn('Error creando proyecto:', projErr);
      }
    }

    const fecha     = new Date().toLocaleDateString('es-CL', { day: '2-digit', month: 'long', year: 'numeric' });
    const svcLabels = { regularizacion:'Regularización', ampliacion:'Ampliación', 'declaracion-jurada':'Declaración Jurada', 'obra-nueva':'Obra Nueva', informe:'Informe de Propiedad', 'ley-del-mono':'Ley del Mono' };
    const svcName   = svcLabels[svc] || svc || 'Trámite';
    const nombreCliente = `${nombre || ''} ${apellido || ''}`.trim();
    const arqNombre = arquitecto ? `${arquitecto.nombre} ${arquitecto.apellido}` : 'Por asignar';

    /* ── Subir firma a Supabase Storage y obtener URL real ── */
    let firmaUrl = null;
    if (firma_data && SERVICE_KEY && projectNumber) {
      try {
        // Convertir data URI base64 a binario
        const base64 = firma_data.replace(/^data:image\/png;base64,/, '');
        const binaryStr = atob(base64);
        const bytes = new Uint8Array(binaryStr.length);
        for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);

        const path = `${projectNumber}/firma/firma-cliente.png`;

        // Subir al bucket tramite-files
        const upRes = await fetch(
          `${SUPABASE_URL}/storage/v1/object/tramite-files/${path}`,
          {
            method: 'POST',
            headers: {
              'apikey':        SERVICE_KEY,
              'Authorization': `Bearer ${SERVICE_KEY}`,
              'Content-Type':  'image/png',
              'x-upsert':      'true',
            },
            body: bytes,
          }
        );

        if (upRes.ok) {
          // Crear URL firmada válida por 10 años
          const signRes = await fetch(
            `${SUPABASE_URL}/storage/v1/object/sign/tramite-files/${path}`,
            {
              method: 'POST',
              headers: {
                'apikey':        SERVICE_KEY,
                'Authorization': `Bearer ${SERVICE_KEY}`,
                'Content-Type':  'application/json',
              },
              body: JSON.stringify({ expiresIn: 315360000 }), // 10 años
            }
          );
          if (signRes.ok) {
            const signData = await signRes.json();
            if (signData.signedURL) firmaUrl = `${SUPABASE_URL}/storage/v1${signData.signedURL}`;
          }
        }
        if (firmaUrl) console.log('Firma subida a Storage:', firmaUrl);
        else console.warn('No se pudo subir la firma a Storage');
      } catch (firmaErr) {
        console.warn('Error subiendo firma:', firmaErr);
      }
    }

    /* ── Bloque de firma del cliente (usa URL https://, no base64) ── */
    const firmaClienteBlock = firmaUrl
      ? `<div style="margin-top:12px;padding:12px 16px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;">
           <p style="margin:0 0 8px;font-size:11px;color:#718096;font-weight:700;text-transform:uppercase;">Firma digital del cliente</p>
           <img src="${firmaUrl}" style="max-width:100%;height:auto;border:1px solid #cbd5e0;border-radius:4px;" alt="Firma cliente" />
         </div>`
      : '';

    /* ── Bloque arquitecto para email cliente ── */
    const arqFotoBlock = arquitecto?.foto_url
      ? `<img src="${arquitecto.foto_url}" style="width:64px;height:64px;border-radius:50%;object-fit:cover;margin-right:14px;border:2px solid #e2e8f0;" alt="${arqNombre}" />`
      : `<div style="width:64px;height:64px;border-radius:50%;background:#1a1a2e;display:flex;align-items:center;justify-content:center;margin-right:14px;font-size:28px;flex-shrink:0;">👷</div>`;
    const arqStarsBlock = arquitecto?.calificacion
      ? `<div style="font-size:13px;color:#D97706;margin-top:3px;">${'★'.repeat(Math.round(arquitecto.calificacion))}${'☆'.repeat(5 - Math.round(arquitecto.calificacion))} <span style="color:#718096;font-size:11px;">${Number(arquitecto.calificacion).toFixed(1)}/5</span></div>`
      : '';

    /* ── Email interno a hola@apparq.cl ────────── */
    const esWaitlist = !arquitecto;
    await sendEmail({
      to:      'hola@apparq.cl',
      subject: esWaitlist
        ? `⚠️ LISTA DE ESPERA — ${nombreCliente} · ${svcName} · ${commune} — SIN ARQUITECTO`
        : `🚀 Nuevo trámite iniciado — ${nombreCliente} · ${svcName} · ${commune}`,
      html: `
        <div style="font-family:Arial,sans-serif;max-width:640px;margin:0 auto;color:#1a1a2e">
          <div style="background:#1a1a2e;padding:28px 32px;border-radius:8px 8px 0 0">
            <h1 style="color:#fff;margin:0;font-size:20px">APPARQ</h1>
            <p style="color:#a0aec0;margin:6px 0 0;font-size:13px">Nuevo trámite confirmado</p>
          </div>
          ${esWaitlist ? `
          <div style="background:#FEF2F2;border:2px solid #FCA5A5;padding:16px 32px;text-align:center">
            <p style="margin:0;font-size:16px;font-weight:900;color:#DC2626">⚠️ TRÁMITE EN LISTA DE ESPERA</p>
            <p style="margin:6px 0 0;font-size:13px;color:#7F1D1D">No hay arquitecto activo en <strong>${commune}</strong> para <strong>${svcName}</strong>. Asignar manualmente.</p>
          </div>` : ''}
          <div style="background:#fff;padding:28px 32px;border:1px solid #e2e8f0;border-radius:0 0 8px 8px">
            <h2 style="margin-top:0;font-size:16px;color:#1a1a2e">📋 Datos del trámite</h2>
            <table style="width:100%;border-collapse:collapse;font-size:13px">
              ${projectNumber ? `<tr style="background:#fffbeb"><td style="padding:8px 10px;color:#718096;width:40%">N° Trámite</td><td style="padding:8px 10px;font-weight:900;color:#E8503A;font-size:15px">${projectNumber}</td></tr>` : ''}
              <tr style="background:#f7fafc"><td style="padding:8px 10px;color:#718096;width:40%">Servicio</td><td style="padding:8px 10px;font-weight:700">${svcName}</td></tr>
              <tr><td style="padding:8px 10px;color:#718096">Dirección</td><td style="padding:8px 10px">${direccion || '—'}</td></tr>
              <tr style="background:#f7fafc"><td style="padding:8px 10px;color:#718096">Comuna</td><td style="padding:8px 10px">${commune || '—'}</td></tr>
              <tr><td style="padding:8px 10px;color:#718096">Superficie</td><td style="padding:8px 10px">${m2 ? m2 + ' m²' : '—'}</td></tr>
              <tr style="background:#f7fafc"><td style="padding:8px 10px;color:#718096">Total</td><td style="padding:8px 10px;font-weight:700">${clpFmt(clp)}</td></tr>
              <tr><td style="padding:8px 10px;color:#718096">E1 pagado</td><td style="padding:8px 10px;font-weight:700;color:#059669">${clpFmt(e1)} ✓</td></tr>
              ${payment_id ? `<tr style="background:#f0fdf4"><td style="padding:8px 10px;color:#718096">ID Pago MP</td><td style="padding:8px 10px;font-family:monospace;font-size:12px">${payment_id}</td></tr>` : ''}
              <tr style="background:#f7fafc"><td style="padding:8px 10px;color:#718096">Fecha</td><td style="padding:8px 10px">${fecha}</td></tr>
            </table>

            <h2 style="margin-top:24px;font-size:16px;color:#1a1a2e">👤 Datos del cliente</h2>
            <table style="width:100%;border-collapse:collapse;font-size:13px">
              <tr style="background:#f7fafc"><td style="padding:8px 10px;color:#718096;width:40%">Nombre</td><td style="padding:8px 10px;font-weight:700">${nombreCliente}</td></tr>
              <tr><td style="padding:8px 10px;color:#718096">Email</td><td style="padding:8px 10px">${email || '—'}</td></tr>
              <tr style="background:#f7fafc"><td style="padding:8px 10px;color:#718096">Teléfono</td><td style="padding:8px 10px">${telefono || '—'}</td></tr>
              <tr><td style="padding:8px 10px;color:#718096">RUT</td><td style="padding:8px 10px">${rut || '—'}</td></tr>
            </table>

            ${firmaClienteBlock}

            <h2 style="margin-top:24px;font-size:16px;color:#1a1a2e">🏗 Arquitecto asignado</h2>
            <table style="width:100%;border-collapse:collapse;font-size:13px">
              <tr style="background:#f7fafc"><td style="padding:8px 10px;color:#718096;width:40%">Nombre</td><td style="padding:8px 10px;font-weight:700">${arqNombre}</td></tr>
              <tr><td style="padding:8px 10px;color:#718096">Email arq.</td><td style="padding:8px 10px${!arquitecto?.email ? ';color:#dc2626;font-weight:700' : ''}">${arquitecto?.email || '⚠️ SIN EMAIL — revisar DB'}</td></tr>
              ${arquitecto?.comunas ? `<tr style="background:#f7fafc"><td style="padding:8px 10px;color:#718096">Comunas</td><td style="padding:8px 10px">${arquitecto.comunas.join(', ')}</td></tr>` : ''}
              ${arquitecto?.tramites ? `<tr><td style="padding:8px 10px;color:#718096">Trámites</td><td style="padding:8px 10px">${arquitecto.tramites.join(', ')}</td></tr>` : ''}
            </table>

            <p style="margin-top:24px;font-size:11px;color:#a0aec0">APPARQ — Sistema automático · ${fecha}</p>
          </div>
        </div>
      `,
    }, RESEND_API_KEY);

    /* ── Email de confirmación al cliente ─────── */
    if (email) {
      const esInforme = svc === 'informe';

      if (esWaitlist) {
        /* Caso lista de espera: no hay arquitecto disponible */
        await sendEmail({
          to:      email,
          subject: `⏳ Trámite recibido — en lista de espera — APPARQ`,
          html: `
          <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#1a1a2e">
            <div style="background:#1a1a2e;padding:32px;text-align:center;border-radius:8px 8px 0 0">
              <h1 style="color:#fff;margin:0;font-size:26px;letter-spacing:-0.5px">APPARQ</h1>
              <p style="color:#a0aec0;margin:8px 0 0;font-size:13px">Trámites de arquitectura</p>
            </div>
            <div style="background:#fff;padding:32px;border:1px solid #e2e8f0;border-radius:0 0 8px 8px">
              <h2 style="margin-top:0;color:#1a1a2e">¡Hola ${nombre || 'cliente'}! Hemos recibido tu trámite 🎉</h2>
              <p style="color:#4a5568;font-size:14px;line-height:1.7">
                Hemos recibido tu pago y tu trámite ha sido registrado con éxito.
              </p>

              ${projectNumber ? `
              <div style="background:#FFF7ED;border:2px solid #E8503A;border-radius:8px;padding:16px 20px;margin:20px 0;text-align:center">
                <p style="margin:0 0 4px;font-size:12px;color:#92400E;font-weight:700">TU NÚMERO DE TRÁMITE</p>
                <p style="margin:0;font-size:28px;font-weight:900;color:#E8503A;letter-spacing:2px">${projectNumber}</p>
                <p style="margin:6px 0 0;font-size:11px;color:#78350F">Guarda este número para revisar el avance en <strong>apparq.cl → Mi trámite</strong></p>
              </div>` : ''}

              <div style="background:#f0fdf4;border:1.5px solid #bbf7d0;border-radius:8px;padding:16px 20px;margin:20px 0">
                <p style="margin:0 0 6px;font-size:13px"><strong>✓ Servicio:</strong> ${svcName}</p>
                <p style="margin:0 0 6px;font-size:13px"><strong>✓ Dirección:</strong> ${direccion || '—'}, ${commune}</p>
                <p style="margin:0 0 6px;font-size:13px"><strong>✓ Pago E1 recibido:</strong> ${clpFmt(e1)}</p>
                <p style="margin:0 0 6px;font-size:13px"><strong>✓ Total del proyecto:</strong> ${clpFmt(clp)}</p>
                ${payment_id ? `<p style="margin:4px 0 0;font-size:11px;color:#718096">ID comprobante: ${payment_id}</p>` : ''}
              </div>

              <div style="background:#FEF9C3;border:1.5px solid #FDE047;border-radius:8px;padding:20px 24px;margin:24px 0;text-align:center">
                <p style="margin:0;font-size:28px">⏳</p>
                <p style="margin:8px 0 4px;font-size:15px;font-weight:800;color:#78350F">Tu trámite está en cola de espera</p>
                <p style="margin:0;font-size:13px;color:#92400E;line-height:1.6">
                  Te asignaremos un arquitecto a la brevedad.<br>
                  Te avisaremos por correo en cuanto esté confirmado.
                </p>
              </div>

              <div style="background:#EEF2FF;border:1.5px solid #C7D2FE;border-radius:8px;padding:14px 18px;margin-top:16px;text-align:center">
                <p style="margin:0 0 8px;font-size:13px;font-weight:700;color:#3730A3">Sigue el avance de tu trámite en:</p>
                <a href="https://apparq.cl" style="display:inline-block;background:#E8503A;color:#fff;text-decoration:none;font-weight:700;font-size:14px;padding:10px 28px;border-radius:6px;">apparq.cl → Mi trámite</a>
              </div>

              <div style="background:#FFF7ED;border:1.5px solid #FED7AA;border-radius:8px;padding:14px 18px;margin-top:20px">
                <p style="margin:0;font-size:12px;color:#92400E;font-weight:700">⚠️ Importante</p>
                <p style="margin:6px 0 0;font-size:12px;color:#78350F;line-height:1.6">
                  Todos los pagos y comunicaciones deben hacerse exclusivamente a través de <strong>apparq.cl</strong>.
                </p>
              </div>

              <hr style="border:none;border-top:1px solid #e2e8f0;margin:28px 0 16px">
              <p style="font-size:11px;color:#a0aec0;margin:0">
                APPARQ · DSR ARQ SPA · RUT 76.341.206-7 · Santiago, Chile<br>
                ¿Consultas? Escríbenos a <a href="mailto:hola@apparq.cl" style="color:#667eea">hola@apparq.cl</a>
                o por <a href="https://wa.me/56942054581" style="color:#25D366">WhatsApp</a>
              </p>
            </div>
          </div>
          `,
        }, RESEND_API_KEY);
      } else {
      await sendEmail({
        to:      email,
        subject: `✅ Tu trámite está en marcha — APPARQ`,
        html: `
          <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#1a1a2e">
            <div style="background:#1a1a2e;padding:32px;text-align:center;border-radius:8px 8px 0 0">
              <h1 style="color:#fff;margin:0;font-size:26px;letter-spacing:-0.5px">APPARQ</h1>
              <p style="color:#a0aec0;margin:8px 0 0;font-size:13px">Trámites de arquitectura</p>
            </div>
            <div style="background:#fff;padding:32px;border:1px solid #e2e8f0;border-radius:0 0 8px 8px">
              <h2 style="margin-top:0;color:#1a1a2e">¡Hola ${nombre || 'cliente'}! Tu trámite está en marcha 🎉</h2>
              <p style="color:#4a5568;font-size:14px;line-height:1.7">
                Hemos recibido tu pago y tu trámite ha sido activado. A continuación el resumen:
              </p>

              ${projectNumber ? `
              <div style="background:#FFF7ED;border:2px solid #E8503A;border-radius:8px;padding:16px 20px;margin:20px 0;text-align:center">
                <p style="margin:0 0 4px;font-size:12px;color:#92400E;font-weight:700">TU NÚMERO DE TRÁMITE</p>
                <p style="margin:0;font-size:28px;font-weight:900;color:#E8503A;letter-spacing:2px">${projectNumber}</p>
                <p style="margin:6px 0 0;font-size:11px;color:#78350F">Guarda este número para revisar el avance en <strong>apparq.cl → Mi trámite</strong></p>
              </div>` : ''}

              <div style="background:#f0fdf4;border:1.5px solid #bbf7d0;border-radius:8px;padding:16px 20px;margin:20px 0">
                <p style="margin:0 0 6px;font-size:13px"><strong>✓ Servicio:</strong> ${svcName}</p>
                <p style="margin:0 0 6px;font-size:13px"><strong>✓ Dirección:</strong> ${direccion || '—'}, ${commune}</p>
                <p style="margin:0 0 6px;font-size:13px"><strong>✓ Pago E1 recibido:</strong> ${clpFmt(e1)}</p>
                <p style="margin:0 0 6px;font-size:13px"><strong>✓ Total del proyecto:</strong> ${clpFmt(clp)}</p>
                ${payment_id ? `<p style="margin:4px 0 0;font-size:11px;color:#718096">ID comprobante: ${payment_id}</p>` : ''}
              </div>

              <h3 style="color:#1a1a2e;font-size:14px;margin-top:24px">🏗 Tu arquitecto asignado</h3>
              <div style="background:#f7fafc;border-radius:8px;padding:14px 18px;margin-bottom:20px;display:flex;align-items:center">
                ${arqFotoBlock}
                <div>
                  <p style="margin:0;font-size:15px;font-weight:700">${arqNombre}</p>
                  <p style="margin:3px 0 0;font-size:12px;color:#718096">Arquitecto APPARQ · ${commune}</p>
                  ${arqStarsBlock}
                </div>
              </div>

              <h3 style="color:#1a1a2e;font-size:14px;margin-top:24px">📝 Tu contrato firmado</h3>
              ${firmaClienteBlock || '<p style="font-size:12px;color:#a0aec0;font-style:italic;">Contrato firmado digitalmente en apparq.cl</p>'}

              <h3 style="color:#1a1a2e;font-size:14px;margin-top:24px">⏱ ¿Qué sigue?</h3>
              <ol style="color:#4a5568;font-size:13px;line-height:2;padding-left:20px;margin:8px 0">
                <li>Tu arquitecto actualizará los avances directamente en <strong>apparq.cl</strong></li>
                <li>Podrás coordinar y comunicarte con tu arquitecto a través de la plataforma</li>
                ${esInforme
                  ? (servicio_subtipo === 'evaluacion'
                      ? `<li><strong>Etapa 1 · Análisis normativo:</strong> Envía a tu arquitecto el <strong>número de rol</strong> y dirección de la propiedad para comenzar. No se requiere visita ni documentos adicionales</li>
                         <li><strong>Etapa 2 · Entrega del informe:</strong> Recibirás el informe con todas las condicionantes normativas de tu predio. Plazo estimado: <strong>5 a 7 días hábiles</strong></li>
                         <li>APPARQ te notificará para completar el <strong>Pago E2 (50%)</strong> al momento de la entrega</li>`
                      : servicio_subtipo === 'factibilidad'
                        ? `<li><strong>Etapa 1 · Visita a terreno:</strong> Tu arquitecto te contactará para coordinar la visita. Reúne todos los <strong>documentos y planos existentes</strong> de la propiedad para entregárselos</li>
                           <li><strong>Etapa 2 · Elaboración y entrega del informe:</strong> El arquitecto evaluará si tus documentos sirven para regularizar o deben rehacerse, y te entregará el diagnóstico con el camino a seguir. Plazo estimado: <strong>aproximadamente 2 semanas desde la visita</strong></li>
                           <li>APPARQ te notificará para completar el <strong>Pago E2 (50%)</strong> al momento de la entrega</li>`
                        : `<li><strong>Etapa 1 · Visita a terreno:</strong> Tu arquitecto te contactará para coordinar la visita. Facilita el acceso a la propiedad para la inspección del estado físico</li>
                           <li><strong>Etapa 2 · Elaboración y entrega del informe:</strong> El arquitecto documentará superficies, terminaciones, ventanas, instalaciones y condiciones generales. Plazo estimado: <strong>aproximadamente 1 semana desde la visita</strong></li>
                           <li>APPARQ te notificará para completar el <strong>Pago E2 (50%)</strong> al momento de la entrega</li>`)
                  : svc === 'declaracion-jurada'
                    ? `<li>Tu arquitecto elaborará y presentará la Declaración Jurada ante la DOM</li><li>Plazo DOM: <strong>3 días hábiles</strong> para emitir el giro de derechos</li><li>Al ${servicio_subtipo === 'demolicion' ? 'ingreso DOM y ejecución' : 'archivo de la DJTE'} recibirás el aviso del <strong>Pago E2</strong></li>`
                    : '<li>Una vez entregados los planos, recibirás el aviso del pago E2</li><li>El trámite completo toma entre <strong>3 y 6 meses</strong></li>'
                }
              </ol>

              <div style="background:#EEF2FF;border:1.5px solid #C7D2FE;border-radius:8px;padding:14px 18px;margin-top:16px;text-align:center">
                <p style="margin:0 0 8px;font-size:13px;font-weight:700;color:#3730A3">Sigue el avance de tu trámite en:</p>
                <a href="https://apparq.cl" style="display:inline-block;background:#E8503A;color:#fff;text-decoration:none;font-weight:700;font-size:14px;padding:10px 28px;border-radius:6px;">apparq.cl → Mi trámite</a>
              </div>

              <div style="background:#FFF7ED;border:1.5px solid #FED7AA;border-radius:8px;padding:14px 18px;margin-top:20px">
                <p style="margin:0;font-size:12px;color:#92400E;font-weight:700">⚠️ Importante</p>
                <p style="margin:6px 0 0;font-size:12px;color:#78350F;line-height:1.6">
                  Todos los pagos y comunicaciones deben hacerse exclusivamente a través de <strong>apparq.cl</strong>.
                  Nunca pagues directamente al arquitecto ni coordines por canales externos.
                </p>
              </div>

              <hr style="border:none;border-top:1px solid #e2e8f0;margin:28px 0 16px">
              <p style="font-size:11px;color:#a0aec0;margin:0">
                APPARQ · DSR ARQ SPA · RUT 76.341.206-7 · Santiago, Chile<br>
                ¿Consultas? Escríbenos a <a href="mailto:hola@apparq.cl" style="color:#667eea">hola@apparq.cl</a>
                o por <a href="https://wa.me/56942054581" style="color:#25D366">WhatsApp</a>
              </p>
            </div>
          </div>
        `,
      }, RESEND_API_KEY);
      } /* end else (not waitlist) */
    }

    /* ── Email al arquitecto asignado ─────────── */
    const arqEmail = arquitecto?.email || null;
    console.log('Arquitecto email:', arqEmail, '| objeto arq:', JSON.stringify(arquitecto));

    if (!arqEmail) {
      console.warn('⚠️  Sin email de arquitecto — no se envía correo de asignación. arquitecto:', JSON.stringify(arquitecto));
    } else {
      const esInforme  = svc === 'informe';
      const ARQ_PCT    = arquitecto?.patente ? 0.80 : 0.70;  /* 80% con patente, 70% sin patente */
      const APP_PCT    = 1 - ARQ_PCT;

      /* Honorarios netos por etapa (descontando comisión APPARQ) */
      const arqTotal = Math.round((clp || 0) * ARQ_PCT);
      const arqE1    = Math.round((e1  || 0) * ARQ_PCT);

      /* Etapas de pago según tipo de servicio */
      const esDJ        = svc === 'declaracion-jurada';
      const isDemocion  = servicio_subtipo === 'demolicion';
      const e2DJLabel   = isDemocion ? 'Ingreso DOM y ejecución' : 'Archivo DJTE ante la DOM';

      const e1InfLabel = servicio_subtipo === 'evaluacion' ? 'Análisis normativo' : 'Visita a terreno';
      const etapasBlock = esInforme
        ? /* Informe: 2 etapas 50/50 */
          `<tr><td style="padding:8px 10px;color:#718096">E1 · ${e1InfLabel} (ya pagado)</td><td style="padding:8px 10px;font-weight:700;color:#059669">${clpFmt(Math.round((clp||0)*0.5*ARQ_PCT))} ✓</td></tr>
           <tr style="background:#f7fafc"><td style="padding:8px 10px;color:#718096">E2 · Entrega del informe</td><td style="padding:8px 10px;font-weight:700">${clpFmt(Math.round((clp||0)*0.5*ARQ_PCT))}</td></tr>`
        : esDJ
          ? /* Declaración Jurada: 2 etapas 50/50 */
            `<tr><td style="padding:8px 10px;color:#718096">E1 · Inicio (ya pagado)</td><td style="padding:8px 10px;font-weight:700;color:#059669">${clpFmt(arqE1)} ✓</td></tr>
             <tr style="background:#f7fafc"><td style="padding:8px 10px;color:#718096">E2 · ${e2DJLabel}</td><td style="padding:8px 10px;font-weight:700">${clpFmt(Math.round((clp||0)*0.50*ARQ_PCT))}</td></tr>`
          : /* Resto: 4 etapas 20-30-20-30 */
            `<tr><td style="padding:8px 10px;color:#718096">E1 · Levantamiento (ya pagado)</td><td style="padding:8px 10px;font-weight:700;color:#059669">${clpFmt(arqE1)} ✓</td></tr>
             <tr style="background:#f7fafc"><td style="padding:8px 10px;color:#718096">E2 · Elaboración de planos</td><td style="padding:8px 10px;font-weight:700">${clpFmt(Math.round((clp||0)*0.30*ARQ_PCT))}</td></tr>
             <tr><td style="padding:8px 10px;color:#718096">E3 · Ingreso DOM</td><td style="padding:8px 10px;font-weight:700">${clpFmt(Math.round((clp||0)*0.30*ARQ_PCT))}</td></tr>
             <tr style="background:#f7fafc"><td style="padding:8px 10px;color:#718096">E4 · Recepción final</td><td style="padding:8px 10px;font-weight:700">${clpFmt(Math.round((clp||0)*0.20*ARQ_PCT))}</td></tr>`;

      /* Firma del cliente (contrato de servicio) — usa URL https://, no base64 */
      const firmaArqBlock = firmaUrl
        ? `<div style="margin-top:8px;padding:12px 16px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;">
             <p style="margin:0 0 8px;font-size:11px;color:#718096;font-weight:700;text-transform:uppercase;">Firma digital del cliente — ${nombreCliente}</p>
             <img src="${firmaUrl}" style="max-width:100%;height:auto;border:1px solid #cbd5e0;border-radius:4px;" alt="Firma cliente" />
             <p style="margin:8px 0 0;font-size:11px;color:#a0aec0;">Firmado el ${fecha} en apparq.cl · Contrato de prestación de servicios con DSR ARQ SPA</p>
           </div>`
        : `<p style="font-size:12px;color:#718096;font-style:italic;margin:4px 0;">Contrato firmado digitalmente por el cliente el ${fecha} en apparq.cl</p>`;

      await sendEmail({
        to:      arqEmail,
        subject: `🏗 Nuevo trámite asignado — ${projectNumber || svcName} · ${commune} — APPARQ`,
        html: `
          <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#1a1a2e">
            <div style="background:#1a1a2e;padding:32px;text-align:center;border-radius:8px 8px 0 0">
              <h1 style="color:#fff;margin:0;font-size:26px;letter-spacing:-0.5px">APPARQ</h1>
              <p style="color:#a0aec0;margin:8px 0 0;font-size:13px">Portal del arquitecto</p>
            </div>
            <div style="background:#fff;padding:32px;border:1px solid #e2e8f0;border-radius:0 0 8px 8px">
              <h2 style="margin-top:0;color:#1a1a2e">¡Hola ${arquitecto.nombre}! Se te ha asignado un nuevo trámite 🎉</h2>
              <p style="color:#4a5568;font-size:14px;line-height:1.7">
                Un cliente ha iniciado un trámite y has sido asignado como arquitecto responsable. A continuación los detalles:
              </p>

              <!-- N° TRÁMITE -->
              <div style="background:#FFF7ED;border:2px solid #E8503A;border-radius:8px;padding:16px 20px;margin:20px 0;text-align:center">
                <p style="margin:0 0 4px;font-size:12px;color:#92400E;font-weight:700;text-transform:uppercase;">N° de Trámite</p>
                <p style="margin:0;font-size:30px;font-weight:900;color:#E8503A;letter-spacing:2px">${projectNumber || '—'}</p>
                <p style="margin:6px 0 0;font-size:11px;color:#78350F">Usa este número para gestionar el trámite en <strong>apparq.cl → Soy Arquitecto</strong></p>
              </div>

              <!-- HONORARIOS NETOS -->
              <div style="background:#f0fdf4;border:1.5px solid #86efac;border-radius:8px;padding:16px 20px;margin:20px 0">
                <p style="margin:0 0 10px;font-size:13px;font-weight:800;color:#15803d;">💰 Tus honorarios netos (descontado ${Math.round(APP_PCT*100)}% APPARQ)</p>
                <table style="width:100%;border-collapse:collapse;font-size:13px">
                  ${etapasBlock}
                  <tr style="border-top:2px solid #86efac">
                    <td style="padding:10px 10px;color:#15803d;font-weight:800">TOTAL a recibir</td>
                    <td style="padding:10px 10px;font-weight:900;color:#15803d;font-size:15px">${clpFmt(arqTotal)}</td>
                  </tr>
                </table>
                <p style="margin:10px 0 0;font-size:11px;color:#4ade80;">* El pago de cada etapa se transfiere dentro de los 5 días hábiles desde la confirmación del pago del cliente, previa emisión de boleta de honorarios electrónica a nombre de DSR ARQ SPA.</p>
              </div>

              <!-- DATOS DEL TRÁMITE -->
              <h3 style="color:#1a1a2e;font-size:14px;margin-top:24px">📋 Datos del trámite</h3>
              <table style="width:100%;border-collapse:collapse;font-size:13px">
                <tr style="background:#f7fafc"><td style="padding:8px 10px;color:#718096;width:42%">Servicio</td><td style="padding:8px 10px;font-weight:700">${svcName}</td></tr>
                <tr><td style="padding:8px 10px;color:#718096">Dirección</td><td style="padding:8px 10px">${direccion || '—'}</td></tr>
                <tr style="background:#f7fafc"><td style="padding:8px 10px;color:#718096">Comuna</td><td style="padding:8px 10px">${commune || '—'}</td></tr>
                <tr><td style="padding:8px 10px;color:#718096">Superficie</td><td style="padding:8px 10px">${m2 ? m2 + ' m²' : '—'}</td></tr>
                <tr style="background:#f7fafc"><td style="padding:8px 10px;color:#718096">Valor total proyecto</td><td style="padding:8px 10px;font-weight:700">${clpFmt(clp)}</td></tr>
                <tr><td style="padding:8px 10px;color:#718096">Fecha inicio</td><td style="padding:8px 10px">${fecha}</td></tr>
              </table>

              <!-- DATOS DEL CLIENTE -->
              <h3 style="color:#1a1a2e;font-size:14px;margin-top:24px">👤 Datos del cliente</h3>
              <table style="width:100%;border-collapse:collapse;font-size:13px">
                <tr style="background:#f7fafc"><td style="padding:8px 10px;color:#718096;width:42%">Nombre</td><td style="padding:8px 10px;font-weight:700">${nombreCliente}</td></tr>
                <tr><td style="padding:8px 10px;color:#718096">Teléfono</td><td style="padding:8px 10px">${telefono || '—'}</td></tr>
                <tr style="background:#f7fafc"><td style="padding:8px 10px;color:#718096">RUT</td><td style="padding:8px 10px">${rut || '—'}</td></tr>
              </table>

              <!-- CONTRATO FIRMADO -->
              <h3 style="color:#1a1a2e;font-size:14px;margin-top:24px">📄 Contrato firmado por el cliente</h3>
              ${firmaArqBlock}

              <!-- PRÓXIMOS PASOS -->
              <h3 style="color:#1a1a2e;font-size:14px;margin-top:24px">⏱ Próximos pasos</h3>
              <ol style="color:#4a5568;font-size:13px;line-height:2;padding-left:20px;margin:8px 0">
                <li>Ingresa a <strong>apparq.cl → Soy Arquitecto</strong> con tu correo</li>
                ${esInforme
                  ? (servicio_subtipo === 'evaluacion'
                      ? `<li>Contacta al cliente para solicitarle el <strong>número de rol</strong> y la dirección de la propiedad</li>
                         <li>Analiza la normativa vigente aplicable al predio: plan regulador comunal, OGUC, rasantes, distancias mínimas y coeficientes de constructibilidad y ocupación. <strong>No se requiere visita a terreno ni revisión de documentos existentes</strong></li>
                         <li>Al entregar el informe, actualiza la etapa a <strong>«Entrega del informe»</strong> en la plataforma — esto gatilla el cobro del <strong>Pago E2 (50%)</strong> al cliente</li>
                         <li>Plazo estimado: <strong>5 a 7 días hábiles</strong></li>`
                      : servicio_subtipo === 'factibilidad'
                        ? `<li>Contacta al cliente para coordinar la visita y solicitarle los <strong>documentos y planos existentes</strong> (escrituras, planos aprobados, permisos de edificación, recepciones municipales)</li>
                           <li>Realiza la visita a terreno y <strong>márcala como realizada en la plataforma</strong></li>
                           <li>Evalúa si los documentos existentes son suficientes para regularizar o si la documentación debe rehacerse</li>
                           <li>Elabora el informe y al entregarlo actualiza la etapa a <strong>«Entrega del informe»</strong> — esto gatilla el <strong>Pago E2 (50%)</strong> al cliente</li>
                           <li>Plazo estimado: <strong>aproximadamente 2 semanas desde la visita</strong></li>`
                        : `<li>Contacta al cliente para coordinar el acceso a la propiedad (comprador o vendedor provee acceso)</li>
                           <li>Realiza la inspección física: superficies construidas, terminaciones, permisos vigentes y recepciones municipales. <strong>No incluye revisión de escrituras</strong></li>
                           <li>Marca la visita como realizada en la plataforma</li>
                           <li>Elabora el informe con el estado real del inmueble y actualiza la etapa a <strong>«Entrega del informe»</strong> — esto gatilla el <strong>Pago E2 (50%)</strong> al cliente</li>
                           <li>Plazo estimado: <strong>aproximadamente 1 semana desde la visita</strong></li>`)
                  : esDJ
                    ? `<li>Coordina la visita a terreno con el cliente a través de la plataforma</li><li>Elabora la Declaración Jurada según la DDU 542 y la Ley 21.718</li><li>Presenta la DJ ante la DOM (plazo DOM: <strong>3 días hábiles</strong> para emitir giro)</li><li>${isDemocion ? '<strong>Nota:</strong> demolición no requiere DJTE — E2 se cobra al ingreso DOM y ejecución' : 'Al archivo de la DJTE, APPARQ cobrará el Pago E2 al cliente'}</li>`
                    : '<li>Coordina la visita a terreno con el cliente a través de la plataforma</li><li>Actualiza las etapas del trámite en la plataforma conforme avances</li><li>APPARQ notificará al cliente los pagos de cada etapa</li>'
                }
                <li>Emite tu <strong>boleta de honorarios electrónica</strong> a APPARQ para recibir cada pago</li>
              </ol>

              <div style="background:#EEF2FF;border:1.5px solid #C7D2FE;border-radius:8px;padding:14px 18px;margin-top:16px;text-align:center">
                <p style="margin:0 0 8px;font-size:13px;font-weight:700;color:#3730A3">Actualiza los avances del trámite en:</p>
                <a href="https://apparq.cl" style="display:inline-block;background:#E8503A;color:#fff;text-decoration:none;font-weight:700;font-size:14px;padding:10px 28px;border-radius:6px;">apparq.cl → Soy Arquitecto</a>
              </div>

              <!-- DATOS PARA BOLETA DE HONORARIOS -->
              <h3 style="color:#1a1a2e;font-size:14px;margin-top:28px">🧾 Datos para emitir tu boleta de honorarios</h3>
              <p style="color:#4a5568;font-size:13px;margin:4px 0 10px">Emite una boleta de honorarios electrónica a nombre de:</p>
              <table style="width:100%;border-collapse:collapse;font-size:13px">
                <tr style="background:#f7fafc"><td style="padding:8px 10px;color:#718096;width:42%">Razón Social</td><td style="padding:8px 10px;font-weight:700">DSR ARQ SPA</td></tr>
                <tr><td style="padding:8px 10px;color:#718096">RUT</td><td style="padding:8px 10px;font-weight:700">76.341.206-7</td></tr>
                <tr style="background:#f7fafc"><td style="padding:8px 10px;color:#718096">Giro</td><td style="padding:8px 10px">Arquitectura y servicios conexos</td></tr>
                <tr><td style="padding:8px 10px;color:#718096">Correo boleta</td><td style="padding:8px 10px">hola@apparq.cl</td></tr>
              </table>
              <p style="color:#4a5568;font-size:12px;margin-top:8px;line-height:1.6">
                Envíanos la boleta a <strong>hola@apparq.cl</strong> para procesar el pago. Sin boleta de honorarios no se puede efectuar la transferencia.
              </p>

              <!-- DATOS DE TRANSFERENCIA -->
              <div style="background:#F0FDF4;border:1.5px solid #86EFAC;border-radius:8px;padding:16px 18px;margin-top:16px">
                <p style="margin:0 0 8px;font-size:13px;font-weight:700;color:#15803D">📤 Envíanos tus datos de transferencia</p>
                <p style="margin:0 0 10px;font-size:12px;color:#166534;line-height:1.6">Para efectuar el pago necesitamos tus datos bancarios. Responde este correo con:</p>
                <ul style="margin:0;padding-left:18px;font-size:12px;color:#166534;line-height:2">
                  <li>Banco</li>
                  <li>Tipo de cuenta (corriente / vista / ahorro)</li>
                  <li>Número de cuenta</li>
                  <li>Nombre del titular</li>
                  <li>RUT del titular</li>
                  <li>Email para comprobante</li>
                </ul>
              </div>

              <div style="background:#FFF7ED;border:1.5px solid #FED7AA;border-radius:8px;padding:14px 18px;margin-top:20px">
                <p style="margin:0;font-size:12px;color:#92400E;font-weight:700">⚠️ Importante</p>
                <p style="margin:6px 0 0;font-size:12px;color:#78350F;line-height:1.6">
                  Toda coordinación con el cliente debe realizarse a través de <strong>apparq.cl</strong>.
                  No compartas tu teléfono ni correo personal con el cliente.
                  Recuerda emitir tu boleta electrónica a APPARQ para recibir cada pago.
                </p>
              </div>

              <hr style="border:none;border-top:1px solid #e2e8f0;margin:28px 0 16px">
              <p style="font-size:11px;color:#a0aec0;margin:0">
                APPARQ · DSR ARQ SPA · RUT 76.341.206-7 · Santiago, Chile<br>
                ¿Consultas? Escríbenos a <a href="mailto:hola@apparq.cl" style="color:#667eea">hola@apparq.cl</a>
              </p>
            </div>
          </div>
        `,
      }, RESEND_API_KEY);

      /* ── Email interno a APPARQ: recordatorio de pago al arquitecto ── */
      const ARQ_PCT_ADMIN  = arquitecto?.patente ? 0.80 : 0.70;
      const payDueDate     = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000);
      const payDueFmt      = payDueDate.toLocaleDateString('es-CL', { day: '2-digit', month: 'long', year: 'numeric' });
      const arqTotalAdmin  = Math.round((clp || 0) * ARQ_PCT_ADMIN);

      const etapasAdminBlock = (esInforme || esDJ)
        ? `<tr><td style="padding:6px 10px;color:#718096">E1 · Inicio (ya pagado por cliente)</td><td style="padding:6px 10px;font-weight:700;color:#059669">${clpFmt(Math.round((clp||0)*0.50*ARQ_PCT_ADMIN))} ✓</td><td style="padding:6px 10px;font-weight:700;color:#E8503A">${payDueFmt}</td></tr>
           <tr style="background:#f7fafc"><td style="padding:6px 10px;color:#718096">E2 · ${esInforme ? 'Entrega informe' : 'Cierre DJ'}</td><td style="padding:6px 10px;font-weight:700">${clpFmt(Math.round((clp||0)*0.50*ARQ_PCT_ADMIN))}</td><td style="padding:6px 10px;color:#718096">Al pagar cliente E2</td></tr>`
        : `<tr><td style="padding:6px 10px;color:#718096">E1 · Levantamiento (ya pagado por cliente)</td><td style="padding:6px 10px;font-weight:700;color:#059669">${clpFmt(Math.round((clp||0)*0.20*ARQ_PCT_ADMIN))} ✓</td><td style="padding:6px 10px;font-weight:700;color:#E8503A">${payDueFmt}</td></tr>
           <tr style="background:#f7fafc"><td style="padding:6px 10px;color:#718096">E2 · Planos</td><td style="padding:6px 10px;font-weight:700">${clpFmt(Math.round((clp||0)*0.30*ARQ_PCT_ADMIN))}</td><td style="padding:6px 10px;color:#718096">Al pagar cliente E2</td></tr>
           <tr><td style="padding:6px 10px;color:#718096">E3 · Ingreso DOM</td><td style="padding:6px 10px;font-weight:700">${clpFmt(Math.round((clp||0)*0.30*ARQ_PCT_ADMIN))}</td><td style="padding:6px 10px;color:#718096">Al pagar cliente E3</td></tr>
           <tr style="background:#f7fafc"><td style="padding:6px 10px;color:#718096">E4 · Recepción</td><td style="padding:6px 10px;font-weight:700">${clpFmt(Math.round((clp||0)*0.20*ARQ_PCT_ADMIN))}</td><td style="padding:6px 10px;color:#718096">Al pagar cliente E4</td></tr>`;

      await sendEmail({
        to:      'hola@apparq.cl',
        subject: `⚠️ Pagar arquitecto · ${projectNumber} · ${arquitecto.nombre} ${arquitecto.apellido} · E1 vence ${payDueFmt}`,
        html: `
          <div style="font-family:Arial,sans-serif;max-width:620px;margin:0 auto;color:#1a1a2e">
            <div style="background:#1a1a2e;padding:24px 32px;border-radius:8px 8px 0 0">
              <h1 style="color:#fff;margin:0;font-size:20px">APPARQ · Pago pendiente a arquitecto</h1>
              <p style="color:#a0aec0;margin:6px 0 0;font-size:13px">Recordatorio automático — trámite confirmado</p>
            </div>
            <div style="background:#fff;padding:28px 32px;border:1px solid #e2e8f0;border-radius:0 0 8px 8px">

              <table style="width:100%;border-collapse:collapse;font-size:13px;margin-bottom:20px">
                <tr style="background:#f7fafc"><td style="padding:7px 10px;color:#718096;width:40%">N° Trámite</td><td style="padding:7px 10px;font-weight:700;color:#E8503A">${projectNumber}</td></tr>
                <tr><td style="padding:7px 10px;color:#718096">Servicio</td><td style="padding:7px 10px">${svcName}</td></tr>
                <tr style="background:#f7fafc"><td style="padding:7px 10px;color:#718096">Arquitecto</td><td style="padding:7px 10px;font-weight:700">${arquitecto.nombre} ${arquitecto.apellido} — ${arqEmail}</td></tr>
                <tr><td style="padding:7px 10px;color:#718096">% honorarios</td><td style="padding:7px 10px">${Math.round(ARQ_PCT_ADMIN*100)}% ${arquitecto?.patente ? '(con patente)' : '(sin patente)'}</td></tr>
                <tr style="background:#f7fafc"><td style="padding:7px 10px;color:#718096">Cliente</td><td style="padding:7px 10px">${nombreCliente}</td></tr>
                <tr><td style="padding:7px 10px;color:#718096">Total cliente</td><td style="padding:7px 10px">${clpFmt(clp)}</td></tr>
                <tr style="background:#f7fafc"><td style="padding:7px 10px;color:#718096">Total arquitecto</td><td style="padding:7px 10px;font-weight:700">${clpFmt(arqTotalAdmin)}</td></tr>
              </table>

              <h3 style="font-size:13px;color:#1a1a2e;margin-bottom:8px">📅 Calendario de pagos al arquitecto</h3>
              <table style="width:100%;border-collapse:collapse;font-size:12.5px">
                <thead>
                  <tr style="background:#1a1a2e;color:#fff">
                    <th style="padding:7px 10px;text-align:left">Etapa</th>
                    <th style="padding:7px 10px;text-align:left">Monto arquitecto</th>
                    <th style="padding:7px 10px;text-align:left">Fecha estimada</th>
                  </tr>
                </thead>
                <tbody>${etapasAdminBlock}
                  <tr style="border-top:2px solid #e2e8f0">
                    <td style="padding:8px 10px;font-weight:800;color:#1a1a2e">TOTAL</td>
                    <td style="padding:8px 10px;font-weight:800;color:#1a1a2e">${clpFmt(arqTotalAdmin)}</td>
                    <td></td>
                  </tr>
                </tbody>
              </table>

              <div style="background:#FEF3C7;border:1.5px solid #FCD34D;border-radius:8px;padding:14px 18px;margin-top:20px">
                <p style="margin:0;font-size:13px;font-weight:700;color:#92400E">⚠️ Pago E1 — vence ${payDueFmt}</p>
                <p style="margin:6px 0 0;font-size:12px;color:#78350F;line-height:1.6">
                  Verificar que el arquitecto envíe datos de transferencia y boleta de honorarios antes de pagar.<br>
                  <strong>Monto E1: ${clpFmt(Math.round((clp||0)*((esInforme||esDJ)?0.50:0.20)*ARQ_PCT_ADMIN))}</strong>
                </p>
              </div>

              <hr style="border:none;border-top:1px solid #e2e8f0;margin:24px 0 12px">
              <p style="font-size:11px;color:#a0aec0;margin:0">APPARQ · Sistema de notificaciones internas</p>
            </div>
          </div>
        `,
      }, RESEND_API_KEY);
    }

    return corsResponse({ ok: true, project_number: projectNumber, waitlist: esWaitlist });

  } catch (err) {
    console.error('confirm-tramite error:', err);
    return corsResponse({ error: err.message }, 500);
  }
}

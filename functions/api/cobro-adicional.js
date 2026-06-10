/* ══════════════════════════════════════════════════
   APPARQ — Cloudflare Pages Function: cobro-adicional
   Sistema de cobros adicionales dentro de trámites activos
   POST /api/cobro-adicional
   Body: { action, ... }
   Actions (arquitecto, requieren token):
     crear-cobro     — crea un cobro adicional, notifica al cliente
     cancelar-cobro  — cancela un cobro pendiente
     get-cobros      — lista cobros de un trámite
   Actions (cliente, sin auth):
     create-payment  — crea preferencia MP para pagar un cobro
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

async function verifyToken(token, SUPABASE_URL, SUPABASE_KEY) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${token}` },
  });
  if (!res.ok) return null;
  const user = await res.json();
  return user.email?.toLowerCase() || null;
}

async function getUF() {
  try {
    const res = await fetch('https://mindicador.cl/api/uf', {
      headers: { 'Accept': 'application/json' },
    });
    if (res.ok) {
      const data = await res.json();
      if (data?.serie?.[0]?.valor) {
        return {
          valor: data.serie[0].valor,
          fecha: data.serie[0].fecha?.split('T')[0] ?? null,
        };
      }
    }
  } catch (_) {}
  // Fallback CMF
  try {
    const res = await fetch(
      'https://api.cmfchile.cl/api-sbifv3/recursos/v1/uf?apikey=l7d40a28ad0e15b65d9d9bf06e5f5e2c84&formato=json',
      { headers: { 'Accept': 'application/json' } }
    );
    if (res.ok) {
      const data = await res.json();
      const val = data?.UFs?.[0]?.Valor;
      if (val) {
        return {
          valor: parseFloat(val.replace('.', '').replace(',', '.')),
          fecha: data.UFs[0].Fecha ?? null,
        };
      }
    }
  } catch (_) {}
  return null;
}

function clpFmt(n) {
  return '$' + Math.round(n).toLocaleString('es-CL');
}

const SERVICIOS_ADICIONALES = {
  cambio_propietario:    { label: 'Cambio de Propietario',    valor_uf: 5,    editable: false },
  cambio_profesional:    { label: 'Cambio de Profesional',    valor_uf: 5,    editable: false },
  modificacion_proyecto: { label: 'Modificación de Proyecto', valor_uf: 10,   editable: false },
  otro:                  { label: 'Otro',                     valor_uf: null, editable: true  },
};

function svcLabel(tipo_servicio) {
  return SERVICIOS_ADICIONALES[tipo_servicio]?.label || tipo_servicio;
}

export async function onRequest(context) {
  const { request, env } = context;
  const SUPABASE_URL   = env.SUPABASE_URL || 'https://ibdafnzlsufsshczqvoa.supabase.co';
  const SUPABASE_KEY   = env.SUPABASE_SERVICE_KEY || env.SUPABASE_SVC || env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImliZGFmbnpsc3Vmc3NoY3pxdm9hIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM5Njg0NjYsImV4cCI6MjA4OTU0NDQ2Nn0.ucEjCcnSbaz-OeMrLbUbgcKacvg9J2Csg2VzrWVtVHA';
  const RESEND_API_KEY = env.RESEND_API_KEY || 're_RRVTgGik_GtaRwK2p9jimrkemYTY4Uew6';
  const MP_ACCESS_TOKEN = env.MP_ACCESS_TOKEN || 'APP_USR-8464091449756756-032117-1cb0461b0053151dd99159498a8ebb3c-3280513372';

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }
  if (request.method !== 'POST') {
    return corsResponse({ error: 'Método no permitido' }, 405);
  }

  try {
    const body = await request.json();
    const { action } = body;

    /* ══════════════════════════════════════════════
       ACCIONES DEL ARQUITECTO (requieren token)
    ══════════════════════════════════════════════ */

    if (action === 'crear-cobro' || action === 'cancelar-cobro' || action === 'get-cobros') {
      const { token } = body;
      if (!token) return corsResponse({ error: 'No autenticado' }, 401);

      const email = await verifyToken(token, SUPABASE_URL, SUPABASE_KEY);
      if (!email) return corsResponse({ error: 'Sesión expirada. Vuelve a ingresar.' }, 401);

      /* Verificar que es arquitecto */
      const arqRes = await fetch(
        `${SUPABASE_URL}/rest/v1/architects?email=eq.${encodeURIComponent(email)}&select=id,nombre,apellido&limit=1`,
        { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
      );
      const arqData = await arqRes.json();
      if (!arqData.length) return corsResponse({ error: 'No tienes acceso de arquitecto.' }, 403);
      const architect = arqData[0];

      /* ── GET-COBROS ─────────────────────────── */
      if (action === 'get-cobros') {
        const { project_number } = body;
        if (!project_number) return corsResponse({ error: 'Falta project_number' }, 400);

        /* Verificar que el proyecto le pertenece */
        const projCheck = await fetch(
          `${SUPABASE_URL}/rest/v1/projects?project_number=eq.${encodeURIComponent(project_number)}&architect_email=eq.${encodeURIComponent(email)}&select=id&limit=1`,
          { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
        );
        const projData = await projCheck.json();
        if (!projData.length) return corsResponse({ error: 'Proyecto no encontrado' }, 404);

        const cobrosRes = await fetch(
          `${SUPABASE_URL}/rest/v1/cobros_adicionales?tramite_id=eq.${encodeURIComponent(project_number)}&order=fecha_creacion.desc`,
          { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
        );
        const cobros = cobrosRes.ok ? await cobrosRes.json() : [];
        return corsResponse({ cobros });
      }

      /* ── CREAR-COBRO ─────────────────────────── */
      if (action === 'crear-cobro') {
        const { project_number, tipo_servicio, fundamento_tecnico, valor_uf_custom } = body;

        if (!project_number || !tipo_servicio || !fundamento_tecnico) {
          return corsResponse({ error: 'Faltan campos obligatorios' }, 400);
        }
        if (!Object.keys(SERVICIOS_ADICIONALES).includes(tipo_servicio)) {
          return corsResponse({ error: 'tipo_servicio inválido' }, 400);
        }
        if (fundamento_tecnico.trim().length < 100) {
          return corsResponse({ error: 'El fundamento técnico debe tener al menos 100 caracteres' }, 400);
        }
        if (tipo_servicio === 'otro' && (!valor_uf_custom || isNaN(Number(valor_uf_custom)) || Number(valor_uf_custom) <= 0)) {
          return corsResponse({ error: 'Debes ingresar un valor en UF para el servicio adicional' }, 400);
        }

        /* Verificar que el proyecto le pertenece y está activo */
        const projRes = await fetch(
          `${SUPABASE_URL}/rest/v1/projects?project_number=eq.${encodeURIComponent(project_number)}&architect_email=eq.${encodeURIComponent(email)}&select=*&limit=1`,
          { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
        );
        const projData = await projRes.json();
        if (!projData.length) return corsResponse({ error: 'Proyecto no encontrado' }, 403);
        const proj = projData[0];

        const etapasInactivas = ['completado', 'no_viable', 'entrega_informe'];
        if (etapasInactivas.includes(proj.stage)) {
          return corsResponse({ error: 'No se pueden agregar cobros a un trámite completado o no viable' }, 400);
        }

        /* Verificar que no hay cobro pendiente de pago */
        if (proj.cobro_adicional_pendiente) {
          return corsResponse({ error: 'Ya existe un cobro adicional pendiente de pago para este trámite. El cliente debe pagarlo antes de agregar uno nuevo.' }, 400);
        }

        /* Obtener valor UF */
        const ufData = await getUF();
        if (!ufData) return corsResponse({ error: 'No se pudo obtener el valor de la UF. Intenta en un momento.' }, 503);

        const svcDef    = SERVICIOS_ADICIONALES[tipo_servicio];
        const valor_uf  = svcDef.editable ? Number(valor_uf_custom) : svcDef.valor_uf;
        const valor_clp = Math.round(valor_uf * ufData.valor);
        const descripcion = svcDef.editable
          ? (valor_uf_custom ? `${svcDef.label} (${valor_uf} UF)` : svcDef.label)
          : `${svcDef.label} (${valor_uf} UF)`;

        /* Insertar cobro */
        const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/cobros_adicionales`, {
          method: 'POST',
          headers: {
            'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`,
            'Content-Type': 'application/json', 'Prefer': 'return=representation',
          },
          body: JSON.stringify({
            tramite_id:       project_number,
            arquitecto_email: email,
            tipo_servicio,
            descripcion,
            fundamento_tecnico: fundamento_tecnico.trim(),
            valor_uf,
            valor_clp,
            valor_uf_fecha:   ufData.fecha,
            estado:           'pendiente_pago',
            fecha_creacion:   new Date().toISOString(),
          }),
        });

        if (!insertRes.ok) {
          const errText = await insertRes.text();
          console.error('Error inserting cobro:', errText);
          return corsResponse({ error: 'Error al registrar el cobro adicional' }, 500);
        }
        const insertedArr = await insertRes.json();
        const cobro = insertedArr[0];

        /* Marcar cobro_adicional_pendiente en el proyecto */
        await fetch(
          `${SUPABASE_URL}/rest/v1/projects?project_number=eq.${encodeURIComponent(project_number)}`,
          {
            method: 'PATCH',
            headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
            body: JSON.stringify({ cobro_adicional_pendiente: true, updated_at: new Date().toISOString() }),
          }
        );

        /* Email al cliente */
        const svcLabels = { regularizacion:'Regularización', ampliacion:'Ampliación', 'obra-nueva':'Obra Nueva', informe:'Informe de Propiedad', 'ley-del-mono':'Ley del Mono', 'declaracion-jurada':'Declaración Jurada' };
        const svcName = svcLabels[proj.service_type] || proj.service_type;
        const fecha = new Date().toLocaleDateString('es-CL', { day: '2-digit', month: 'long', year: 'numeric' });

        if (proj.client_email) {
          await sendEmail({
            to: proj.client_email,
            subject: `⚠️ ${svcLabel(tipo_servicio)} requerido en tu trámite ${project_number} — APPARQ`,
            html: `
              <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#1a1a2e">
                <div style="background:#1a1a2e;padding:28px 32px;text-align:center;border-radius:8px 8px 0 0">
                  <h1 style="color:#fff;margin:0;font-size:22px">APPARQ</h1>
                  <p style="color:#a0aec0;margin:6px 0 0;font-size:13px">Notificación de servicio adicional</p>
                </div>
                <div style="background:#fff;padding:28px 32px;border:1px solid #e2e8f0;border-radius:0 0 8px 8px">
                  <h2 style="margin-top:0;color:#1a1a2e;">Hola ${proj.client_nombre},</h2>
                  <p style="color:#4a5568;font-size:14px;line-height:1.7;">
                    Tu arquitecto <strong>${proj.architect_nombre} ${proj.architect_apellido}</strong> ha indicado que tu trámite requiere un servicio adicional para continuar.
                  </p>

                  <div style="background:#FFF7ED;border:2px solid #E8503A;border-radius:8px;padding:16px 20px;margin:20px 0;text-align:center;">
                    <p style="margin:0 0 4px;font-size:12px;color:#92400E;font-weight:700;">SERVICIO ADICIONAL REQUERIDO</p>
                    <p style="margin:0;font-size:20px;font-weight:900;color:#E8503A;">${descripcion}</p>
                    <p style="margin:8px 0 0;font-size:24px;font-weight:900;color:#1a1a2e;">${clpFmt(valor_clp)}</p>
                    <p style="margin:4px 0 0;font-size:12px;color:#92400E;">(${valor_uf} UF × ${clpFmt(ufData.valor)}/UF al ${ufData.fecha || fecha})</p>
                  </div>

                  <div style="background:#FEF2F2;border:1.5px solid #FECACA;border-radius:8px;padding:14px 18px;margin-bottom:20px;">
                    <p style="margin:0 0 6px;font-size:12px;color:#991B1B;font-weight:700;">📋 FUNDAMENTO TÉCNICO DEL ARQUITECTO</p>
                    <p style="margin:0;font-size:13px;color:#7F1D1D;line-height:1.7;">${fundamento_tecnico.trim()}</p>
                  </div>

                  <table style="width:100%;border-collapse:collapse;font-size:13px;margin-bottom:20px;">
                    <tr style="background:#f7fafc"><td style="padding:8px 10px;color:#718096;width:40%">N° Trámite</td><td style="padding:8px 10px;font-weight:700;color:#E8503A">${project_number}</td></tr>
                    <tr><td style="padding:8px 10px;color:#718096">Servicio</td><td style="padding:8px 10px">${svcName}</td></tr>
                    <tr style="background:#f7fafc"><td style="padding:8px 10px;color:#718096">Dirección</td><td style="padding:8px 10px">${proj.address || '—'}, ${proj.commune}</td></tr>
                    <tr><td style="padding:8px 10px;color:#718096">Arquitecto</td><td style="padding:8px 10px">${proj.architect_nombre} ${proj.architect_apellido}</td></tr>
                    <tr style="background:#f7fafc"><td style="padding:8px 10px;color:#718096">Monto</td><td style="padding:8px 10px;font-weight:700;color:#059669;">${clpFmt(valor_clp)}</td></tr>
                  </table>

                  <div style="background:#FEF3C7;border:1.5px solid #FCD34D;border-radius:8px;padding:14px 18px;margin-bottom:20px;">
                    <p style="margin:0;font-size:13px;color:#92400E;font-weight:700;">⚠️ El trámite permanecerá pausado hasta que realices el pago</p>
                    <p style="margin:6px 0 0;font-size:12px;color:#78350F;line-height:1.5;">Ingresa a tu portal en apparq.cl para ver el detalle y realizar el pago con Mercado Pago.</p>
                  </div>

                  <div style="text-align:center;margin-top:20px;">
                    <a href="https://apparq.cl" style="display:inline-block;background:#E8503A;color:#fff;text-decoration:none;font-weight:700;font-size:14px;padding:12px 32px;border-radius:6px;">
                      💳 Pagar servicio adicional
                    </a>
                  </div>

                  <div style="background:#F0FDF4;border:1.5px solid #86EFAC;border-radius:8px;padding:12px 16px;margin-top:16px;text-align:center;">
                    <p style="margin:0;font-size:13px;font-weight:700;color:#15803D;">💡 Puedes pagar en cuotas con Mercado Pago</p>
                    <p style="margin:4px 0 0;font-size:12px;color:#166534;line-height:1.5;">Al hacer clic en el botón de pago, selecciona la opción de <strong>cuotas con tu tarjeta de crédito</strong> para distribuir el pago cómodamente.</p>
                  </div>

                  <p style="font-size:12px;color:#a0aec0;margin-top:16px;text-align:center;">
                    ¿Tienes dudas? Escríbenos a <a href="mailto:hola@apparq.cl" style="color:#E8503A">hola@apparq.cl</a> o por
                    <a href="https://wa.me/56942054581" style="color:#25D366">WhatsApp</a>
                  </p>
                  <hr style="border:none;border-top:1px solid #e2e8f0;margin:24px 0 14px">
                  <p style="font-size:11px;color:#a0aec0;margin:0">APPARQ SpA · RUT 78.441.391-8 · hola@apparq.cl</p>
                </div>
              </div>`,
          }, RESEND_API_KEY);
        }

        /* Email a hola@apparq.cl */
        await sendEmail({
          to: 'hola@apparq.cl',
          subject: `💰 Cobro adicional creado — ${project_number} — ${descripcion} — ${clpFmt(valor_clp)}`,
          html: `
            <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#1a1a2e">
              <div style="background:#1a1a2e;padding:24px 32px;border-radius:8px 8px 0 0">
                <h1 style="color:#fff;margin:0;font-size:18px">APPARQ — Cobro adicional creado</h1>
              </div>
              <div style="background:#fff;padding:28px 32px;border:1px solid #e2e8f0;border-radius:0 0 8px 8px">
                <table style="width:100%;border-collapse:collapse;font-size:13px;">
                  <tr style="background:#f7fafc"><td style="padding:8px 10px;color:#718096;width:40%">N° Trámite</td><td style="padding:8px 10px;font-weight:700;color:#E8503A">${project_number}</td></tr>
                  <tr><td style="padding:8px 10px;color:#718096">Tipo servicio</td><td style="padding:8px 10px;font-weight:700">${descripcion}</td></tr>
                  <tr style="background:#f7fafc"><td style="padding:8px 10px;color:#718096">Monto</td><td style="padding:8px 10px;font-weight:700;color:#059669">${clpFmt(valor_clp)} (${valor_uf} UF)</td></tr>
                  <tr><td style="padding:8px 10px;color:#718096">Arquitecto</td><td style="padding:8px 10px">${architect.nombre} ${architect.apellido} · ${email}</td></tr>
                  <tr style="background:#f7fafc"><td style="padding:8px 10px;color:#718096">Cliente</td><td style="padding:8px 10px">${proj.client_nombre} ${proj.client_apellido} · ${proj.client_email}</td></tr>
                  <tr><td style="padding:8px 10px;color:#718096">ID Cobro</td><td style="padding:8px 10px;font-family:monospace;font-size:11px">${cobro?.id || '—'}</td></tr>
                </table>
                <div style="background:#FEF2F2;border:1.5px solid #FECACA;border-radius:8px;padding:14px 18px;margin-top:16px;">
                  <p style="margin:0 0 4px;font-size:12px;color:#991B1B;font-weight:700;">Fundamento técnico</p>
                  <p style="margin:0;font-size:13px;color:#7F1D1D;line-height:1.6">${fundamento_tecnico.trim()}</p>
                </div>
              </div>
            </div>`,
        }, RESEND_API_KEY);

        return corsResponse({ ok: true, cobro_id: cobro?.id, valor_clp, valor_uf, descripcion });
      }

      /* ── CANCELAR-COBRO ─────────────────────────── */
      if (action === 'cancelar-cobro') {
        const { cobro_id, project_number } = body;
        if (!cobro_id || !project_number) return corsResponse({ error: 'Faltan datos' }, 400);

        /* Verificar que el cobro pertenece a un proyecto del arquitecto */
        const cobroRes = await fetch(
          `${SUPABASE_URL}/rest/v1/cobros_adicionales?id=eq.${encodeURIComponent(cobro_id)}&tramite_id=eq.${encodeURIComponent(project_number)}&arquitecto_email=eq.${encodeURIComponent(email)}&select=*&limit=1`,
          { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
        );
        const cobroData = await cobroRes.json();
        if (!cobroData.length) return corsResponse({ error: 'Cobro no encontrado' }, 404);
        const cobro = cobroData[0];

        if (cobro.estado !== 'pendiente_pago') {
          return corsResponse({ error: 'Solo se pueden cancelar cobros pendientes de pago' }, 400);
        }

        /* Cancelar el cobro */
        await fetch(
          `${SUPABASE_URL}/rest/v1/cobros_adicionales?id=eq.${encodeURIComponent(cobro_id)}`,
          {
            method: 'PATCH',
            headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
            body: JSON.stringify({ estado: 'cancelado' }),
          }
        );

        /* Desbloquear el proyecto */
        await fetch(
          `${SUPABASE_URL}/rest/v1/projects?project_number=eq.${encodeURIComponent(project_number)}`,
          {
            method: 'PATCH',
            headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
            body: JSON.stringify({ cobro_adicional_pendiente: false, updated_at: new Date().toISOString() }),
          }
        );

        return corsResponse({ ok: true });
      }
    }

    /* ══════════════════════════════════════════════
       CREATE-PAYMENT (cliente, sin auth)
    ══════════════════════════════════════════════ */
    if (action === 'create-payment') {
      const { project_number, email: clientEmail, cobro_id } = body;
      if (!project_number || !clientEmail || !cobro_id) {
        return corsResponse({ error: 'Faltan datos' }, 400);
      }

      const emailLower = clientEmail.trim().toLowerCase();

      /* Verificar el par proyecto+email */
      const projRes = await fetch(
        `${SUPABASE_URL}/rest/v1/projects?project_number=eq.${encodeURIComponent(project_number)}&client_email=eq.${encodeURIComponent(emailLower)}&select=id,client_nombre,client_apellido,project_number&limit=1`,
        { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
      );
      const projData = await projRes.json();
      if (!projData.length) {
        return corsResponse({ error: 'Trámite no encontrado. Verifica el número y el email.' }, 404);
      }

      /* Verificar el cobro */
      const cobroRes = await fetch(
        `${SUPABASE_URL}/rest/v1/cobros_adicionales?id=eq.${encodeURIComponent(cobro_id)}&tramite_id=eq.${encodeURIComponent(project_number)}&estado=eq.pendiente_pago&select=*&limit=1`,
        { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
      );
      const cobroData = await cobroRes.json();
      if (!cobroData.length) {
        return corsResponse({ error: 'Cobro no encontrado o ya fue procesado' }, 404);
      }
      const cobro = cobroData[0];

      /* Crear preferencia en Mercado Pago */
      const preference = {
        items: [{
          title:      cobro.descripcion,
          quantity:   1,
          unit_price: cobro.valor_clp,
          currency_id: 'CLP',
        }],
        payer: { email: emailLower },
        back_urls: {
          success: `https://apparq.cl/?pago=aprobado&ref=${project_number}`,
          pending: `https://apparq.cl/?pago=pendiente&ref=${project_number}`,
          failure: `https://apparq.cl/?pago=rechazado&ref=${project_number}`,
        },
        auto_return:          'approved',
        external_reference:   `COBRO-${cobro.id}`,
        notification_url:     'https://apparq.cl/api/mp-webhook',
        statement_descriptor: 'APPARQ',
        payment_methods: {
          excluded_payment_types: [],
          installments: 1,
        },
      };

      const mpRes = await fetch('https://api.mercadopago.com/checkout/preferences', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${MP_ACCESS_TOKEN}`,
          'Content-Type':  'application/json',
        },
        body: JSON.stringify(preference),
      });

      if (!mpRes.ok) {
        console.error('Error MP crear preferencia cobro:', await mpRes.text());
        return corsResponse({ error: 'Error al crear el pago. Intenta nuevamente.' }, 502);
      }

      const mpData = await mpRes.json();
      return corsResponse({ ok: true, init_point: mpData.init_point, sandbox_init_point: mpData.sandbox_init_point });
    }

    return corsResponse({ error: 'Acción no reconocida' }, 400);

  } catch (err) {
    console.error('cobro-adicional error:', err);
    return corsResponse({ error: 'Error interno' }, 500);
  }
}

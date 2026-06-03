/* ══════════════════════════════════════════════════
   APPARQ — Cloudflare Pages Function: mp-webhook
   Recibe notificaciones IPN de Mercado Pago,
   registra el pago en Supabase y activa el proyecto
   pre-creado (pendiente_pago → levantamiento).
   POST /api/mp-webhook
══════════════════════════════════════════════════ */

const CORS = {
  'Access-Control-Allow-Origin': 'https://apparq.cl',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

function corsResponse(body, status = 200) {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: CORS });
}

/* ── Envío de email vía Resend ─────────────────── */
async function sendEmail({ to, subject, html }, RESEND_API_KEY) {
  if (!RESEND_API_KEY) return;
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({
        from:    'APPARQ <hola@apparq.cl>',
        to,
        subject,
        html,
      }),
    });
    if (!res.ok) {
      const err = await res.text();
      console.error('Resend error:', err);
    } else {
      console.log('Email enviado a:', to);
    }
  } catch (e) {
    console.error('Error enviando email:', e);
  }
}

/* ── Formato de monto CLP ──────────────────────── */
function formatCLP(amount) {
  return new Intl.NumberFormat('es-CL', { style: 'currency', currency: 'CLP' }).format(amount);
}

function clpFmt(n) {
  return '$' + Math.round(n).toLocaleString('es-CL');
}

/* ══════════════════════════════════════════════════
   AUTO-ASIGNACIÓN DE ARQUITECTO (solo no_auto_assign=false)
══════════════════════════════════════════════════ */
async function autoAssignArchitect(SUPABASE_URL, SERVICE_KEY, commune, svc) {
  const SVC_LABEL_MAP = {
    'ley-del-mono':       'Ley del Mono',
    regularizacion:       'Regularización',
    ampliacion:           'Ampliación',
    'declaracion-jurada': 'Declaración Jurada',
    'obra-nueva':         'Obra Nueva',
    informe:              'Informe',
  };
  const svcLabel = SVC_LABEL_MAP[svc] || svc;

  try {
    /* 1 — Obtener arquitectos activos que no bloqueen auto-asignación */
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/architects?activo=eq.true&no_auto_assign=eq.false&select=id,nombre,apellido,email,tramites,comunas,foto_url,calificacion,habilitado_declaracion_jurada,patente`,
      { headers: { 'apikey': SERVICE_KEY, 'Authorization': `Bearer ${SERVICE_KEY}` } }
    );
    if (!res.ok) { console.error('Error obteniendo arquitectos:', await res.text()); return null; }
    const all = await res.json();

    /* 2 — Filtrar por comuna y tipo de trámite */
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

    /* 3 — Contar proyectos activos por arquitecto candidato */
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
    console.log(`Auto-asignado (webhook): ${assigned.nombre} ${assigned.apellido} (${assigned.activeProjects} proyectos activos)`);
    return assigned;

  } catch (e) {
    console.error('Error en autoAssignArchitect (webhook):', e);
    return null;
  }
}

export async function onRequest(context) {
  const { request, env } = context;
  const MP_ACCESS_TOKEN = env.MP_ACCESS_TOKEN || 'APP_USR-8464091449756756-032117-1cb0461b0053151dd99159498a8ebb3c-3280513372';
  const SUPABASE_URL    = env.SUPABASE_URL || 'https://ibdafnzlsufsshczqvoa.supabase.co';
  const SERVICE_KEY     = env.SUPABASE_SERVICE_KEY || env.SUPABASE_SVC;
  const SUPABASE_KEY    = SERVICE_KEY || env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImliZGFmbnpsc3Vmc3NoY3pxdm9hIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM5Njg0NjYsImV4cCI6MjA4OTU0NDQ2Nn0.ucEjCcnSbaz-OeMrLbUbgcKacvg9J2Csg2VzrWVtVHA';
  const RESEND_API_KEY  = env.RESEND_API_KEY || 're_RRVTgGik_GtaRwK2p9jimrkemYTY4Uew6';

  /* MP envía GET para verificar y POST con la notificación */
  if (request.method === 'GET') {
    return new Response('OK', { status: 200 });
  }
  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  try {
    const url    = new URL(request.url);
    const topic  = url.searchParams.get('topic') || url.searchParams.get('type');
    const id     = url.searchParams.get('id') || url.searchParams.get('data.id');

    console.log('MP Webhook recibido:', { topic, id });

    /* Solo procesamos pagos */
    if (topic !== 'payment' && topic !== 'merchant_order') {
      return new Response('Ignorado', { status: 200 });
    }

    /* Consultar el pago a MP */
    const mpRes = await fetch(`https://api.mercadopago.com/v1/payments/${id}`, {
      headers: { 'Authorization': `Bearer ${MP_ACCESS_TOKEN}` },
    });

    if (!mpRes.ok) {
      console.error('No se pudo consultar el pago:', id);
      return new Response('Error al consultar pago', { status: 200 });
    }

    const payment = await mpRes.json();
    console.log('Pago MP:', {
      id:         payment.id,
      status:     payment.status,
      amount:     payment.transaction_amount,
      reference:  payment.external_reference,
      email:      payment.payer?.email,
    });

    /* Guardar en Supabase y enviar emails si el pago fue aprobado */
    if (payment.status === 'approved') {

      /* ── Declarar emailCliente al inicio del bloque approved ── */
      const emailCliente = payment.payer?.email;

      /* 1 — Idempotencia: verificar si el pago ya fue procesado
             SERVICE_KEY bypasa RLS para que el SELECT devuelva el registro si ya existe */
      const idempotencyKey = SERVICE_KEY || SUPABASE_KEY;
      if (SUPABASE_URL && idempotencyKey) {
        const checkRes = await fetch(
          `${SUPABASE_URL}/rest/v1/payments?mp_payment_id=eq.${String(payment.id)}&select=id`,
          {
            headers: {
              'apikey':        idempotencyKey,
              'Authorization': `Bearer ${idempotencyKey}`,
            },
          }
        );
        if (checkRes.ok) {
          const existing = await checkRes.json();
          if (existing.length > 0) {
            console.log('Pago ya procesado, ignorando duplicado:', payment.id);
            return new Response('OK', { status: 200 });
          }
        }
      }

      /* 2 — Guardar en Supabase (SERVICE_KEY para bypassear RLS en escritura)
             409 = constraint UNIQUE mp_payment_id disparado por carrera de webhooks → retornar OK sin duplicar. */
      if (SUPABASE_URL && idempotencyKey) {
        const record = {
          mp_payment_id:  String(payment.id),
          external_ref:   payment.external_reference,
          status:         payment.status,
          amount:         payment.transaction_amount,
          currency:       payment.currency_id,
          payer_email:    payment.payer?.email,
          payment_method: payment.payment_type_id,
          created_at:     new Date().toISOString(),
        };

        const sbRes = await fetch(`${SUPABASE_URL}/rest/v1/payments`, {
          method:  'POST',
          headers: {
            'apikey':        idempotencyKey,
            'Authorization': `Bearer ${idempotencyKey}`,
            'Content-Type':  'application/json',
            'Prefer':        'return=minimal',
          },
          body: JSON.stringify(record),
        });

        if (!sbRes.ok) {
          const err = await sbRes.text();
          if (sbRes.status === 409) {
            console.log('Pago duplicado bloqueado por constraint único (carrera entre webhooks):', payment.id);
            return new Response('OK', { status: 200 });
          }
          console.error('Error Supabase al guardar pago:', err);
        } else {
          console.log('Pago guardado en Supabase:', payment.id);
        }
      }

      /* 3 — Auto-convertir leads: email + monto coinciden con E1 del presupuesto */
      const svcKey = SERVICE_KEY || SUPABASE_KEY;
      if (emailCliente && svcKey) {
        try {
          const leadsRes = await fetch(
            `${SUPABASE_URL}/rest/v1/leads?email=eq.${encodeURIComponent(emailCliente)}&converted=eq.false&select=id,clp,svc`,
            { headers: { 'apikey': svcKey, 'Authorization': `Bearer ${svcKey}` } }
          );
          if (leadsRes.ok) {
            const matchingLeads = await leadsRes.json();
            const amount = payment.transaction_amount;
            for (const lead of matchingLeads) {
              if (!lead.clp) continue;
              /* E1: 50% para DJ e Informe, 20% para el resto */
              const esDJ = lead.svc === 'declaracion-jurada' || lead.svc === 'informe';
              const e1   = lead.clp * (esDJ ? 0.50 : 0.20);
              /* Tolerancia ±10% para cubrir redondeos y ajustes de UF */
              const coincide = Math.abs(amount - e1) / e1 <= 0.10;
              if (coincide) {
                await fetch(`${SUPABASE_URL}/rest/v1/leads?id=eq.${lead.id}`, {
                  method:  'PATCH',
                  headers: {
                    'apikey':        svcKey,
                    'Authorization': `Bearer ${svcKey}`,
                    'Content-Type':  'application/json',
                    'Prefer':        'return=minimal',
                  },
                  body: JSON.stringify({ converted: true }),
                });
                console.log(`Lead auto-convertido: ${emailCliente} | id=${lead.id} | clp=${lead.clp} | e1=${e1} | pagado=${amount}`);
              }
            }
          }
        } catch (e) {
          console.error('Error al auto-convertir lead:', e);
        }
      }

      /* 4 — Activar proyecto pre-creado (external_reference = project_number) */
      const extRef = payment.external_reference;
      let projectActivated = false;
      let projectData = null;

      /* ── Cobro adicional ────────────────────────────────── */
      if (extRef && extRef.startsWith('COBRO-') && SERVICE_KEY) {
        try {
          const cobroId = extRef.replace('COBRO-', '');
          console.log('Procesando cobro adicional:', cobroId);

          /* Obtener el cobro */
          const cobroRes = await fetch(
            `${SUPABASE_URL}/rest/v1/cobros_adicionales?id=eq.${encodeURIComponent(cobroId)}&estado=eq.pendiente_pago&select=*&limit=1`,
            { headers: { 'apikey': SERVICE_KEY, 'Authorization': `Bearer ${SERVICE_KEY}` } }
          );
          const cobroArr = cobroRes.ok ? await cobroRes.json() : [];
          const cobro    = cobroArr[0] || null;

          if (cobro) {
            /* Calcular comisión según patente del arquitecto */
            let comisionPct = 30;  /* default: sin patente → 30% APPARQ */
            if (cobro.arquitecto_email) {
              try {
                const arqPatRes = await fetch(
                  `${SUPABASE_URL}/rest/v1/architects?email=eq.${encodeURIComponent(cobro.arquitecto_email)}&select=patente&limit=1`,
                  { headers: { 'apikey': SERVICE_KEY, 'Authorization': `Bearer ${SERVICE_KEY}` } }
                );
                const arqPatArr = arqPatRes.ok ? await arqPatRes.json() : [];
                if (arqPatArr[0]?.patente === true) comisionPct = 20;
              } catch(_) {}
            }
            const comisionMonto      = Math.round((cobro.valor_clp || 0) * comisionPct / 100);
            const pagoNetoArquitecto = (cobro.valor_clp || 0) - comisionMonto;

            /* Marcar cobro como pagado + guardar comisión */
            await fetch(`${SUPABASE_URL}/rest/v1/cobros_adicionales?id=eq.${encodeURIComponent(cobroId)}`, {
              method: 'PATCH',
              headers: { 'apikey': SERVICE_KEY, 'Authorization': `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
              body: JSON.stringify({
                estado:                'pagado',
                mp_payment_id:         String(payment.id),
                fecha_pago:            new Date().toISOString(),
                comision_pct:          comisionPct,
                comision_monto:        comisionMonto,
                pago_neto_arquitecto:  pagoNetoArquitecto,
              }),
            });

            /* Desbloquear el proyecto */
            await fetch(`${SUPABASE_URL}/rest/v1/projects?project_number=eq.${encodeURIComponent(cobro.tramite_id)}`, {
              method: 'PATCH',
              headers: { 'apikey': SERVICE_KEY, 'Authorization': `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
              body: JSON.stringify({ cobro_adicional_pendiente: false, updated_at: new Date().toISOString() }),
            });

            /* Obtener datos del proyecto para los emails */
            const projRes2 = await fetch(
              `${SUPABASE_URL}/rest/v1/projects?project_number=eq.${encodeURIComponent(cobro.tramite_id)}&select=*&limit=1`,
              { headers: { 'apikey': SERVICE_KEY, 'Authorization': `Bearer ${SERVICE_KEY}` } }
            );
            const projArr = projRes2.ok ? await projRes2.json() : [];
            const proj    = projArr[0] || null;

            if (proj) {
              const svcLabels = { regularizacion:'Regularización', ampliacion:'Ampliación', 'obra-nueva':'Obra Nueva', informe:'Informe de Propiedad', 'ley-del-mono':'Ley del Mono', 'declaracion-jurada':'Declaración Jurada' };
              const svcName  = svcLabels[proj.service_type] || proj.service_type;
              const fecha    = new Date().toLocaleDateString('es-CL', { day:'2-digit', month:'long', year:'numeric' });

              const tableBase = `
                <table style="width:100%;border-collapse:collapse;font-size:13px;">
                  <tr style="background:#f7fafc"><td style="padding:8px 10px;color:#718096;width:40%">N° Trámite</td><td style="padding:8px 10px;font-weight:700;color:#E8503A">${cobro.tramite_id}</td></tr>
                  <tr><td style="padding:8px 10px;color:#718096">Servicio</td><td style="padding:8px 10px">${svcName}</td></tr>
                  <tr style="background:#f7fafc"><td style="padding:8px 10px;color:#718096">Cobro adicional</td><td style="padding:8px 10px;font-weight:700">${cobro.descripcion}</td></tr>
                  <tr><td style="padding:8px 10px;color:#718096">Monto pagado</td><td style="padding:8px 10px;font-weight:700;color:#059669">${clpFmt(cobro.valor_clp)} ✓</td></tr>
                  <tr style="background:#f7fafc"><td style="padding:8px 10px;color:#718096">ID Pago MP</td><td style="padding:8px 10px;font-family:monospace;font-size:11px">${payment.id}</td></tr>
                  <tr><td style="padding:8px 10px;color:#718096">Fecha</td><td style="padding:8px 10px">${fecha}</td></tr>
                </table>`;

              /* Email al cliente */
              if (proj.client_email) {
                await sendEmail({
                  to:      proj.client_email,
                  subject: `✅ Pago confirmado — Servicio adicional trámite ${cobro.tramite_id} — APPARQ`,
                  html: `
                    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#1a1a2e">
                      <div style="background:#1a1a2e;padding:28px 32px;text-align:center;border-radius:8px 8px 0 0">
                        <h1 style="color:#fff;margin:0;font-size:22px">APPARQ</h1>
                        <p style="color:#a0aec0;margin:6px 0 0;font-size:13px">Pago confirmado</p>
                      </div>
                      <div style="background:#fff;padding:28px 32px;border:1px solid #e2e8f0;border-radius:0 0 8px 8px">
                        <h2 style="margin-top:0;color:#1a1a2e;">¡Hola ${proj.client_nombre}! Tu pago fue confirmado ✅</h2>
                        <p style="color:#4a5568;font-size:14px;line-height:1.7;">
                          Hemos recibido el pago del servicio adicional para tu trámite. Tu trámite continuará con normalidad.
                        </p>
                        <div style="background:#f0fdf4;border:1.5px solid #bbf7d0;border-radius:8px;padding:14px 20px;margin:16px 0;text-align:center;">
                          <p style="margin:0 0 4px;font-size:12px;color:#718096;font-weight:700;">PAGO CONFIRMADO</p>
                          <p style="margin:0;font-size:22px;font-weight:900;color:#059669;">${clpFmt(cobro.valor_clp)} ✓</p>
                          <p style="margin:4px 0 0;font-size:12px;color:#6EE7B7;">ID: ${payment.id}</p>
                        </div>
                        ${tableBase}
                        <div style="background:#EEF2FF;border:1.5px solid #C7D2FE;border-radius:8px;padding:14px 18px;margin-top:20px;text-align:center;">
                          <p style="margin:0 0 8px;font-size:13px;font-weight:700;color:#3730A3">Sigue el avance de tu trámite en:</p>
                          <a href="https://apparq.cl" style="display:inline-block;background:#E8503A;color:#fff;text-decoration:none;font-weight:700;font-size:14px;padding:10px 28px;border-radius:6px;">apparq.cl → Mi trámite</a>
                        </div>
                        <div style="background:#F0FDF4;border:1.5px solid #86EFAC;border-radius:8px;padding:12px 16px;margin-top:14px;text-align:center;">
                          <p style="margin:0;font-size:13px;font-weight:700;color:#15803D;">💡 Recuerda: puedes pagar en cuotas con Mercado Pago</p>
                          <p style="margin:4px 0 0;font-size:12px;color:#166534;line-height:1.5;">En tus próximos pagos del trámite puedes seleccionar la opción de <strong>cuotas con tu tarjeta de crédito</strong> directamente en Mercado Pago.</p>
                        </div>
                        <hr style="border:none;border-top:1px solid #e2e8f0;margin:24px 0 14px">
                        <p style="font-size:11px;color:#a0aec0;margin:0">APPARQ · DSR ARQ SPA · hola@apparq.cl</p>
                      </div>
                    </div>`,
                }, RESEND_API_KEY);
              }

              /* Email al arquitecto */
              if (proj.architect_email) {
                await sendEmail({
                  to:      proj.architect_email,
                  subject: `💰 Cobro adicional pagado — ${cobro.tramite_id} · ${cobro.descripcion}`,
                  html: `
                    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#1a1a2e">
                      <div style="background:#1a1a2e;padding:24px 32px;border-radius:8px 8px 0 0">
                        <h1 style="color:#fff;margin:0;font-size:18px">APPARQ — Cobro adicional pagado</h1>
                      </div>
                      <div style="background:#D1FAE5;border:2px solid #6EE7B7;padding:14px 32px">
                        <p style="margin:0;font-size:14px;font-weight:700;color:#065F46">💰 El cliente pagó el servicio adicional. El trámite fue desbloqueado.</p>
                      </div>
                      <div style="background:#fff;padding:28px 32px;border:1px solid #e2e8f0;border-radius:0 0 8px 8px">
                        ${tableBase}
                        <table style="width:100%;border-collapse:collapse;font-size:13px;margin-top:12px">
                          <tr><td style="padding:8px 10px;color:#718096;width:40%">Cliente</td><td style="padding:8px 10px">${proj.client_nombre} ${proj.client_apellido}</td></tr>
                        </table>
                        <p style="font-size:12px;color:#718096;margin-top:16px;">El monto correspondiente a tus honorarios será transferido en los próximos días hábiles. Recuerda emitir la boleta de honorarios electrónica a DSR ARQ SPA (RUT 76.341.206-7).</p>
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
                to:      'hola@apparq.cl',
                subject: `💰 Cobro adicional pagado — ${cobro.tramite_id} — ${cobro.descripcion} — ${clpFmt(cobro.valor_clp)}`,
                html: `
                  <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#1a1a2e">
                    <div style="background:#1a1a2e;padding:24px 32px;border-radius:8px 8px 0 0">
                      <h1 style="color:#fff;margin:0;font-size:18px">APPARQ — Cobro adicional pagado</h1>
                    </div>
                    <div style="background:#D1FAE5;border:2px solid #6EE7B7;padding:14px 32px">
                      <p style="margin:0;font-size:13px;font-weight:700;color:#065F46">✅ Cobro pagado · Trámite desbloqueado</p>
                    </div>
                    <div style="background:#fff;padding:28px 32px;border:1px solid #e2e8f0;border-radius:0 0 8px 8px">
                      ${tableBase}
                      <table style="width:100%;border-collapse:collapse;font-size:13px;margin-top:12px">
                        <tr style="background:#f7fafc"><td style="padding:8px 10px;color:#718096;width:40%">Cliente</td><td style="padding:8px 10px">${proj.client_nombre} ${proj.client_apellido} · ${proj.client_email}</td></tr>
                        <tr><td style="padding:8px 10px;color:#718096">Arquitecto</td><td style="padding:8px 10px">${proj.architect_nombre} ${proj.architect_apellido} · ${proj.architect_email}</td></tr>
                      </table>
                      <div style="background:#FEF3C7;border:1.5px solid #FCD34D;border-radius:8px;padding:12px 16px;margin-top:16px;">
                        <p style="margin:0;font-size:12px;font-weight:700;color:#92400E;">⚠️ Recordatorio: transferir honorarios al arquitecto (previa boleta electrónica)</p>
                      </div>
                    </div>
                  </div>`,
              }, RESEND_API_KEY);

              console.log('Cobro adicional procesado correctamente:', cobroId);
            }
          } else {
            console.log('Cobro no encontrado o ya procesado:', cobroId);
          }
        } catch (cobroErr) {
          console.error('Error procesando cobro adicional:', cobroErr);
        }
      } else if (extRef && extRef.startsWith('ARQ-') && SERVICE_KEY) {
        try {
          const projRes = await fetch(
            `${SUPABASE_URL}/rest/v1/projects?project_number=eq.${encodeURIComponent(extRef)}&stage=eq.pendiente_pago&select=id,project_number,client_email,client_nombre,client_apellido,client_telefono,client_rut,service_type,servicio_subtipo,commune,m2,total_clp,e1_clp,address,firma_url`,
            { headers: { 'apikey': SERVICE_KEY, 'Authorization': `Bearer ${SERVICE_KEY}` } }
          );
          const projects = projRes.ok ? await projRes.json() : [];
          const project  = projects[0] || null;

          if (project) {
            /* Auto-asignar arquitecto (desactivada — asignación manual hasta nuevo aviso) */
            const AUTO_ASSIGN_ENABLED = false;
            const arq = AUTO_ASSIGN_ENABLED
              ? await autoAssignArchitect(SUPABASE_URL, SERVICE_KEY, project.commune, project.service_type)
              : null;

            /* PATCH proyecto: arquitecto + stage + e1_clp real del pago */
            const patchRes = await fetch(`${SUPABASE_URL}/rest/v1/projects?id=eq.${project.id}`, {
              method: 'PATCH',
              headers: {
                'apikey':        SERVICE_KEY,
                'Authorization': `Bearer ${SERVICE_KEY}`,
                'Content-Type':  'application/json',
                'Prefer':        'return=minimal',
              },
              body: JSON.stringify({
                architect_email:    arq?.email    || null,
                architect_nombre:   arq?.nombre   || '',
                architect_apellido: arq?.apellido || '',
                stage:              arq ? 'levantamiento' : 'en_espera',
                e1_clp:             payment.transaction_amount,
              }),
            });

            if (patchRes.ok) {
              projectActivated = true;
              projectData = { ...project, arq };
              console.log('Proyecto activado desde webhook:', extRef, arq ? `→ ${arq.nombre} ${arq.apellido}` : '→ en_espera');
            } else {
              console.error('Error al PATCH proyecto:', await patchRes.text());
            }

            /* ── Emails completos: cliente + arquitecto + APPARQ ── */
            if (projectActivated && projectData) {
              const p        = projectData;
              const arqObj   = projectData.arq;
              const fecha    = new Date().toLocaleDateString('es-CL', { day: '2-digit', month: 'long', year: 'numeric' });
              const svcLabels = { regularizacion:'Regularización', ampliacion:'Ampliación', 'declaracion-jurada':'Declaración Jurada', 'obra-nueva':'Obra Nueva', informe:'Informe de Propiedad', 'ley-del-mono':'Ley del Mono' };
              const svcName  = svcLabels[p.service_type] || p.service_type || 'Trámite';
              const nombreCliente = `${p.client_nombre || ''} ${p.client_apellido || ''}`.trim();
              const arqNombre     = arqObj ? `${arqObj.nombre} ${arqObj.apellido}` : 'Por asignar';
              const clp     = p.total_clp || 0;
              const e1Real  = payment.transaction_amount || p.e1_clp || 0;
              const esWaitlist = !arqObj;

              /* Firma del cliente (URL ya guardada en el proyecto) */
              const firmaUrl = p.firma_url || null;
              const firmaClienteBlock = firmaUrl
                ? `<div style="margin-top:12px;padding:12px 16px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;">
                     <p style="margin:0 0 8px;font-size:11px;color:#718096;font-weight:700;text-transform:uppercase;">Firma digital del cliente</p>
                     <img src="${firmaUrl}" style="max-width:100%;height:auto;border:1px solid #cbd5e0;border-radius:4px;" alt="Firma cliente" />
                   </div>`
                : '';

              /* ── Email interno a APPARQ ── */
              await sendEmail({
                to:      'hola@apparq.cl',
                subject: esWaitlist
                  ? `⚠️ LISTA DE ESPERA — ${nombreCliente} · ${svcName} · ${p.commune} — SIN ARQUITECTO`
                  : `🚀 Nuevo trámite iniciado — ${nombreCliente} · ${svcName} · ${p.commune}`,
                html: `
                  <div style="font-family:Arial,sans-serif;max-width:640px;margin:0 auto;color:#1a1a2e">
                    <div style="background:#1a1a2e;padding:28px 32px;border-radius:8px 8px 0 0">
                      <h1 style="color:#fff;margin:0;font-size:20px">APPARQ</h1>
                      <p style="color:#a0aec0;margin:6px 0 0;font-size:13px">Nuevo trámite activado vía webhook MP</p>
                    </div>
                    ${esWaitlist ? `
                    <div style="background:#FEF2F2;border:2px solid #FCA5A5;padding:16px 32px;text-align:center">
                      <p style="margin:0;font-size:16px;font-weight:900;color:#DC2626">⚠️ TRÁMITE EN LISTA DE ESPERA</p>
                      <p style="margin:6px 0 0;font-size:13px;color:#7F1D1D">No hay arquitecto activo en <strong>${p.commune}</strong> para <strong>${svcName}</strong>. Asignar manualmente.</p>
                    </div>` : ''}
                    <div style="background:#fff;padding:28px 32px;border:1px solid #e2e8f0;border-radius:0 0 8px 8px">
                      <h2 style="margin-top:0;font-size:16px;color:#1a1a2e">📋 Datos del trámite</h2>
                      <table style="width:100%;border-collapse:collapse;font-size:13px">
                        <tr style="background:#fffbeb"><td style="padding:8px 10px;color:#718096;width:40%">N° Trámite</td><td style="padding:8px 10px;font-weight:900;color:#E8503A;font-size:15px">${p.project_number}</td></tr>
                        <tr style="background:#f7fafc"><td style="padding:8px 10px;color:#718096">Servicio</td><td style="padding:8px 10px;font-weight:700">${svcName}</td></tr>
                        <tr><td style="padding:8px 10px;color:#718096">Dirección</td><td style="padding:8px 10px">${p.address || '—'}</td></tr>
                        <tr style="background:#f7fafc"><td style="padding:8px 10px;color:#718096">Comuna</td><td style="padding:8px 10px">${p.commune || '—'}</td></tr>
                        <tr><td style="padding:8px 10px;color:#718096">Superficie</td><td style="padding:8px 10px">${p.m2 ? p.m2 + ' m²' : '—'}</td></tr>
                        <tr style="background:#f7fafc"><td style="padding:8px 10px;color:#718096">Total</td><td style="padding:8px 10px;font-weight:700">${clpFmt(clp)}</td></tr>
                        <tr><td style="padding:8px 10px;color:#718096">E1 pagado</td><td style="padding:8px 10px;font-weight:700;color:#059669">${clpFmt(e1Real)} ✓</td></tr>
                        <tr style="background:#f0fdf4"><td style="padding:8px 10px;color:#718096">ID Pago MP</td><td style="padding:8px 10px;font-family:monospace;font-size:12px">${payment.id}</td></tr>
                        <tr><td style="padding:8px 10px;color:#718096">Fecha</td><td style="padding:8px 10px">${fecha}</td></tr>
                      </table>
                      <h2 style="margin-top:24px;font-size:16px;color:#1a1a2e">👤 Datos del cliente</h2>
                      <table style="width:100%;border-collapse:collapse;font-size:13px">
                        <tr style="background:#f7fafc"><td style="padding:8px 10px;color:#718096;width:40%">Nombre</td><td style="padding:8px 10px;font-weight:700">${nombreCliente}</td></tr>
                        <tr><td style="padding:8px 10px;color:#718096">Email</td><td style="padding:8px 10px">${p.client_email || '—'}</td></tr>
                        <tr style="background:#f7fafc"><td style="padding:8px 10px;color:#718096">Teléfono</td><td style="padding:8px 10px">${p.client_telefono || '—'}</td></tr>
                        <tr><td style="padding:8px 10px;color:#718096">RUT</td><td style="padding:8px 10px">${p.client_rut || '—'}</td></tr>
                      </table>
                      ${firmaClienteBlock}
                      <h2 style="margin-top:24px;font-size:16px;color:#1a1a2e">🏗 Arquitecto asignado</h2>
                      <table style="width:100%;border-collapse:collapse;font-size:13px">
                        <tr style="background:#f7fafc"><td style="padding:8px 10px;color:#718096;width:40%">Nombre</td><td style="padding:8px 10px;font-weight:700">${arqNombre}</td></tr>
                        <tr><td style="padding:8px 10px;color:#718096">Email arq.</td><td style="padding:8px 10px${!arqObj?.email ? ';color:#dc2626;font-weight:700' : ''}">${arqObj?.email || '⚠️ SIN EMAIL — revisar DB'}</td></tr>
                      </table>
                      <p style="margin-top:24px;font-size:11px;color:#a0aec0">APPARQ — Sistema automático vía webhook · ${fecha}</p>
                    </div>
                  </div>
                `,
              }, RESEND_API_KEY);

              /* ── Email de confirmación al cliente ── */
              const clientEmail = p.client_email;
              if (clientEmail) {
                const arqFotoBlock = arqObj?.foto_url
                  ? `<img src="${arqObj.foto_url}" style="width:64px;height:64px;border-radius:50%;object-fit:cover;margin-right:14px;border:2px solid #e2e8f0;" alt="${arqNombre}" />`
                  : `<div style="width:64px;height:64px;border-radius:50%;background:#1a1a2e;display:flex;align-items:center;justify-content:center;margin-right:14px;font-size:28px;flex-shrink:0;">👷</div>`;
                const arqStarsBlock = arqObj?.calificacion
                  ? `<div style="font-size:13px;color:#D97706;margin-top:3px;">${'★'.repeat(Math.round(arqObj.calificacion))}${'☆'.repeat(5 - Math.round(arqObj.calificacion))} <span style="color:#718096;font-size:11px;">${Number(arqObj.calificacion).toFixed(1)}/5</span></div>`
                  : '';
                const esInforme = p.service_type === 'informe';
                const esDJ      = p.service_type === 'declaracion-jurada';

                if (esWaitlist) {
                  await sendEmail({
                    to:      clientEmail,
                    subject: `⏳ Trámite recibido — en lista de espera — APPARQ`,
                    html: `
                      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#1a1a2e">
                        <div style="background:#1a1a2e;padding:32px;text-align:center;border-radius:8px 8px 0 0">
                          <h1 style="color:#fff;margin:0;font-size:26px;letter-spacing:-0.5px">APPARQ</h1>
                          <p style="color:#a0aec0;margin:8px 0 0;font-size:13px">Trámites de arquitectura</p>
                        </div>
                        <div style="background:#fff;padding:32px;border:1px solid #e2e8f0;border-radius:0 0 8px 8px">
                          <h2 style="margin-top:0;color:#1a1a2e">¡Hola ${p.client_nombre || 'cliente'}! Hemos recibido tu trámite 🎉</h2>
                          <p style="color:#4a5568;font-size:14px;line-height:1.7">Hemos recibido tu pago y tu trámite ha sido registrado con éxito.</p>
                          <div style="background:#FFF7ED;border:2px solid #E8503A;border-radius:8px;padding:16px 20px;margin:20px 0;text-align:center">
                            <p style="margin:0 0 4px;font-size:12px;color:#92400E;font-weight:700">TU NÚMERO DE TRÁMITE</p>
                            <p style="margin:0;font-size:28px;font-weight:900;color:#E8503A;letter-spacing:2px">${p.project_number}</p>
                            <p style="margin:6px 0 0;font-size:11px;color:#78350F">Guarda este número para revisar el avance en <strong>apparq.cl → Mi trámite</strong></p>
                          </div>
                          <div style="background:#f0fdf4;border:1.5px solid #bbf7d0;border-radius:8px;padding:16px 20px;margin:20px 0">
                            <p style="margin:0 0 6px;font-size:13px"><strong>✓ Servicio:</strong> ${svcName}</p>
                            <p style="margin:0 0 6px;font-size:13px"><strong>✓ Dirección:</strong> ${p.address || '—'}, ${p.commune}</p>
                            <p style="margin:0 0 6px;font-size:13px"><strong>✓ Pago E1 recibido:</strong> ${clpFmt(e1Real)}</p>
                            <p style="margin:0 0 6px;font-size:13px"><strong>✓ Total del proyecto:</strong> ${clpFmt(clp)}</p>
                            <p style="margin:4px 0 0;font-size:11px;color:#718096">ID comprobante: ${payment.id}</p>
                          </div>
                          <div style="background:#FEF9C3;border:1.5px solid #FDE047;border-radius:8px;padding:20px 24px;margin:24px 0;text-align:center">
                            <p style="margin:0;font-size:28px">⏳</p>
                            <p style="margin:8px 0 4px;font-size:15px;font-weight:800;color:#78350F">Tu trámite está en cola de espera</p>
                            <p style="margin:0;font-size:13px;color:#92400E;line-height:1.6">Te asignaremos un arquitecto a la brevedad.<br>Te avisaremos por correo en cuanto esté confirmado.</p>
                          </div>
                          <div style="background:#EEF2FF;border:1.5px solid #C7D2FE;border-radius:8px;padding:14px 18px;margin-top:16px;text-align:center">
                            <p style="margin:0 0 8px;font-size:13px;font-weight:700;color:#3730A3">Sigue el avance de tu trámite en:</p>
                            <a href="https://apparq.cl" style="display:inline-block;background:#E8503A;color:#fff;text-decoration:none;font-weight:700;font-size:14px;padding:10px 28px;border-radius:6px;">apparq.cl → Mi trámite</a>
                          </div>
                          <div style="background:#F0FDF4;border:1.5px solid #86EFAC;border-radius:8px;padding:12px 16px;margin-top:12px;text-align:center">
                            <p style="margin:0;font-size:13px;font-weight:700;color:#15803D;">💡 Recuerda: puedes pagar en cuotas con Mercado Pago</p>
                            <p style="margin:4px 0 0;font-size:12px;color:#166534;line-height:1.5;">En tus próximos pagos del trámite puedes seleccionar <strong>cuotas con tu tarjeta de crédito</strong> directamente en Mercado Pago.</p>
                          </div>
                          <hr style="border:none;border-top:1px solid #e2e8f0;margin:28px 0 16px">
                          <p style="font-size:11px;color:#a0aec0;margin:0">APPARQ · DSR ARQ SPA · RUT 76.341.206-7 · Santiago, Chile<br>¿Consultas? <a href="mailto:hola@apparq.cl" style="color:#667eea">hola@apparq.cl</a> o <a href="https://wa.me/56942054581" style="color:#25D366">WhatsApp</a></p>
                        </div>
                      </div>
                    `,
                  }, RESEND_API_KEY);
                } else {
                  await sendEmail({
                    to:      clientEmail,
                    subject: `✅ Tu trámite está en marcha — APPARQ`,
                    html: `
                      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#1a1a2e">
                        <div style="background:#1a1a2e;padding:32px;text-align:center;border-radius:8px 8px 0 0">
                          <h1 style="color:#fff;margin:0;font-size:26px;letter-spacing:-0.5px">APPARQ</h1>
                          <p style="color:#a0aec0;margin:8px 0 0;font-size:13px">Trámites de arquitectura</p>
                        </div>
                        <div style="background:#fff;padding:32px;border:1px solid #e2e8f0;border-radius:0 0 8px 8px">
                          <h2 style="margin-top:0;color:#1a1a2e">¡Hola ${p.client_nombre || 'cliente'}! Tu trámite está en marcha 🎉</h2>
                          <p style="color:#4a5568;font-size:14px;line-height:1.7">Hemos recibido tu pago y tu trámite ha sido activado. A continuación el resumen:</p>
                          <div style="background:#FFF7ED;border:2px solid #E8503A;border-radius:8px;padding:16px 20px;margin:20px 0;text-align:center">
                            <p style="margin:0 0 4px;font-size:12px;color:#92400E;font-weight:700">TU NÚMERO DE TRÁMITE</p>
                            <p style="margin:0;font-size:28px;font-weight:900;color:#E8503A;letter-spacing:2px">${p.project_number}</p>
                            <p style="margin:6px 0 0;font-size:11px;color:#78350F">Guarda este número para revisar el avance en <strong>apparq.cl → Mi trámite</strong></p>
                          </div>
                          <div style="background:#f0fdf4;border:1.5px solid #bbf7d0;border-radius:8px;padding:16px 20px;margin:20px 0">
                            <p style="margin:0 0 6px;font-size:13px"><strong>✓ Servicio:</strong> ${svcName}</p>
                            <p style="margin:0 0 6px;font-size:13px"><strong>✓ Dirección:</strong> ${p.address || '—'}, ${p.commune}</p>
                            <p style="margin:0 0 6px;font-size:13px"><strong>✓ Pago E1 recibido:</strong> ${clpFmt(e1Real)}</p>
                            <p style="margin:0 0 6px;font-size:13px"><strong>✓ Total del proyecto:</strong> ${clpFmt(clp)}</p>
                            <p style="margin:4px 0 0;font-size:11px;color:#718096">ID comprobante: ${payment.id}</p>
                          </div>
                          <h3 style="color:#1a1a2e;font-size:14px;margin-top:24px">🏗 Tu arquitecto asignado</h3>
                          <div style="background:#f7fafc;border-radius:8px;padding:14px 18px;margin-bottom:20px;display:flex;align-items:center">
                            ${arqFotoBlock}
                            <div>
                              <p style="margin:0;font-size:15px;font-weight:700">${arqNombre}</p>
                              <p style="margin:3px 0 0;font-size:12px;color:#718096">Arquitecto APPARQ · ${p.commune}</p>
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
                              ? (p.servicio_subtipo === 'evaluacion'
                                  ? `<li><strong>Etapa 1 · Análisis normativo:</strong> Envía a tu arquitecto el <strong>número de rol</strong> y dirección de la propiedad para comenzar. No se requiere visita ni documentos adicionales</li>
                                     <li><strong>Etapa 2 · Entrega del informe:</strong> Recibirás el informe con todas las condicionantes normativas de tu predio. Plazo estimado: <strong>5 a 7 días hábiles</strong></li>
                                     <li>APPARQ te notificará para completar el <strong>Pago E2 (50%)</strong> al momento de la entrega</li>`
                                  : p.servicio_subtipo === 'factibilidad'
                                    ? `<li><strong>Etapa 1 · Visita a terreno:</strong> Tu arquitecto te contactará para coordinar la visita. Reúne todos los <strong>documentos y planos existentes</strong> de la propiedad para entregárselos</li>
                                       <li><strong>Etapa 2 · Elaboración y entrega del informe:</strong> El arquitecto evaluará si tus documentos sirven para regularizar o deben rehacerse, y te entregará el diagnóstico. Plazo estimado: <strong>aproximadamente 2 semanas desde la visita</strong></li>
                                       <li>APPARQ te notificará para completar el <strong>Pago E2 (50%)</strong> al momento de la entrega</li>`
                                    : `<li><strong>Etapa 1 · Visita a terreno:</strong> Tu arquitecto te contactará para coordinar la visita. Facilita el acceso a la propiedad para la inspección del estado físico</li>
                                       <li><strong>Etapa 2 · Elaboración y entrega del informe:</strong> El arquitecto documentará superficies, terminaciones, ventanas, instalaciones y condiciones generales. Plazo estimado: <strong>aproximadamente 1 semana desde la visita</strong></li>
                                       <li>APPARQ te notificará para completar el <strong>Pago E2 (50%)</strong> al momento de la entrega</li>`)
                              : esDJ
                                ? `<li>Tu arquitecto elaborará y presentará la Declaración Jurada ante la DOM</li><li>Plazo DOM: <strong>3 días hábiles</strong> para emitir el giro de derechos</li>`
                                : '<li>Una vez entregados los planos, recibirás el aviso del pago E2</li><li>El trámite completo toma entre <strong>3 y 6 meses</strong></li>'
                            }
                          </ol>
                          <div style="background:#EEF2FF;border:1.5px solid #C7D2FE;border-radius:8px;padding:14px 18px;margin-top:16px;text-align:center">
                            <p style="margin:0 0 8px;font-size:13px;font-weight:700;color:#3730A3">Sigue el avance de tu trámite en:</p>
                            <a href="https://apparq.cl" style="display:inline-block;background:#E8503A;color:#fff;text-decoration:none;font-weight:700;font-size:14px;padding:10px 28px;border-radius:6px;">apparq.cl → Mi trámite</a>
                          </div>
                          <div style="background:#F0FDF4;border:1.5px solid #86EFAC;border-radius:8px;padding:12px 16px;margin-top:14px;text-align:center">
                            <p style="margin:0;font-size:13px;font-weight:700;color:#15803D">💡 Recuerda: puedes pagar en cuotas con Mercado Pago</p>
                            <p style="margin:4px 0 0;font-size:12px;color:#166534;line-height:1.5">En tus próximos pagos del trámite (E2, E3…) puedes seleccionar <strong>cuotas con tu tarjeta de crédito</strong> directamente en Mercado Pago.</p>
                          </div>
                          <div style="background:#FFF7ED;border:1.5px solid #FED7AA;border-radius:8px;padding:14px 18px;margin-top:14px">
                            <p style="margin:0;font-size:12px;color:#92400E;font-weight:700">⚠️ Importante</p>
                            <p style="margin:6px 0 0;font-size:12px;color:#78350F;line-height:1.6">Todos los pagos y comunicaciones deben hacerse exclusivamente a través de <strong>apparq.cl</strong>. Nunca pagues directamente al arquitecto ni coordines por canales externos.</p>
                          </div>
                          <hr style="border:none;border-top:1px solid #e2e8f0;margin:28px 0 16px">
                          <p style="font-size:11px;color:#a0aec0;margin:0">APPARQ · DSR ARQ SPA · RUT 76.341.206-7 · Santiago, Chile<br>¿Consultas? <a href="mailto:hola@apparq.cl" style="color:#667eea">hola@apparq.cl</a> o <a href="https://wa.me/56942054581" style="color:#25D366">WhatsApp</a></p>
                        </div>
                      </div>
                    `,
                  }, RESEND_API_KEY);
                }
              }

              /* ── Email al arquitecto asignado ── */
              if (arqObj?.email) {
                const arqEmail   = arqObj.email;
                const ARQ_PCT      = arqObj.patente ? 0.80 : 0.70;
                const COM_PCT      = arqObj.patente ? 20 : 30;
                const RETENCION    = 0.1525; /* 15,25% — Ley 21.133 vigente 2026 */
                const APP_PCT      = 1 - ARQ_PCT;
                const arqTotal     = Math.round((clp || 0) * ARQ_PCT);
                const arqE1        = Math.round((e1Real || 0) * ARQ_PCT);
                const arqTotalRet  = Math.round(arqTotal * RETENCION);
                const arqTotalNeto = arqTotal - arqTotalRet;
                const arqE1Ret     = Math.round(arqE1 * RETENCION);
                const arqE1Neto    = arqE1 - arqE1Ret;
                const esInforme  = p.service_type === 'informe';
                const esDJ       = p.service_type === 'declaracion-jurada';
                const isDemolicion = p.servicio_subtipo === 'demolicion';
                const e2DJLabel  = isDemolicion ? 'Ingreso DOM y ejecución' : 'Archivo DJTE ante la DOM';
                const fecha      = new Date().toLocaleDateString('es-CL', { day: '2-digit', month: 'long', year: 'numeric' });
                const svcName    = ({ regularizacion:'Regularización', ampliacion:'Ampliación', 'declaracion-jurada':'Declaración Jurada', 'obra-nueva':'Obra Nueva', informe:'Informe de Propiedad', 'ley-del-mono':'Ley del Mono' })[p.service_type] || p.service_type;

                const e1InfLabelWH = p.servicio_subtipo === 'evaluacion' ? 'Análisis normativo' : 'Visita a terreno';
                const mkRow = (label, bruto, isPaid = false, bg = '') => {
                  const ret  = Math.round(bruto * RETENCION);
                  const neto = bruto - ret;
                  const s    = isPaid ? 'color:#059669;font-weight:700' : '';
                  const chk  = isPaid ? ' ✓' : '';
                  const bgS  = bg ? ` style="background:${bg}"` : '';
                  return `<tr${bgS}><td style="padding:8px 10px;color:#718096">${label}${chk}</td><td style="padding:8px 10px;font-weight:700;${s}">${clpFmt(bruto)}</td><td style="padding:8px 10px;${s}">${clpFmt(neto)}</td></tr>`;
                };
                const hdrRow = `<tr style="background:#d1fae5"><td style="padding:5px 10px;font-size:11px;font-weight:700;color:#065f46;text-transform:uppercase">Etapa</td><td style="padding:5px 10px;font-size:11px;font-weight:700;color:#065f46">Bruto boleta</td><td style="padding:5px 10px;font-size:11px;font-weight:700;color:#065f46">Neto recibes</td></tr>`;
                const etapasBlock = esInforme
                  ? hdrRow +
                    mkRow(`E1 · ${e1InfLabelWH} (ya pagado)`, Math.round((clp||0)*0.5*ARQ_PCT), true) +
                    mkRow('E2 · Entrega del informe', Math.round((clp||0)*0.5*ARQ_PCT), false, '#f7fafc')
                  : esDJ
                    ? hdrRow +
                      mkRow('E1 · Inicio (ya pagado)', arqE1, true) +
                      mkRow(`E2 · ${e2DJLabel}`, Math.round((clp||0)*0.50*ARQ_PCT), false, '#f7fafc')
                    : hdrRow +
                      mkRow('E1 · Levantamiento (ya pagado)', arqE1, true) +
                      mkRow('E2 · Elaboración de planos', Math.round((clp||0)*0.30*ARQ_PCT), false, '#f7fafc') +
                      mkRow('E3 · Ingreso DOM', Math.round((clp||0)*0.30*ARQ_PCT)) +
                      mkRow('E4 · Recepción final', Math.round((clp||0)*0.20*ARQ_PCT), false, '#f7fafc');

                const firmaArqBlock = firmaUrl
                  ? `<div style="margin-top:8px;padding:12px 16px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;">
                       <p style="margin:0 0 8px;font-size:11px;color:#718096;font-weight:700;text-transform:uppercase;">Firma digital del cliente — ${nombreCliente}</p>
                       <img src="${firmaUrl}" style="max-width:100%;height:auto;border:1px solid #cbd5e0;border-radius:4px;" alt="Firma cliente" />
                       <p style="margin:8px 0 0;font-size:11px;color:#a0aec0;">Firmado el ${fecha} en apparq.cl · Contrato de prestación de servicios con DSR ARQ SPA</p>
                     </div>`
                  : `<p style="font-size:12px;color:#718096;font-style:italic;margin:4px 0;">Contrato firmado digitalmente por el cliente el ${fecha} en apparq.cl</p>`;

                await sendEmail({
                  to:      arqEmail,
                  subject: `🏗 Nuevo trámite asignado — ${p.project_number} · ${p.commune} — APPARQ`,
                  html: `
                    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#1a1a2e">
                      <div style="background:#1a1a2e;padding:32px;text-align:center;border-radius:8px 8px 0 0">
                        <h1 style="color:#fff;margin:0;font-size:26px;letter-spacing:-0.5px">APPARQ</h1>
                        <p style="color:#a0aec0;margin:8px 0 0;font-size:13px">Portal del arquitecto</p>
                      </div>
                      <div style="background:#fff;padding:32px;border:1px solid #e2e8f0;border-radius:0 0 8px 8px">
                        <h2 style="margin-top:0;color:#1a1a2e">¡Hola ${arqObj.nombre}! Se te ha asignado un nuevo trámite 🎉</h2>
                        <div style="background:#FFF7ED;border:2px solid #E8503A;border-radius:8px;padding:16px 20px;margin:20px 0;text-align:center">
                          <p style="margin:0 0 4px;font-size:12px;color:#92400E;font-weight:700;text-transform:uppercase;">N° de Trámite</p>
                          <p style="margin:0;font-size:30px;font-weight:900;color:#E8503A;letter-spacing:2px">${p.project_number}</p>
                          <p style="margin:6px 0 0;font-size:11px;color:#78350F">Usa este número para gestionar el trámite en <strong>apparq.cl → Soy Arquitecto</strong></p>
                        </div>
                        <div style="background:#f0fdf4;border:1.5px solid #86efac;border-radius:8px;padding:16px 20px;margin:20px 0">
                          <p style="margin:0 0 10px;font-size:13px;font-weight:800;color:#15803d;">💰 Tus honorarios — comisión APPARQ ${COM_PCT}% ya descontada</p>
                          <table style="width:100%;border-collapse:collapse;font-size:13px">
                            ${etapasBlock}
                            <tr style="border-top:2px solid #86efac;background:#ecfdf5">
                              <td style="padding:10px 10px;color:#15803d;font-weight:800">TOTAL</td>
                              <td style="padding:10px 10px;font-weight:900;color:#15803d">${clpFmt(arqTotal)}</td>
                              <td style="padding:10px 10px;font-weight:900;color:#15803d;font-size:15px">${clpFmt(arqTotalNeto)}</td>
                            </tr>
                          </table>
                          <p style="margin:10px 0 0;font-size:11px;color:#166534;line-height:1.6">⚠️ Emite tu boleta por el <strong>monto BRUTO</strong>. APPARQ retiene el 15,25% (Ley 21.133) y lo entera en el F29 mensual.<br>* El pago se transfiere dentro de los 5 días hábiles desde la confirmación del pago del cliente.</p>
                        </div>
                        <h3 style="color:#1a1a2e;font-size:14px;margin-top:24px">📋 Datos del trámite</h3>
                        <table style="width:100%;border-collapse:collapse;font-size:13px">
                          <tr style="background:#f7fafc"><td style="padding:8px 10px;color:#718096;width:42%">Servicio</td><td style="padding:8px 10px;font-weight:700">${svcName}</td></tr>
                          <tr><td style="padding:8px 10px;color:#718096">Dirección</td><td style="padding:8px 10px">${p.address || '—'}</td></tr>
                          <tr style="background:#f7fafc"><td style="padding:8px 10px;color:#718096">Comuna</td><td style="padding:8px 10px">${p.commune || '—'}</td></tr>
                          <tr><td style="padding:8px 10px;color:#718096">Superficie</td><td style="padding:8px 10px">${p.m2 ? p.m2 + ' m²' : '—'}</td></tr>
                          <tr style="background:#f7fafc"><td style="padding:8px 10px;color:#718096">Valor total proyecto</td><td style="padding:8px 10px;font-weight:700">${clpFmt(clp)}</td></tr>
                          <tr><td style="padding:8px 10px;color:#718096">Fecha inicio</td><td style="padding:8px 10px">${fecha}</td></tr>
                        </table>
                        <h3 style="color:#1a1a2e;font-size:14px;margin-top:24px">👤 Datos del cliente</h3>
                        <table style="width:100%;border-collapse:collapse;font-size:13px">
                          <tr style="background:#f7fafc"><td style="padding:8px 10px;color:#718096;width:42%">Nombre</td><td style="padding:8px 10px;font-weight:700">${nombreCliente}</td></tr>
                          <tr><td style="padding:8px 10px;color:#718096">Teléfono</td><td style="padding:8px 10px">${p.client_telefono || '—'}</td></tr>
                          <tr style="background:#f7fafc"><td style="padding:8px 10px;color:#718096">RUT</td><td style="padding:8px 10px">${p.client_rut || '—'}</td></tr>
                        </table>
                        <h3 style="color:#1a1a2e;font-size:14px;margin-top:24px">📄 Contrato firmado por el cliente</h3>
                        ${firmaArqBlock}
                        <h3 style="color:#1a1a2e;font-size:14px;margin-top:24px">⏱ Próximos pasos</h3>
                        <ol style="color:#4a5568;font-size:13px;line-height:2;padding-left:20px;margin:8px 0">
                          <li>Ingresa a <strong>apparq.cl → Soy Arquitecto</strong> con tu correo</li>
                          ${esInforme
                            ? (p.servicio_subtipo === 'evaluacion'
                                ? `<li>Contacta al cliente para solicitarle el <strong>número de rol</strong> y la dirección de la propiedad</li>
                                   <li>Analiza la normativa vigente: plan regulador comunal, OGUC, rasantes, distancias mínimas y coeficientes. <strong>No se requiere visita ni revisión de documentos existentes</strong></li>
                                   <li>Al entregar el informe, actualiza la etapa a <strong>«Entrega del informe»</strong> — esto gatilla el cobro del <strong>Pago E2 (50%)</strong></li>
                                   <li>Plazo estimado: <strong>5 a 7 días hábiles</strong></li>`
                                : p.servicio_subtipo === 'factibilidad'
                                  ? `<li>Contacta al cliente para coordinar la visita y solicitarle los <strong>documentos y planos existentes</strong> (escrituras, planos aprobados, permisos, recepciones)</li>
                                     <li>Realiza la visita a terreno y <strong>márcala como realizada en la plataforma</strong></li>
                                     <li>Evalúa si los documentos son suficientes para regularizar o deben rehacerse</li>
                                     <li>Elabora el informe y actualiza la etapa a <strong>«Entrega del informe»</strong> — gatilla el <strong>Pago E2 (50%)</strong></li>
                                     <li>Plazo estimado: <strong>aproximadamente 2 semanas desde la visita</strong></li>`
                                  : `<li>Contacta al cliente para coordinar el acceso a la propiedad</li>
                                     <li>Realiza la inspección física: superficies, terminaciones, permisos y recepciones municipales. <strong>No incluye revisión de escrituras</strong></li>
                                     <li>Marca la visita como realizada en la plataforma</li>
                                     <li>Elabora el informe y actualiza la etapa a <strong>«Entrega del informe»</strong> — gatilla el <strong>Pago E2 (50%)</strong></li>
                                     <li>Plazo estimado: <strong>aproximadamente 1 semana desde la visita</strong></li>`)
                            : esDJ
                              ? `<li>Coordina la visita a terreno con el cliente a través de la plataforma</li><li>Elabora la Declaración Jurada según la DDU 542 y la Ley 21.718</li><li>Presenta la DJ ante la DOM (plazo DOM: <strong>3 días hábiles</strong> para emitir giro)</li>`
                              : '<li>Coordina la visita a terreno con el cliente a través de la plataforma</li><li>Actualiza las etapas del trámite en la plataforma conforme avances</li><li>APPARQ notificará al cliente los pagos de cada etapa</li>'
                          }
                          <li>Emite tu <strong>boleta de honorarios electrónica</strong> a APPARQ para recibir cada pago</li>
                        </ol>
                        <div style="background:#EEF2FF;border:1.5px solid #C7D2FE;border-radius:8px;padding:14px 18px;margin-top:16px;text-align:center">
                          <p style="margin:0 0 8px;font-size:13px;font-weight:700;color:#3730A3">Actualiza los avances del trámite en:</p>
                          <a href="https://apparq.cl" style="display:inline-block;background:#E8503A;color:#fff;text-decoration:none;font-weight:700;font-size:14px;padding:10px 28px;border-radius:6px;">apparq.cl → Soy Arquitecto</a>
                        </div>
                        <h3 style="color:#1a1a2e;font-size:14px;margin-top:28px">🧾 Datos para emitir tu boleta de honorarios</h3>
                        <table style="width:100%;border-collapse:collapse;font-size:13px">
                          <tr style="background:#f7fafc"><td style="padding:8px 10px;color:#718096;width:42%">Razón Social</td><td style="padding:8px 10px;font-weight:700">DSR ARQ SPA</td></tr>
                          <tr><td style="padding:8px 10px;color:#718096">RUT</td><td style="padding:8px 10px;font-weight:700">76.341.206-7</td></tr>
                          <tr style="background:#f7fafc"><td style="padding:8px 10px;color:#718096">Giro</td><td style="padding:8px 10px">Arquitectura y servicios conexos</td></tr>
                          <tr><td style="padding:8px 10px;color:#718096">Correo boleta</td><td style="padding:8px 10px">hola@apparq.cl</td></tr>
                        </table>
                        <div style="background:#F0FDF4;border:1.5px solid #86EFAC;border-radius:8px;padding:16px 18px;margin-top:16px">
                          <p style="margin:0 0 8px;font-size:13px;font-weight:700;color:#15803D">📤 Envíanos tus datos de transferencia</p>
                          <ul style="margin:0;padding-left:18px;font-size:12px;color:#166534;line-height:2">
                            <li>Banco · Tipo de cuenta · Número de cuenta</li>
                            <li>Nombre del titular · RUT · Email para comprobante</li>
                          </ul>
                        </div>
                        <hr style="border:none;border-top:1px solid #e2e8f0;margin:28px 0 16px">
                        <p style="font-size:11px;color:#a0aec0;margin:0">APPARQ · DSR ARQ SPA · RUT 76.341.206-7 · Santiago, Chile<br>¿Consultas? <a href="mailto:hola@apparq.cl" style="color:#667eea">hola@apparq.cl</a></p>
                      </div>
                    </div>
                  `,
                }, RESEND_API_KEY);

                /* ── Email interno: recordatorio pago al arquitecto ── */
                const payDueDate  = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000);
                const payDueFmt   = payDueDate.toLocaleDateString('es-CL', { day: '2-digit', month: 'long', year: 'numeric' });
                await sendEmail({
                  to:      'hola@apparq.cl',
                  subject: `⚠️ Pagar arquitecto · ${p.project_number} · ${arqObj.nombre} ${arqObj.apellido} · E1 vence ${payDueFmt}`,
                  html: `
                    <div style="font-family:Arial,sans-serif;max-width:620px;margin:0 auto;color:#1a1a2e">
                      <div style="background:#1a1a2e;padding:24px 32px;border-radius:8px 8px 0 0">
                        <h1 style="color:#fff;margin:0;font-size:20px">APPARQ · Pago pendiente a arquitecto</h1>
                        <p style="color:#a0aec0;margin:6px 0 0;font-size:13px">Recordatorio automático — trámite confirmado vía webhook</p>
                      </div>
                      <div style="background:#fff;padding:28px 32px;border:1px solid #e2e8f0;border-radius:0 0 8px 8px">
                        <table style="width:100%;border-collapse:collapse;font-size:13px;margin-bottom:20px">
                          <tr style="background:#f7fafc"><td style="padding:7px 10px;color:#718096;width:40%">N° Trámite</td><td style="padding:7px 10px;font-weight:700;color:#E8503A">${p.project_number}</td></tr>
                          <tr><td style="padding:7px 10px;color:#718096">Servicio</td><td style="padding:7px 10px">${svcName}</td></tr>
                          <tr style="background:#f7fafc"><td style="padding:7px 10px;color:#718096">Arquitecto</td><td style="padding:7px 10px;font-weight:700">${arqObj.nombre} ${arqObj.apellido} — ${arqEmail}</td></tr>
                          <tr><td style="padding:7px 10px;color:#718096">% honorarios</td><td style="padding:7px 10px">${Math.round(ARQ_PCT*100)}% ${arqObj.patente ? '(con patente)' : '(sin patente)'}</td></tr>
                          <tr style="background:#f7fafc"><td style="padding:7px 10px;color:#718096">Cliente</td><td style="padding:7px 10px">${nombreCliente}</td></tr>
                          <tr><td style="padding:7px 10px;color:#718096">Total cliente</td><td style="padding:7px 10px">${clpFmt(clp)}</td></tr>
                          <tr style="background:#f7fafc"><td style="padding:7px 10px;color:#718096">Bruto boletas total</td><td style="padding:7px 10px;font-weight:700">${clpFmt(arqTotal)}</td></tr>
                          <tr><td style="padding:7px 10px;color:#718096">Retención SII 15,25%</td><td style="padding:7px 10px;color:#dc2626">-${clpFmt(arqTotalRet)}</td></tr>
                          <tr style="background:#f0fdf4"><td style="padding:7px 10px;color:#15803d;font-weight:700">Neto a transferir</td><td style="padding:7px 10px;font-weight:700;color:#15803d">${clpFmt(arqTotalNeto)}</td></tr>
                        </table>
                        <div style="background:#FEF3C7;border:1.5px solid #FCD34D;border-radius:8px;padding:14px 18px;margin-top:20px">
                          <p style="margin:0;font-size:13px;font-weight:700;color:#92400E">⚠️ Pago E1 — vence ${payDueFmt}</p>
                          <p style="margin:6px 0 0;font-size:12px;color:#78350F;line-height:1.6">Verificar que el arquitecto envíe datos de transferencia y boleta de honorarios antes de pagar.<br><strong>Neto E1 a transferir: ${clpFmt(arqE1Neto)}</strong> (bruto boleta: ${clpFmt(arqE1)} · ret. SII: ${clpFmt(arqE1Ret)})</p>
                        </div>
                        <hr style="border:none;border-top:1px solid #e2e8f0;margin:24px 0 12px">
                        <p style="font-size:11px;color:#a0aec0;margin:0">APPARQ · Sistema de notificaciones internas</p>
                      </div>
                    </div>
                  `,
                }, RESEND_API_KEY);
              }
            }
          } else {
            console.log('No hay proyecto pendiente_pago para external_reference:', extRef);
          }
        } catch (projErr) {
          console.error('Error activando proyecto desde webhook:', projErr);
        }
      } else {
        /* external_reference no es un project_number → solo email básico de pago */
        const monto     = formatCLP(payment.transaction_amount);
        const referencia = payment.external_reference || String(payment.id);
        const emailPayer = payment.payer?.email;
        const fecha     = new Date().toLocaleDateString('es-CL', { day: '2-digit', month: 'long', year: 'numeric' });

        await sendEmail({
          to:      'hola@apparq.cl',
          subject: `Nuevo pago recibido — ${monto} — ${referencia}`,
          html: `
            <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto">
              <h2 style="color:#1a1a2e">💰 Nuevo pago aprobado</h2>
              <table style="width:100%;border-collapse:collapse">
                <tr><td style="padding:8px;color:#666">Monto</td><td style="padding:8px;font-weight:bold">${monto}</td></tr>
                <tr style="background:#f9f9f9"><td style="padding:8px;color:#666">Referencia</td><td style="padding:8px">${referencia}</td></tr>
                <tr><td style="padding:8px;color:#666">Email cliente</td><td style="padding:8px">${emailPayer || '—'}</td></tr>
                <tr style="background:#f9f9f9"><td style="padding:8px;color:#666">ID Pago MP</td><td style="padding:8px">${payment.id}</td></tr>
                <tr><td style="padding:8px;color:#666">Método de pago</td><td style="padding:8px">${payment.payment_type_id || '—'}</td></tr>
                <tr style="background:#f9f9f9"><td style="padding:8px;color:#666">Fecha</td><td style="padding:8px">${fecha}</td></tr>
              </table>
              <p style="margin-top:24px;color:#888;font-size:12px">APPARQ — Sistema automático de notificaciones</p>
            </div>
          `,
        }, RESEND_API_KEY);

        if (emailPayer) {
          await sendEmail({
            to:      emailPayer,
            subject: 'Tu pago en APPARQ fue confirmado ✓',
            html: `
              <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto">
                <div style="background:#1a1a2e;padding:32px;text-align:center;border-radius:8px 8px 0 0">
                  <h1 style="color:#fff;margin:0;font-size:24px">APPARQ</h1>
                  <p style="color:#a0aec0;margin:8px 0 0">Trámites de arquitectura</p>
                </div>
                <div style="background:#fff;padding:32px;border:1px solid #e2e8f0;border-radius:0 0 8px 8px">
                  <h2 style="color:#1a1a2e;margin-top:0">¡Pago recibido con éxito!</h2>
                  <p style="color:#4a5568">Hemos confirmado tu pago. A continuación el resumen:</p>
                  <div style="background:#f7fafc;border-radius:8px;padding:20px;margin:20px 0">
                    <p style="margin:0 0 8px"><strong>Monto pagado:</strong> ${monto}</p>
                    <p style="margin:0 0 8px"><strong>Referencia:</strong> ${referencia}</p>
                    <p style="margin:0"><strong>Fecha:</strong> ${new Date().toLocaleDateString('es-CL', { day: '2-digit', month: 'long', year: 'numeric' })}</p>
                  </div>
                  <p style="color:#4a5568">Nuestro equipo se pondrá en contacto contigo a la brevedad para coordinar los próximos pasos de tu trámite.</p>
                  <hr style="border:none;border-top:1px solid #e2e8f0;margin:24px 0">
                  <p style="color:#a0aec0;font-size:12px;margin:0">APPARQ — DSR ARQ SPA · RUT 76.341.206-7<br>apparq.cl</p>
                </div>
              </div>
            `,
          }, RESEND_API_KEY);
        }
      }
    }

    return new Response('OK', { status: 200 });

  } catch (err) {
    console.error('Error en webhook:', err);
    /* Siempre responder 200 a MP para que no reintente */
    return new Response('Error procesado', { status: 200 });
  }
}

/* ══════════════════════════════════════════════════
   APPARQ — Cloudflare Pages Function: architect-add-client
   Permite a un arquitecto ingresar su propio cliente a la plataforma.
   Comisión reducida: 10% (con patente) o 20% (sin patente).
   POST /api/architect-add-client
   Actions: get-quote | create
══════════════════════════════════════════════════ */

import { sendEmail } from './_email.js';

const CORS = {
  'Access-Control-Allow-Origin': 'https://apparq.cl',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

function corsResponse(body, status = 200) {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: CORS });
}

async function verifyToken(token, SUPABASE_URL, SUPABASE_KEY) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${token}` },
  });
  if (!res.ok) return null;
  const user = await res.json();
  return user.email?.toLowerCase() || null;
}

/* ── Tabla de precios en UF (IVA incluido, vigentes desde 2026-07-06) ── */
const PRECIO_LEY_MONO  = { hasta90: 15.4, hasta140: 20.9 };
const PRECIO_REG       = { 'obra-menor': 30.8, 'obra-nueva-reg-hasta140': 41.8, 'obra-nueva-reg-por-m2': 0.429 };
const PRECIO_AMP       = { hasta50: 22, hasta100: 30.8 };
const PRECIO_ON        = { tarifa: 0.88, minimo: 38.5 };
const PRECIO_INF       = { evaluacion: 3.3, factibilidad: 6.6, compraventa: 8.8 };
const PRECIO_DJ        = { piscina: 11, pergola: 6.6, demolicion_base: 8.8, demolicion_umbral: 100, demolicion_por_m2: 0.055 };
const UF_FALLBACK      = 40823;
const IVA_RATE         = 0.19;

function calcUF({ svc, servicio_subtipo, m2 = 0 }) {
  const m = Number(m2) || 0;
  switch (svc) {
    case 'ley-del-mono':
      return m <= 90 ? PRECIO_LEY_MONO.hasta90 : PRECIO_LEY_MONO.hasta140;
    case 'regularizacion':
      if (servicio_subtipo === 'obra-nueva-reg-por-m2') return Math.max(PRECIO_REG['obra-nueva-reg-por-m2'] * m, 28);
      return PRECIO_REG[servicio_subtipo] || 28;
    case 'ampliacion':
      return m <= 50 ? PRECIO_AMP.hasta50 : PRECIO_AMP.hasta100;
    case 'obra-nueva':
      return Math.max(PRECIO_ON.tarifa * m, PRECIO_ON.minimo);
    case 'informe':
      return PRECIO_INF[servicio_subtipo] || 3;
    case 'declaracion-jurada':
      if (servicio_subtipo === 'piscina_privada')    return PRECIO_DJ.piscina;
      if (servicio_subtipo === 'pergola_sombreadero') return PRECIO_DJ.pergola;
      if (servicio_subtipo === 'demolicion') {
        return PRECIO_DJ.demolicion_base + Math.max(0, m - PRECIO_DJ.demolicion_umbral) * PRECIO_DJ.demolicion_por_m2;
      }
      return PRECIO_DJ.piscina;
    default:
      return 0;
  }
}

function clpFmt(n) { return '$ ' + Math.round(n).toLocaleString('es-CL'); }

export async function onRequest(context) {
  const { request, env } = context;
  const SUPABASE_URL    = env.SUPABASE_URL    || 'https://ibdafnzlsufsshczqvoa.supabase.co';
  const SUPABASE_KEY    = env.SUPABASE_SERVICE_KEY || env.SUPABASE_SVC || env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImliZGFmbnpsc3Vmc3NoY3pxdm9hIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM5Njg0NjYsImV4cCI6MjA4OTU0NDQ2Nn0.ucEjCcnSbaz-OeMrLbUbgcKacvg9J2Csg2VzrWVtVHA';
  const MP_ACCESS_TOKEN = env.MP_ACCESS_TOKEN || 'APP_USR-8464091449756756-032117-1cb0461b0053151dd99159498a8ebb3c-3280513372';

  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (request.method !== 'POST')   return corsResponse({ error: 'Método no permitido' }, 405);

  try {
    const body = await request.json();
    const { action, token } = body;

    if (!token) return corsResponse({ error: 'No autenticado' }, 401);

    const email = await verifyToken(token, SUPABASE_URL, SUPABASE_KEY);
    if (!email)  return corsResponse({ error: 'Sesión expirada' }, 401);

    /* Obtener datos del arquitecto */
    const arqRes = await fetch(
      `${SUPABASE_URL}/rest/v1/architects?email=eq.${encodeURIComponent(email)}&select=id,nombre,apellido,foto_url,patente&limit=1`,
      { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
    );
    const arqData = await arqRes.json();
    if (!arqData.length) return corsResponse({ error: 'Acceso no autorizado' }, 403);
    const architect = arqData[0];

    /* Comisión reducida para cliente propio */
    const comision_pct = architect.patente ? 10 : 20;
    const arq_pct      = architect.patente ? 0.90 : 0.80;

    /* ── GET-QUOTE ─────────────────────────────────── */
    if (action === 'get-quote') {
      const { svc, servicio_subtipo, m2 } = body;
      if (!svc) return corsResponse({ error: 'Falta tipo de trámite' }, 400);

      /* Obtener UF actual */
      let uf = UF_FALLBACK;
      try {
        const ufRes = await fetch('https://mindicador.cl/api/uf', { headers: { Accept: 'application/json' } });
        if (ufRes.ok) { const d = await ufRes.json(); if (d?.serie?.[0]?.valor) uf = d.serie[0].valor; }
      } catch(_) {}

      const uf_total   = calcUF({ svc, servicio_subtipo, m2 });
      const clp_total  = Math.round(uf_total * uf);
      const is2stages  = svc === 'informe' || svc === 'declaracion-jurada';
      const e1_clp     = Math.round(clp_total * (is2stages ? 0.50 : 0.20));
      const neto_base  = Math.round(clp_total / (1 + IVA_RATE));
      const arq_total  = Math.round(neto_base * arq_pct);
      const com_total  = clp_total - arq_total;

      return corsResponse({
        uf, uf_total: Math.round(uf_total * 100) / 100,
        clp_total, e1_clp, is2stages,
        comision_pct, arq_pct,
        arq_total, com_total,
      });
    }

    /* ── CREATE ────────────────────────────────────── */
    if (action === 'create') {
      const {
        client_nombre, client_apellido, client_rut, client_email, client_telefono,
        svc, servicio_subtipo, m2, commune, address,
        clp_total, e1_clp,
      } = body;

      if (!client_email || !client_nombre || !svc || !commune) {
        return corsResponse({ error: 'Faltan datos requeridos' }, 400);
      }
      if (!clp_total || !e1_clp) {
        return corsResponse({ error: 'Falta cotización (clp_total/e1_clp)' }, 400);
      }

      /* Generar número de proyecto */
      const maxRes  = await fetch(
        `${SUPABASE_URL}/rest/v1/projects?select=project_number&order=project_number.desc&limit=1`,
        { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
      );
      const maxData  = maxRes.ok ? await maxRes.json() : [];
      let nextSeq    = 100;
      if (maxData.length && maxData[0].project_number) {
        const m = maxData[0].project_number.match(/(\d+)$/);
        if (m) nextSeq = Math.max(parseInt(m[1], 10) + 1, 100);
      }
      const projectNumber = `ARQ-${new Date().getFullYear()}-${String(nextSeq).padStart(6, '0')}`;

      /* Crear proyecto */
      const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/projects`, {
        method: 'POST',
        headers: {
          'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`,
          'Content-Type': 'application/json', 'Prefer': 'return=minimal',
        },
        body: JSON.stringify({
          project_number:     projectNumber,
          client_email:       client_email.trim().toLowerCase(),
          client_nombre:      client_nombre.trim(),
          client_apellido:    client_apellido?.trim() || '',
          client_rut:         client_rut?.trim() || '',
          client_telefono:    client_telefono?.trim() || '',
          architect_email:    email,
          architect_nombre:   architect.nombre,
          architect_apellido: architect.apellido,
          service_type:       svc,
          servicio_subtipo:   servicio_subtipo || null,
          num_etapas_pago:    (svc === 'declaracion-jurada' || svc === 'informe') ? 2 : 4,
          address:            address?.trim() || '',
          commune,
          m2:                 Number(m2) || 0,
          total_clp:          Math.round(clp_total),
          e1_clp:             Math.round(e1_clp),
          stage:              'pendiente_pago',
          cliente_propio:     true,
          comision_pct,
        }),
      });

      if (!insertRes.ok) {
        const err = await insertRes.text();
        console.error('Error creando proyecto:', err);
        return corsResponse({ error: 'Error al crear proyecto' }, 500);
      }

      /* Crear preferencia de pago MP para E1 */
      const svcLabels = { regularizacion:'Regularización', ampliacion:'Ampliación', 'obra-nueva':'Obra Nueva', informe:'Informe de Propiedad', 'ley-del-mono':'Ley del Mono', 'declaracion-jurada':'Declaración Jurada' };
      const svcName   = svcLabels[svc] || svc;

      let init_point = null;
      try {
        const mpRes = await fetch('https://api.mercadopago.com/checkout/preferences', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${MP_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            items: [{ title: `APPARQ · ${projectNumber} · Pago E1 · ${svcName}`, quantity: 1, unit_price: Math.round(e1_clp), currency_id: 'CLP' }],
            payer: { email: client_email.trim().toLowerCase() },
            back_urls: { success: 'https://apparq.cl/?pago=aprobado', pending: 'https://apparq.cl/?pago=pendiente', failure: 'https://apparq.cl/?pago=rechazado' },
            auto_return: 'approved',
            external_reference: projectNumber,
            notification_url: 'https://apparq.cl/api/mp-webhook',
            statement_descriptor: 'APPARQ',
            payment_methods: { installments: 12 },
          }),
        });
        if (mpRes.ok) { const d = await mpRes.json(); init_point = d.init_point; }
        else console.error('MP preference error:', await mpRes.text());
      } catch(e) { console.error('Error creando preferencia MP:', e); }

      const fecha = new Date().toLocaleDateString('es-CL', { day: '2-digit', month: 'long', year: 'numeric' });
      const nombreCliente = `${client_nombre} ${client_apellido || ''}`.trim();
      const RETENCION = 0.1525;
      const brutoBoleta = Math.round(clp_total * arq_pct);
      const retencion   = Math.round(brutoBoleta * RETENCION);
      const netoArq     = brutoBoleta - retencion;
      const comMonto    = clp_total - brutoBoleta;

      /* Email al cliente con cotización y link de pago */
      await sendEmail({
        to: client_email.trim().toLowerCase(),
        subject: `💳 Tu cotización APPARQ — ${svcName} · ${commune}`,
        html: `
          <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#1a1a2e">
            <div style="background:#1a1a2e;padding:28px 32px;text-align:center;border-radius:8px 8px 0 0">
              <h1 style="color:#fff;margin:0;font-size:22px">APPARQ</h1>
              <p style="color:#a0aec0;margin:6px 0 0;font-size:13px">Cotización de trámite</p>
            </div>
            <div style="background:#fff;padding:28px 32px;border:1px solid #e2e8f0;border-radius:0 0 8px 8px">
              <h2 style="margin-top:0;color:#1a1a2e;">Hola ${client_nombre}, aquí está tu cotización</h2>
              <p style="color:#4a5568;font-size:14px;line-height:1.7;">
                Tu arquitecto <strong>${architect.nombre} ${architect.apellido}</strong> ha ingresado tu trámite en la plataforma APPARQ. Para comenzar, realiza el primer pago (E1):
              </p>
              <div style="background:#FFF7ED;border:2px solid #E8503A;border-radius:8px;padding:18px 20px;margin:20px 0;text-align:center;">
                <p style="margin:0 0 4px;font-size:11px;color:#92400E;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;">Primer pago — E1</p>
                <p style="margin:0;font-size:32px;font-weight:900;color:#E8503A;">${clpFmt(e1_clp)}</p>
                <p style="margin:6px 0 0;font-size:12px;color:#78350F;">${svcName} · ${commune}</p>
              </div>
              <table style="width:100%;border-collapse:collapse;font-size:13px;margin-bottom:20px;">
                <tr style="background:#f7fafc"><td style="padding:8px 10px;color:#718096;width:45%">N° Trámite</td><td style="padding:8px 10px;font-weight:700;color:#E8503A;">${projectNumber}</td></tr>
                <tr><td style="padding:8px 10px;color:#718096">Servicio</td><td style="padding:8px 10px;font-weight:700;">${svcName} · ${commune}</td></tr>
                <tr style="background:#f7fafc"><td style="padding:8px 10px;color:#718096">Precio total</td><td style="padding:8px 10px;font-weight:700;">${clpFmt(clp_total)}</td></tr>
                <tr><td style="padding:8px 10px;color:#718096">Arquitecto</td><td style="padding:8px 10px;">${architect.nombre} ${architect.apellido}</td></tr>
                <tr style="background:#f7fafc"><td style="padding:8px 10px;color:#718096">Fecha</td><td style="padding:8px 10px;">${fecha}</td></tr>
              </table>
              ${init_point ? `
              <div style="text-align:center;margin:24px 0;">
                <a href="${init_point}" style="display:inline-block;background:#E8503A;color:#fff;text-decoration:none;font-weight:700;font-size:16px;padding:14px 40px;border-radius:8px;letter-spacing:0.5px;">PAGAR AHORA →</a>
              </div>
              <p style="font-size:12px;color:#718096;text-align:center;margin-top:8px;">Puedes pagar en cuotas con tu tarjeta de crédito a través de Mercado Pago.</p>
              ` : ''}
              <div style="background:#EEF2FF;border:1.5px solid #C7D2FE;border-radius:8px;padding:12px 16px;margin-top:16px;">
                <p style="margin:0;font-size:13px;font-weight:700;color:#3730A3;">¿Cómo funciona el pago?</p>
                <p style="margin:6px 0 0;font-size:12px;color:#4338CA;line-height:1.6;">
                  El trámite se divide en ${(svc === 'informe' || svc === 'declaracion-jurada') ? '2 pagos de 50% cada uno' : '4 etapas (20% — 30% — 30% — 20%)'}.
                  Solo pagas cada cuota cuando tu arquitecto completa la etapa correspondiente.
                </p>
              </div>
              <hr style="border:none;border-top:1px solid #e2e8f0;margin:24px 0 14px">
              <p style="font-size:11px;color:#a0aec0;margin:0">APPARQ SpA · RUT 78.441.391-8 · hola@apparq.cl</p>
            </div>
          </div>`,
      }, env);

      /* Notificación interna a hola@apparq.cl */
      await sendEmail({
        to: 'hola@apparq.cl',
        subject: `🤝 Cliente propio ingresado — ${projectNumber} · ${architect.nombre} ${architect.apellido}`,
        html: `
          <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#1a1a2e">
            <div style="background:#1a1a2e;padding:24px 32px;border-radius:8px 8px 0 0">
              <h2 style="color:#fff;margin:0;font-size:18px">APPARQ — Cliente propio ingresado</h2>
            </div>
            <div style="background:#EDE9FE;border:2px solid #C4B5FD;padding:12px 32px">
              <p style="margin:0;font-size:13px;font-weight:700;color:#5B21B6">🤝 El arquitecto ingresó su propio cliente — comisión reducida (${comision_pct}%)</p>
            </div>
            <div style="background:#fff;padding:24px 32px;border:1px solid #e2e8f0;border-radius:0 0 8px 8px">
              <table style="width:100%;border-collapse:collapse;font-size:13px;">
                <tr style="background:#f7fafc"><td style="padding:8px 10px;color:#718096;width:40%">N° Trámite</td><td style="padding:8px 10px;font-weight:900;color:#E8503A">${projectNumber}</td></tr>
                <tr><td style="padding:8px 10px;color:#718096">Servicio</td><td style="padding:8px 10px;font-weight:700">${svcName} · ${commune}</td></tr>
                <tr style="background:#f7fafc"><td style="padding:8px 10px;color:#718096">Cliente</td><td style="padding:8px 10px">${nombreCliente} · ${client_email}</td></tr>
                <tr><td style="padding:8px 10px;color:#718096">RUT cliente</td><td style="padding:8px 10px">${client_rut || '—'}</td></tr>
                <tr style="background:#f7fafc"><td style="padding:8px 10px;color:#718096">Arquitecto</td><td style="padding:8px 10px">${architect.nombre} ${architect.apellido} · ${email}</td></tr>
                <tr><td style="padding:8px 10px;color:#718096">Precio total</td><td style="padding:8px 10px;font-weight:700">${clpFmt(clp_total)}</td></tr>
                <tr style="background:#f7fafc"><td style="padding:8px 10px;color:#718096">Comisión APPARQ (${comision_pct}%)</td><td style="padding:8px 10px;color:#E8503A;font-weight:700">${clpFmt(comMonto)}</td></tr>
                <tr><td style="padding:8px 10px;color:#718096">Bruto arquitecto</td><td style="padding:8px 10px;font-weight:700">${clpFmt(brutoBoleta)}</td></tr>
                <tr style="background:#f7fafc"><td style="padding:8px 10px;color:#718096">Retención SII (15,25%)</td><td style="padding:8px 10px;color:#DC2626">−${clpFmt(retencion)}</td></tr>
                <tr><td style="padding:8px 10px;color:#718096;font-weight:700">Neto arquitecto</td><td style="padding:8px 10px;font-weight:900;color:#059669">${clpFmt(netoArq)}</td></tr>
                <tr style="background:#f7fafc"><td style="padding:8px 10px;color:#718096">E1 a recibir</td><td style="padding:8px 10px;font-weight:700">${clpFmt(e1_clp)}</td></tr>
                <tr><td style="padding:8px 10px;color:#718096">Fecha</td><td style="padding:8px 10px">${fecha}</td></tr>
              </table>
              <div style="background:#FEF3C7;border:1.5px solid #FCD34D;border-radius:8px;padding:12px 16px;margin-top:16px;">
                <p style="margin:0;font-size:12px;font-weight:700;color:#92400E;">ℹ️ Patente: ${architect.patente ? 'Sí — comisión 10%' : 'No — comisión 20%'}</p>
              </div>
            </div>
          </div>`,
      }, env);

      return corsResponse({ ok: true, project_number: projectNumber, init_point });
    }

    return corsResponse({ error: 'Acción no reconocida' }, 400);

  } catch (err) {
    console.error('architect-add-client error:', err);
    return corsResponse({ error: 'Error interno' }, 500);
  }
}

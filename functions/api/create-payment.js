/* ══════════════════════════════════════════════════
   APPARQ — Cloudflare Pages Function: create-payment
   Crea una preferencia de pago en Mercado Pago
   y retorna la URL del Checkout Pro.
   POST /api/create-payment
   Body: { amount, description, email, reference }
══════════════════════════════════════════════════ */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

function corsResponse(body, status = 200) {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: CORS });
}

export async function onRequest(context) {
  const { request, env } = context;
  const MP_ACCESS_TOKEN = env.MP_ACCESS_TOKEN || 'APP_USR-8464091449756756-032117-1cb0461b0053151dd99159498a8ebb3c-3280513372';

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }
  if (request.method !== 'POST') {
    return corsResponse({ error: 'Método no permitido' }, 405);
  }
  if (!MP_ACCESS_TOKEN) {
    return corsResponse({ error: 'Token MP no configurado' }, 500);
  }

  try {
    const { amount, description, email, reference } = await request.json();

    if (!amount || !description) {
      return corsResponse({ error: 'Faltan parámetros: amount, description' }, 400);
    }

    const preference = {
      items: [{
        title:      description,
        quantity:   1,
        unit_price: Math.round(Number(amount)), /* CLP: sin decimales */
        currency_id: 'CLP',
      }],
      payer: {
        email: email || 'cliente@apparq.cl',
      },
      back_urls: {
        success: 'https://apparq.cl/?pago=aprobado',
        pending: 'https://apparq.cl/?pago=pendiente',
        failure: 'https://apparq.cl/?pago=rechazado',
      },
      auto_return:          'approved',
      external_reference:   reference || `apparq-${Date.now()}`,
      notification_url:     'https://apparq.cl/api/mp-webhook',
      statement_descriptor: 'APPARQ',
      payment_methods: {
        excluded_payment_types: [],   /* acepta todos: WebPay, tarjetas, etc. */
        installments: 1,              /* sin cuotas — pago único */
      },
    };

    const res = await fetch('https://api.mercadopago.com/checkout/preferences', {
      method:  'POST',
      headers: {
        'Authorization': `Bearer ${MP_ACCESS_TOKEN}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify(preference),
    });

    const data = await res.json();

    if (!res.ok) {
      console.error('MP error:', JSON.stringify(data));
      return corsResponse({ error: 'Error al crear preferencia en Mercado Pago', detail: data }, 502);
    }

    return corsResponse({
      id:                   data.id,
      init_point:           data.init_point,           /* producción */
      sandbox_init_point:   data.sandbox_init_point,   /* pruebas    */
    });

  } catch (err) {
    console.error('Error inesperado:', err);
    return corsResponse({ error: 'Error interno del servidor' }, 500);
  }
}

/* ══════════════════════════════════════════════════
   APPARQ — Netlify Function: create-payment
   Crea una preferencia de pago en Mercado Pago
   y retorna la URL del Checkout Pro.
   POST /.netlify/functions/create-payment
   Body: { amount, description, email, reference }
══════════════════════════════════════════════════ */

const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Método no permitido' }) };
  }
  if (!MP_ACCESS_TOKEN) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Token MP no configurado' }) };
  }

  try {
    const { amount, description, email, reference } = JSON.parse(event.body || '{}');

    if (!amount || !description) {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Faltan parámetros: amount, description' }) };
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
      notification_url:     'https://apparq.cl/.netlify/functions/mp-webhook',
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
      return {
        statusCode: 502,
        headers: CORS,
        body: JSON.stringify({ error: 'Error al crear preferencia en Mercado Pago', detail: data }),
      };
    }

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        id:                   data.id,
        init_point:           data.init_point,           /* producción */
        sandbox_init_point:   data.sandbox_init_point,   /* pruebas    */
      }),
    };

  } catch (err) {
    console.error('Error inesperado:', err);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Error interno del servidor' }) };
  }
};

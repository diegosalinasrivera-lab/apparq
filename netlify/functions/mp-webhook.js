/* ══════════════════════════════════════════════════
   APPARQ — Netlify Function: mp-webhook
   Recibe notificaciones IPN de Mercado Pago y
   registra el pago en Supabase.
   POST /.netlify/functions/mp-webhook
══════════════════════════════════════════════════ */

const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN;
const SUPABASE_URL    = process.env.SUPABASE_URL;
const SUPABASE_KEY    = process.env.SUPABASE_ANON_KEY;

exports.handler = async (event) => {
  /* MP envía GET para verificar y POST con la notificación */
  if (event.httpMethod === 'GET') {
    return { statusCode: 200, body: 'OK' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  try {
    const params = event.queryStringParameters || {};
    const topic  = params.topic || params.type;
    const id     = params.id || params['data.id'];

    console.log('MP Webhook recibido:', { topic, id });

    /* Solo procesamos pagos */
    if (topic !== 'payment' && topic !== 'merchant_order') {
      return { statusCode: 200, body: 'Ignorado' };
    }

    /* Consultar el pago a MP */
    const mpRes = await fetch(`https://api.mercadopago.com/v1/payments/${id}`, {
      headers: { 'Authorization': `Bearer ${MP_ACCESS_TOKEN}` },
    });

    if (!mpRes.ok) {
      console.error('No se pudo consultar el pago:', id);
      return { statusCode: 200, body: 'Error al consultar pago' };
    }

    const payment = await mpRes.json();
    console.log('Pago MP:', {
      id:         payment.id,
      status:     payment.status,
      amount:     payment.transaction_amount,
      reference:  payment.external_reference,
      email:      payment.payer?.email,
    });

    /* Guardar en Supabase si el pago fue aprobado */
    if (SUPABASE_URL && SUPABASE_KEY && payment.status === 'approved') {
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
          'apikey':        SUPABASE_KEY,
          'Authorization': `Bearer ${SUPABASE_KEY}`,
          'Content-Type':  'application/json',
          'Prefer':        'return=minimal',
        },
        body: JSON.stringify(record),
      });

      if (!sbRes.ok) {
        const err = await sbRes.text();
        console.error('Error Supabase al guardar pago:', err);
        /* No fallamos — respondemos OK a MP igual */
      } else {
        console.log('Pago guardado en Supabase:', payment.id);
      }
    }

    return { statusCode: 200, body: 'OK' };

  } catch (err) {
    console.error('Error en webhook:', err);
    /* Siempre responder 200 a MP para que no reintente */
    return { statusCode: 200, body: 'Error procesado' };
  }
};

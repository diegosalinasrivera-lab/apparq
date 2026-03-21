/* ══════════════════════════════════════════════════
   APPARQ — Netlify Function: mp-webhook
   Recibe notificaciones IPN de Mercado Pago,
   registra el pago en Supabase y envía emails
   vía Resend.
   POST /.netlify/functions/mp-webhook
══════════════════════════════════════════════════ */

const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN;
const SUPABASE_URL    = process.env.SUPABASE_URL;
const SUPABASE_KEY    = process.env.SUPABASE_ANON_KEY;
const RESEND_API_KEY  = process.env.RESEND_API_KEY;

/* ── Envío de email vía Resend ─────────────────── */
async function sendEmail({ to, subject, html }) {
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

    /* Guardar en Supabase y enviar emails si el pago fue aprobado */
    if (payment.status === 'approved') {

      /* 1 — Guardar en Supabase */
      if (SUPABASE_URL && SUPABASE_KEY) {
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
        } else {
          console.log('Pago guardado en Supabase:', payment.id);
        }
      }

      const monto     = formatCLP(payment.transaction_amount);
      const referencia = payment.external_reference || String(payment.id);
      const emailCliente = payment.payer?.email;
      const fecha     = new Date().toLocaleDateString('es-CL', { day: '2-digit', month: 'long', year: 'numeric' });

      /* 2 — Email interno a hola@apparq.cl */
      await sendEmail({
        to:      'hola@apparq.cl',
        subject: `Nuevo pago recibido — ${monto} — ${referencia}`,
        html: `
          <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto">
            <h2 style="color:#1a1a2e">💰 Nuevo pago aprobado</h2>
            <table style="width:100%;border-collapse:collapse">
              <tr><td style="padding:8px;color:#666">Monto</td><td style="padding:8px;font-weight:bold">${monto}</td></tr>
              <tr style="background:#f9f9f9"><td style="padding:8px;color:#666">Referencia</td><td style="padding:8px">${referencia}</td></tr>
              <tr><td style="padding:8px;color:#666">Email cliente</td><td style="padding:8px">${emailCliente || '—'}</td></tr>
              <tr style="background:#f9f9f9"><td style="padding:8px;color:#666">ID Pago MP</td><td style="padding:8px">${payment.id}</td></tr>
              <tr><td style="padding:8px;color:#666">Método de pago</td><td style="padding:8px">${payment.payment_type_id || '—'}</td></tr>
              <tr style="background:#f9f9f9"><td style="padding:8px;color:#666">Fecha</td><td style="padding:8px">${fecha}</td></tr>
            </table>
            <p style="margin-top:24px;color:#888;font-size:12px">APPARQ — Sistema automático de notificaciones</p>
          </div>
        `,
      });

      /* 3 — Email de confirmación al cliente */
      if (emailCliente) {
        await sendEmail({
          to:      emailCliente,
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
                  <p style="margin:0"><strong>Fecha:</strong> ${fecha}</p>
                </div>
                <p style="color:#4a5568">Nuestro equipo se pondrá en contacto contigo a la brevedad para coordinar los próximos pasos de tu trámite.</p>
                <p style="color:#4a5568">Si tienes preguntas, escríbenos a <a href="mailto:hola@apparq.cl" style="color:#667eea">hola@apparq.cl</a></p>
                <hr style="border:none;border-top:1px solid #e2e8f0;margin:24px 0">
                <p style="color:#a0aec0;font-size:12px;margin:0">APPARQ — DSR ARQ SPA · RUT 76.341.206-7<br>apparq.cl</p>
              </div>
            </div>
          `,
        });
      }
    }

    return { statusCode: 200, body: 'OK' };

  } catch (err) {
    console.error('Error en webhook:', err);
    /* Siempre responder 200 a MP para que no reintente */
    return { statusCode: 200, body: 'Error procesado' };
  }
};

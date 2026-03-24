/* ══════════════════════════════════════════════════
   APPARQ — Netlify Function: register-architect
   Recibe el formulario de inscripción de arquitecto,
   lo guarda en Supabase y envía emails de confirmación.
══════════════════════════════════════════════════ */

const SUPABASE_URL   = process.env.SUPABASE_URL;
const SUPABASE_KEY   = process.env.SUPABASE_ANON_KEY;
const RESEND_API_KEY = process.env.RESEND_API_KEY;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

async function sendEmail({ to, subject, html }) {
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
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Método no permitido' }) };
  }
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Error de configuración del servidor' }) };
  }

  try {
    const data = JSON.parse(event.body || '{}');

    if (!data.nombre || !data.apellido || !data.email) {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Faltan campos obligatorios: nombre, apellido, email' }) };
    }

    const comunas  = data.comunas  ? data.comunas.split(',').map(c => c.trim()).filter(Boolean)  : [];
    const tramites = data.tramites ? data.tramites.split(',').map(t => t.trim()).filter(Boolean) : [];

    const payload = {
      nombre:      data.nombre.trim(),
      apellido:    data.apellido.trim(),
      email:       data.email.trim().toLowerCase(),
      telefono:    data.telefono?.trim()    || null,
      rut:         data.rut?.trim()         || null,
      experiencia: data.experiencia?.trim() || null,
      patente:     data.patente?.trim()     || null,
      tramites,
      comunas,
      mensaje:     data.mensaje?.trim()     || null,
      foto_url:    data.foto_url            || null,
      activo:      true,
    };

    /* Guardar en Supabase */
    let saved = [{}];
    try {
      const res = await fetch(`${SUPABASE_URL}/rest/v1/architects`, {
        method: 'POST',
        headers: {
          'apikey':        SUPABASE_KEY,
          'Authorization': `Bearer ${SUPABASE_KEY}`,
          'Content-Type':  'application/json',
          'Prefer':        'return=representation',
        },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const errText = await res.text();
        console.error('Supabase error:', errText);
      } else {
        saved = await res.json();
      }
    } catch (dbErr) {
      console.error('Supabase fetch error:', dbErr);
    }
    const nombreCompleto = `${payload.nombre} ${payload.apellido}`;
    const fecha = new Date().toLocaleDateString('es-CL', { day: '2-digit', month: 'long', year: 'numeric' });

    /* ── Bloque de firma (si viene como base64) ── */
    const firmaBlock = data.firma_data
      ? `<div style="margin-top:16px;padding:12px 16px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;">
           <p style="margin:0 0 8px;font-size:11px;color:#718096;font-weight:700;text-transform:uppercase;">Firma digital del contrato</p>
           <img src="${data.firma_data}" style="max-width:100%;height:auto;border:1px solid #cbd5e0;border-radius:4px;" alt="Firma" />
         </div>`
      : '<p style="font-size:12px;color:#a0aec0;font-style:italic;">Firma registrada digitalmente</p>';

    /* ── Email interno a hola@apparq.cl ── */
    await sendEmail({
      to:      'hola@apparq.cl',
      subject: `🏗 Nueva inscripción de arquitecto — ${nombreCompleto}`,
      html: `
        <div style="font-family:Arial,sans-serif;max-width:640px;margin:0 auto;color:#1a1a2e">
          <div style="background:#1a1a2e;padding:28px 32px;border-radius:8px 8px 0 0">
            <h1 style="color:#fff;margin:0;font-size:20px">APPARQ</h1>
            <p style="color:#a0aec0;margin:6px 0 0;font-size:13px">Nueva inscripción de arquitecto</p>
          </div>
          <div style="background:#fff;padding:28px 32px;border:1px solid #e2e8f0;border-radius:0 0 8px 8px">
            <h2 style="margin-top:0;font-size:16px;color:#1a1a2e">👤 Datos del arquitecto</h2>
            ${data.foto_url ? `<div style="margin-bottom:16px;"><img src="${data.foto_url}" style="width:80px;height:80px;border-radius:50%;object-fit:cover;border:3px solid #e2e8f0;" alt="${nombreCompleto}" /></div>` : ''}
            <table style="width:100%;border-collapse:collapse;font-size:13px">
              <tr style="background:#f7fafc"><td style="padding:8px 10px;color:#718096;width:38%">Nombre</td><td style="padding:8px 10px;font-weight:700">${nombreCompleto}</td></tr>
              <tr><td style="padding:8px 10px;color:#718096">Email</td><td style="padding:8px 10px">${payload.email}</td></tr>
              <tr style="background:#f7fafc"><td style="padding:8px 10px;color:#718096">Teléfono</td><td style="padding:8px 10px">${payload.telefono || '—'}</td></tr>
              <tr><td style="padding:8px 10px;color:#718096">RUT</td><td style="padding:8px 10px">${payload.rut || '—'}</td></tr>
              <tr style="background:#f7fafc"><td style="padding:8px 10px;color:#718096">Patente profesional</td><td style="padding:8px 10px">${payload.patente || '—'}</td></tr>
              <tr><td style="padding:8px 10px;color:#718096">Experiencia</td><td style="padding:8px 10px">${payload.experiencia || '—'}</td></tr>
              <tr style="background:#f7fafc"><td style="padding:8px 10px;color:#718096">Comunas</td><td style="padding:8px 10px">${comunas.join(', ') || '—'}</td></tr>
              <tr><td style="padding:8px 10px;color:#718096">Trámites</td><td style="padding:8px 10px">${tramites.join(', ') || '—'}</td></tr>
              <tr style="background:#f7fafc"><td style="padding:8px 10px;color:#718096">Mensaje</td><td style="padding:8px 10px">${payload.mensaje || '—'}</td></tr>
              <tr><td style="padding:8px 10px;color:#718096">Fecha</td><td style="padding:8px 10px">${fecha}</td></tr>
            </table>
            <h2 style="margin-top:24px;font-size:16px;color:#1a1a2e">📝 Contrato firmado</h2>
            ${firmaBlock}
            <p style="margin-top:24px;font-size:11px;color:#a0aec0">APPARQ — Sistema automático · ${fecha}</p>
          </div>
        </div>
      `,
    });

    /* ── Email de bienvenida al arquitecto ── */
    await sendEmail({
      to:      payload.email,
      subject: `✅ Tu inscripción en APPARQ fue recibida — ${nombreCompleto}`,
      html: `
        <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#1a1a2e">
          <div style="background:#1a1a2e;padding:32px;text-align:center;border-radius:8px 8px 0 0">
            <h1 style="color:#fff;margin:0;font-size:26px;letter-spacing:-0.5px">APPARQ</h1>
            <p style="color:#a0aec0;margin:8px 0 0;font-size:13px">Plataforma de arquitectura</p>
          </div>
          <div style="background:#fff;padding:32px;border:1px solid #e2e8f0;border-radius:0 0 8px 8px">
            <h2 style="margin-top:0;color:#1a1a2e">¡Hola ${payload.nombre}! Tu inscripción fue recibida 🎉</h2>
            <p style="color:#4a5568;font-size:14px;line-height:1.7">
              Gracias por registrarte como arquitecto en APPARQ. Hemos recibido tu solicitud y la revisaremos en las próximas 24–48 horas hábiles.
            </p>

            <div style="background:#f0fdf4;border:1.5px solid #bbf7d0;border-radius:8px;padding:16px 20px;margin:20px 0">
              <p style="margin:0 0 6px;font-size:13px"><strong>✓ Nombre:</strong> ${nombreCompleto}</p>
              <p style="margin:0 0 6px;font-size:13px"><strong>✓ Email:</strong> ${payload.email}</p>
              <p style="margin:0 0 6px;font-size:13px"><strong>✓ Comunas:</strong> ${comunas.join(', ') || '—'}</p>
              <p style="margin:0;font-size:13px"><strong>✓ Trámites:</strong> ${tramites.join(', ') || '—'}</p>
            </div>

            <h3 style="color:#1a1a2e;font-size:14px;margin-top:24px">📝 Copia de tu contrato firmado</h3>
            ${firmaBlock}

            <h3 style="color:#1a1a2e;font-size:14px;margin-top:24px">⏱ ¿Qué sigue?</h3>
            <ol style="color:#4a5568;font-size:13px;line-height:2;padding-left:20px;margin:8px 0">
              <li>Revisaremos tu ficha y validaremos tus antecedentes</li>
              <li>Recibirás un email de activación cuando estés disponible en tu(s) comuna(s)</li>
              <li>Podrás ingresar al <strong>Portal Arquitecto</strong> en apparq.cl con tu email y contraseña</li>
            </ol>

            <div style="background:#FFF7ED;border:1.5px solid #FED7AA;border-radius:8px;padding:14px 18px;margin-top:24px">
              <p style="margin:0;font-size:12px;color:#92400E;font-weight:700">⚠️ Recuerda</p>
              <p style="margin:6px 0 0;font-size:12px;color:#78350F;line-height:1.6">
                Todos los pagos y comunicaciones con clientes deben hacerse exclusivamente a través de <strong>apparq.cl</strong>, según el contrato firmado.
              </p>
            </div>

            <hr style="border:none;border-top:1px solid #e2e8f0;margin:28px 0 16px">
            <p style="font-size:11px;color:#a0aec0;margin:0">
              APPARQ · DSR ARQ SPA · RUT 76.341.206-7 · Santiago, Chile<br>
              ¿Consultas? <a href="mailto:hola@apparq.cl" style="color:#667eea">hola@apparq.cl</a>
            </p>
          </div>
        </div>
      `,
    });

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({ success: true, id: saved[0]?.id }),
    };

  } catch (err) {
    console.error('Error inesperado:', err);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Error interno del servidor' }) };
  }
};

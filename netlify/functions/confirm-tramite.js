/* ══════════════════════════════════════════════════
   APPARQ — Netlify Function: confirm-tramite
   Recibe los datos del trámite confirmado (pago + arquitecto)
   y envía emails a cliente y a hola@apparq.cl
   POST /.netlify/functions/confirm-tramite
══════════════════════════════════════════════════ */

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const SUPABASE_URL   = process.env.SUPABASE_URL;
const SUPABASE_KEY   = process.env.SUPABASE_ANON_KEY;

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
  else         console.log('Email enviado a:', to);
}

function clpFmt(n) {
  return '$' + Math.round(n).toLocaleString('es-CL');
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const headers = {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  try {
    const body = JSON.parse(event.body || '{}');
    const {
      nombre, apellido, email, telefono, rut, direccion,
      svc, m2, commune, clp, e1,
      arquitecto,   /* { nombre, apellido, comunas, tramites, foto_url, calificacion } o null */
      firma_data,   /* base64 PNG de la firma del cliente */
      payment_id,   /* ID de pago de Mercado Pago */
    } = body;

    /* ── Crear proyecto en Supabase ─────────────── */
    let projectNumber = null;
    if (SUPABASE_URL && SUPABASE_KEY && email) {
      try {
        /* Generar número secuencial: contar proyectos existentes */
        const countRes = await fetch(
          `${SUPABASE_URL}/rest/v1/projects?select=id`,
          { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Prefer': 'count=exact' } }
        );
        const countHeader = parseInt(countRes.headers.get('content-range')?.split('/')[1] || '0', 10);
        const seq = String(countHeader + 1).padStart(6, '0');
        projectNumber = `ARQ-${new Date().getFullYear()}-${seq}`;

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
            project_number:   projectNumber,
            client_email:     email.trim().toLowerCase(),
            client_nombre:    nombre  || '',
            client_apellido:  apellido || '',
            client_telefono:  telefono || '',
            client_rut:       rut      || '',
            architect_email:  architect_email,
            architect_nombre: arquitecto?.nombre  || '',
            architect_apellido: arquitecto?.apellido || '',
            service_type:     svc      || '',
            address:          direccion || '',
            commune:          commune  || '',
            m2:               m2       || 0,
            total_clp:        clp      || 0,
            e1_clp:           e1       || 0,
            stage:            'levantamiento',
          }),
        });
      } catch (projErr) {
        console.warn('Error creando proyecto:', projErr);
      }
    }

    const fecha     = new Date().toLocaleDateString('es-CL', { day: '2-digit', month: 'long', year: 'numeric' });
    const svcLabels = { regularizacion:'Regularización', ampliacion:'Ampliación', 'obra-nueva':'Obra Nueva', informe:'Informe de Propiedad' };
    const svcName   = svcLabels[svc] || svc || 'Trámite';
    const nombreCliente = `${nombre || ''} ${apellido || ''}`.trim();
    const arqNombre = arquitecto ? `${arquitecto.nombre} ${arquitecto.apellido}` : 'Por asignar';

    /* ── Bloque de firma del cliente ── */
    const firmaClienteBlock = firma_data
      ? `<div style="margin-top:12px;padding:12px 16px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;">
           <p style="margin:0 0 8px;font-size:11px;color:#718096;font-weight:700;text-transform:uppercase;">Firma digital del cliente</p>
           <img src="${firma_data}" style="max-width:100%;height:auto;border:1px solid #cbd5e0;border-radius:4px;" alt="Firma cliente" />
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
    await sendEmail({
      to:      'hola@apparq.cl',
      subject: `🚀 Nuevo trámite iniciado — ${nombreCliente} · ${svcName} · ${commune}`,
      html: `
        <div style="font-family:Arial,sans-serif;max-width:640px;margin:0 auto;color:#1a1a2e">
          <div style="background:#1a1a2e;padding:28px 32px;border-radius:8px 8px 0 0">
            <h1 style="color:#fff;margin:0;font-size:20px">APPARQ</h1>
            <p style="color:#a0aec0;margin:6px 0 0;font-size:13px">Nuevo trámite confirmado</p>
          </div>
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
              ${arquitecto?.email ? `<tr><td style="padding:8px 10px;color:#718096">Email arq.</td><td style="padding:8px 10px">${arquitecto.email}</td></tr>` : ''}
              ${arquitecto?.comunas ? `<tr style="background:#f7fafc"><td style="padding:8px 10px;color:#718096">Comunas</td><td style="padding:8px 10px">${arquitecto.comunas.join(', ')}</td></tr>` : ''}
              ${arquitecto?.tramites ? `<tr><td style="padding:8px 10px;color:#718096">Trámites</td><td style="padding:8px 10px">${arquitecto.tramites.join(', ')}</td></tr>` : ''}
            </table>

            <p style="margin-top:24px;font-size:11px;color:#a0aec0">APPARQ — Sistema automático · ${fecha}</p>
          </div>
        </div>
      `,
    });

    /* ── Email de confirmación al cliente ─────── */
    if (email) {
      const esInforme = svc === 'informe';
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
                <li>Tu arquitecto te contactará en las próximas <strong>24 horas hábiles</strong> vía apparq.cl</li>
                <li>Coordinarán la visita a terreno para el levantamiento</li>
                ${esInforme
                  ? '<li>Recibirás tu informe en <strong>aproximadamente 2 semanas</strong></li>'
                  : '<li>Una vez entregados los planos, recibirás el aviso del pago E2</li><li>El trámite completo toma entre <strong>3 y 6 meses</strong></li>'
                }
              </ol>

              <div style="background:#FFF7ED;border:1.5px solid #FED7AA;border-radius:8px;padding:14px 18px;margin-top:24px">
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
      });
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ ok: true, project_number: projectNumber }),
    };

  } catch (err) {
    console.error('confirm-tramite error:', err);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: err.message }),
    };
  }
};

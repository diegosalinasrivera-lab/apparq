/* ══════════════════════════════════════════════════
   APPARQ — Cloudflare Pages Function: register-architect
   Recibe el formulario de inscripción de arquitecto,
   lo guarda en Supabase y envía emails de confirmación.
══════════════════════════════════════════════════ */

const CORS = {
  'Access-Control-Allow-Origin': '*',
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
  else console.log('Email enviado a:', to);
}

export async function onRequest(context) {
  const { request, env } = context;
  const SUPABASE_URL   = env.SUPABASE_URL || 'https://ibdafnzlsufsshczqvoa.supabase.co';
  const SUPABASE_KEY   = env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImliZGFmbnpsc3Vmc3NoY3pxdm9hIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NDQ0NDY2NDcsImV4cCI6MjA2MDIyNjY0N30.GyDKA0A9PhfHqKD8bm8rR_EVS45JtOBEMArXFBfXvQg';
  const RESEND_API_KEY = env.RESEND_API_KEY || 're_RRVTgGik_GtaRwK2p9jimrkemYTY4Uew6';

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }
  if (request.method !== 'POST') {
    return corsResponse({ error: 'Método no permitido' }, 405);
  }
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return corsResponse({ error: 'Error de configuración del servidor' }, 500);
  }

  try {
    const data = await request.json();

    if (!data.nombre || !data.apellido || !data.email) {
      return corsResponse({ error: 'Faltan campos obligatorios: nombre, apellido, email' }, 400);
    }

    const comunas  = data.comunas  ? data.comunas.split(',').map(c => c.trim()).filter(Boolean)  : [];
    const tramites = data.tramites ? data.tramites.split(',').map(t => t.trim()).filter(Boolean) : [];
    const sinPatente = !!data.sin_patente;
    const pctApp = sinPatente ? '30%' : '20%';
    const pctArq = sinPatente ? '70%' : '80%';

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
        console.error('Supabase error:', await res.text());
      } else {
        saved = await res.json();
      }
    } catch (dbErr) {
      console.error('Supabase fetch error:', dbErr);
    }

    const nombreCompleto = `${payload.nombre} ${payload.apellido}`;
    const fecha = new Date().toLocaleDateString('es-CL', { day: '2-digit', month: 'long', year: 'numeric' });

    /* ── Foto de perfil (base64 inline) ── */
    const fotoBlock = payload.foto_url
      ? `<img src="${payload.foto_url}" width="80" height="80" style="width:80px;height:80px;border-radius:50%;object-fit:cover;border:3px solid #e2e8f0;display:block;" alt="${nombreCompleto}" />`
      : `<div style="width:80px;height:80px;border-radius:50%;background:#f1f5f9;display:flex;align-items:center;justify-content:center;font-size:36px;">👷</div>`;

    /* ── Firma digital ── */
    const firmaBlock = data.firma_data
      ? `<img src="${data.firma_data}" style="max-width:260px;height:auto;border:1px solid #cbd5e0;border-radius:4px;display:block;" alt="Firma" />`
      : '<p style="font-size:12px;color:#a0aec0;font-style:italic;">Firmado digitalmente en apparq.cl</p>';

    /* ── Contrato completo ── */
    const contratoHTML = `
      <div style="background:#fff;border:2px solid #1a1a2e;border-radius:8px;padding:28px 32px;font-size:12px;color:#1a1a2e;line-height:1.7;margin-top:16px;">
        <div style="text-align:center;margin-bottom:20px;">
          <h2 style="margin:0 0 4px;font-size:15px;font-weight:900;letter-spacing:1px;">CONTRATO DE COLABORACIÓN PROFESIONAL</h2>
          <p style="margin:0;font-size:11px;color:#718096;">APPARQ — DSR ARQ SPA · RUT 76.341.206-7</p>
        </div>

        <p><strong>En Santiago de Chile, a ${fecha}</strong>, entre:</p>

        <p><strong>APPARQ (DSR ARQ SPA)</strong>, RUT 76.341.206-7, en adelante <em>"la Plataforma"</em>; y</p>

        <p><strong>${nombreCompleto}</strong>, RUT ${payload.rut || '—'}, arquitecto, en adelante <em>"el Profesional"</em>.</p>

        <table style="width:100%;border-collapse:collapse;font-size:12px;margin:16px 0;">
          <tr style="background:#f7fafc;"><td style="padding:6px 10px;color:#718096;width:38%">Nombre completo</td><td style="padding:6px 10px;font-weight:700;">${nombreCompleto}</td></tr>
          <tr><td style="padding:6px 10px;color:#718096;">RUT</td><td style="padding:6px 10px;">${payload.rut || '—'}</td></tr>
          <tr style="background:#f7fafc;"><td style="padding:6px 10px;color:#718096;">Email</td><td style="padding:6px 10px;">${payload.email}</td></tr>
          <tr><td style="padding:6px 10px;color:#718096;">Teléfono</td><td style="padding:6px 10px;">${payload.telefono || '—'}</td></tr>
          <tr style="background:#f7fafc;"><td style="padding:6px 10px;color:#718096;">Patente profesional</td><td style="padding:6px 10px;">${payload.patente || (sinPatente ? 'Sin patente' : '—')}</td></tr>
          <tr><td style="padding:6px 10px;color:#718096;">Experiencia</td><td style="padding:6px 10px;">${payload.experiencia || '—'}</td></tr>
          <tr style="background:#f7fafc;"><td style="padding:6px 10px;color:#718096;">Comunas</td><td style="padding:6px 10px;">${comunas.join(', ') || '—'}</td></tr>
          <tr><td style="padding:6px 10px;color:#718096;">Trámites</td><td style="padding:6px 10px;">${tramites.join(', ') || '—'}</td></tr>
        </table>

        <p><strong>CLÁUSULAS:</strong></p>
        <ol style="padding-left:18px;margin:8px 0;">
          <li>El Profesional prestará servicios de arquitectura a clientes asignados por APPARQ.</li>
          <li>El Profesional acepta que TODOS los contactos y pagos se realizan exclusivamente a través de apparq.cl.</li>
          <li>APPARQ recibirá el <strong>${pctApp}</strong> del valor neto de cada servicio como comisión de plataforma.</li>
          <li>El Profesional recibirá el <strong>${pctArq}</strong> del valor neto una vez completada cada etapa.</li>
          <li>El Profesional se compromete a responder al cliente en un plazo máximo de 24 horas hábiles.</li>
          <li>El Profesional no podrá captar directamente a los clientes asignados por APPARQ.</li>
          <li>TODOS los pagos del servicio (E1, E2, E3 y E4) deben procesarse mediante la plataforma.</li>
          <li>El Profesional acepta los Términos de Uso y Política de Privacidad de apparq.cl.</li>
          <li>APPARQ podrá desactivar al Profesional si incumple estas cláusulas.</li>
        </ol>

        <div style="margin-top:20px;padding-top:16px;border-top:1px solid #e2e8f0;">
          <p style="margin:0 0 8px;font-size:11px;color:#718096;font-weight:700;text-transform:uppercase;">Firma digital del profesional — ${fecha}</p>
          ${firmaBlock}
          <p style="margin:8px 0 0;font-size:11px;color:#718096;">Firmado electrónicamente por <strong>${nombreCompleto}</strong> (${payload.email}) en apparq.cl</p>
        </div>
      </div>`;

    /* ── Email interno a hola@apparq.cl ── */
    await sendEmail({
      to:      'hola@apparq.cl',
      subject: `🏗 Nueva inscripción de arquitecto — ${nombreCompleto}`,
      html: `
        <div style="font-family:Arial,sans-serif;max-width:640px;margin:0 auto;color:#1a1a2e;">
          <div style="background:#1a1a2e;padding:28px 32px;border-radius:8px 8px 0 0;">
            <h1 style="color:#fff;margin:0;font-size:20px;">APPARQ</h1>
            <p style="color:#a0aec0;margin:6px 0 0;font-size:13px;">Nueva inscripción de arquitecto · ${fecha}</p>
          </div>
          <div style="background:#fff;padding:28px 32px;border:1px solid #e2e8f0;border-radius:0 0 8px 8px;">
            <div style="display:flex;align-items:center;gap:16px;margin-bottom:20px;">
              ${fotoBlock}
              <div>
                <div style="font-size:17px;font-weight:900;">${nombreCompleto}</div>
                <div style="font-size:12px;color:#718096;">${payload.email} · ${payload.telefono || ''}</div>
                <div style="font-size:12px;color:#718096;">Comisión APPARQ: <strong style="color:#E8503A;">${pctApp}</strong></div>
              </div>
            </div>
            ${contratoHTML}
            <p style="margin-top:24px;font-size:11px;color:#a0aec0;">APPARQ — Sistema automático · ${fecha}</p>
          </div>
        </div>
      `,
    }, RESEND_API_KEY);

    /* ── Email de bienvenida al arquitecto ── */
    await sendEmail({
      to:      payload.email,
      subject: `✅ Tu inscripción en APPARQ fue recibida — ${nombreCompleto}`,
      html: `
        <div style="font-family:Arial,sans-serif;max-width:640px;margin:0 auto;color:#1a1a2e;">
          <div style="background:#1a1a2e;padding:32px;text-align:center;border-radius:8px 8px 0 0;">
            <h1 style="color:#fff;margin:0;font-size:26px;letter-spacing:-0.5px;">APPARQ</h1>
            <p style="color:#a0aec0;margin:8px 0 0;font-size:13px;">Plataforma de arquitectura</p>
          </div>
          <div style="background:#fff;padding:32px;border:1px solid #e2e8f0;border-radius:0 0 8px 8px;">
            <h2 style="margin-top:0;color:#1a1a2e;">¡Hola ${payload.nombre}! Tu inscripción fue recibida 🎉</h2>
            <p style="color:#4a5568;font-size:14px;line-height:1.7;">
              Gracias por unirte a APPARQ. Hemos recibido tu solicitud y la revisaremos en las próximas 24–48 horas hábiles. A continuación tu copia del contrato firmado.
            </p>

            <h3 style="color:#1a1a2e;font-size:14px;margin-top:24px;">📋 Copia de tu contrato de colaboración</h3>
            ${contratoHTML}

            <h3 style="color:#1a1a2e;font-size:14px;margin-top:28px;">⏱ ¿Qué sigue?</h3>
            <ol style="color:#4a5568;font-size:13px;line-height:2;padding-left:20px;margin:8px 0;">
              <li>Revisaremos tu ficha y validaremos tus antecedentes</li>
              <li>Recibirás un email de activación cuando estés disponible en tu(s) comuna(s)</li>
              <li>Podrás ingresar al <strong>Portal Arquitecto</strong> en apparq.cl con tu email y contraseña</li>
            </ol>

            <div style="background:#FFF7ED;border:1.5px solid #FED7AA;border-radius:8px;padding:14px 18px;margin-top:24px;">
              <p style="margin:0;font-size:12px;color:#92400E;font-weight:700;">⚠️ Recuerda</p>
              <p style="margin:6px 0 0;font-size:12px;color:#78350F;line-height:1.6;">
                Todos los pagos y comunicaciones con clientes deben hacerse exclusivamente a través de <strong>apparq.cl</strong>, según el contrato firmado.
              </p>
            </div>

            <hr style="border:none;border-top:1px solid #e2e8f0;margin:28px 0 16px;" />
            <p style="font-size:11px;color:#a0aec0;margin:0;">
              APPARQ · DSR ARQ SPA · RUT 76.341.206-7 · Santiago, Chile<br>
              ¿Consultas? <a href="mailto:hola@apparq.cl" style="color:#667eea;">hola@apparq.cl</a>
            </p>
          </div>
        </div>
      `,
    }, RESEND_API_KEY);

    return corsResponse({ success: true, id: saved[0]?.id });

  } catch (err) {
    console.error('Error inesperado:', err);
    return corsResponse({ error: 'Error interno del servidor' }, 500);
  }
}

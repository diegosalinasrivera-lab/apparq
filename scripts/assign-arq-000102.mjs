/**
 * ONE-TIME: Asignar ARQ-2026-000102 a Milagros Hidalgo.
 * Supabase ya actualizado. Este script solo envía los 2 correos.
 */

const RESEND_KEY = 're_RRVTgGik_GtaRwK2p9jimrkemYTY4Uew6';

const project = {
  project_number: 'ARQ-2026-000102',
  client_email:   'ceci_ivonne@live.cl',
  client_nombre:  'Cecilia',
  client_apellido:'Berrios',
  client_telefono:'997025843',
  service_type:   'ley-del-mono',
  servicio_subtipo: null,
  address:        'Pasaje Los Sauces 8315',
  commune:        'La Florida',
  m2:             12,
  total_clp:      571408.18,
  e1_clp:         114282,
};

const architect = {
  nombre:   'Milagros',
  apellido: 'Hidalgo',
  email:    'mhidalgoarquitecta@gmail.com',
  patente:  '303482',
  telefono: '974927866',
};

/* ── helpers ── */
function clpFmt(n) {
  return '$' + Math.round(n).toLocaleString('es-CL');
}

async function sendEmail(to, subject, html) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${RESEND_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: 'APPARQ <hola@apparq.cl>',
      to: [to],
      subject,
      html,
    }),
  });
  const data = await res.json();
  if (!res.ok) {
    console.error(`ERROR enviando a ${to}:`, data);
    return false;
  }
  console.log(`OK → ${to} | id: ${data.id}`);
  return true;
}

/* ── email al arquitecto (sendPaymentEmails template) ── */
async function sendArchitectEmail() {
  const clp       = project.total_clp;
  const e1        = project.e1_clp;
  const svcName   = 'Ley del Mono';
  const pnum      = project.project_number;
  const ARQ_PCT   = 0.80; // tiene patente
  const arqTotal  = Math.round(clp * ARQ_PCT);
  const clientName = `${project.client_nombre} ${project.client_apellido}`.trim();

  const payDue    = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000);
  const payDueFmt = payDue.toLocaleDateString('es-CL', { day:'2-digit', month:'long', year:'numeric' });

  // ley-del-mono → not informe, not DJ → is2stages = false
  const etapasArqBlock = `
    <tr><td style="padding:8px 10px;color:#718096">E1 · Levantamiento (ya pagado)</td><td style="padding:8px 10px;font-weight:700;color:#059669">${clpFmt(Math.round(e1*ARQ_PCT))} ✓</td></tr>
    <tr style="background:#f7fafc"><td style="padding:8px 10px;color:#718096">E2 · Elaboración de planos</td><td style="padding:8px 10px;font-weight:700">${clpFmt(Math.round(clp*0.30*ARQ_PCT))}</td></tr>
    <tr><td style="padding:8px 10px;color:#718096">E3 · Ingreso DOM</td><td style="padding:8px 10px;font-weight:700">${clpFmt(Math.round(clp*0.30*ARQ_PCT))}</td></tr>
    <tr style="background:#f7fafc"><td style="padding:8px 10px;color:#718096">E4 · Recepción final</td><td style="padding:8px 10px;font-weight:700">${clpFmt(Math.round(clp*0.20*ARQ_PCT))}</td></tr>`;

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#1a1a2e">
      <div style="background:#1a1a2e;padding:32px;text-align:center;border-radius:8px 8px 0 0">
        <h1 style="color:#fff;margin:0;font-size:26px;letter-spacing:-0.5px">APPARQ</h1>
        <p style="color:#a0aec0;margin:8px 0 0;font-size:13px">Se te ha asignado un nuevo trámite</p>
      </div>
      <div style="background:#fff;padding:32px;border:1px solid #e2e8f0;border-radius:0 0 8px 8px">
        <h2 style="margin-top:0;color:#1a1a2e">¡Hola ${architect.nombre}! Te asignaron un trámite 🎉</h2>
        <p style="color:#4a5568;font-size:14px;line-height:1.7;margin:0 0 20px;">Un cliente completó su pago y quedas a cargo de este proyecto. Contáctalo dentro de las próximas <strong>24 horas</strong> para coordinar la visita de levantamiento.</p>

        <div style="background:#FFF7ED;border:2px solid #E8503A;border-radius:8px;padding:14px 20px;margin:0 0 20px;text-align:center">
          <p style="margin:0 0 4px;font-size:12px;color:#92400E;font-weight:700;text-transform:uppercase;">N° de Trámite</p>
          <p style="margin:0;font-size:28px;font-weight:900;color:#E8503A;letter-spacing:2px">${pnum}</p>
        </div>

        <table style="width:100%;border-collapse:collapse;font-size:13px;margin-bottom:16px">
          <tr style="background:#f7fafc"><td style="padding:7px 10px;color:#718096;width:42%">Servicio</td><td style="padding:7px 10px;font-weight:700">${svcName}</td></tr>
          <tr><td style="padding:7px 10px;color:#718096">Dirección</td><td style="padding:7px 10px">${project.address}, ${project.commune}</td></tr>
          <tr style="background:#f7fafc"><td style="padding:7px 10px;color:#718096">Superficie</td><td style="padding:7px 10px">${project.m2} m²</td></tr>
        </table>

        <div style="background:#EFF6FF;border:2px solid #93C5FD;border-radius:8px;padding:18px 20px;margin:0 0 20px">
          <p style="margin:0 0 10px;font-size:13px;font-weight:800;color:#1E40AF">📞 Datos de contacto del cliente</p>
          <table style="width:100%;border-collapse:collapse;font-size:13px">
            <tr><td style="padding:5px 0;color:#3B82F6;width:36%">Nombre</td><td style="padding:5px 0;font-weight:700;color:#1E3A8A">${clientName}</td></tr>
            <tr><td style="padding:5px 0;color:#3B82F6">Email</td><td style="padding:5px 0"><a href="mailto:${project.client_email}" style="color:#1E40AF;font-weight:700">${project.client_email}</a></td></tr>
            <tr><td style="padding:5px 0;color:#3B82F6">Teléfono</td><td style="padding:5px 0;font-weight:700"><a href="tel:${project.client_telefono}" style="color:#1E40AF">+56 ${project.client_telefono}</a></td></tr>
          </table>
        </div>

        <div style="background:#f0fdf4;border:1.5px solid #86efac;border-radius:8px;padding:16px 20px;margin:20px 0">
          <p style="margin:0 0 10px;font-size:13px;font-weight:800;color:#15803d;">💰 Tus honorarios netos (${Math.round(ARQ_PCT*100)}%)</p>
          <table style="width:100%;border-collapse:collapse;font-size:13px">
            ${etapasArqBlock}
            <tr style="border-top:2px solid #86efac">
              <td style="padding:10px;color:#15803d;font-weight:800">TOTAL a recibir</td>
              <td style="padding:10px;font-weight:900;color:#15803d;font-size:15px">${clpFmt(arqTotal)}</td>
            </tr>
          </table>
          <p style="margin:10px 0 0;font-size:11px;color:#4ade80;">* Pago dentro de los 5 días hábiles tras la confirmación de pago del cliente, contra boleta de honorarios.</p>
        </div>

        <div style="background:#FEF3C7;border:1.5px solid #FCD34D;border-radius:8px;padding:14px 18px;margin-bottom:20px">
          <p style="margin:0 0 4px;font-size:13px;font-weight:700;color:#92400E">⏰ Primer pago — E1</p>
          <p style="margin:0;font-size:13px;color:#78350F;">Monto: <strong>${clpFmt(Math.round(clp*0.20*ARQ_PCT))}</strong> &nbsp;·&nbsp; Vence: <strong>${payDueFmt}</strong></p>
        </div>

        <h3 style="color:#1a1a2e;font-size:14px;margin-top:24px">🧾 Datos para emitir tu boleta de honorarios</h3>
        <table style="width:100%;border-collapse:collapse;font-size:13px">
          <tr style="background:#f7fafc"><td style="padding:8px 10px;color:#718096;width:42%">Razón Social</td><td style="padding:8px 10px;font-weight:700">APPARQ SpA</td></tr>
          <tr><td style="padding:8px 10px;color:#718096">RUT</td><td style="padding:8px 10px;font-weight:700">78.441.391-8</td></tr>
          <tr style="background:#f7fafc"><td style="padding:8px 10px;color:#718096">Giro</td><td style="padding:8px 10px">Arquitectura y servicios conexos</td></tr>
          <tr><td style="padding:8px 10px;color:#718096">Correo boleta</td><td style="padding:8px 10px">hola@apparq.cl</td></tr>
        </table>
        <p style="color:#4a5568;font-size:12px;margin:8px 0 0;line-height:1.6">Envía la boleta a <strong>hola@apparq.cl</strong> para que procesemos el pago. Sin boleta no se puede efectuar la transferencia.</p>

        <div style="background:#F0FDF4;border:1.5px solid #86EFAC;border-radius:8px;padding:16px 18px;margin-top:16px">
          <p style="margin:0 0 8px;font-size:13px;font-weight:700;color:#15803D">📤 Envíanos tus datos de transferencia</p>
          <ul style="margin:0;padding-left:18px;font-size:12px;color:#166534;line-height:2">
            <li>Banco</li><li>Tipo de cuenta (corriente / vista / ahorro)</li>
            <li>Número de cuenta</li><li>Nombre del titular</li>
            <li>RUT del titular</li><li>Email para comprobante</li>
          </ul>
          <p style="margin:8px 0 0;font-size:12px;color:#166534">Responde este correo o escríbenos a <strong>hola@apparq.cl</strong></p>
        </div>

        <hr style="border:none;border-top:1px solid #e2e8f0;margin:28px 0 16px">
        <p style="font-size:11px;color:#a0aec0;margin:0">APPARQ SpA · RUT 78.441.391-8<br>
        ¿Consultas? <a href="mailto:hola@apparq.cl" style="color:#667eea">hola@apparq.cl</a></p>
      </div>
    </div>
  `;

  return sendEmail(
    architect.email,
    `🏗 Te asignaron un trámite — ${pnum} · ${svcName} · ${project.commune} — APPARQ`,
    html
  );
}

/* ── email al cliente (template líneas 916-956 admin-data.js) ── */
async function sendClientEmail() {
  const pnum      = project.project_number;
  const svcName   = 'Ley del Mono';
  const clientName = `${project.client_nombre} ${project.client_apellido}`.trim();

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#1a1a2e">
      <div style="background:#1a1a2e;padding:32px;text-align:center;border-radius:8px 8px 0 0">
        <h1 style="color:#fff;margin:0;font-size:26px;letter-spacing:-0.5px">APPARQ</h1>
        <p style="color:#a0aec0;margin:8px 0 0;font-size:13px">Actualización de tu trámite</p>
      </div>
      <div style="background:#fff;padding:32px;border:1px solid #e2e8f0;border-radius:0 0 8px 8px">
        <h2 style="margin-top:0;color:#1a1a2e">Hola ${clientName} 👋</h2>
        <p style="color:#4a5568;font-size:14px;line-height:1.7;">Queremos informarte que el arquitecto asignado a tu trámite ha sido actualizado. A partir de ahora, el profesional a cargo de tu proyecto es:</p>

        <div style="background:#F0FDF4;border:2px solid #86EFAC;border-radius:8px;padding:20px 24px;margin:20px 0;text-align:center">
          <p style="margin:0 0 6px;font-size:12px;font-weight:700;color:#15803D;text-transform:uppercase">Tu arquitecta</p>
          <p style="margin:0;font-size:22px;font-weight:900;color:#1a1a2e">${architect.nombre} ${architect.apellido}</p>
          <p style="margin:8px 0 0;font-size:14px;color:#4a5568">📞 <a href="tel:${architect.telefono}" style="color:#E8503A;font-weight:700">+56 ${architect.telefono}</a></p>
          <p style="margin:6px 0 0;font-size:13px;color:#4a5568">✉️ <a href="mailto:${architect.email}" style="color:#E8503A">${architect.email}</a></p>
        </div>

        <table style="width:100%;border-collapse:collapse;font-size:13px;margin-bottom:20px">
          <tr style="background:#f7fafc"><td style="padding:7px 10px;color:#718096;width:42%">N° Trámite</td><td style="padding:7px 10px;font-weight:700;color:#E8503A">${pnum}</td></tr>
          <tr><td style="padding:7px 10px;color:#718096">Servicio</td><td style="padding:7px 10px">${svcName}</td></tr>
          <tr style="background:#f7fafc"><td style="padding:7px 10px;color:#718096">Dirección</td><td style="padding:7px 10px">${project.address}, ${project.commune}</td></tr>
        </table>

        <p style="color:#4a5568;font-size:14px;line-height:1.7;">Tu arquitecta te contactará a la brevedad para coordinar los próximos pasos. Si tienes alguna consulta, escríbenos a <a href="mailto:hola@apparq.cl" style="color:#E8503A">hola@apparq.cl</a>.</p>

        <hr style="border:none;border-top:1px solid #e2e8f0;margin:24px 0 14px">
        <p style="font-size:11px;color:#a0aec0;margin:0">APPARQ SpA · RUT 78.441.391-8<br>
        <a href="mailto:hola@apparq.cl" style="color:#667eea">hola@apparq.cl</a></p>
      </div>
    </div>
  `;

  return sendEmail(
    project.client_email,
    `👤 Tu arquitecta APPARQ — ${pnum}`,
    html
  );
}

/* ── main ── */
async function main() {
  console.log('Enviando email a arquitecta Milagros Hidalgo...');
  await sendArchitectEmail();

  console.log('Enviando email a cliente Cecilia Berrios...');
  await sendClientEmail();

  console.log('Listo.');
}

main();

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

async function sendEmail({ to, subject, html, attachments }, RESEND_API_KEY) {
  if (!RESEND_API_KEY) { console.warn('Sin RESEND_API_KEY'); return; }
  const body = { from: 'APPARQ <hola@apparq.cl>', to, subject, html };
  if (attachments && attachments.length) body.attachments = attachments;
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${RESEND_API_KEY}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) console.error('Resend error:', await res.text());
  else console.log('Email enviado a:', to);
}

export async function onRequest(context) {
  const { request, env } = context;
  const SUPABASE_URL   = env.SUPABASE_URL || 'https://ibdafnzlsufsshczqvoa.supabase.co';
  const SUPABASE_KEY   = env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImliZGFmbnpsc3Vmc3NoY3pxdm9hIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM5Njg0NjYsImV4cCI6MjA4OTU0NDQ2Nn0.ucEjCcnSbaz-OeMrLbUbgcKacvg9J2Csg2VzrWVtVHA';
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

    const comunas  = Array.isArray(data.comunas)  ? data.comunas  : (data.comunas  ? data.comunas.split(',').map(c => c.trim()).filter(Boolean)  : []);
    const tramites = Array.isArray(data.tramites) ? data.tramites : (data.tramites ? data.tramites.split(',').map(t => t.trim()).filter(Boolean) : []);
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

        <p>Entre <strong>DSR ARQ SPA</strong>, RUT 76.341.206-7, en adelante "APPARQ", y el profesional que suscribe este documento (en adelante "el Arquitecto"), se acuerda lo siguiente:</p>

        <p><strong>1. Objeto.</strong> El Arquitecto se incorpora a la red APPARQ como colaborador independiente para ejecutar trámites de arquitectura asignados por la plataforma en las comunas que declare trabajar. Esta relación no constituye vínculo laboral ni de subordinación entre las partes.</p>

        <p><strong>2. Asignación de proyectos.</strong> APPARQ asignará proyectos al Arquitecto según la disponibilidad geográfica declarada. El Arquitecto podrá aceptar o rechazar proyectos dentro de las 24 horas siguientes a la notificación. El rechazo reiterado e injustificado podrá ser causal de suspensión de la red.</p>

        <p><strong>3. Honorarios, tarifas y aceptación del cotizador.</strong> Por cada etapa de pago que el cliente realice a APPARQ, el Arquitecto recibirá el <strong>${pctArq} del monto neto</strong> correspondiente a dicha etapa. APPARQ retendrá el <strong>${pctApp}</strong> en concepto de comisión por el uso de la plataforma, gestión administrativa y captación de clientes.<br>El Arquitecto declara conocer y aceptar expresamente los precios publicados en el cotizador online de APPARQ (disponible en apparq.cl). APPARQ podrá actualizar dichas tarifas con un aviso previo de 30 días corridos; si el Arquitecto no manifiesta su desacuerdo en dicho plazo, se entenderá que acepta la modificación.</p>

        <p><strong>4. Forma y plazo de pago. Boleta electrónica.</strong> APPARQ transferirá los honorarios al Arquitecto dentro de los 10 días hábiles siguientes a la confirmación del pago de cada etapa por parte del cliente. El pago se realizará mediante transferencia bancaria a la cuenta indicada por el Arquitecto al momento de la inscripción.<br>Como condición previa e indispensable para recibir el pago de cada etapa, el Arquitecto deberá emitir y enviar a APPARQ una boleta de honorarios electrónica por el monto neto que le corresponda. El incumplimiento de esta obligación suspenderá el pago hasta que sea subsanada.</p>

        <p><strong>5. Obligatoriedad de uso de la plataforma.</strong> El Arquitecto se obliga a: (a) Realizar todas las entregas de planos, documentos e informes exclusivamente a través de apparq.cl. (b) No recibir pagos directos de los clientes asignados por APPARQ bajo ninguna circunstancia. (c) No contactar a los clientes por medios externos para gestionar pagos o entregar documentación fuera de la plataforma.</p>

        <p><strong>6. No captación directa.</strong> Durante la vigencia de este contrato y por un período de 12 meses desde su término, el Arquitecto se compromete a no gestionar directamente ni a través de terceros los proyectos de clientes que hayan sido captados originalmente por APPARQ.</p>

        <p><strong>7. Obligaciones del Arquitecto.</strong> (a) Mantener vigente su patente profesional y habilitación en el Colegio de Arquitectos de Chile. (b) Ejecutar los proyectos con la diligencia, estándares técnicos y plazos acordados con el cliente. (c) Responder las comunicaciones de la plataforma en un plazo máximo de 24 horas hábiles. (d) Informar a APPARQ cualquier impedimento para ejecutar un proyecto asignado con al menos 48 horas de anticipación.</p>

        <p><strong>8. Obligaciones de APPARQ.</strong> (a) Poner a disposición del Arquitecto la plataforma y las herramientas necesarias para la gestión de proyectos. (b) Transferir los honorarios correspondientes en los plazos establecidos. (c) Asignar proyectos de manera justa considerando la carga de trabajo y disponibilidad del Arquitecto.</p>

        <p><strong>9. Responsabilidad profesional.</strong> El Arquitecto es el único responsable de la calidad técnica, legalidad y exactitud de los proyectos que elabore. APPARQ no asume responsabilidad por errores técnicos, rechazos municipales derivados de deficiencias en los documentos, ni por daños causados por incumplimiento del Arquitecto.</p>

        <p><strong>10. Confidencialidad.</strong> El Arquitecto se obliga a mantener confidencialidad sobre los datos personales de los clientes, información comercial de APPARQ y las condiciones de este contrato. Esta obligación se extiende por 2 años desde la terminación del contrato.</p>

        <p><strong>11. Protección de datos.</strong> El Arquitecto acepta que sus datos personales sean tratados por APPARQ conforme a la Ley N° 19.628 para los fines propios de la plataforma.</p>

        <p><strong>12. Vigencia y término.</strong> Este contrato tiene vigencia indefinida desde la aceptación digital. Cualquiera de las partes podrá ponerle término con un aviso escrito de 30 días corridos a la otra parte. APPARQ podrá terminarlo de inmediato en caso de incumplimiento grave, incluyendo el cobro directo a clientes o el uso de datos de la plataforma para fines distintos a los acordados.</p>

        <p><strong>13. Ley aplicable y resolución de conflictos.</strong> Este contrato se rige por la legislación chilena vigente. Cualquier controversia se someterá al arbitraje del Centro de Arbitraje y Mediación de Santiago, o a los Tribunales Ordinarios de Justicia de Santiago, a elección de APPARQ.</p>

        <p><strong>14. Abandono de proyecto.</strong> Se entenderá por abandono la ausencia de actividad, avance o comunicación injustificados por más de 5 días hábiles consecutivos. En caso de abandono: (a) APPARQ reasignará el proyecto a otro arquitecto sin previo aviso. (b) El arquitecto que abandone perderá el derecho a los honorarios de la etapa en curso y de todas las etapas futuras del proyecto abandonado. (c) APPARQ podrá retener hasta el 100% de los honorarios pendientes para cubrir costos de reasignación y perjuicios causados al cliente. (d) El abandono de 2 o más proyectos dentro de un período de 12 meses será causal de eliminación definitiva e irrevocable de la red APPARQ, sin derecho a indemnización.</p>

        <p><strong>15. Calidad técnica y rechazos municipales.</strong> Si un proyecto es rechazado por la municipalidad u organismo competente por causas imputables a errores técnicos, omisiones o negligencia del Arquitecto, el Arquitecto deberá corregir y reingresar los documentos sin costo adicional para el cliente ni para APPARQ, en un plazo máximo de 10 días hábiles desde la notificación del rechazo. El incumplimiento de esta obligación se considerará abandono en los términos de la cláusula 14.</p>

        <p><strong>16. Propiedad no regularizable o trámite inviable.</strong> Si durante el desarrollo del proyecto el Arquitecto determina que la propiedad no es técnicamente regularizable o que el trámite no es viable, deberá: (a) Comunicarlo a APPARQ de inmediato y por escrito a través de la plataforma. (b) Adjuntar un informe técnico fundado que acredite la inviabilidad. (c) No podrá abandonar el proyecto ni cesar sus actividades sin completar este informe. APPARQ informará al cliente y aplicará la política de reembolsos correspondiente. El Arquitecto recibirá los honorarios por el trabajo efectivamente ejecutado hasta esa etapa.</p>

        <p><strong>17. Indisponibilidad temporal.</strong> El Arquitecto deberá informar a APPARQ con al menos 72 horas de anticipación cualquier período de indisponibilidad (vacaciones, enfermedad, otros compromisos). Durante períodos de indisponibilidad no se asignarán nuevos proyectos. Si existe un proyecto en curso, el Arquitecto deberá coordinar con APPARQ la suspensión temporal o reasignación.</p>

        <p><strong>18. Independencia y ausencia de relación laboral.</strong> El Arquitecto declara y acepta que su inscripción y participación en la plataforma APPARQ se realiza en calidad de profesional independiente, sin que exista relación laboral, de dependencia, subordinación o exclusividad alguna con APPARQ. APPARQ actúa únicamente como una plataforma tecnológica de intermediación. Los servicios que el Arquitecto realice a través de APPARQ tendrán carácter puntual y por proyecto, siendo el Arquitecto responsable de: (a) La organización de su tiempo y forma de trabajo. (b) El cumplimiento técnico del encargo asignado. (c) Sus obligaciones tributarias y previsionales. (d) Sus seguros profesionales si correspondiera. (e) Sus herramientas y medios de trabajo. El Arquitecto podrá prestar servicios a terceros libremente, incluyendo plataformas similares, sin restricción alguna. No existe relación laboral, subordinación, obligación de continuidad, beneficios laborales ni exclusividad. Cada encargo constituirá una contratación independiente y autónoma.</p>

        <p>Al enviar su inscripción, el Arquitecto declara haber leído, comprendido y aceptado íntegramente las condiciones de este contrato, incluyendo las obligaciones de no abandono, calidad técnica y uso exclusivo de la plataforma para todas las gestiones y entregas.</p>

        <div style="margin-top:20px;padding-top:16px;border-top:1px solid #e2e8f0;">
          <p style="margin:0 0 8px;font-size:11px;color:#718096;font-weight:700;text-transform:uppercase;">Firma digital del profesional — ${fecha}</p>
          ${firmaBlock}
          <p style="margin:8px 0 0;font-size:11px;color:#718096;">Firmado electrónicamente por <strong>${nombreCompleto}</strong> (${payload.email}) en apparq.cl</p>
        </div>
      </div>`;

    /* ── Documento HTML standalone del contrato (adjunto) ── */
    const contratoDoc = `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Contrato de Colaboración APPARQ — ${nombreCompleto}</title>
<style>
  body { font-family: Arial, Helvetica, sans-serif; font-size: 12px; color: #1a1a2e; line-height: 1.7; max-width: 800px; margin: 40px auto; padding: 0 32px; }
  h1 { font-size: 17px; font-weight: 900; letter-spacing: 1px; text-align: center; margin-bottom: 4px; }
  .subtitle { text-align: center; font-size: 11px; color: #718096; margin-bottom: 24px; }
  table { width: 100%; border-collapse: collapse; margin: 16px 0; }
  td { padding: 6px 10px; border: 1px solid #e2e8f0; }
  td:first-child { color: #718096; width: 38%; background: #f7fafc; }
  .firma-section { margin-top: 24px; padding-top: 16px; border-top: 1px solid #e2e8f0; }
  .firma-label { font-size: 11px; color: #718096; font-weight: 700; text-transform: uppercase; margin-bottom: 8px; }
  .firma-note { font-size: 11px; color: #718096; margin-top: 8px; }
  img.firma { max-width: 260px; border: 1px solid #cbd5e0; border-radius: 4px; }
  .footer { margin-top: 40px; font-size: 10px; color: #a0aec0; text-align: center; border-top: 1px solid #e2e8f0; padding-top: 12px; }
</style>
</head>
<body>
<h1>CONTRATO DE COLABORACIÓN PROFESIONAL</h1>
<p class="subtitle">APPARQ — DSR ARQ SPA · RUT 76.341.206-7</p>

<p><strong>En Santiago de Chile, a ${fecha}</strong>, entre:</p>
<p><strong>APPARQ (DSR ARQ SPA)</strong>, RUT 76.341.206-7, en adelante <em>"la Plataforma"</em>; y</p>
<p><strong>${nombreCompleto}</strong>, RUT ${payload.rut || '—'}, arquitecto, en adelante <em>"el Profesional"</em>.</p>

<table>
  <tr><td>Nombre completo</td><td><strong>${nombreCompleto}</strong></td></tr>
  <tr><td>RUT</td><td>${payload.rut || '—'}</td></tr>
  <tr><td>Email</td><td>${payload.email}</td></tr>
  <tr><td>Teléfono</td><td>${payload.telefono || '—'}</td></tr>
  <tr><td>Patente profesional</td><td>${payload.patente || (sinPatente ? 'Sin patente' : '—')}</td></tr>
  <tr><td>Experiencia</td><td>${payload.experiencia || '—'}</td></tr>
  <tr><td>Comunas</td><td>${comunas.join(', ') || '—'}</td></tr>
  <tr><td>Trámites</td><td>${tramites.join(', ') || '—'}</td></tr>
</table>

<p>Entre <strong>DSR ARQ SPA</strong>, RUT 76.341.206-7, en adelante "APPARQ", y el profesional que suscribe este documento (en adelante "el Arquitecto"), se acuerda lo siguiente:</p>

<p><strong>1. Objeto.</strong> El Arquitecto se incorpora a la red APPARQ como colaborador independiente para ejecutar trámites de arquitectura asignados por la plataforma en las comunas que declare trabajar. Esta relación no constituye vínculo laboral ni de subordinación entre las partes.</p>

<p><strong>2. Asignación de proyectos.</strong> APPARQ asignará proyectos al Arquitecto según la disponibilidad geográfica declarada. El Arquitecto podrá aceptar o rechazar proyectos dentro de las 24 horas siguientes a la notificación. El rechazo reiterado e injustificado podrá ser causal de suspensión de la red.</p>

<p><strong>3. Honorarios, tarifas y aceptación del cotizador.</strong> Por cada etapa de pago que el cliente realice a APPARQ, el Arquitecto recibirá el <strong>${pctArq} del monto neto</strong> correspondiente a dicha etapa. APPARQ retendrá el <strong>${pctApp}</strong> en concepto de comisión por el uso de la plataforma, gestión administrativa y captación de clientes.<br>El Arquitecto declara conocer y aceptar expresamente los precios publicados en el cotizador online de APPARQ (disponible en apparq.cl). APPARQ podrá actualizar dichas tarifas con un aviso previo de 30 días corridos; si el Arquitecto no manifiesta su desacuerdo en dicho plazo, se entenderá que acepta la modificación.</p>

<p><strong>4. Forma y plazo de pago. Boleta electrónica.</strong> APPARQ transferirá los honorarios al Arquitecto dentro de los 10 días hábiles siguientes a la confirmación del pago de cada etapa por parte del cliente. El pago se realizará mediante transferencia bancaria a la cuenta indicada por el Arquitecto al momento de la inscripción.<br>Como condición previa e indispensable para recibir el pago de cada etapa, el Arquitecto deberá emitir y enviar a APPARQ una boleta de honorarios electrónica por el monto neto que le corresponda. El incumplimiento de esta obligación suspenderá el pago hasta que sea subsanada.</p>

<p><strong>5. Obligatoriedad de uso de la plataforma.</strong> El Arquitecto se obliga a: (a) Realizar todas las entregas de planos, documentos e informes exclusivamente a través de apparq.cl. (b) No recibir pagos directos de los clientes asignados por APPARQ bajo ninguna circunstancia. (c) No contactar a los clientes por medios externos para gestionar pagos o entregar documentación fuera de la plataforma.</p>

<p><strong>6. No captación directa.</strong> Durante la vigencia de este contrato y por un período de 12 meses desde su término, el Arquitecto se compromete a no gestionar directamente ni a través de terceros los proyectos de clientes que hayan sido captados originalmente por APPARQ.</p>

<p><strong>7. Obligaciones del Arquitecto.</strong> (a) Mantener vigente su patente profesional y habilitación en el Colegio de Arquitectos de Chile. (b) Ejecutar los proyectos con la diligencia, estándares técnicos y plazos acordados con el cliente. (c) Responder las comunicaciones de la plataforma en un plazo máximo de 24 horas hábiles. (d) Informar a APPARQ cualquier impedimento para ejecutar un proyecto asignado con al menos 48 horas de anticipación.</p>

<p><strong>8. Obligaciones de APPARQ.</strong> (a) Poner a disposición del Arquitecto la plataforma y las herramientas necesarias para la gestión de proyectos. (b) Transferir los honorarios correspondientes en los plazos establecidos. (c) Asignar proyectos de manera justa considerando la carga de trabajo y disponibilidad del Arquitecto.</p>

<p><strong>9. Responsabilidad profesional.</strong> El Arquitecto es el único responsable de la calidad técnica, legalidad y exactitud de los proyectos que elabore. APPARQ no asume responsabilidad por errores técnicos, rechazos municipales derivados de deficiencias en los documentos, ni por daños causados por incumplimiento del Arquitecto.</p>

<p><strong>10. Confidencialidad.</strong> El Arquitecto se obliga a mantener confidencialidad sobre los datos personales de los clientes, información comercial de APPARQ y las condiciones de este contrato. Esta obligación se extiende por 2 años desde la terminación del contrato.</p>

<p><strong>11. Protección de datos.</strong> El Arquitecto acepta que sus datos personales sean tratados por APPARQ conforme a la Ley N° 19.628 para los fines propios de la plataforma.</p>

<p><strong>12. Vigencia y término.</strong> Este contrato tiene vigencia indefinida desde la aceptación digital. Cualquiera de las partes podrá ponerle término con un aviso escrito de 30 días corridos a la otra parte. APPARQ podrá terminarlo de inmediato en caso de incumplimiento grave, incluyendo el cobro directo a clientes o el uso de datos de la plataforma para fines distintos a los acordados.</p>

<p><strong>13. Ley aplicable y resolución de conflictos.</strong> Este contrato se rige por la legislación chilena vigente. Cualquier controversia se someterá al arbitraje del Centro de Arbitraje y Mediación de Santiago, o a los Tribunales Ordinarios de Justicia de Santiago, a elección de APPARQ.</p>

<p><strong>14. Abandono de proyecto.</strong> Se entenderá por abandono la ausencia de actividad, avance o comunicación injustificados por más de 5 días hábiles consecutivos. En caso de abandono: (a) APPARQ reasignará el proyecto a otro arquitecto sin previo aviso. (b) El arquitecto que abandone perderá el derecho a los honorarios de la etapa en curso y de todas las etapas futuras del proyecto abandonado. (c) APPARQ podrá retener hasta el 100% de los honorarios pendientes para cubrir costos de reasignación y perjuicios causados al cliente. (d) El abandono de 2 o más proyectos dentro de un período de 12 meses será causal de eliminación definitiva e irrevocable de la red APPARQ, sin derecho a indemnización.</p>

<p><strong>15. Calidad técnica y rechazos municipales.</strong> Si un proyecto es rechazado por la municipalidad u organismo competente por causas imputables a errores técnicos, omisiones o negligencia del Arquitecto, el Arquitecto deberá corregir y reingresar los documentos sin costo adicional para el cliente ni para APPARQ, en un plazo máximo de 10 días hábiles desde la notificación del rechazo. El incumplimiento de esta obligación se considerará abandono en los términos de la cláusula 14.</p>

<p><strong>16. Propiedad no regularizable o trámite inviable.</strong> Si durante el desarrollo del proyecto el Arquitecto determina que la propiedad no es técnicamente regularizable o que el trámite no es viable, deberá: (a) Comunicarlo a APPARQ de inmediato y por escrito a través de la plataforma. (b) Adjuntar un informe técnico fundado que acredite la inviabilidad. (c) No podrá abandonar el proyecto ni cesar sus actividades sin completar este informe. APPARQ informará al cliente y aplicará la política de reembolsos correspondiente. El Arquitecto recibirá los honorarios por el trabajo efectivamente ejecutado hasta esa etapa.</p>

<p><strong>17. Indisponibilidad temporal.</strong> El Arquitecto deberá informar a APPARQ con al menos 72 horas de anticipación cualquier período de indisponibilidad (vacaciones, enfermedad, otros compromisos). Durante períodos de indisponibilidad no se asignarán nuevos proyectos. Si existe un proyecto en curso, el Arquitecto deberá coordinar con APPARQ la suspensión temporal o reasignación.</p>

<p><strong>18. Independencia y ausencia de relación laboral.</strong> El Arquitecto declara y acepta que su inscripción y participación en la plataforma APPARQ se realiza en calidad de profesional independiente, sin que exista relación laboral, de dependencia, subordinación o exclusividad alguna con APPARQ. APPARQ actúa únicamente como una plataforma tecnológica de intermediación. Los servicios que el Arquitecto realice a través de APPARQ tendrán carácter puntual y por proyecto, siendo el Arquitecto responsable de: (a) La organización de su tiempo y forma de trabajo. (b) El cumplimiento técnico del encargo asignado. (c) Sus obligaciones tributarias y previsionales. (d) Sus seguros profesionales si correspondiera. (e) Sus herramientas y medios de trabajo. El Arquitecto podrá prestar servicios a terceros libremente, incluyendo plataformas similares, sin restricción alguna. No existe relación laboral, subordinación, obligación de continuidad, beneficios laborales ni exclusividad. Cada encargo constituirá una contratación independiente y autónoma.</p>

<p>Al enviar su inscripción, el Arquitecto declara haber leído, comprendido y aceptado íntegramente las condiciones de este contrato, incluyendo las obligaciones de no abandono, calidad técnica y uso exclusivo de la plataforma para todas las gestiones y entregas.</p>

<div class="firma-section">
  <p class="firma-label">Firma digital del profesional — ${fecha}</p>
  ${data.firma_data ? `<img class="firma" src="${data.firma_data}" alt="Firma digital de ${nombreCompleto}" />` : '<p style="font-size:12px;color:#a0aec0;font-style:italic;">Firmado digitalmente en apparq.cl</p>'}
  <p class="firma-note">Firmado electrónicamente por <strong>${nombreCompleto}</strong> (${payload.email}) en apparq.cl</p>
</div>

<div class="footer">APPARQ · DSR ARQ SPA · RUT 76.341.206-7 · Santiago, Chile · hola@apparq.cl</div>
</body>
</html>`;

    const contratoBase64 = Buffer.from(contratoDoc, 'utf-8').toString('base64');
    const contratoFilename = `contrato-colaboracion-apparq-${nombreCompleto.replace(/\s+/g, '-').toLowerCase()}.html`;
    const contratoAttachment = [{ filename: contratoFilename, content: contratoBase64 }];

    /* ── Email interno a hola@apparq.cl ── */
    await sendEmail({
      to:      'hola@apparq.cl',
      subject: `🏗 Nueva inscripción de arquitecto — ${nombreCompleto}`,
      attachments: contratoAttachment,
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
            <div style="background:#EFF6FF;border:1.5px solid #BFDBFE;border-radius:8px;padding:14px 18px;margin-top:8px;">
              <p style="margin:0;font-size:13px;color:#1e3a5f;font-weight:700;">📎 Contrato adjunto</p>
              <p style="margin:6px 0 0;font-size:12px;color:#1e3a5f;">El contrato firmado por el arquitecto se adjunta como archivo HTML descargable: <strong>${contratoFilename}</strong></p>
            </div>
            <p style="margin-top:24px;font-size:11px;color:#a0aec0;">APPARQ — Sistema automático · ${fecha}</p>
          </div>
        </div>
      `,
    }, RESEND_API_KEY);

    /* ── Email de bienvenida al arquitecto ── */
    await sendEmail({
      to:      payload.email,
      subject: `✅ Tu inscripción en APPARQ fue recibida — ${nombreCompleto}`,
      attachments: contratoAttachment,
      html: `
        <div style="font-family:Arial,sans-serif;max-width:640px;margin:0 auto;color:#1a1a2e;">
          <div style="background:#1a1a2e;padding:32px;text-align:center;border-radius:8px 8px 0 0;">
            <h1 style="color:#fff;margin:0;font-size:26px;letter-spacing:-0.5px;">APPARQ</h1>
            <p style="color:#a0aec0;margin:8px 0 0;font-size:13px;">Plataforma de arquitectura</p>
          </div>
          <div style="background:#fff;padding:32px;border:1px solid #e2e8f0;border-radius:0 0 8px 8px;">
            <h2 style="margin-top:0;color:#1a1a2e;">¡Hola ${payload.nombre}! Tu inscripción fue recibida 🎉</h2>
            <p style="color:#4a5568;font-size:14px;line-height:1.7;">
              Gracias por unirte a APPARQ. Hemos recibido tu solicitud y la revisaremos en las próximas 24–48 horas hábiles.
            </p>

            <div style="background:#EFF6FF;border:1.5px solid #BFDBFE;border-radius:8px;padding:16px 20px;margin:20px 0;">
              <p style="margin:0;font-size:13px;color:#1e3a5f;font-weight:700;">📎 Tu contrato de colaboración</p>
              <p style="margin:8px 0 0;font-size:12px;color:#1e3a5f;line-height:1.6;">
                Encontrarás el contrato completo firmado digitalmente como archivo adjunto en este correo (<strong>${contratoFilename}</strong>). Descárgalo y guárdalo como respaldo.
              </p>
            </div>

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
    return corsResponse({ error: 'Error interno del servidor', detail: String(err?.message || err) }, 500);
  }
}

/**
 * Envía correo a clientes con al menos una etapa completada
 * pidiéndoles que califiquen a su arquitecto.
 *
 * Uso:
 *   SUPABASE_SERVICE_KEY=eyJ... node scripts/send-rating-request.mjs
 */

const RESEND_KEY  = process.env.RESEND_KEY;
const SB_URL      = 'https://ibdafnzlsufsshczqvoa.supabase.co';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!SERVICE_KEY || !RESEND_KEY) {
  console.error('❌  Faltan variables: SUPABASE_SERVICE_KEY y RESEND_KEY. Abortando.');
  console.error('    Uso: SUPABASE_SERVICE_KEY=eyJ... RESEND_KEY=re_... node scripts/send-rating-request.mjs');
  process.exit(1);
}

/* Etapas que indican al menos una etapa terminada */
const REGULAR_OK = ['elaboracion', 'ingreso_dom', 'tramitacion', 'completado'];
const INFORME_OK = ['elaboracion_inf', 'entrega_informe'];

const STAGE_LABEL = {
  elaboracion:    'Levantamiento en terreno',
  ingreso_dom:    'Elaboración de planos',
  tramitacion:    'Ingreso a la DOM',
  completado:     'Trámite completado',
  elaboracion_inf:'Visita a terreno',
  entrega_informe:'Elaboración del informe + Entrega',
};

/* Consultar proyectos con arquitecto asignado */
const res  = await fetch(
  `${SB_URL}/rest/v1/projects?architect_email=neq.&select=project_number,client_nombre,client_apellido,client_email,architect_nombre,architect_apellido,service_type,stage,rating_arquitecto&limit=500`,
  { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } }
);
const rows = await res.json();
if (!Array.isArray(rows)) {
  console.error('❌  Error Supabase:', JSON.stringify(rows));
  process.exit(1);
}

const eligible = rows.filter(p =>
  p.service_type === 'informe'
    ? INFORME_OK.includes(p.stage)
    : REGULAR_OK.includes(p.stage)
);

console.log(`\nProyectos elegibles: ${eligible.length}\n`);
eligible.forEach(p =>
  console.log(`  ${p.project_number} | ${p.service_type} | ${p.stage} | ${p.client_email} | rating: ${p.rating_arquitecto ?? '—'}`)
);

if (!eligible.length) {
  console.log('Nada que enviar.');
  process.exit(0);
}

/* Enviar correos */
let ok = 0, fail = 0;
for (const p of eligible) {
  const clientName = `${p.client_nombre || ''} ${p.client_apellido || ''}`.trim();
  const archName   = `${p.architect_nombre || ''} ${p.architect_apellido || ''}`.trim();
  const etapaLabel = STAGE_LABEL[p.stage] || p.stage;

  /* Para informes con ambas etapas completas */
  const etapasTexto = p.stage === 'entrega_informe'
    ? 'Visita a terreno y Elaboración del informe'
    : etapaLabel;

  const stars = '★'.repeat(p.rating_arquitecto || 0) + '☆'.repeat(5 - (p.rating_arquitecto || 0));

  const html = `<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;padding:32px 0;">
  <tr><td align="center">
    <table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:10px;overflow:hidden;max-width:600px;width:100%;">
      <tr><td style="background:#1a1a2e;padding:28px 36px;">
        <div style="color:#ffffff;font-size:22px;font-weight:800;letter-spacing:1px;">APPARQ</div>
        <div style="color:rgba(255,255,255,0.6);font-size:12px;margin-top:4px;">Tu trámite avanza — cuéntanos cómo va</div>
      </td></tr>
      <tr><td style="padding:36px 36px 28px;">
        <p style="font-size:13px;color:#888;text-transform:uppercase;letter-spacing:1px;margin:0 0 8px;">Trámite ${p.project_number}</p>
        <p style="font-size:22px;font-weight:800;color:#1a1a2e;margin:0 0 24px;">¿Cómo va la experiencia con tu arquitecto?</p>

        <p style="font-size:14px;color:#444;line-height:1.7;margin:0 0 16px;">Hola ${clientName},</p>

        <p style="font-size:14px;color:#444;line-height:1.7;margin:0 0 20px;">
          Tu arquitecto <strong>${archName}</strong> ya completó la etapa <strong>${etapasTexto}</strong> de tu trámite.
          Nos gustaría saber cómo ha sido tu experiencia hasta ahora.
        </p>

        <div style="background:#FFFBEB;border:1.5px solid #FDE68A;border-radius:10px;padding:20px 24px;margin-bottom:28px;text-align:center;">
          <p style="font-size:14px;color:#92400E;margin:0 0 12px;font-weight:700;">Califica a tu arquitecto</p>
          <p style="font-size:32px;letter-spacing:4px;margin:0 0 16px;color:#F59E0B;">${stars}</p>
          <a href="https://apparq.cl" style="display:inline-block;background:#1a1a2e;color:#fff;text-decoration:none;padding:12px 28px;border-radius:8px;font-size:14px;font-weight:700;">
            Ir a mi portal → calificar
          </a>
          <p style="font-size:12px;color:#92400E;margin:12px 0 0;">
            Ingresa con tu N° de trámite <strong>${p.project_number}</strong> y tu email
          </p>
        </div>

        <p style="font-size:13px;color:#888;line-height:1.6;margin:0 0 28px;">
          Tu opinión nos ayuda a mejorar el servicio y a reconocer a los mejores arquitectos de nuestra red.
          ¡No dejes que este trámite quede pendiente — tu tranquilidad vale la pena!
        </p>

        <hr style="border:none;border-top:1px solid #e2e8f0;margin:0 0 20px;">
        <p style="font-size:13px;color:#888;margin:0;">Saludos,<br>
          <strong style="color:#1a1a2e;">Equipo APPARQ</strong><br>
          <a href="mailto:hola@apparq.cl" style="color:#1a1a2e;">hola@apparq.cl</a>
          · <a href="https://wa.me/56942054581" style="color:#1a1a2e;">WhatsApp +56 9 4205 4581</a>
        </p>
      </td></tr>
      <tr><td style="background:#f4f4f5;padding:16px 36px;text-align:center;">
        <p style="font-size:11px;color:#aaa;margin:0;">APPARQ SpA · RUT 78.441.391-8 · Santiago, Chile</p>
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`;

  const sendRes = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from:    'APPARQ <hola@apparq.cl>',
      to:      p.client_email,
      subject: `¿Cómo va la experiencia con tu arquitecto? — Trámite ${p.project_number}`,
      html,
    }),
  });
  const d = await sendRes.json();
  if (sendRes.ok) {
    console.log(`✅  ${p.project_number} → ${p.client_email}`);
    ok++;
  } else {
    console.error(`❌  ${p.project_number} → ${p.client_email}: ${d.message}`);
    fail++;
  }

  await new Promise(r => setTimeout(r, 300));
}

console.log(`\nResultado: ${ok} enviados, ${fail} fallidos.`);

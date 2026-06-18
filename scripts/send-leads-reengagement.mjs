/**
 * Re-engagement a leads no convertidos del cotizador.
 * EJECUTAR UNA SOLA VEZ. Crea archivo .lock al terminar para evitar re-ejecución.
 *
 * Requiere la service_role key de Supabase (Settings > API en supabase.io):
 *   SUPABASE_SERVICE_KEY=eyJ... node scripts/send-leads-reengagement.mjs
 */
import { existsSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dir = dirname(fileURLToPath(import.meta.url));
const LOCK  = join(__dir, 'send-leads-reengagement.lock');

if (existsSync(LOCK)) {
  console.error('⛔  Ya fue ejecutado. Archivo .lock encontrado. Abortando.');
  process.exit(1);
}

const RESEND_KEY = 're_RRVTgGik_GtaRwK2p9jimrkemYTY4Uew6';

const leadsRes = await fetch(
  'https://apparq.pages.dev/api/admin-data?section=leads_export&token=apparq-leads-2026'
);
if (!leadsRes.ok) {
  console.error('❌  Error al obtener leads:', await leadsRes.text());
  process.exit(1);
}
const leads = await leadsRes.json();
console.log(`\nLeads no convertidos encontrados: ${leads.length}\n`);
if (!leads.length) { console.log('Nada que enviar.'); process.exit(0); }

const SUB_LABELS = {
  'obra-menor':          'Obra menor',
  'obra-nueva-reg':      'Obra nueva',
  'evaluacion':          'Evaluación normativa',
  'factibilidad':        'Factibilidad con visita',
  'compraventa':         'Informe compraventa',
  'piscina_privada':     'Piscina privada',
  'pergola_sombreadero': 'Pérgola / Sombreadero',
  'demolicion':          'Demolición',
};

function buildURL(lead) {
  const p = new URLSearchParams({ svc: lead.svc });
  if (lead.servicio_subtipo) p.set('sub', lead.servicio_subtipo);
  if (lead.commune)          p.set('commune', lead.commune);
  if (lead.m2)               p.set('m2', lead.m2);
  return `https://www.apparq.cl?${p.toString()}`;
}

function getCopy(lead) {
  const commune = lead.commune || 'tu comuna';
  const sub     = lead.servicio_subtipo;
  const subTxt  = sub && SUB_LABELS[sub] ? ` (${SUB_LABELS[sub]})` : '';

  const data = {
    regularizacion: {
      subject: `Tu propiedad en ${commune} puede regularizarse — quedaste a un paso`,
      intro:   `Cotizaste una <strong>Regularización${subTxt}</strong> para tu propiedad en <strong>${commune}</strong>.`,
      body1:   'Regularizar no solo te saca de una situación irregular con el municipio — te permite vender, ampliar o hipotecar tu propiedad sin problemas. Una construcción sin recepción final puede bloquear cualquier trámite futuro.',
      body2:   'El proceso es más simple de lo que parece. Un arquitecto de nuestra red lo gestiona por ti, con seguimiento completo en la plataforma y pagos en etapas.',
    },
    'ley-del-mono': {
      subject: `Tu regularización Ley del Mono en ${commune} — quedaste a un paso`,
      intro:   `Cotizaste una regularización mediante <strong>Ley del Mono</strong> para tu propiedad en <strong>${commune}</strong>.`,
      body1:   'La Ley del Mono existe precisamente para situaciones como la tuya — propiedades construidas sin los permisos formales. Te entrega recepción final, documentos legales y certeza jurídica sobre tu vivienda.',
      body2:   'El proceso no requiere demoler ni modificar nada. Un arquitecto hace el levantamiento y gestiona todo ante el municipio. Tú pagas en etapas y haces seguimiento desde la plataforma.',
    },
    informe: {
      subject: `El informe que cotizaste para ${commune} sigue disponible`,
      intro:   `Cotizaste un <strong>Informe de Propiedad${subTxt}</strong> para una dirección en <strong>${commune}</strong>.`,
      body1:   'Un informe de propiedad puede ser lo que necesitas para cerrar una compraventa, evaluar una ampliación o conocer la situación normativa antes de invertir.',
      body2:   'Es un proceso rápido — un arquitecto especializado en tu comuna lo prepara con toda la documentación oficial. Puedes seguir el avance desde tu portal.',
    },
    'declaracion-jurada': {
      subject: `Tu declaración jurada en ${commune} — retoma el proceso`,
      intro:   `Cotizaste una <strong>Declaración Jurada${subTxt}</strong> para tu propiedad en <strong>${commune}</strong>.`,
      body1:   'Una declaración jurada te permite regularizar elementos como piscinas, pérgolas o demoliciones de forma directa, sin pasar por el proceso de permiso completo.',
      body2:   'Es un trámite ágil: el arquitecto prepara la documentación, tú la firmas y queda regularizado. Sin visitas innecesarias al municipio.',
    },
    ampliacion: {
      subject: `Tu ampliación en ${commune} puede formalizarse — retoma el proceso`,
      intro:   `Cotizaste una <strong>Ampliación</strong> para tu propiedad en <strong>${commune}</strong>.`,
      body1:   'Formalizar tu ampliación es el paso que te permite tener todo en orden — para vender, hipotecar o simplemente tener tu propiedad al día.',
      body2:   'Un arquitecto de nuestra red gestiona el trámite ante el municipio. Tú haces seguimiento desde la plataforma y pagas en etapas.',
    },
    'obra-nueva': {
      subject: `Tu obra nueva en ${commune} — retoma el proceso`,
      intro:   `Cotizaste una <strong>Obra Nueva</strong> en <strong>${commune}</strong>.`,
      body1:   'Tu proyecto necesita permiso de construcción para que todo quede en regla. Sin ese documento, no hay recepción final y la propiedad no puede venderse ni hipotecarse.',
      body2:   'Un arquitecto especializado gestiona el expediente completo. Tú pagas en etapas y haces seguimiento en tiempo real desde tu portal.',
    },
  };

  return data[lead.svc] || {
    subject: `Retoma tu trámite en ${commune} — estás a un paso`,
    intro:   `Cotizaste un trámite para tu propiedad en <strong>${commune}</strong>.`,
    body1:   'Puedes retomar el proceso en cualquier momento — tu cotización sigue disponible.',
    body2:   'Un arquitecto de nuestra red lo gestiona por ti con seguimiento completo y pagos en etapas.',
  };
}

function buildHtml(lead) {
  const url = buildURL(lead);
  const { intro, body1, body2 } = getCopy(lead);

  return `<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;padding:32px 0;">
  <tr><td align="center">
    <table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:10px;overflow:hidden;max-width:600px;width:100%;">
      <tr><td style="background:#1a1a2e;padding:28px 36px;">
        <div style="color:#ffffff;font-size:22px;font-weight:800;letter-spacing:1px;">APPARQ</div>
        <div style="color:rgba(255,255,255,0.6);font-size:12px;margin-top:4px;">Plataforma de gestión de permisos</div>
      </td></tr>
      <tr><td style="padding:36px 36px 24px;">
        <p style="font-size:15px;color:#1a1a2e;margin:0 0 20px;">Hola,</p>
        <p style="font-size:14px;color:#444;line-height:1.7;margin:0 0 20px;">${intro}</p>
        <table width="100%" cellpadding="0" cellspacing="0" style="background:#f8f8fb;border-left:4px solid #1a1a2e;border-radius:0 8px 8px 0;margin-bottom:24px;">
          <tr><td style="padding:16px 20px;">
            <p style="font-size:13px;color:#444;line-height:1.7;margin:0;">${body1}</p>
          </td></tr>
        </table>
        <p style="font-size:13px;color:#444;line-height:1.7;margin:0 0 28px;">${body2}</p>
        <table cellpadding="0" cellspacing="0" style="margin-bottom:12px;">
          <tr><td style="background:#1a1a2e;border-radius:8px;padding:14px 28px;">
            <a href="${url}" style="color:#ffffff;text-decoration:none;font-size:14px;font-weight:700;">Comenzar mi trámite →</a>
          </td></tr>
        </table>
        <p style="font-size:11px;color:#aaa;margin:0 0 28px;">O ingresa en <a href="https://www.apparq.cl" style="color:#1a1a2e;font-weight:700;">www.apparq.cl</a> y selecciona tu servicio.</p>
        <hr style="border:none;border-top:1px solid #e2e8f0;margin:0 0 20px;">
        <p style="font-size:13px;color:#888;margin:0;">Saludos,<br><strong style="color:#1a1a2e;">Equipo APPARQ</strong><br>
        <a href="mailto:hola@apparq.cl" style="color:#1a1a2e;">hola@apparq.cl</a> · <a href="https://www.apparq.cl" style="color:#1a1a2e;">www.apparq.cl</a></p>
      </td></tr>
      <tr><td style="background:#f4f4f5;padding:16px 36px;text-align:center;">
        <p style="font-size:11px;color:#aaa;margin:0;">APPARQ SpA · RUT 78.441.391-8 · Santiago, Chile</p>
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`;
}

async function sendEmail(lead) {
  const { subject } = getCopy(lead);
  const html = buildHtml(lead);
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: 'APPARQ <hola@apparq.cl>', to: lead.email, subject, html }),
  });
  const data = await res.json();
  console.log(`[${res.ok ? 'OK' : 'ERROR'}] ${lead.email} (${lead.svc}${lead.commune ? ' · ' + lead.commune : ''}) — ${data.id || data.message}`);
  return res.ok;
}

async function main() {
  console.log(`Enviando a ${leads.length} leads...\n`);
  let ok = 0, fail = 0;
  for (const lead of leads) {
    const success = await sendEmail(lead);
    if (success) ok++; else fail++;
    await new Promise(r => setTimeout(r, 400));
  }
  console.log(`\nResumen: ${ok} enviados, ${fail} fallidos.`);
  if (fail === 0) {
    writeFileSync(LOCK, new Date().toISOString());
    console.log('Archivo .lock creado — no se puede re-ejecutar.');
  }
}

main();

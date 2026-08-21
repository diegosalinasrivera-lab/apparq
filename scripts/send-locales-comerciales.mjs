/* ══════════════════════════════════════════════════
   APPARQ — Correo a arquitectos con patente
   Tema: Regularización de locales comerciales
   Uso: node scripts/send-locales-comerciales.mjs [--send]
══════════════════════════════════════════════════ */

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dotenv = Object.fromEntries(
  readFileSync(resolve(__dirname, '../.env'), 'utf8').split('\n')
    .filter(l => l && !l.startsWith('#'))
    .map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; })
);

const RESEND_KEY   = process.env.RESEND_KEY   || dotenv.RESEND_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL || dotenv.SUPABASE_URL || 'https://ibdafnzlsufsshczqvoa.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || dotenv.SUPABASE_KEY;
const FROM         = 'hola@apparq.cl';
const PREVIEW_TO   = 'diegosalinasrivera@gmail.com';

const isSend = process.argv.includes('--send');

function buildHtml(nombre) {
  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
</head>
<body style="margin:0;padding:0;background:#f4f1eb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">

<table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f1eb;padding:32px 0;">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.07);">

  <!-- Header -->
  <tr><td style="background:#111827;padding:28px 36px;">
    <table width="100%" cellpadding="0" cellspacing="0">
      <tr>
        <td><span style="font-size:18px;font-weight:900;letter-spacing:0.1em;color:#ffffff;">APPARQ</span></td>
        <td align="right"><span style="font-size:11px;font-weight:600;color:rgba(255,255,255,0.45);letter-spacing:0.08em;text-transform:uppercase;">Agosto 2026</span></td>
      </tr>
    </table>
  </td></tr>

  <!-- Saludo -->
  <tr><td style="padding:32px 36px 0;">
    <p style="margin:0 0 8px;font-size:15px;color:#374151;">Hola <strong>${nombre}</strong>,</p>
    <p style="margin:0;font-size:14px;color:#6B7280;line-height:1.6;">
      Estamos incorporando un nuevo tipo de trámite a la plataforma y queremos contar con tu participación.
    </p>
  </td></tr>

  <!-- Bloque destacado -->
  <tr><td style="padding:24px 36px;">
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#FFF7ED;border:2px solid #E8503A;border-radius:10px;">
      <tr><td style="padding:22px 24px;">
        <div style="font-size:11px;font-weight:700;color:#92400E;text-transform:uppercase;letter-spacing:0.08em;margin-bottom:10px;">Nueva categoría</div>
        <h2 style="margin:0 0 12px;font-size:20px;font-weight:800;color:#1a1a2e;line-height:1.3;">
          Regularización de locales comerciales
        </h2>
        <p style="margin:0;font-size:14px;color:#78350F;line-height:1.6;">
          APPARQ está habilitando este servicio para conectar locales comerciales con arquitectos habilitados para tramitarlo ante la DOM.
        </p>
      </td></tr>
    </table>
  </td></tr>

  <!-- Cuerpo -->
  <tr><td style="padding:0 36px 24px;">
    <p style="margin:0 0 16px;font-size:14px;color:#374151;line-height:1.7;">
      Para activar esta categoría correctamente, necesitamos saber qué arquitectos de nuestra red tienen experiencia o interés en realizar este tipo de trámite.
    </p>

    <!-- Qué pedimos -->
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#EEF2FF;border:1.5px solid #C7D2FE;border-radius:10px;margin-bottom:20px;">
      <tr><td style="padding:18px 22px;">
        <div style="font-size:11px;font-weight:700;color:#3730A3;text-transform:uppercase;letter-spacing:0.08em;margin-bottom:10px;">¿Qué te pedimos?</div>
        <p style="margin:0 0 8px;font-size:14px;color:#1e1b4b;line-height:1.6;">Si quieres quedar habilitado, <strong>responde este correo</strong> indicándonos:</p>
        <ul style="margin:8px 0 0;padding-left:20px;font-size:14px;color:#1e1b4b;line-height:1.8;">
          <li>✅ Sí, quiero recibir este tipo de trámites</li>
          <li>Las comunas donde operas para este servicio (si son distintas a las que ya tienes en la plataforma)</li>
        </ul>
      </td></tr>
    </table>

    <p style="margin:0;font-size:14px;color:#374151;line-height:1.7;">
      Activaremos la categoría en los próximos días y te notificaremos en cuanto esté disponible para recibir clientes.
    </p>
  </td></tr>

  <!-- Footer -->
  <tr><td style="background:#f0f0f0;padding:18px 36px;text-align:center;">
    <p style="margin:0;color:#9CA3AF;font-size:12px;line-height:1.6;">
      Equipo APPARQ · <a href="https://apparq.cl" style="color:#9CA3AF;text-decoration:none;">apparq.cl</a><br>
      ¿Consultas? <a href="mailto:hola@apparq.cl" style="color:#9CA3AF;">hola@apparq.cl</a>
      o por <a href="https://wa.me/56942054581" style="color:#25D366;text-decoration:none;">WhatsApp</a>
    </p>
  </td></tr>

</table>
</td></tr>
</table>
</body>
</html>`;
}

async function sendEmail(to, nombre) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: `APPARQ <${FROM}>`,
      to,
      subject: 'APPARQ · Nueva categoría — Regularización de locales comerciales',
      html: buildHtml(nombre),
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Resend error: ${err}`);
  }
  return res.json();
}

async function main() {
  // Obtener arquitectos activos con patente
  const url = `${SUPABASE_URL}/rest/v1/architects?select=nombre,apellido,email&activo=eq.true&patente=not.is.null&limit=200`;
  const res = await fetch(url, {
    headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` },
  });
  const architects = await res.json();
  console.log(`Arquitectos con patente activos: ${architects.length}`);

  if (!isSend) {
    // Preview al correo propio
    await sendEmail(PREVIEW_TO, 'Diego');
    console.log(`Preview enviado a ${PREVIEW_TO}`);
    return;
  }

  let ok = 0, fail = 0;
  for (const a of architects) {
    const nombre = a.nombre || 'Arquitecto';
    try {
      await sendEmail(a.email, nombre);
      console.log(`✓ ${a.email}`);
      ok++;
    } catch (e) {
      console.error(`✗ ${a.email}: ${e.message}`);
      fail++;
    }
    await new Promise(r => setTimeout(r, 200));
  }
  console.log(`\nEnviados: ${ok} | Fallidos: ${fail}`);
}

main().catch(console.error);

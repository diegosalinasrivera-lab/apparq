/* ══════════════════════════════════════════════════
   APPARQ — Cloudflare Pages Function: save-lead
   Guarda un lead del cotizador en Supabase y envía
   un email con el resumen de cotización al usuario.
   POST /api/save-lead
══════════════════════════════════════════════════ */

const CORS = {
  'Access-Control-Allow-Origin': 'https://apparq.cl',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

function corsResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: CORS });
}

function clpFmt(n) {
  return '$' + Math.round(n).toLocaleString('es-CL');
}

async function sendEmail({ to, subject, html }, RESEND_API_KEY) {
  if (!RESEND_API_KEY) return;
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ from: 'APPARQ <hola@apparq.cl>', to, subject, html }),
  });
  if (!res.ok) console.error('Resend error:', await res.text());
}

/* Etiquetas legibles */
const SVC_LABELS = {
  regularizacion:       'Regularización',
  ampliacion:           'Ampliación',
  'declaracion-jurada': 'Declaración Jurada',
  'obra-nueva':         'Obra Nueva',
  informe:              'Informe de Propiedad',
  'ley-del-mono':       'Ley del Mono',
};
const SUBTIPO_LABELS = {
  'piscina_privada':      'Piscina Privada',
  'pergola_sombreadero':  'Pérgola / Sombreadero',
  'demolicion':           'Demolición',
  'obra-menor':           'Obra Menor',
  'obra-nueva-reg':       'Obra Nueva',
  'evaluacion':           'Evaluación normativa',
  'factibilidad':         'Factibilidad',
  'compraventa':          'Compraventa',
};

export async function onRequest(context) {
  const { request, env } = context;
  const RESEND_API_KEY = env.RESEND_API_KEY || 're_RRVTgGik_GtaRwK2p9jimrkemYTY4Uew6';
  const SUPABASE_URL   = env.SUPABASE_URL   || 'https://ibdafnzlsufsshczqvoa.supabase.co';
  /* Usar service key para bypassear RLS en el INSERT de leads */
  const SUPABASE_KEY   = env.SUPABASE_SERVICE_KEY || env.SUPABASE_SVC || env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImliZGFmbnpsc3Vmc3NoY3pxdm9hIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM5Njg0NjYsImV4cCI6MjA4OTU0NDQ2Nn0.ucEjCcnSbaz-OeMrLbUbgcKacvg9J2Csg2VzrWVtVHA';

  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (request.method !== 'POST')   return new Response('Method Not Allowed', { status: 405 });

  try {
    const body = await request.json();
    const { email, svc, servicio_subtipo, m2, commune, uf, clp, svc_label } = body;

    if (!email || !email.includes('@')) {
      return corsResponse({ error: 'Email inválido' }, 400);
    }

    /* ── Guardar lead en Supabase ─────────────────── */
    const fecha = new Date().toISOString();
    await fetch(`${SUPABASE_URL}/rest/v1/leads`, {
      method: 'POST',
      headers: {
        'apikey':        SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type':  'application/json',
        'Prefer':        'return=minimal',
      },
      body: JSON.stringify({
        email:            email.trim().toLowerCase(),
        svc:              svc              || null,
        servicio_subtipo: servicio_subtipo || null,
        m2:               m2              || null,
        commune:          commune          || null,
        uf:               uf              || null,
        clp:              clp             || null,
        created_at:       fecha,
        converted:        false,
      }),
    });

    /* ── Email de cotización al lead ──────────────── */
    const svcName    = SVC_LABELS[svc]              || svc_label || svc || 'Trámite';
    const subtipoStr = SUBTIPO_LABELS[servicio_subtipo] || '';
    const nombreSvc  = subtipoStr ? `${svcName} — ${subtipoStr}` : svcName;
    const comunaStr  = commune || 'tu comuna';
    const m2Str      = m2 ? `${m2} m²` : null;
    const fechaLeg   = new Date().toLocaleDateString('es-CL', { day:'2-digit', month:'long', year:'numeric' });

    /* Etapas de pago según servicio */
    const esDJ      = svc === 'declaracion-jurada';
    const esInforme = svc === 'informe';
    const etapas    = esDJ || esInforme
      ? [
          { label: 'E1 — Inicio',  pct: 0.50 },
          { label: 'E2 — Cierre',  pct: 0.50 },
        ]
      : [
          { label: 'E1 — Inicio (20%)',       pct: 0.20 },
          { label: 'E2 — Elaboración (30%)',  pct: 0.30 },
          { label: 'E3 — Ingreso DOM (20%)',  pct: 0.20 },
          { label: 'E4 — Recepción (30%)',    pct: 0.30 },
        ];

    const etapasHTML = etapas.map((e, i) => `
      <tr style="background:${i % 2 ? '#f7fafc' : '#fff'}">
        <td style="padding:7px 12px;color:#718096;font-size:13px;">${e.label}</td>
        <td style="padding:7px 12px;font-weight:700;font-size:13px;color:#1a1a2e;">${clpFmt(clp * e.pct)}</td>
      </tr>`).join('');

    await sendEmail({
      to:      email,
      subject: `Tu cotización APPARQ — ${nombreSvc} en ${comunaStr}`,
      html: `
<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;padding:32px 16px;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:12px;overflow:hidden;max-width:600px;width:100%;">

        <!-- Header -->
        <tr>
          <td style="background:#1a1a2e;padding:28px 36px;">
            <span style="color:#fff;font-size:22px;font-weight:700;letter-spacing:1px;">APPARQ</span>
            <span style="color:#E8503A;font-size:22px;font-weight:700;">.</span>
            <span style="display:block;color:#a0aec0;font-size:12px;margin-top:4px;">Tu cotización guardada · ${fechaLeg}</span>
          </td>
        </tr>

        <!-- Body -->
        <tr>
          <td style="padding:32px 36px;">
            <h2 style="margin:0 0 6px;font-size:20px;color:#1a1a2e;">Aquí está tu cotización 📋</h2>
            <p style="margin:0 0 24px;color:#718096;font-size:14px;">
              La guardamos para que la tengas a mano. Cuando estés listo, puedes comenzar tu trámite en cualquier momento.
            </p>

            <!-- Resumen cotización -->
            <table width="100%" cellpadding="0" cellspacing="0" style="background:#FFF7ED;border:2px solid #E8503A;border-radius:10px;margin-bottom:24px;">
              <tr>
                <td style="padding:20px 24px;">
                  <div style="font-size:12px;font-weight:700;color:#92400E;text-transform:uppercase;letter-spacing:0.08em;margin-bottom:12px;">Resumen</div>
                  <table width="100%" cellpadding="0" cellspacing="0" style="font-size:14px;">
                    <tr>
                      <td style="color:#718096;padding:3px 0;width:40%">Servicio</td>
                      <td style="font-weight:700;color:#1a1a2e;">${nombreSvc}</td>
                    </tr>
                    ${commune ? `<tr><td style="color:#718096;padding:3px 0;">Comuna</td><td style="font-weight:700;color:#1a1a2e;">${comunaStr}</td></tr>` : ''}
                    ${m2Str ? `<tr><td style="color:#718096;padding:3px 0;">Superficie</td><td style="font-weight:700;color:#1a1a2e;">${m2Str}</td></tr>` : ''}
                    <tr>
                      <td style="color:#718096;padding:6px 0 0;">Total estimado</td>
                      <td style="font-weight:900;font-size:20px;color:#E8503A;padding-top:6px;">${clpFmt(clp)}</td>
                    </tr>
                    <tr>
                      <td></td>
                      <td style="font-size:11px;color:#78350F;">${uf ? uf + ' UF al valor del día' : ''}</td>
                    </tr>
                  </table>
                </td>
              </tr>
            </table>

            <!-- Etapas de pago -->
            <div style="font-size:13px;font-weight:700;color:#1a1a2e;margin-bottom:8px;">Forma de pago</div>
            <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e2e8f0;border-radius:8px;overflow:hidden;margin-bottom:28px;">
              ${etapasHTML}
            </table>

            <!-- CTA -->
            <table width="100%" cellpadding="0" cellspacing="0">
              <tr>
                <td style="background:#EEF2FF;border:1.5px solid #C7D2FE;border-radius:10px;padding:18px 24px;text-align:center;">
                  <p style="margin:0 0 12px;font-size:14px;font-weight:700;color:#3730A3;">¿Listo para comenzar?</p>
                  <p style="margin:0 0 16px;font-size:13px;color:#4338ca;line-height:1.5;">
                    Tu cotización está guardada. Cuando quieras iniciar, entra a APPARQ y selecciona los mismos parámetros — el proceso toma menos de 5 minutos.
                  </p>
                  <a href="https://apparq.cl/#cotizador"
                     style="display:inline-block;background:#E8503A;color:#fff;text-decoration:none;font-weight:700;font-size:14px;padding:12px 32px;border-radius:8px;">
                    Comenzar mi trámite →
                  </a>
                </td>
              </tr>
            </table>

            <p style="margin-top:24px;font-size:12px;color:#a0aec0;line-height:1.6;">
              * El valor es una estimación basada en los parámetros ingresados. El precio final puede variar si hay diferencias en la superficie real o en las condiciones del predio.<br>
              * Los valores en UF se actualizan diariamente.
            </p>
          </td>
        </tr>

        <!-- Footer -->
        <tr>
          <td style="background:#f0f0f0;padding:18px 36px;text-align:center;">
            <p style="margin:0;color:#999;font-size:12px;">
              Equipo APPARQ · <a href="https://apparq.cl" style="color:#999;text-decoration:none;">apparq.cl</a><br>
              ¿Consultas? <a href="mailto:hola@apparq.cl" style="color:#999;">hola@apparq.cl</a>
              o por <a href="https://wa.me/56942054581" style="color:#25D366;text-decoration:none;">WhatsApp</a>
            </p>
          </td>
        </tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`,
    }, RESEND_API_KEY);

    console.log(`Lead guardado: ${email} | ${svc} | ${commune} | $${clp}`);
    return corsResponse({ ok: true });

  } catch (err) {
    console.error('save-lead error:', err);
    return corsResponse({ error: err.message }, 500);
  }
}

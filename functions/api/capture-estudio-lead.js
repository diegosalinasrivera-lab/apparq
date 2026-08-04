/* ══════════════════════════════════════════════════
   APPARQ — Cloudflare Pages Function: capture-estudio-lead
   Guarda un lead del cotizador de estudios en Supabase.
   POST /api/capture-estudio-lead
   Body: { email, estudio_nombre, svc, commune, m2, clp }
══════════════════════════════════════════════════ */

const CORS = {
  'Access-Control-Allow-Origin': 'https://apparq.cl',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

function corsResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: CORS });
}

export async function onRequest(context) {
  const { request, env } = context;
  const SUPABASE_URL = env.SUPABASE_URL || 'https://ibdafnzlsufsshczqvoa.supabase.co';
  const SUPABASE_KEY = env.SUPABASE_SERVICE_KEY || env.SUPABASE_SVC;

  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (request.method !== 'POST') return corsResponse({ error: 'Método no permitido' }, 405);

  try {
    const { email, estudio_nombre, svc, commune, m2, clp } = await request.json();

    if (!email || !email.includes('@')) return corsResponse({ error: 'Email inválido' }, 400);
    if (!estudio_nombre || !estudio_nombre.trim()) return corsResponse({ error: 'Nombre del estudio requerido' }, 400);

    /* Guardamos en leads:
       svc = servicio real (regularizacion, ampliacion, etc.)
       servicio_subtipo = 'estlead:' + nombre del estudio → identifica canal y nombre
    */
    const res = await fetch(`${SUPABASE_URL}/rest/v1/leads`, {
      method: 'POST',
      headers: {
        'apikey':        SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type':  'application/json',
        'Prefer':        'return=minimal',
      },
      body: JSON.stringify({
        email:            email.trim().toLowerCase(),
        svc:              svc || 'desconocido',
        servicio_subtipo: 'estlead:' + estudio_nombre.trim(),
        m2:               m2    || null,
        commune:          commune || null,
        clp:              clp   || null,
        converted:        false,
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      console.error('Supabase error:', err);
      return corsResponse({ error: 'Error al guardar lead' }, 500);
    }

    console.log(`Estudio lead: ${email} | ${estudio_nombre} | ${commune}`);
    return corsResponse({ ok: true });

  } catch (err) {
    console.error('capture-estudio-lead:', err);
    return corsResponse({ error: err.message }, 500);
  }
}

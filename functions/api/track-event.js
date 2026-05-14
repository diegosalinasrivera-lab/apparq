/* ══════════════════════════════════════════════════
   APPARQ — Cloudflare Pages Function: track-event
   Registra eventos de funnel en Supabase.
   Fire-and-forget: siempre responde 200.
   POST /api/track-event  { event_type, svc, commune, clp, email? }
══════════════════════════════════════════════════ */

const SUPABASE_URL = 'https://ibdafnzlsufsshczqvoa.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImliZGFmbnpsc3Vmc3NoY3pxdm9hIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM5Njg0NjYsImV4cCI6MjA4OTU0NDQ2Nn0.ucEjCcnSbaz-OeMrLbUbgcKacvg9J2Csg2VzrWVtVHA';

const CORS = {
  'Access-Control-Allow-Origin':  'https://apparq.cl',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

export async function onRequest(context) {
  const { request, env } = context;
  const url  = env.SUPABASE_URL   || SUPABASE_URL;
  const key  = env.SUPABASE_SERVICE_KEY || env.SUPABASE_SVC || env.SUPABASE_ANON_KEY || SUPABASE_KEY;

  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

  /* Siempre responde 200 — nunca bloquea el flujo del usuario */
  if (request.method !== 'POST') return new Response('{}', { status: 200, headers: CORS });

  try {
    const body = await request.json();
    const { event_type, svc, commune, clp, email } = body;

    if (!event_type) return new Response('{}', { status: 200, headers: CORS });

    await fetch(`${url}/rest/v1/funnel_events`, {
      method: 'POST',
      headers: {
        'apikey':        key,
        'Authorization': `Bearer ${key}`,
        'Content-Type':  'application/json',
        'Prefer':        'return=minimal',
      },
      body: JSON.stringify({
        event_type,
        email:   email   || null,
        svc:     svc     || null,
        commune: commune || null,
        clp:     clp     || null,
      }),
    });
  } catch (_) {
    /* Silencioso — nunca falla hacia el cliente */
  }

  return new Response('{}', { status: 200, headers: CORS });
}

/* ══════════════════════════════════════════════════
   APPARQ — Cloudflare Pages Function: pre-create-project
   Crea el proyecto en Supabase ANTES del redirect a MP,
   con stage = 'pendiente_pago'. Idempotente: si ya existe
   uno con mismo email + pendiente_pago, devuelve ese número.
   POST /api/pre-create-project
══════════════════════════════════════════════════ */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

function corsResponse(body, status = 200) {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: CORS });
}

export async function onRequest(context) {
  const { request, env } = context;
  const SUPABASE_URL = env.SUPABASE_URL || 'https://ibdafnzlsufsshczqvoa.supabase.co';
  /* Usar service key para bypassear RLS en INSERT/SELECT de proyectos */
  const SERVICE_KEY  = env.SUPABASE_SERVICE_KEY || env.SUPABASE_SVC;
  const SUPABASE_KEY = SERVICE_KEY || env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImliZGFmbnpsc3Vmc3NoY3pxdm9hIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM5Njg0NjYsImV4cCI6MjA4OTU0NDQ2Nn0.ucEjCcnSbaz-OeMrLbUbgcKacvg9J2Csg2VzrWVtVHA';

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }
  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  try {
    const body = await request.json();
    const {
      nombre, apellido, email, telefono, rut, direccion,
      svc, servicio_subtipo, m2, commune, clp, e1,
      firma_data,   /* base64 PNG de la firma del cliente */
    } = body;

    if (!email)    return corsResponse({ error: 'email requerido' }, 400);
    if (!telefono) return corsResponse({ error: 'telefono requerido — el cliente debe ingresar su número de contacto' }, 400);

    const emailLower = email.trim().toLowerCase();

    /* ── Idempotencia: verificar si ya existe proyecto pendiente_pago para este email ── */
    const existRes = await fetch(
      `${SUPABASE_URL}/rest/v1/projects?client_email=eq.${encodeURIComponent(emailLower)}&stage=eq.pendiente_pago&select=id,project_number&order=created_at.desc&limit=1`,
      { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
    );
    if (existRes.ok) {
      const existing = await existRes.json();
      if (existing.length > 0) {
        console.log('Proyecto pendiente ya existe para:', emailLower, existing[0].project_number);
        return corsResponse({ ok: true, project_number: existing[0].project_number, project_id: existing[0].id, already_exists: true });
      }
    }

    /* ── Generar número secuencial ── */
    const maxRes = await fetch(
      `${SUPABASE_URL}/rest/v1/projects?select=project_number&order=project_number.desc&limit=1`,
      { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
    );
    const maxData = maxRes.ok ? await maxRes.json() : [];
    let nextSeq = 100;
    if (Array.isArray(maxData) && maxData.length > 0 && maxData[0].project_number) {
      const match = maxData[0].project_number.match(/(\d+)$/);
      if (match) nextSeq = Math.max(parseInt(match[1], 10) + 1, 100);
    }
    const projectNumber = `ARQ-${new Date().getFullYear()}-${String(nextSeq).padStart(6, '0')}`;

    /* ── Subir firma a Supabase Storage si existe ── */
    let firmaUrl = null;
    if (firma_data && SERVICE_KEY) {
      try {
        const base64 = firma_data.replace(/^data:image\/png;base64,/, '');
        const binaryStr = atob(base64);
        const bytes = new Uint8Array(binaryStr.length);
        for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);

        const path = `${projectNumber}/firma/firma-cliente.png`;
        const upRes = await fetch(
          `${SUPABASE_URL}/storage/v1/object/tramite-files/${path}`,
          {
            method: 'POST',
            headers: {
              'apikey':        SERVICE_KEY,
              'Authorization': `Bearer ${SERVICE_KEY}`,
              'Content-Type':  'image/png',
              'x-upsert':      'true',
            },
            body: bytes,
          }
        );
        if (upRes.ok) {
          const signRes = await fetch(
            `${SUPABASE_URL}/storage/v1/object/sign/tramite-files/${path}`,
            {
              method: 'POST',
              headers: {
                'apikey':        SERVICE_KEY,
                'Authorization': `Bearer ${SERVICE_KEY}`,
                'Content-Type':  'application/json',
              },
              body: JSON.stringify({ expiresIn: 315360000 }),
            }
          );
          if (signRes.ok) {
            const signData = await signRes.json();
            if (signData.signedURL) firmaUrl = `${SUPABASE_URL}/storage/v1${signData.signedURL}`;
          }
        }
        if (firmaUrl) console.log('Firma pre-subida a Storage:', firmaUrl);
        else console.warn('No se pudo pre-subir la firma a Storage');
      } catch (firmaErr) {
        console.warn('Error pre-subiendo firma:', firmaErr);
      }
    }

    /* ── INSERT en projects con stage = pendiente_pago ── */
    const insertBody = {
      project_number:     projectNumber,
      client_email:       emailLower,
      client_nombre:      nombre   || '',
      client_apellido:    apellido || '',
      client_telefono:    telefono || '',
      client_rut:         rut      || '',
      architect_email:    null,
      architect_nombre:   '',
      architect_apellido: '',
      service_type:       svc      || '',
      servicio_subtipo:   servicio_subtipo || null,
      num_etapas_pago:    (svc === 'declaracion-jurada' || svc === 'informe') ? 2 : 4,
      address:            direccion || '',
      commune:            commune   || '',
      m2:                 m2        || 0,
      total_clp:          clp       || 0,
      e1_clp:             e1        || 0,
      stage:              'pendiente_pago',
    };
    /* Solo añadir firma_url si la tenemos */
    if (firmaUrl) insertBody.firma_url = firmaUrl;

    const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/projects`, {
      method: 'POST',
      headers: {
        'apikey':        SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type':  'application/json',
        'Prefer':        'return=representation',
      },
      body: JSON.stringify(insertBody),
    });

    if (!insertRes.ok) {
      const err = await insertRes.text();
      console.error('Error insertando proyecto:', err);
      return corsResponse({ error: 'Error al crear proyecto: ' + err }, 500);
    }

    const inserted = await insertRes.json();
    const projectId = Array.isArray(inserted) ? inserted[0]?.id : inserted?.id;
    console.log('Proyecto pre-creado:', projectNumber, projectId);

    return corsResponse({ ok: true, project_number: projectNumber, project_id: projectId });

  } catch (err) {
    console.error('pre-create-project error:', err);
    return corsResponse({ error: err.message }, 500);
  }
}

/* ══════════════════════════════════════════════════
   APPARQ — Cloudflare Pages Function: pre-create-estudio-project
   Crea un proyecto B2B (estudio de arquitectura) en Supabase
   con stage = 'pendiente_pago', sin firma digital.
   Guarda metadatos del estudio en tabla `proyectos_estudio`.
   Crea/actualiza cuenta del estudio en tabla `estudios_accounts`.

   POST /api/pre-create-estudio-project
   Body: {
     nombre, apellido, email, telefono,   ← contacto del trámite
     estudio_nombre, estudio_rut,          ← facturación
     password,                             ← contraseña portal (texto plano, se hashea aquí)
     contacto_tipo,                        ← 'arquitecto_estudio' | 'cliente_final'
     notas,                                ← instrucciones libres (opcional)
     svc, servicio_subtipo, m2, commune, clp, e1,
     direccion
   }

   SQL para crear tablas (ejecutar en Supabase SQL Editor):
   ──────────────────────────────────────────────────
   create table if not exists proyectos_estudio (
     id              uuid primary key default gen_random_uuid(),
     project_number  text not null references projects(project_number),
     estudio_nombre  text,
     estudio_rut     text,
     contacto_tipo   text,   -- 'arquitecto_estudio' | 'cliente_final'
     notas           text,
     created_at      timestamptz default now()
   );

   create table if not exists estudios_accounts (
     id             uuid primary key default gen_random_uuid(),
     email          text unique not null,
     password_hash  text not null,
     estudio_nombre text,
     estudio_rut    text,
     created_at     timestamptz default now()
   );
   ──────────────────────────────────────────────────
══════════════════════════════════════════════════ */

async function hashPassword(password, email) {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: enc.encode(email.toLowerCase()), iterations: 100000, hash: 'SHA-256' },
    keyMaterial, 256
  );
  return btoa(String.fromCharCode(...new Uint8Array(bits)));
}

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
      nombre, apellido, email, telefono, direccion,
      estudio_nombre, estudio_rut, password,
      contacto_tipo, notas,
      svc, servicio_subtipo, m2, commune, clp, e1,
    } = body;

    if (!email)         return corsResponse({ error: 'email requerido' }, 400);
    if (!telefono)      return corsResponse({ error: 'telefono requerido' }, 400);
    if (!estudio_rut)   return corsResponse({ error: 'estudio_rut requerido' }, 400);

    const emailLower = email.trim().toLowerCase();

    /* ── Idempotencia: proyecto pendiente_pago para este email ── */
    const existRes = await fetch(
      `${SUPABASE_URL}/rest/v1/projects?client_email=eq.${encodeURIComponent(emailLower)}&stage=eq.pendiente_pago&select=id,project_number&order=created_at.desc&limit=1`,
      { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
    );
    if (existRes.ok) {
      const existing = await existRes.json();
      if (existing.length > 0) {
        return corsResponse({ ok: true, project_number: existing[0].project_number, project_id: existing[0].id, already_exists: true });
      }
    }

    /* ── Número secuencial ── */
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

    /* ── INSERT en projects ──
       client_rut = RUT del estudio (para facturación)
       client_nombre/apellido/email/telefono = persona de contacto del trámite
    ── */
    const insertBody = {
      project_number:     projectNumber,
      client_email:       emailLower,
      client_nombre:      nombre   || '',
      client_apellido:    apellido || '',
      client_telefono:    telefono || '',
      client_rut:         estudio_rut || '',
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
      console.error('Error insertando proyecto estudio:', err);
      return corsResponse({ error: 'Error al crear proyecto: ' + err }, 500);
    }

    const inserted = await insertRes.json();
    const projectId = Array.isArray(inserted) ? inserted[0]?.id : inserted?.id;
    console.log('Proyecto estudio pre-creado:', projectNumber, projectId);

    /* ── INSERT en proyectos_estudio (metadatos B2B) ──
       Si la tabla no existe aún, se loguea pero no bloquea el flujo.
    ── */
    try {
      await fetch(`${SUPABASE_URL}/rest/v1/proyectos_estudio`, {
        method: 'POST',
        headers: {
          'apikey':        SUPABASE_KEY,
          'Authorization': `Bearer ${SUPABASE_KEY}`,
          'Content-Type':  'application/json',
          'Prefer':        'return=minimal',
        },
        body: JSON.stringify({
          project_number: projectNumber,
          estudio_nombre: estudio_nombre || '',
          estudio_rut:    estudio_rut    || '',
          contacto_tipo:  contacto_tipo  || '',
          notas:          notas          || '',
        }),
      });
    } catch (metaErr) {
      console.warn('proyectos_estudio insert failed (tabla puede no existir aún):', metaErr.message);
    }

    /* ── UPSERT en estudios_accounts (cuenta del portal) ── */
    if (password) {
      try {
        const hash = await hashPassword(password, emailLower);
        await fetch(`${SUPABASE_URL}/rest/v1/estudios_accounts`, {
          method: 'POST',
          headers: {
            'apikey':        SUPABASE_KEY,
            'Authorization': `Bearer ${SUPABASE_KEY}`,
            'Content-Type':  'application/json',
            'Prefer':        'resolution=merge-duplicates,return=minimal',
          },
          body: JSON.stringify({
            email:          emailLower,
            password_hash:  hash,
            estudio_nombre: estudio_nombre || '',
            estudio_rut:    estudio_rut    || '',
          }),
        });
      } catch (accErr) {
        console.warn('estudios_accounts upsert failed:', accErr.message);
      }
    }

    return corsResponse({ ok: true, project_number: projectNumber, project_id: projectId });

  } catch (err) {
    console.error('pre-create-estudio-project error:', err);
    return corsResponse({ error: err.message }, 500);
  }
}

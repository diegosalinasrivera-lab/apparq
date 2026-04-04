/* ══════════════════════════════════════════════════
   APPARQ — Cloudflare Pages Function: files
   Gestión de archivos por trámite usando Supabase Storage
   POST /api/files
   Actions:
     get-upload-url  — URL firmada para subir un archivo directamente a Supabase
     list            — lista archivos del trámite con URLs de descarga firmadas
     delete          — elimina un archivo (solo la carpeta propia)
   Auth:
     cliente:    { project_number, email }
     arquitecto: { token, project_number }
══════════════════════════════════════════════════ */

const BUCKET = 'tramite-files';

const CORS = {
  'Access-Control-Allow-Origin': 'https://apparq.cl',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: CORS });
}

/* ── Auth helpers ──────────────────────────────── */
async function verifyClient(projectNumber, email, SUPABASE_URL, KEY) {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/projects?project_number=eq.${encodeURIComponent(projectNumber)}&client_email=eq.${encodeURIComponent(email)}&select=id,project_number&limit=1`,
    { headers: { 'apikey': KEY, 'Authorization': `Bearer ${KEY}` } }
  );
  if (!res.ok) return false;
  const data = await res.json();
  return data.length > 0;
}

async function verifyArchitect(token, SUPABASE_URL, KEY) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { 'apikey': KEY, 'Authorization': `Bearer ${token}` },
  });
  if (!res.ok) return null;
  const user = await res.json();
  return user.email?.toLowerCase() || null;
}

/* ── Supabase Storage helpers ──────────────────── */
async function ensureBucket(SUPABASE_URL, SERVICE_KEY) {
  try {
    await fetch(`${SUPABASE_URL}/storage/v1/bucket`, {
      method: 'POST',
      headers: {
        'apikey': SERVICE_KEY,
        'Authorization': `Bearer ${SERVICE_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ id: BUCKET, name: BUCKET, public: false, fileSizeLimit: 52428800 }), // 50 MB
    });
  } catch (_) { /* bucket ya existe, ok */ }
}

async function createSignedUploadUrl(SUPABASE_URL, SERVICE_KEY, path) {
  const res = await fetch(
    `${SUPABASE_URL}/storage/v1/object/upload/sign/${BUCKET}/${path}`,
    {
      method: 'POST',
      headers: {
        'apikey': SERVICE_KEY,
        'Authorization': `Bearer ${SERVICE_KEY}`,
        'Content-Type': 'application/json',
      },
      body: '{}',
    }
  );
  if (!res.ok) {
    const err = await res.text();
    throw new Error('Error al crear URL de carga: ' + err);
  }
  return res.json(); // { signedURL, token, url }
}

async function createSignedDownloadUrl(SUPABASE_URL, SERVICE_KEY, path, expiresIn = 7200) {
  const res = await fetch(
    `${SUPABASE_URL}/storage/v1/object/sign/${BUCKET}/${path}`,
    {
      method: 'POST',
      headers: {
        'apikey': SERVICE_KEY,
        'Authorization': `Bearer ${SERVICE_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ expiresIn }),
    }
  );
  if (!res.ok) return null;
  const data = await res.json();
  if (!data.signedURL) return null;
  return `${SUPABASE_URL}/storage/v1${data.signedURL}`;
}

async function listFolder(SUPABASE_URL, SERVICE_KEY, prefix) {
  const res = await fetch(
    `${SUPABASE_URL}/storage/v1/object/list/${BUCKET}`,
    {
      method: 'POST',
      headers: {
        'apikey': SERVICE_KEY,
        'Authorization': `Bearer ${SERVICE_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        prefix,
        limit: 200,
        offset: 0,
        sortBy: { column: 'created_at', order: 'desc' },
      }),
    }
  );
  if (!res.ok) return [];
  const data = await res.json();
  return Array.isArray(data) ? data : [];
}

async function deleteObject(SUPABASE_URL, SERVICE_KEY, path) {
  const res = await fetch(
    `${SUPABASE_URL}/storage/v1/object/${BUCKET}`,
    {
      method: 'DELETE',
      headers: {
        'apikey': SERVICE_KEY,
        'Authorization': `Bearer ${SERVICE_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ prefixes: [path] }),
    }
  );
  return res.ok;
}

/* ── Main handler ──────────────────────────────── */
export async function onRequest(context) {
  const { request, env } = context;

  const SUPABASE_URL  = env.SUPABASE_URL  || 'https://ibdafnzlsufsshczqvoa.supabase.co';
  const ANON_KEY      = env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImliZGFmbnpsc3Vmc3NoY3pxdm9hIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM5Njg0NjYsImV4cCI6MjA4OTU0NDQ2Nn0.ucEjCcnSbaz-OeMrLbUbgcKacvg9J2Csg2VzrWVtVHA';
  const SERVICE_KEY   = env.SUPABASE_SERVICE_KEY || env.SUPABASE_SVC;

  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (request.method !== 'POST')    return json({ error: 'Método no permitido' }, 405);
  if (!SERVICE_KEY)                 return json({ error: 'Servicio de archivos no configurado' }, 503);

  let body;
  try { body = await request.json(); }
  catch (_) { return json({ error: 'JSON inválido' }, 400); }

  const { action, project_number, email, token, filename } = body;
  const filePath = body.path; // 'path' es palabra reservada

  if (!action)         return json({ error: 'Se requiere action' }, 400);
  if (!project_number) return json({ error: 'Se requiere project_number' }, 400);

  const numUpper = project_number.trim().toUpperCase();

  /* ── Verificar identidad ───────────────────────── */
  let role = null; // 'client' | 'architect'

  if (token) {
    const archEmail = await verifyArchitect(token, SUPABASE_URL, ANON_KEY);
    if (archEmail) role = 'architect';
  }
  if (!role && email) {
    const ok = await verifyClient(numUpper, email.trim().toLowerCase(), SUPABASE_URL, ANON_KEY);
    if (ok) role = 'client';
  }
  if (!role) return json({ error: 'No autorizado' }, 403);

  try {
    await ensureBucket(SUPABASE_URL, SERVICE_KEY);

    /* ── get-upload-url ──────────────────────────── */
    if (action === 'get-upload-url') {
      if (!filename) return json({ error: 'Se requiere filename' }, 400);

      const uploader  = role === 'architect' ? 'arquitecto' : 'cliente';
      const safeName  = filename
        .replace(/[<>:"/\\|?*\x00-\x1f ]/g, '_') // caracteres inválidos y espacios → _
        .slice(0, 120);
      const path = `${numUpper}/${uploader}/${Date.now()}_${safeName}`;

      const signed = await createSignedUploadUrl(SUPABASE_URL, SERVICE_KEY, path);
      // 'url' es la URL completa devuelta por Supabase
      const uploadUrl = signed.url || `${SUPABASE_URL}/storage/v1${signed.signedURL}`;
      return json({ uploadUrl, path });
    }

    /* ── list ────────────────────────────────────── */
    if (action === 'list') {
      const [clientObjs, archObjs] = await Promise.all([
        listFolder(SUPABASE_URL, SERVICE_KEY, `${numUpper}/cliente`),
        listFolder(SUPABASE_URL, SERVICE_KEY, `${numUpper}/arquitecto`),
      ]);

      const toObj = (f, uploader) => ({
        name:       f.name.replace(/^\d+_/, ''), // quitar prefijo timestamp
        rawName:    f.name,
        path:       `${numUpper}/${uploader}/${f.name}`,
        size:       f.metadata?.size   || 0,
        mimetype:   f.metadata?.mimetype || '',
        created_at: f.created_at || '',
        uploader,
      });

      const placeholder = '.emptyFolderPlaceholder';
      const all = [
        ...clientObjs.filter(f => f.name && f.name !== placeholder).map(f => toObj(f, 'cliente')),
        ...archObjs.filter(f  => f.name && f.name !== placeholder).map(f => toObj(f, 'arquitecto')),
      ];

      // URLs de descarga firmadas (2h de validez)
      const withUrls = await Promise.all(all.map(async f => ({
        ...f,
        downloadUrl: await createSignedDownloadUrl(SUPABASE_URL, SERVICE_KEY, f.path),
      })));

      // Ordenar: primero arquitecto (planos), luego cliente (docs), cada grupo por fecha desc
      withUrls.sort((a, b) => {
        if (a.uploader !== b.uploader) return a.uploader === 'arquitecto' ? -1 : 1;
        return new Date(b.created_at) - new Date(a.created_at);
      });

      return json({ files: withUrls });
    }

    /* ── delete ──────────────────────────────────── */
    if (action === 'delete') {
      if (!filePath) return json({ error: 'Se requiere path' }, 400);

      // Cada rol solo puede eliminar su propia carpeta
      const allowedPrefix = `${numUpper}/${role === 'architect' ? 'arquitecto' : 'cliente'}/`;
      if (!filePath.startsWith(allowedPrefix)) {
        return json({ error: 'No tienes permiso para eliminar este archivo' }, 403);
      }

      const ok = await deleteObject(SUPABASE_URL, SERVICE_KEY, filePath);
      if (!ok) return json({ error: 'Error al eliminar el archivo' }, 500);
      return json({ ok: true });
    }

    return json({ error: 'Acción no reconocida' }, 400);

  } catch (err) {
    console.error('files error:', err);
    return json({ error: 'Error interno: ' + err.message }, 500);
  }
}

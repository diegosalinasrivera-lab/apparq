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
const NOTIFY_EMAIL = 'hola@apparq.cl';

const CORS = {
  'Access-Control-Allow-Origin': 'https://apparq.cl',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: CORS });
}

async function sendEmail({ to, subject, html }, RESEND_API_KEY) {
  if (!RESEND_API_KEY) return;
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'APPARQ <hola@apparq.cl>', to, subject, html }),
    });
    if (!res.ok) console.error('Resend error (files):', await res.text());
  } catch (e) { console.error('sendEmail error (files):', e); }
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
  const RESEND_API_KEY = env.RESEND_API_KEY || 're_RRVTgGik_GtaRwK2p9jimrkemYTY4Uew6';

  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (request.method !== 'POST')    return json({ error: 'Método no permitido' }, 405);
  if (!SERVICE_KEY)                 return json({ error: 'Servicio de archivos no configurado' }, 503);

  // Crear bucket si no existe (idempotente, antes de auth para garantizar que ocurra en el primer request)
  await ensureBucket(SUPABASE_URL, SERVICE_KEY);

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

    /* ── get-upload-url ──────────────────────────── */
    if (action === 'get-upload-url') {
      if (!filename) return json({ error: 'Se requiere filename' }, 400);

      const uploader  = role === 'architect' ? 'arquitecto' : 'cliente';
      const safeName  = filename
        .replace(/[<>:"/\\|?*\x00-\x1f ]/g, '_') // caracteres inválidos y espacios → _
        .slice(0, 120);
      const path = `${numUpper}/${uploader}/${Date.now()}_${safeName}`;

      const signed = await createSignedUploadUrl(SUPABASE_URL, SERVICE_KEY, path);
      /* Siempre construir URL absoluta con el dominio de Supabase.
         signed.url puede ser relativa (/object/upload/sign/...) en algunas versiones,
         lo que causaría que el browser intentara subir a apparq.cl en vez de Supabase. */
      const signedPath = signed.signedURL || signed.url || '';
      const uploadUrl  = signedPath.startsWith('http')
        ? signedPath
        : `${SUPABASE_URL}/storage/v1${signedPath}`;
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

    /* ── confirm-upload ──────────────────────────── */
    if (action === 'confirm-upload') {
      /* Llamado por el frontend tras PUT exitoso; envía notificación interna */
      const uploadedFilename = body.filename || filename || '(sin nombre)';
      const filesize         = body.filesize || 0;
      const sizeMB           = filesize ? `${(filesize / 1024 / 1024).toFixed(2)} MB` : '—';
      const uploaderLabel    = role === 'architect' ? 'Arquitecto' : 'Cliente';
      const emoji            = role === 'architect' ? '🏗' : '📁';
      const fechaHora        = new Date().toLocaleString('es-CL', {
        timeZone: 'America/Santiago', day: '2-digit', month: 'long', year: 'numeric',
        hour: '2-digit', minute: '2-digit',
      });

      /* Obtener datos del proyecto para el correo */
      let proyectoHtml = '';
      try {
        const projRes = await fetch(
          `${SUPABASE_URL}/rest/v1/projects?project_number=eq.${encodeURIComponent(numUpper)}&select=client_nombre,client_apellido,client_email,architect_nombre,architect_apellido,architect_email,service_type,commune,address&limit=1`,
          { headers: { 'apikey': SERVICE_KEY, 'Authorization': `Bearer ${SERVICE_KEY}` } }
        );
        if (projRes.ok) {
          const projArr = await projRes.json();
          if (projArr.length) {
            const p = projArr[0];
            const svcLabels = { regularizacion:'Regularización', ampliacion:'Ampliación', 'obra-nueva':'Obra Nueva', informe:'Informe', 'declaracion-jurada':'Declaración Jurada', 'ley-del-mono':'Ley del Mono' };
            proyectoHtml = `
              <table style="width:100%;border-collapse:collapse;font-size:13px;margin-top:14px">
                <tr style="background:#f7fafc"><td style="padding:7px 10px;color:#718096;width:40%">Servicio</td><td style="padding:7px 10px">${svcLabels[p.service_type] || p.service_type} · ${p.commune}</td></tr>
                <tr><td style="padding:7px 10px;color:#718096">Dirección</td><td style="padding:7px 10px">${p.address || '—'}, ${p.commune}</td></tr>
                <tr style="background:#f7fafc"><td style="padding:7px 10px;color:#718096">Cliente</td><td style="padding:7px 10px">${p.client_nombre} ${p.client_apellido} · ${p.client_email}</td></tr>
                <tr><td style="padding:7px 10px;color:#718096">Arquitecto</td><td style="padding:7px 10px">${p.architect_nombre} ${p.architect_apellido} · ${p.architect_email || '—'}</td></tr>
              </table>`;
          }
        }
      } catch (_) { /* no bloquear si falla la fetch del proyecto */ }

      await sendEmail({
        to: NOTIFY_EMAIL,
        subject: `${emoji} Archivo subido — ${numUpper} · ${uploaderLabel}`,
        html: `
          <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#1a1a2e">
            <div style="background:#1a1a2e;padding:22px 32px;border-radius:8px 8px 0 0">
              <h2 style="color:#fff;margin:0;font-size:17px">APPARQ — Archivo subido a la plataforma</h2>
            </div>
            <div style="background:#EFF6FF;border:2px solid #BFDBFE;padding:12px 32px">
              <p style="margin:0;font-size:14px;font-weight:700;color:#1D4ED8">${emoji} ${uploaderLabel} subió un archivo al trámite <strong>${numUpper}</strong></p>
            </div>
            <div style="background:#fff;padding:22px 32px;border:1px solid #e2e8f0;border-radius:0 0 8px 8px">
              <table style="width:100%;border-collapse:collapse;font-size:13px">
                <tr style="background:#f7fafc"><td style="padding:7px 10px;color:#718096;width:40%">N° Trámite</td><td style="padding:7px 10px;font-weight:700;color:#E8503A">${numUpper}</td></tr>
                <tr><td style="padding:7px 10px;color:#718096">Subido por</td><td style="padding:7px 10px;font-weight:700">${uploaderLabel}</td></tr>
                <tr style="background:#f7fafc"><td style="padding:7px 10px;color:#718096">Nombre archivo</td><td style="padding:7px 10px">${uploadedFilename}</td></tr>
                <tr><td style="padding:7px 10px;color:#718096">Tamaño</td><td style="padding:7px 10px">${sizeMB}</td></tr>
                <tr style="background:#f7fafc"><td style="padding:7px 10px;color:#718096">Fecha y hora</td><td style="padding:7px 10px">${fechaHora}</td></tr>
              </table>
              ${proyectoHtml}
              <div style="text-align:center;margin-top:18px">
                <a href="https://apparq.cl/admin" style="display:inline-block;background:#E8503A;color:#fff;text-decoration:none;font-weight:700;font-size:13px;padding:9px 24px;border-radius:6px">Ver en Admin</a>
              </div>
            </div>
          </div>`,
      }, RESEND_API_KEY);

      return json({ ok: true });
    }

    return json({ error: 'Acción no reconocida' }, 400);

  } catch (err) {
    console.error('files error:', err);
    return json({ error: 'Error interno: ' + err.message }, 500);
  }
}

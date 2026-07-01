/* ══════════════════════════════════════════════════
   APPARQ — Cloudflare Pages Function: portal-estudio
   Portal B2B para estudios de arquitectura.
   Login: email + contraseña (verificada contra estudios_accounts).
   Retorna todos los trámites del estudio con etapa y actualizaciones.

   POST /api/portal-estudio
   Body: { email, password }              → lista de proyectos del estudio
   Body: { email, password, action:'get-updates', project_number } → updates
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
  'Access-Control-Allow-Origin': 'https://apparq.cl',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: CORS });
}

const STAGE_LABELS = {
  levantamiento:   { label: 'Levantamiento en terreno', pct: 20, color: '#3B82F6' },
  elaboracion:     { label: 'Elaboración de planos',    pct: 40, color: '#3B82F6' },
  ingreso_dom:     { label: 'Ingreso a la DOM',         pct: 60, color: '#F59E0B' },
  tramitacion:     { label: 'Tramitación municipal',    pct: 80, color: '#F59E0B' },
  completado:      { label: 'Completado',               pct: 100, color: '#10B981' },
  visita:          { label: 'Visita a terreno',         pct: 33, color: '#3B82F6' },
  elaboracion_inf: { label: 'Elaboración del informe',  pct: 66, color: '#3B82F6' },
  entrega_informe: { label: 'Informe entregado',        pct: 100, color: '#10B981' },
  pendiente_pago:  { label: 'Pendiente de pago',        pct: 5,  color: '#9CA3AF' },
};

const SVC_LABEL = {
  regularizacion: 'Regularización',
  ampliacion:     'Ampliación',
  'obra-nueva':   'Obra Nueva',
  informe:        'Informe de Propiedad',
  'declaracion-jurada': 'Declaración Jurada',
};

export async function onRequest({ request, env }) {
  const SUPABASE_URL = env.SUPABASE_URL || 'https://ibdafnzlsufsshczqvoa.supabase.co';
  const SUPABASE_KEY = env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImliZGFmbnpsc3Vmc3NoY3pxdm9hIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM5Njg0NjYsImV4cCI6MjA4OTU0NDQ2Nn0.ucEjCcnSbaz-OeMrLbUbgcKacvg9J2Csg2VzrWVtVHA';
  const headers = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` };

  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (request.method !== 'POST') return json({ error: 'Método no permitido' }, 405);

  let body;
  try { body = await request.json(); } catch { return json({ error: 'JSON inválido' }, 400); }

  const email    = (body.email    || '').trim().toLowerCase();
  const password = (body.password || '').trim();

  if (!email || !password) return json({ error: 'Email y contraseña requeridos' }, 400);

  /* ── Verificar contraseña contra estudios_accounts ── */
  const accRes = await fetch(
    `${SUPABASE_URL}/rest/v1/estudios_accounts?email=eq.${encodeURIComponent(email)}&select=password_hash,estudio_nombre&limit=1`,
    { headers }
  );
  const accounts = accRes.ok ? await accRes.json() : [];
  if (!accounts.length) return json({ error: 'No existe una cuenta con ese email.' }, 404);

  const expectedHash = await hashPassword(password, email);
  if (accounts[0].password_hash !== expectedHash) {
    return json({ error: 'Contraseña incorrecta.' }, 401);
  }

  const estudio_nombre_account = accounts[0].estudio_nombre || '';

  /* ── get-updates: actualizaciones de un trámite específico ── */
  if (body.action === 'get-updates') {
    const num = (body.project_number || '').trim().toUpperCase();
    if (!num) return json({ error: 'project_number requerido' }, 400);

    /* Verificar que el trámite pertenece al estudio */
    const verRes = await fetch(
      `${SUPABASE_URL}/rest/v1/projects?project_number=eq.${encodeURIComponent(num)}&client_email=eq.${encodeURIComponent(email)}&select=id&limit=1`,
      { headers }
    );
    const ver = verRes.ok ? await verRes.json() : [];
    if (!ver.length) return json({ error: 'Trámite no encontrado' }, 404);

    const updRes = await fetch(
      `${SUPABASE_URL}/rest/v1/project_updates?project_number=eq.${encodeURIComponent(num)}&order=created_at.asc`,
      { headers }
    );
    const updates = updRes.ok ? await updRes.json() : [];
    return json({ updates });
  }

  /* ── default: listar todos los trámites del estudio ── */
  const projRes = await fetch(
    `${SUPABASE_URL}/rest/v1/projects?client_email=eq.${encodeURIComponent(email)}&order=created_at.desc&select=*`,
    { headers }
  );
  if (!projRes.ok) return json({ error: 'Error consultando proyectos' }, 500);

  const projects = await projRes.json();
  if (!projects.length) return json({ error: 'No se encontraron trámites para estos datos.' }, 404);

  /* Enriquecer con stage_label / pct / color */
  const enriched = projects.map(p => {
    const s = STAGE_LABELS[p.stage] || { label: p.stage, pct: 0, color: '#9CA3AF' };
    return {
      project_number:  p.project_number,
      service_type:    p.service_type,
      service_label:   SVC_LABEL[p.service_type] || p.service_type,
      commune:         p.commune,
      address:         p.address,
      stage:           p.stage,
      stage_label:     s.label,
      stage_pct:       s.pct,
      stage_color:     s.color,
      architect_nombre: p.architect_nombre ? `${p.architect_nombre} ${p.architect_apellido}`.trim() : null,
      created_at:      p.created_at,
      total_clp:       p.total_clp,
    };
  });

  return json({ projects: enriched, estudio_nombre: estudio_nombre_account });
}

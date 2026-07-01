/* ══════════════════════════════════════════════════
   APPARQ — Cloudflare Pages Function: portal-estudio
   Portal B2B para estudios de arquitectura.
   Login: email + RUT del estudio (client_email + client_rut en projects).
   Retorna todos los trámites del estudio con etapa y actualizaciones.

   POST /api/portal-estudio
   Body: { email, rut }              → lista de proyectos del estudio
   Body: { email, rut, action:'get-updates', project_number } → updates de un trámite
══════════════════════════════════════════════════ */

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

  const email = (body.email || '').trim().toLowerCase();
  const rut   = (body.rut   || '').trim().replace(/\./g, '').toUpperCase();

  if (!email || !rut) return json({ error: 'Email y RUT requeridos' }, 400);

  /* ── get-updates: actualizaciones de un trámite específico ── */
  if (body.action === 'get-updates') {
    const num = (body.project_number || '').trim().toUpperCase();
    if (!num) return json({ error: 'project_number requerido' }, 400);

    /* Verificar que el trámite pertenece al estudio */
    const verRes = await fetch(
      `${SUPABASE_URL}/rest/v1/projects?project_number=eq.${encodeURIComponent(num)}&client_email=eq.${encodeURIComponent(email)}&client_rut=ilike.${encodeURIComponent(rut)}&select=id&limit=1`,
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
    `${SUPABASE_URL}/rest/v1/projects?client_email=eq.${encodeURIComponent(email)}&client_rut=ilike.${encodeURIComponent(rut)}&order=created_at.desc&select=*`,
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

  /* Nombre del estudio desde proyectos_estudio (primer registro) */
  let estudio_nombre = '';
  try {
    const estRes = await fetch(
      `${SUPABASE_URL}/rest/v1/proyectos_estudio?project_number=eq.${encodeURIComponent(projects[0].project_number)}&select=estudio_nombre&limit=1`,
      { headers }
    );
    const est = estRes.ok ? await estRes.json() : [];
    if (est.length) estudio_nombre = est[0].estudio_nombre || '';
  } catch (_) {}

  return json({ projects: enriched, estudio_nombre });
}

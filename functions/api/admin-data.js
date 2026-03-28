/* ══════════════════════════════════════════════════
   APPARQ — Cloudflare Pages Function: admin-data
   Admin-only API: verifica JWT, opera con service role.
   GET  /api/admin-data?section=architects|projects|payments
   POST /api/admin-data  body: { action, ...params }
══════════════════════════════════════════════════ */

const SUPABASE_URL     = 'https://ibdafnzlsufsshczqvoa.supabase.co';
const SUPABASE_ANON    = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImliZGFmbnpsc3Vmc3NoY3pxdm9hIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM5Njg0NjYsImV4cCI6MjA4OTU0NDQ2Nn0.ucEjCcnSbaz-OeMrLbUbgcKacvg9J2Csg2VzrWVtVHA';
const SERVICE_KEY      = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImliZGFmbnpsc3Vmc3NoY3pxdm9hIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3Mzk2ODQ2NiwiZXhwIjoyMDg5NTQ0NDY2fQ.GyDKA0A9PhfHqKD8bm8rR_EVS45JtOBEMArXFBfXvQg';
const ADMIN_EMAIL      = 'diegosalinasrivera@gmail.com';

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Content-Type': 'application/json',
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: CORS });
}

/* ── Verify JWT and return user email ─────────── */
async function verifyAdmin(authHeader) {
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  const token = authHeader.slice(7);

  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: {
      'apikey':        SUPABASE_ANON,
      'Authorization': `Bearer ${token}`,
    },
  });

  if (!res.ok) return null;
  const user = await res.json();
  if (!user || !user.email) return null;
  if (user.email.toLowerCase() !== ADMIN_EMAIL) return null;
  return user.email;
}

/* ── Supabase REST helper (service role) ──────── */
async function sb(path, opts = {}) {
  const url = `${SUPABASE_URL}/rest/v1${path}`;
  const res = await fetch(url, {
    ...opts,
    headers: {
      'apikey':        SERVICE_KEY,
      'Authorization': `Bearer ${SERVICE_KEY}`,
      'Content-Type':  'application/json',
      'Prefer':        opts.prefer || 'return=representation',
      ...(opts.headers || {}),
    },
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch(_) { data = text; }
  return { ok: res.ok, status: res.status, data };
}

/* ══════════════════════════════════════════════════
   MAIN HANDLER
══════════════════════════════════════════════════ */
export async function onRequest(context) {
  const { request } = context;

  /* CORS preflight */
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }

  /* Auth check */
  const adminEmail = await verifyAdmin(request.headers.get('Authorization'));
  if (!adminEmail) {
    return json({ error: 'No autorizado' }, 403);
  }

  /* ── GET ──────────────────────────────────────── */
  if (request.method === 'GET') {
    const section = new URL(request.url).searchParams.get('section');

    if (section === 'architects') {
      const { ok, data } = await sb(
        '/architects?select=id,nombre,apellido,email,telefono,rut,patente,tramites,comunas,activo,created_at,foto_url&order=created_at.desc'
      );
      if (!ok) return json({ error: 'Error al obtener arquitectos' }, 500);
      return json({ architects: data });
    }

    if (section === 'projects') {
      const { ok, data } = await sb(
        '/projects?select=id,project_number,client_email,client_nombre,client_apellido,client_telefono,client_rut,architect_email,architect_nombre,architect_apellido,service_type,address,commune,m2,total_clp,e1_clp,stage,created_at&order=created_at.desc&limit=200'
      );
      if (!ok) return json({ error: 'Error al obtener trámites' }, 500);
      return json({ projects: data });
    }

    if (section === 'payments') {
      const { ok, data } = await sb(
        '/payments?select=id,mp_payment_id,external_ref,status,amount,currency,payer_email,payment_method,created_at&order=created_at.desc&limit=200'
      );
      if (!ok) return json({ error: 'Error al obtener pagos' }, 500);
      return json({ payments: data });
    }

    if (section === 'dashboard') {
      /* Fetch all in parallel */
      const [archRes, projRes, payRes] = await Promise.all([
        sb('/architects?select=id,activo'),
        sb('/projects?select=id,project_number,client_nombre,client_apellido,client_email,service_type,commune,architect_nombre,architect_apellido,stage,total_clp,created_at&order=created_at.desc&limit=500'),
        sb('/payments?select=id,amount,status,payer_email,payment_method,created_at&order=created_at.desc&limit=500'),
      ]);

      const architects = archRes.ok && Array.isArray(archRes.data) ? archRes.data : [];
      const projects   = projRes.ok && Array.isArray(projRes.data) ? projRes.data : [];
      const payments   = payRes.ok  && Array.isArray(payRes.data)  ? payRes.data  : [];

      const now        = new Date();
      const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

      const totalArchitectos  = architects.length;
      const tramitesActivos   = projects.filter(p => p.stage && p.stage !== 'completado').length;
      const recaudadoTotal    = payments.filter(p => p.status === 'approved').reduce((s, p) => s + (p.amount || 0), 0);
      const tramitesMes       = projects.filter(p => p.created_at >= monthStart).length;

      /* Last 10 projects + last 5 payments for recent tables */
      const recentProjects = projects.slice(0, 10);
      const recentPayments = payments.slice(0, 5);

      return json({ totalArchitectos, tramitesActivos, recaudadoTotal, tramitesMes, recentProjects, recentPayments });
    }

    return json({ error: 'Sección no válida' }, 400);
  }

  /* ── POST ─────────────────────────────────────── */
  if (request.method === 'POST') {
    let body;
    try { body = await request.json(); } catch(_) { return json({ error: 'Body inválido' }, 400); }

    const { action } = body;

    /* add_architect */
    if (action === 'add_architect') {
      const { nombre, apellido, email, telefono, rut, patente, comunas, tramites } = body;
      if (!nombre || !apellido || !email) {
        return json({ error: 'nombre, apellido y email son obligatorios' }, 400);
      }
      const { ok, data } = await sb('/architects', {
        method: 'POST',
        body: JSON.stringify({ nombre, apellido, email: email.toLowerCase(), telefono, rut, patente, comunas: comunas || [], tramites: tramites || [], activo: true }),
        prefer: 'return=representation',
      });
      if (!ok) return json({ error: 'Error al crear arquitecto', detail: data }, 500);
      return json({ success: true, architect: Array.isArray(data) ? data[0] : data });
    }

    /* delete_architect */
    if (action === 'delete_architect') {
      const { id } = body;
      if (!id) return json({ error: 'id requerido' }, 400);
      const { ok, data } = await sb(`/architects?id=eq.${id}`, {
        method: 'DELETE',
        prefer: 'return=minimal',
      });
      if (!ok) return json({ error: 'Error al eliminar arquitecto', detail: data }, 500);
      return json({ success: true });
    }

    /* toggle_architect_activo */
    if (action === 'toggle_architect') {
      const { id, activo } = body;
      if (id === undefined || activo === undefined) return json({ error: 'id y activo requeridos' }, 400);
      const { ok, data } = await sb(`/architects?id=eq.${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ activo }),
        prefer: 'return=representation',
      });
      if (!ok) return json({ error: 'Error al actualizar arquitecto', detail: data }, 500);
      return json({ success: true, architect: Array.isArray(data) ? data[0] : data });
    }

    /* assign_tramite / reassign_tramite */
    if (action === 'assign_tramite' || action === 'reassign_tramite') {
      const { project_id, architect_email, architect_nombre, architect_apellido } = body;
      if (!project_id || !architect_email) {
        return json({ error: 'project_id y architect_email requeridos' }, 400);
      }
      const { ok, data } = await sb(`/projects?id=eq.${project_id}`, {
        method: 'PATCH',
        body: JSON.stringify({ architect_email, architect_nombre: architect_nombre || '', architect_apellido: architect_apellido || '' }),
        prefer: 'return=representation',
      });
      if (!ok) return json({ error: 'Error al asignar arquitecto', detail: data }, 500);
      return json({ success: true, project: Array.isArray(data) ? data[0] : data });
    }

    /* update_stage */
    if (action === 'update_stage') {
      const { project_id, stage } = body;
      if (!project_id || !stage) return json({ error: 'project_id y stage requeridos' }, 400);
      const { ok, data } = await sb(`/projects?id=eq.${project_id}`, {
        method: 'PATCH',
        body: JSON.stringify({ stage }),
        prefer: 'return=representation',
      });
      if (!ok) return json({ error: 'Error al actualizar etapa', detail: data }, 500);
      return json({ success: true, project: Array.isArray(data) ? data[0] : data });
    }

    return json({ error: 'Acción no reconocida' }, 400);
  }

  return json({ error: 'Método no permitido' }, 405);
}

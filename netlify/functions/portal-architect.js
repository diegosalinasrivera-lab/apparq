/* ══════════════════════════════════════════════════
   APPARQ — Netlify Function: portal-architect
   Portal del arquitecto: ver y gestionar sus proyectos
   Requiere token de autenticación (Supabase Auth)
   POST /.netlify/functions/portal-architect
   Body: { action, token, ... }
   Actions: 'get-projects' | 'update-stage' | 'send-message' | 'get-messages'
══════════════════════════════════════════════════ */

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
};

const STAGES_NORMAL  = ['levantamiento','elaboracion','ingreso_dom','tramitacion','completado'];
const STAGES_INFORME = ['visita','elaboracion_inf','entrega_informe'];
const STAGE_LABELS   = {
  levantamiento:    'Levantamiento en terreno',
  elaboracion:      'Elaboración de planos',
  ingreso_dom:      'Ingreso a la DOM',
  tramitacion:      'Tramitación municipal',
  completado:       'Trámite completado',
  visita:           'Visita a terreno',
  elaboracion_inf:  'Elaboración del informe',
  entrega_informe:  'Informe entregado',
};

/* Verifica token con Supabase Auth y devuelve el email */
async function verifyToken(token) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: {
      'apikey':        SUPABASE_KEY,
      'Authorization': `Bearer ${token}`,
    },
  });
  if (!res.ok) return null;
  const user = await res.json();
  return user.email?.toLowerCase() || null;
}

/* Filtro de contenido: bloquea teléfonos y emails */
function filterContent(text) {
  return text
    .replace(/(\+?56)?[\s\-]?9[\s\-]?\d{4}[\s\-]?\d{4}/g, '[número bloqueado]')
    .replace(/\b\d{9,}\b/g, '[número bloqueado]')
    .replace(/[^\s@]+@[^\s@]+\.[^\s@]+/g, '[email bloqueado]')
    .replace(/(https?:\/\/[^\s]+)/g, '[enlace bloqueado]')
    .replace(/instagram|whatsapp|telegram|wa\.me/gi, '[plataforma bloqueada]');
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Método no permitido' }) };
  }

  try {
    const { action, token, ...rest } = JSON.parse(event.body || '{}');

    if (!token) {
      return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'No autenticado' }) };
    }

    const email = await verifyToken(token);
    if (!email) {
      return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Sesión expirada. Vuelve a ingresar.' }) };
    }

    /* Verificar que el email existe en architects */
    const arqRes = await fetch(
      `${SUPABASE_URL}/rest/v1/architects?email=eq.${encodeURIComponent(email)}&select=id,nombre,apellido&limit=1`,
      { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
    );
    const arqData = await arqRes.json();
    if (!arqData.length) {
      return { statusCode: 403, headers: CORS, body: JSON.stringify({ error: 'No tienes acceso de arquitecto.' }) };
    }
    const architect = arqData[0];

    /* ── GET-PROJECTS ─────────────────────────── */
    if (action === 'get-projects') {
      const projRes = await fetch(
        `${SUPABASE_URL}/rest/v1/projects?architect_email=eq.${encodeURIComponent(email)}&order=created_at.desc`,
        { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
      );
      const projects = projRes.ok ? await projRes.json() : [];

      /* Contar mensajes no leídos por proyecto */
      const enriched = await Promise.all(projects.map(async (p) => {
        const msgRes = await fetch(
          `${SUPABASE_URL}/rest/v1/messages?project_number=eq.${encodeURIComponent(p.project_number)}&sender_role=eq.client&read_by_architect=eq.false&select=id`,
          { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
        );
        const unread = msgRes.ok ? (await msgRes.json()).length : 0;
        return { ...p, stage_label: STAGE_LABELS[p.stage] || p.stage, unread_messages: unread };
      }));

      return {
        statusCode: 200,
        headers: CORS,
        body: JSON.stringify({ projects: enriched, architect }),
      };
    }

    /* ── UPDATE-STAGE ─────────────────────────── */
    if (action === 'update-stage') {
      const { project_number, new_stage } = rest;
      if (!project_number || !new_stage) {
        return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Faltan datos' }) };
      }

      /* Verificar que el proyecto le pertenece */
      const checkRes = await fetch(
        `${SUPABASE_URL}/rest/v1/projects?project_number=eq.${encodeURIComponent(project_number)}&architect_email=eq.${encodeURIComponent(email)}&select=id,service_type&limit=1`,
        { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
      );
      const checkData = await checkRes.json();
      if (!checkData.length) {
        return { statusCode: 403, headers: CORS, body: JSON.stringify({ error: 'Proyecto no encontrado' }) };
      }

      /* Validar que la etapa es válida para el tipo de servicio */
      const svc      = checkData[0].service_type;
      const validStages = svc === 'informe' ? STAGES_INFORME : STAGES_NORMAL;
      if (!validStages.includes(new_stage)) {
        return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Etapa inválida para este tipo de trámite' }) };
      }

      /* Actualizar etapa */
      const updRes = await fetch(
        `${SUPABASE_URL}/rest/v1/projects?project_number=eq.${encodeURIComponent(project_number)}`,
        {
          method: 'PATCH',
          headers: {
            'apikey':        SUPABASE_KEY,
            'Authorization': `Bearer ${SUPABASE_KEY}`,
            'Content-Type':  'application/json',
            'Prefer':        'return=representation',
          },
          body: JSON.stringify({ stage: new_stage, updated_at: new Date().toISOString() }),
        }
      );

      if (!updRes.ok) {
        return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Error al actualizar etapa' }) };
      }

      return {
        statusCode: 200,
        headers: CORS,
        body: JSON.stringify({ ok: true, stage_label: STAGE_LABELS[new_stage] }),
      };
    }

    /* ── SEND-MESSAGE ─────────────────────────── */
    if (action === 'send-message') {
      const { project_number, content } = rest;
      if (!project_number || !content?.trim()) {
        return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Faltan datos' }) };
      }

      const clean = filterContent(content.trim());

      const msgRes = await fetch(`${SUPABASE_URL}/rest/v1/messages`, {
        method: 'POST',
        headers: {
          'apikey':        SUPABASE_KEY,
          'Authorization': `Bearer ${SUPABASE_KEY}`,
          'Content-Type':  'application/json',
          'Prefer':        'return=representation',
        },
        body: JSON.stringify({
          project_number,
          sender_email:       email,
          sender_role:        'architect',
          content:            clean,
          read_by_client:     false,
          read_by_architect:  true,
        }),
      });

      if (!msgRes.ok) {
        return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Error al enviar mensaje' }) };
      }

      return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, content: clean }) };
    }

    /* ── GET-MESSAGES ─────────────────────────── */
    if (action === 'get-messages') {
      const { project_number } = rest;
      if (!project_number) {
        return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Falta número de proyecto' }) };
      }

      const msgRes = await fetch(
        `${SUPABASE_URL}/rest/v1/messages?project_number=eq.${encodeURIComponent(project_number)}&order=created_at.asc`,
        { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
      );
      const messages = msgRes.ok ? await msgRes.json() : [];

      /* Marcar mensajes del cliente como leídos por arquitecto */
      await fetch(
        `${SUPABASE_URL}/rest/v1/messages?project_number=eq.${encodeURIComponent(project_number)}&sender_role=eq.client`,
        {
          method: 'PATCH',
          headers: {
            'apikey':        SUPABASE_KEY,
            'Authorization': `Bearer ${SUPABASE_KEY}`,
            'Content-Type':  'application/json',
          },
          body: JSON.stringify({ read_by_architect: true }),
        }
      );

      return { statusCode: 200, headers: CORS, body: JSON.stringify({ messages }) };
    }

    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Acción no reconocida' }) };

  } catch (err) {
    console.error('portal-architect error:', err);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Error interno' }) };
  }
};

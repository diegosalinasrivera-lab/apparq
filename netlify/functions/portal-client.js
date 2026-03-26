/* ══════════════════════════════════════════════════
   APPARQ — Netlify Function: portal-client
   Consulta el proyecto de un cliente por número + email
   No requiere autenticación (el par proyecto+email es el verificador)
   POST /.netlify/functions/portal-client
   Body: { project_number, email }
══════════════════════════════════════════════════ */

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
};

const STAGE_LABELS = {
  levantamiento:     { label: 'Levantamiento en terreno',   pct: 20, desc: 'Tu arquitecto coordinará la visita' },
  elaboracion:       { label: 'Elaboración de planos',       pct: 40, desc: 'En preparación' },
  ingreso_dom:       { label: 'Ingreso a la DOM',            pct: 60, desc: 'Documentación ingresada' },
  tramitacion:       { label: 'Tramitación municipal',       pct: 80, desc: 'En revisión por la municipalidad' },
  completado:        { label: '🎉 Trámite completado',       pct: 100, desc: 'Recepción Final aprobada' },
  /* Informe */
  visita:            { label: 'Visita a terreno',            pct: 33, desc: 'Coordinando con tu arquitecto' },
  elaboracion_inf:   { label: 'Elaboración del informe',     pct: 66, desc: 'En preparación' },
  entrega_informe:   { label: '🎉 Informe entregado',        pct: 100, desc: 'Informe listo' },
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Método no permitido' }) };
  }

  try {
    const { project_number, email } = JSON.parse(event.body || '{}');

    if (!project_number || !email) {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Se requiere número de proyecto y email' }) };
    }

    const emailLower = email.trim().toLowerCase();
    const numUpper   = project_number.trim().toUpperCase();

    /* Buscar proyecto en Supabase */
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/projects?project_number=eq.${encodeURIComponent(numUpper)}&client_email=eq.${encodeURIComponent(emailLower)}&select=*&limit=1`,
      {
        headers: {
          'apikey':        SUPABASE_KEY,
          'Authorization': `Bearer ${SUPABASE_KEY}`,
        },
      }
    );

    if (!res.ok) {
      return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Error en base de datos' }) };
    }

    const data = await res.json();

    if (!data.length) {
      return {
        statusCode: 404,
        headers: CORS,
        body: JSON.stringify({ error: 'No se encontró el proyecto. Verifica el número y el email.' }),
      };
    }

    const project = data[0];
    const stageInfo = STAGE_LABELS[project.stage] || { label: project.stage, pct: 0, desc: '' };

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        project: {
          ...project,
          stage_label: stageInfo.label,
          stage_pct:   stageInfo.pct,
          stage_desc:  stageInfo.desc,
        },
      }),
    };

  } catch (err) {
    console.error('portal-client error:', err);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Error interno' }) };
  }
};

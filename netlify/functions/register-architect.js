/* ══════════════════════════════════════════════════
   APPARQ — Netlify Function: register-architect
   Recibe el formulario de inscripción de arquitecto
   y lo guarda en Supabase.
══════════════════════════════════════════════════ */

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

exports.handler = async (event) => {
  /* Preflight CORS */
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Método no permitido' }) };
  }

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error('Faltan variables de entorno SUPABASE_URL / SUPABASE_ANON_KEY');
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Error de configuración del servidor' }) };
  }

  try {
    const data = JSON.parse(event.body || '{}');

    /* Validación básica */
    if (!data.nombre || !data.apellido || !data.email) {
      return {
        statusCode: 400,
        headers: CORS,
        body: JSON.stringify({ error: 'Faltan campos obligatorios: nombre, apellido, email' }),
      };
    }

    /* Comunas: vienen como string "Providencia, Las Condes, …" */
    const comunas = data.comunas
      ? data.comunas.split(',').map(c => c.trim()).filter(Boolean)
      : [];

    /* Trámites: vienen como string separado por comas */
    const tramites = data.tramites
      ? data.tramites.split(',').map(t => t.trim()).filter(Boolean)
      : [];

    const payload = {
      nombre:      data.nombre.trim(),
      apellido:    data.apellido.trim(),
      email:       data.email.trim().toLowerCase(),
      telefono:    data.telefono?.trim()    || null,
      rut:         data.rut?.trim()         || null,
      experiencia: data.experiencia?.trim() || null,
      patente:     data.patente?.trim()     || null,
      tramites,
      comunas,
      mensaje:     data.mensaje?.trim()     || null,
      activo:      true,
    };

    /* Guardar en Supabase */
    const res = await fetch(`${SUPABASE_URL}/rest/v1/architects`, {
      method: 'POST',
      headers: {
        'apikey':        SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type':  'application/json',
        'Prefer':        'return=representation',
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error('Supabase error:', errText);
      return {
        statusCode: 500,
        headers: CORS,
        body: JSON.stringify({ error: 'Error al guardar en la base de datos' }),
      };
    }

    const saved = await res.json();
    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({ success: true, id: saved[0]?.id }),
    };

  } catch (err) {
    console.error('Error inesperado:', err);
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({ error: 'Error interno del servidor' }),
    };
  }
};

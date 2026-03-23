/* ══════════════════════════════════════════════════
   APPARQ — Netlify Function: auth
   Proxy para Supabase Auth (signup / login)
   Determina el rol: 'client' o 'architect'
   POST /.netlify/functions/auth
   Body: { action: 'signup'|'login', email, password }
══════════════════════════════════════════════════ */

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
};

async function getRole(email) {
  /* Chequear si el email existe en la tabla architects */
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/architects?email=eq.${encodeURIComponent(email.toLowerCase())}&select=id,nombre,apellido&limit=1`,
    {
      headers: {
        'apikey':        SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
      },
    }
  );
  if (!res.ok) return { role: 'client', architect: null };
  const data = await res.json();
  if (data.length > 0) {
    return {
      role: 'architect',
      architect: { id: data[0].id, nombre: data[0].nombre, apellido: data[0].apellido },
    };
  }
  return { role: 'client', architect: null };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Método no permitido' }) };
  }

  try {
    const { action, email, password } = JSON.parse(event.body || '{}');

    if (!action || !email || !password) {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Faltan campos obligatorios' }) };
    }

    const emailLower = email.trim().toLowerCase();

    /* ── SIGNUP ───────────────────────────────── */
    if (action === 'signup') {
      const res = await fetch(`${SUPABASE_URL}/auth/v1/signup`, {
        method: 'POST',
        headers: {
          'apikey':       SUPABASE_KEY,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ email: emailLower, password }),
      });

      const data = await res.json();

      if (data.error || data.error_description || data.msg) {
        const msg = data.error_description || data.msg || data.error || 'Error al crear cuenta';
        return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: msg }) };
      }

      const token = data.access_token;
      if (!token) {
        /* Supabase devuelve user sin token cuando el email no está confirmado */
        if (data.user && !data.session) {
          return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'email_not_confirmed' }) };
        }
        /* Email ya registrado: Supabase devuelve user vacío o identities: [] */
        return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'already registered' }) };
      }

      const { role, architect } = await getRole(emailLower);
      return {
        statusCode: 200,
        headers: CORS,
        body: JSON.stringify({ token, role, email: emailLower, architect }),
      };
    }

    /* ── LOGIN ────────────────────────────────── */
    if (action === 'login') {
      const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
        method: 'POST',
        headers: {
          'apikey':       SUPABASE_KEY,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ email: emailLower, password }),
      });

      const data = await res.json();

      if (data.error || data.error_description) {
        return {
          statusCode: 401,
          headers: CORS,
          body: JSON.stringify({ error: 'Email o contraseña incorrectos' }),
        };
      }

      const token = data.access_token;
      const { role, architect } = await getRole(emailLower);

      return {
        statusCode: 200,
        headers: CORS,
        body: JSON.stringify({ token, role, email: emailLower, architect }),
      };
    }

    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Acción no reconocida' }) };

  } catch (err) {
    console.error('auth error:', err);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Error interno' }) };
  }
};

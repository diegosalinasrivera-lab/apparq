/* ══════════════════════════════════════════════════
   APPARQ — Cloudflare Pages Function: auth
   Proxy para Supabase Auth (signup / login)
   Determina el rol: 'client' o 'architect'
   POST /api/auth
   Body: { action: 'signup'|'login', email, password }
══════════════════════════════════════════════════ */

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
};

function corsResponse(body, status = 200) {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: CORS });
}

async function getRole(email, SUPABASE_URL, SUPABASE_KEY) {
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

export async function onRequest(context) {
  const { request, env } = context;
  const SUPABASE_URL = env.SUPABASE_URL;
  const SUPABASE_KEY = env.SUPABASE_ANON_KEY;

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }
  if (request.method !== 'POST') {
    return corsResponse({ error: 'Método no permitido' }, 405);
  }

  try {
    const { action, email, password } = await request.json();

    if (!action || !email || !password) {
      return corsResponse({ error: 'Faltan campos obligatorios' }, 400);
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
        return corsResponse({ error: msg }, 400);
      }

      const token = data.access_token;
      if (!token) {
        /* Supabase devuelve user sin token cuando el email no está confirmado */
        if (data.user && !data.session) {
          return corsResponse({ error: 'email_not_confirmed' }, 400);
        }
        /* Email ya registrado: Supabase devuelve user vacío o identities: [] */
        return corsResponse({ error: 'already registered' }, 400);
      }

      const { role, architect } = await getRole(emailLower, SUPABASE_URL, SUPABASE_KEY);
      return corsResponse({ token, role, email: emailLower, architect });
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
        return corsResponse({ error: 'Email o contraseña incorrectos' }, 401);
      }

      const token = data.access_token;
      const { role, architect } = await getRole(emailLower, SUPABASE_URL, SUPABASE_KEY);

      return corsResponse({ token, role, email: emailLower, architect });
    }

    return corsResponse({ error: 'Acción no reconocida' }, 400);

  } catch (err) {
    console.error('auth error:', err);
    return corsResponse({ error: 'Error interno' }, 500);
  }
}

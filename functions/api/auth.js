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

      /* Supabase a veces devuelve error explícito para email duplicado */
      if (data.error || data.error_description || data.msg) {
        const msg = data.error_description || data.msg || data.error || '';
        const isAlready = msg.toLowerCase().includes('already') || msg.toLowerCase().includes('registered') || msg.toLowerCase().includes('exists');
        if (isAlready) return corsResponse({ error: 'already registered' }, 400);
        return corsResponse({ error: msg || 'Error al crear cuenta' }, 400);
      }

      const token = data.access_token;
      if (!token) {
        /* Email duplicado: Supabase devuelve user con identities vacías y sin sesión */
        if (data.user && Array.isArray(data.user.identities) && data.user.identities.length === 0) {
          return corsResponse({ error: 'already registered' }, 400);
        }
        /* Email confirmación pendiente: usuario nuevo pero sin sesión aún */
        if (data.user && !data.session) {
          /* Intentar login directo para evitar fricción de confirmación */
          const loginRes = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
            method: 'POST',
            headers: { 'apikey': SUPABASE_KEY, 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: emailLower, password }),
          });
          const loginData = await loginRes.json();
          if (loginData.access_token) {
            const { role, architect } = await getRole(emailLower, SUPABASE_URL, SUPABASE_KEY);
            return corsResponse({ token: loginData.access_token, role, email: emailLower, architect });
          }
          return corsResponse({ error: 'email_not_confirmed' }, 400);
        }
        return corsResponse({ error: 'Error al crear cuenta. Intenta de nuevo.' }, 400);
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

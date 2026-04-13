/* ══════════════════════════════════════════════════
   APPARQ — Cloudflare Pages Function: auth
   Proxy para Supabase Auth (signup / login)
   Determina el rol: 'client' o 'architect'
   POST /api/auth
   Body: { action: 'signup'|'login', email, password }
══════════════════════════════════════════════════ */

const CORS = {
  'Access-Control-Allow-Origin': 'https://apparq.cl',
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
  const SUPABASE_URL = env.SUPABASE_URL || 'https://ibdafnzlsufsshczqvoa.supabase.co';
  const SUPABASE_KEY = env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImliZGFmbnpsc3Vmc3NoY3pxdm9hIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM5Njg0NjYsImV4cCI6MjA4OTU0NDQ2Nn0.ucEjCcnSbaz-OeMrLbUbgcKacvg9J2Csg2VzrWVtVHA';

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }
  if (request.method !== 'POST') {
    return corsResponse({ error: 'Método no permitido' }, 405);
  }

  try {
    const body = await request.json();
    const { action, email, password } = body;

    if (!action) return corsResponse({ error: 'Falta action' }, 400);

    /* ── REFRESH TOKEN ───────────────────────── */
    if (action === 'refresh') {
      const { refresh_token } = body;
      if (!refresh_token) return corsResponse({ error: 'refresh_token requerido' }, 400);

      const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
        method: 'POST',
        headers: { 'apikey': SUPABASE_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token }),
      });
      const data = await res.json();
      if (data.error || data.error_description || !data.access_token) {
        return corsResponse({ error: 'Sesión expirada' }, 401);
      }
      return corsResponse({ token: data.access_token, refresh_token: data.refresh_token });
    }

    if (!email || !password) {
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

      const rawText = await res.text();
      console.log('SUPABASE SIGNUP RAW:', res.status, rawText);
      let data = {};
      try { data = JSON.parse(rawText); } catch(_) {}

      /* Cualquier mensaje de error de Supabase/GoTrue */
      const errMsg = data.error_description || data.msg || data.message || data.error || '';
      if (errMsg) {
        console.log('SUPABASE ERROR MSG:', errMsg);
        const isAlready = errMsg.toLowerCase().includes('already') || errMsg.toLowerCase().includes('registered') || errMsg.toLowerCase().includes('exists');
        if (isAlready) return corsResponse({ error: 'already registered' }, 400);
        return corsResponse({ error: errMsg }, 400);
      }

      /* HTTP error sin mensaje claro */
      if (!res.ok && !data.access_token) {
        return corsResponse({ error: `Error Supabase ${res.status}` }, 400);
      }

      /* Supabase puede devolver token en raíz o dentro de session */
      const token = data.access_token || data.session?.access_token;
      if (!token) {
        /* Email duplicado: Supabase devuelve user con identities vacías y sin sesión */
        if (data.user && Array.isArray(data.user.identities) && data.user.identities.length === 0) {
          return corsResponse({ error: 'already registered' }, 400);
        }
        /* Usuario creado pero sin sesión todavía → intentar login inmediato */
        if (data.user || data.id) {
          const loginRes = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
            method: 'POST',
            headers: { 'apikey': SUPABASE_KEY, 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: emailLower, password }),
          });
          const loginData = await loginRes.json();
          const loginToken = loginData.access_token || loginData.session?.access_token;
          if (loginToken) {
            const { role, architect } = await getRole(emailLower, SUPABASE_URL, SUPABASE_KEY);
            return corsResponse({ token: loginToken, role, email: emailLower, architect });
          }
          return corsResponse({ error: 'email_not_confirmed' }, 400);
        }
        return corsResponse({ error: `Sin token (status ${res.status}) raw=${rawText.substring(0,200)}` }, 400);
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

      if (data.error || data.error_description || data.message) {
        return corsResponse({ error: 'Email o contraseña incorrectos' }, 401);
      }

      const token        = data.access_token        || data.session?.access_token;
      const refreshToken = data.refresh_token       || data.session?.refresh_token;
      const { role, architect } = await getRole(emailLower, SUPABASE_URL, SUPABASE_KEY);

      return corsResponse({ token, refresh_token: refreshToken, role, email: emailLower, architect });
    }

    return corsResponse({ error: 'Acción no reconocida' }, 400);

  } catch (err) {
    console.error('auth error:', err);
    return corsResponse({ error: 'Error interno' }, 500);
  }
}

/**
 * GET /api/get-uf
 * Devuelve el valor actual de la UF consultando mindicador.cl como fuente primaria.
 * Cloudflare cachea la respuesta en el edge por 1 hora (max-age=3600),
 * así se evitan CORS del browser y latencia extra.
 */

const CACHE_SECONDS = 3600; // 1 hora — la UF cambia diariamente, 1h es suficiente

export async function onRequest(context) {
  const { request } = context;

  // ── Cloudflare Cache API ─────────────────────────────
  const cacheKey = new Request('https://cache.apparq.internal/uf', request);
  const cache    = caches.default;
  const cached   = await cache.match(cacheKey);
  if (cached) return cached;

  // ── Consultar mindicador.cl ──────────────────────────
  let uf    = null;
  let fecha = null;

  try {
    const res  = await fetch('https://mindicador.cl/api/uf', {
      headers: { 'Accept': 'application/json' },
      cf: { cacheTtl: 0 }, // queremos el valor fresco del origen
    });
    if (res.ok) {
      const data = await res.json();
      if (data?.serie?.[0]?.valor) {
        uf    = data.serie[0].valor;
        fecha = data.serie[0].fecha?.split('T')[0] ?? null;
      }
    }
  } catch (_) { /* fallo silencioso, intentamos siguiente fuente */ }

  // ── Fallback: API del Banco Central (si mindicador falla) ──
  if (!uf) {
    try {
      // api.cmfchile.cl es la fuente oficial CMF (ex-SBIF)
      const res = await fetch(
        'https://api.cmfchile.cl/api-sbifv3/recursos/v1/uf?apikey=l7d40a28ad0e15b65d9d9bf06e5f5e2c84&formato=json',
        { headers: { 'Accept': 'application/json' } }
      );
      if (res.ok) {
        const data = await res.json();
        const val  = data?.UFs?.[0]?.Valor;
        if (val) {
          uf    = parseFloat(val.replace('.', '').replace(',', '.'));
          fecha = data.UFs[0].Fecha ?? null;
        }
      }
    } catch (_) { /* ambas fuentes fallaron */ }
  }

  // ── Respuesta ────────────────────────────────────────
  const body = JSON.stringify(
    uf
      ? { uf, fecha, fuente: 'mindicador.cl' }
      : { error: 'No se pudo obtener el valor de la UF', uf: null }
  );

  const response = new Response(body, {
    status: uf ? 200 : 503,
    headers: {
      'Content-Type':  'application/json',
      'Cache-Control': uf ? `public, max-age=${CACHE_SECONDS}, s-maxage=${CACHE_SECONDS}` : 'no-store',
      'Access-Control-Allow-Origin': '*',
    },
  });

  // Guardar en cache de Cloudflare solo si obtuvimos valor
  if (uf) await cache.put(cacheKey, response.clone());

  return response;
}

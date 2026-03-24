/* ══════════════════════════════════════════════════
   APPARQ — Netlify Function: get-architect
   Devuelve el mejor arquitecto disponible para
   una comuna dada, usando BFS de proximidad.
   GET /.netlify/functions/get-architect?comuna=Providencia
══════════════════════════════════════════════════ */

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

/* Mapa de comunas adyacentes — Santiago completo */
const COMUNAS_ADYACENTES = {
  'Santiago':            ['Providencia','Independencia','Recoleta','Ñuñoa','San Miguel','Cerrillos','Quinta Normal','Estación Central'],
  'Providencia':         ['Santiago','Las Condes','Ñuñoa','La Reina'],
  'Las Condes':          ['Providencia','Vitacura','La Reina','Lo Barnechea'],
  'Vitacura':            ['Las Condes','Lo Barnechea','Providencia'],
  'Lo Barnechea':        ['Vitacura','Las Condes'],
  'La Reina':            ['Las Condes','Providencia','Ñuñoa','Peñalolén'],
  'Ñuñoa':              ['Providencia','La Reina','Peñalolén','Macul','San Joaquín','Santiago'],
  'Peñalolén':          ['La Reina','Ñuñoa','Macul','La Florida'],
  'La Florida':          ['Peñalolén','Macul','San Joaquín','El Bosque','La Granja','La Pintana'],
  'Macul':               ['Ñuñoa','Peñalolén','La Florida','San Joaquín'],
  'San Joaquín':         ['Ñuñoa','Macul','La Florida','La Granja','San Miguel'],
  'La Granja':           ['San Joaquín','La Florida','La Pintana','El Bosque','San Ramón'],
  'La Pintana':          ['La Granja','La Florida','El Bosque','San Ramón'],
  'El Bosque':           ['La Florida','La Granja','La Pintana','San Ramón','Pedro Aguirre Cerda'],
  'San Ramón':           ['La Granja','La Pintana','El Bosque','Pedro Aguirre Cerda'],
  'Pedro Aguirre Cerda': ['San Miguel','San Ramón','El Bosque','Lo Espejo','La Cisterna'],
  'San Miguel':          ['Santiago','San Joaquín','La Cisterna','Pedro Aguirre Cerda'],
  'La Cisterna':         ['San Miguel','Pedro Aguirre Cerda','Lo Espejo','El Bosque'],
  'Lo Espejo':           ['Pedro Aguirre Cerda','La Cisterna','San Ramón'],
  'Cerrillos':           ['Santiago','Maipú','Estación Central'],
  'Estación Central':    ['Santiago','Cerrillos','Maipú','Pudahuel','Quinta Normal'],
  'Maipú':               ['Cerrillos','Estación Central','Pudahuel'],
  'Pudahuel':            ['Estación Central','Maipú','Renca','Quilicura','Lo Prado','Cerro Navia'],
  'Lo Prado':            ['Pudahuel','Quinta Normal','Cerro Navia'],
  'Quinta Normal':       ['Santiago','Estación Central','Lo Prado','Cerro Navia','Independencia'],
  'Cerro Navia':         ['Lo Prado','Quinta Normal','Pudahuel','Renca'],
  'Renca':               ['Cerro Navia','Pudahuel','Quilicura','Huechuraba','Conchalí'],
  'Quilicura':           ['Renca','Pudahuel','Huechuraba'],
  'Huechuraba':          ['Renca','Quilicura','Conchalí','Recoleta'],
  'Conchalí':            ['Renca','Huechuraba','Recoleta','Independencia'],
  'Recoleta':            ['Santiago','Independencia','Conchalí','Huechuraba'],
  'Independencia':       ['Santiago','Recoleta','Conchalí','Quinta Normal'],
};

function findBestArchitect(targetCommune, architects) {
  if (!architects?.length) return null;

  const rand = arr => arr[Math.floor(Math.random() * arr.length)];
  const inCommune = c => architects.filter(a => Array.isArray(a.comunas) && a.comunas.includes(c));

  /* Nivel 0 — coincidencia exacta */
  const exact = inCommune(targetCommune);
  if (exact.length) return { architect: rand(exact), matchType: 'exact', matchCommune: targetCommune };

  /* Nivel 1 — comunas vecinas directas */
  for (const adj of (COMUNAS_ADYACENTES[targetCommune] || [])) {
    const m = inCommune(adj);
    if (m.length) return { architect: rand(m), matchType: 'adjacent', matchCommune: adj };
  }

  /* Nivel 2 — vecinos de vecinos */
  for (const adj of (COMUNAS_ADYACENTES[targetCommune] || [])) {
    for (const adj2 of (COMUNAS_ADYACENTES[adj] || [])) {
      if (adj2 === targetCommune) continue;
      const m = inCommune(adj2);
      if (m.length) return { architect: rand(m), matchType: 'nearby', matchCommune: adj2 };
    }
  }

  /* Nivel 3 — cualquier arquitecto disponible */
  return { architect: rand(architects), matchType: 'any', matchCommune: architects[0].comunas?.[0] };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS, body: '' };
  }

  const targetCommune = event.queryStringParameters?.comuna || 'Santiago';

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Configuración incompleta' }) };
  }

  try {
    /* Traer todos los arquitectos */
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/architects?select=id,nombre,apellido,email,telefono,comunas,tramites,experiencia,foto_url,activo`,
      {
        headers: {
          'apikey':        SUPABASE_KEY,
          'Authorization': `Bearer ${SUPABASE_KEY}`,
        },
      }
    );

    if (!res.ok) {
      const err = await res.text();
      console.error('Supabase error:', err);
      return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Error al consultar la base de datos' }) };
    }

    const raw = await res.json();

    /* Normalizar comunas (puede venir como array o string CSV) y filtrar activos */
    const architects = raw
      .filter(a => a.activo !== false)
      .map(a => ({
        ...a,
        comunas: Array.isArray(a.comunas) ? a.comunas : (a.comunas ? String(a.comunas).split(',').map(s => s.trim()).filter(Boolean) : []),
      }));

    if (!architects?.length) {
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ architect: null, matchType: 'none' }) };
    }

    const result = findBestArchitect(targetCommune, architects);

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify(result || { architect: null, matchType: 'none' }),
    };

  } catch (err) {
    console.error('Error inesperado:', err);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Error interno' }) };
  }
};

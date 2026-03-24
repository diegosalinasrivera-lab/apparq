/* ══════════════════════════════════════════════════
   APPARQ — Netlify Function: list-architects
   Devuelve los arquitectos disponibles para una
   comuna y tipo de trámite dados.
   GET /.netlify/functions/list-architects?comuna=Ñuñoa&tramite=regularizacion
══════════════════════════════════════════════════ */

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

const TRAMITE_MAP = {
  regularizacion: 'Regularización',
  ampliacion:     'Ampliación',
  'obra-nueva':   'Obra Nueva',
  informe:        'Informe',
};

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

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS, body: '' };
  }

  const targetCommune = event.queryStringParameters?.comuna || '';
  const tramiteKey    = event.queryStringParameters?.tramite || '';
  const tramiteLabel  = TRAMITE_MAP[tramiteKey] || '';

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Configuración incompleta' }) };
  }

  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/architects?select=id,nombre,apellido,comunas,tramites,experiencia,foto_url,activo`,
      { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
    );

    if (!res.ok) {
      return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Error de base de datos' }) };
    }

    const raw = await res.json();

    /* Normalizar comunas y tramites (pueden venir como array o string) */
    const all = raw
      .filter(a => a.activo !== false)  /* excluir solo los explícitamente desactivados */
      .map(a => ({
        ...a,
        comunas:  Array.isArray(a.comunas)  ? a.comunas  : (a.comunas  ? String(a.comunas).split(',').map(s=>s.trim()).filter(Boolean)  : []),
        tramites: Array.isArray(a.tramites) ? a.tramites : (a.tramites ? String(a.tramites).split(',').map(s=>s.trim()).filter(Boolean) : []),
      }));

    /* Filtrar por trámite si se especificó */
    const byTramite = tramiteLabel
      ? all.filter(a => a.tramites.some(t => t.toLowerCase().includes(tramiteLabel.toLowerCase())))
      : all;

    const inCommune = (c) => byTramite.filter(a => Array.isArray(a.comunas) && a.comunas.includes(c));

    /* Buscar primero en la comuna exacta, luego adyacentes */
    let result = inCommune(targetCommune);

    if (!result.length) {
      for (const adj of (COMUNAS_ADYACENTES[targetCommune] || [])) {
        result = [...result, ...inCommune(adj)];
      }
    }

    if (!result.length) result = byTramite;

    /* Ordenar: con foto primero, luego por calificacion descendente */
    result.sort((a, b) => {
      if (!!a.foto_url !== !!b.foto_url) return a.foto_url ? -1 : 1;
      return (b.calificacion || 0) - (a.calificacion || 0);
    });

    /* Limitar a 5 */
    const architects = result.slice(0, 5).map(a => ({
      id:          a.id,
      nombre:      a.nombre,
      apellido:    a.apellido,
      foto_url:    a.foto_url    || null,
      calificacion: a.calificacion || null,
      experiencia: a.experiencia || null,
      comunas:     a.comunas    || [],
      tramites:    a.tramites   || [],
    }));

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({ architects, commune: targetCommune }),
    };

  } catch (err) {
    console.error('Error:', err);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Error interno' }) };
  }
};

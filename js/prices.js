/* ══════════════════════════════════════════════════
   APPARQ — Lógica de precios compartida
   Cargado por index.html y estudios/cotizar.html.
   Depende de una variable global `S` con { svc, svcSub, m2, uf, djElig, djObra }.
══════════════════════════════════════════════════ */

/* ── Tablas de precios en UF ── */
const PRECIO_LEY_MONO = { hasta90: 14, hasta140: 19 };
const PRECIO_REG = { 'obra-menor': 28, 'obra-nueva-reg-hasta140': 38, 'obra-nueva-reg-por-m2': 0.39 };
const PRECIO_AMP = { hasta50: 20, hasta100: 28 };
const PRECIO_DJ  = {
  piscina:           10,
  pergola:            6,
  demolicion_base:    8,
  demolicion_umbral: 100,
  demolicion_por_m2: 0.05,
};
const PRECIO_ON  = { tarifa: 0.80, minimo: 35 };
const PRECIO_INF = { evaluacion: 3, factibilidad: 6, compraventa: 8 };

/* ── Etapas de pago ── */
const STAGES_NORMAL = [
  { name: 'Inicio (E1)',    pct: 0.20 },
  { name: 'Planos (E2)',    pct: 0.30 },
  { name: 'Ingreso (E3)',   pct: 0.30 },
  { name: 'Recepción (E4)', pct: 0.20 },
];
const STAGES_INFORME = [
  { name: 'Inicio (E1)',          pct: 0.50 },
  { name: 'Entrega informe (E2)', pct: 0.50 },
];
const STAGES_DJ = [
  { name: 'Inicio (E1)',  pct: 0.50 },
  { name: 'Cierre (E2)', pct: 0.50 },
];

/* ── calcTotal(): usa la variable global S ── */
function calcTotal() {
  const m2 = S.m2 || 0;

  if (S.svc === 'ley-del-mono') {
    const uf = m2 <= 90 ? PRECIO_LEY_MONO.hasta90 : PRECIO_LEY_MONO.hasta140;
    return { uf, clp: uf * S.uf };
  }

  if (S.svc === 'regularizacion') {
    let uf;
    if (S.svcSub === 'obra-menor') {
      uf = PRECIO_REG['obra-menor'];
    } else {
      uf = m2 <= 140 ? PRECIO_REG['obra-nueva-reg-hasta140'] : PRECIO_REG['obra-nueva-reg-por-m2'] * m2;
    }
    return { uf, clp: uf * S.uf };
  }

  if (S.svc === 'ampliacion') {
    const uf = m2 <= 50 ? PRECIO_AMP.hasta50 : PRECIO_AMP.hasta100;
    return { uf, clp: uf * S.uf };
  }

  if (S.svc === 'declaracion-jurada') {
    let uf = 0;
    if (S.svcSub === 'piscina_privada')         uf = PRECIO_DJ.piscina;
    else if (S.svcSub === 'pergola_sombreadero') uf = PRECIO_DJ.pergola;
    else if (S.svcSub === 'demolicion') {
      uf = PRECIO_DJ.demolicion_base
         + Math.max(0, (m2 - PRECIO_DJ.demolicion_umbral)) * PRECIO_DJ.demolicion_por_m2;
    }
    return { uf: parseFloat(uf.toFixed(2)), clp: uf * S.uf };
  }

  if (S.svc === 'obra-nueva') {
    const uf = Math.max(PRECIO_ON.tarifa * m2, PRECIO_ON.minimo);
    return { uf, clp: uf * S.uf };
  }

  if (S.svc === 'informe') {
    const uf = PRECIO_INF[S.svcSub] || PRECIO_INF.evaluacion;
    return { uf, clp: uf * S.uf };
  }

  return { uf: 0, clp: 0 };
}

/* ── isReady(): usa la variable global S ── */
function isReady() {
  if (!S.svc) return false;
  if (S.svc === 'informe')       return !!S.svcSub;

  if (S.svc === 'declaracion-jurada') {
    if (!S.svcSub) return false;
    if (S.svcSub === 'piscina_privada')         return !!S.djElig && S.djElig !== 'no_15m';
    if (S.svcSub === 'pergola_sombreadero')      return !!S.djObra;
    if (S.svcSub === 'demolicion')               return !!S.m2;
    return false;
  }

  if (!S.m2) return false;
  if (S.svc === 'ley-del-mono')   return true;
  if (S.svc === 'regularizacion') return !!S.svcSub;
  if (S.svc === 'ampliacion')     return true;
  if (S.svc === 'obra-nueva')     return S.mat && S.dest && S.dest.length > 0;
  return false;
}

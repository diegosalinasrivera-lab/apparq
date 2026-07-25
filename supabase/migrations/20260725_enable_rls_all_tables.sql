-- ══════════════════════════════════════════════════════════════
-- APPARQ — Migración de seguridad: habilitar RLS en todas las tablas públicas
-- Fecha: 2026-07-25
--
-- PROPÓSITO:
--   Las tablas del proyecto tenían RLS deshabilitado, permitiendo SELECT
--   público con la anon key sin ninguna autenticación (PII expuesta).
--
-- EFECTO:
--   - Con RLS habilitado y SIN políticas permisivas, anon y authenticated
--     no pueden leer ni escribir ninguna fila (deny-by-default de Postgres).
--   - service_role tiene BYPASSRLS en Supabase → el backend (Cloudflare
--     Functions) sigue funcionando exactamente igual, sin cambio alguno.
--   - Ningún código de frontend consulta estas tablas directamente;
--     todo pasa por /api/ (Cloudflare Pages Functions con service_role).
--
-- CÓMO APLICAR:
--   Supabase Dashboard → SQL Editor → pegar este archivo → Run
--   O: supabase db push (si usas CLI con proyecto linkeado)
--
-- VERIFICACIÓN POST-APPLY (con anon key, debe devolver 0 filas o error):
--   curl 'https://ibdafnzlsufsshczqvoa.supabase.co/rest/v1/projects?limit=1' \
--     -H 'apikey: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImliZGFmbnpsc3Vmc3NoY3pxdm9hIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM5Njg0NjYsImV4cCI6MjA4OTU0NDQ2Nn0.ucEjCcnSbaz-OeMrLbUbgcKacvg9J2Csg2VzrWVtVHA' \
--     -H 'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImliZGFmbnpsc3Vmc3NoY3pxdm9hIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM5Njg0NjYsImV4cCI6MjA4OTU0NDQ2Nn0.ucEjCcnSbaz-OeMrLbUbgcKacvg9J2Csg2VzrWVtVHA'
--   → debe retornar []
-- ══════════════════════════════════════════════════════════════

-- 1. Habilitar RLS en todas las tablas expuestas
--    (cuando RLS está ON y no hay política permisiva, el acceso es denegado por defecto)

ALTER TABLE public.projects           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.architects         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payments           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cobros_adicionales ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.leads              ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.project_updates    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.messages           ENABLE ROW LEVEL SECURITY;

-- 2. Revocar privilegios de SELECT/INSERT/UPDATE/DELETE a anon y authenticated
--    (defensa en profundidad: incluso si se habilita RLS por error con política permisiva,
--     los roles sin privilegio no pueden operar)

REVOKE ALL ON public.projects           FROM anon, authenticated;
REVOKE ALL ON public.architects         FROM anon, authenticated;
REVOKE ALL ON public.payments           FROM anon, authenticated;
REVOKE ALL ON public.cobros_adicionales FROM anon, authenticated;
REVOKE ALL ON public.leads              FROM anon, authenticated;
REVOKE ALL ON public.project_updates    FROM anon, authenticated;
REVOKE ALL ON public.messages           FROM anon, authenticated;

-- 3. Confirmar que service_role mantiene acceso completo
--    (Supabase asigna BYPASSRLS al rol service_role por diseño — esto es solo documentación)
-- GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role; -- ya está por defecto en Supabase

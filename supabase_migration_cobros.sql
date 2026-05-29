-- =============================================
-- APPARQ — Migración: Sistema de Cobros Adicionales
-- Ejecutar en Supabase SQL Editor
-- =============================================

-- 1. Nueva tabla cobros_adicionales
CREATE TABLE IF NOT EXISTS cobros_adicionales (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tramite_id        TEXT NOT NULL,          -- project_number (e.g. ARQ-2026-000001)
  arquitecto_email  TEXT NOT NULL,          -- email del arquitecto
  tipo_servicio     TEXT NOT NULL,          -- 'modificacion_proyecto' | 'otro'
  descripcion       TEXT NOT NULL,          -- nombre legible del servicio
  fundamento_tecnico TEXT NOT NULL,         -- mín. 100 chars
  valor_uf          NUMERIC(10,4) NOT NULL, -- valor en UF
  valor_clp         INTEGER NOT NULL,       -- valor en CLP al momento de crear
  valor_uf_fecha    TEXT,                   -- fecha del valor UF usado
  estado            TEXT NOT NULL DEFAULT 'pendiente_pago', -- 'pendiente_pago' | 'pagado' | 'cancelado'
  mp_payment_id     TEXT,                   -- ID del pago en Mercado Pago
  fecha_creacion    TIMESTAMPTZ DEFAULT NOW(),
  fecha_pago        TIMESTAMPTZ
);

-- 2. Columna nueva en projects
ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS cobro_adicional_pendiente BOOLEAN DEFAULT FALSE;

-- 3. Índices para performance
CREATE INDEX IF NOT EXISTS cobros_tramite_idx ON cobros_adicionales(tramite_id);
CREATE INDEX IF NOT EXISTS cobros_arquitecto_idx ON cobros_adicionales(arquitecto_email);
CREATE INDEX IF NOT EXISTS cobros_estado_idx ON cobros_adicionales(estado);

-- 4. RLS: habilitar row-level security (opcional si ya está habilitado)
-- ALTER TABLE cobros_adicionales ENABLE ROW LEVEL SECURITY;

-- LISTO ✓
SELECT 'Migración cobros_adicionales ejecutada correctamente.' AS resultado;

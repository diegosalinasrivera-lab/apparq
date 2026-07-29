-- Calificación del arquitecto por el cliente
ALTER TABLE public.projects
  ADD COLUMN IF NOT EXISTS rating_arquitecto smallint CHECK (rating_arquitecto BETWEEN 1 AND 5),
  ADD COLUMN IF NOT EXISTS rating_arquitecto_at timestamptz;

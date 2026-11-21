BEGIN;
ALTER TABLE habitaciones.habitaciones ADD COLUMN IF NOT EXISTS estado_operativo varchar(20) NOT NULL DEFAULT 'EN_SERVICIO'
  CHECK (estado_operativo IN ('EN_SERVICIO','LIMPIEZA','MANTENIMIENTO'));
INSERT INTO habitaciones.schema_migrations (version) VALUES (4) ON CONFLICT DO NOTHING;
COMMIT;

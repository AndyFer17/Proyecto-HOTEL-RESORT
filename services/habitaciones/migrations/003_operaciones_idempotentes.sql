BEGIN;
ALTER TABLE habitaciones.bloqueos ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1;
CREATE TABLE IF NOT EXISTS habitaciones.operaciones_idempotentes (
  alcance text NOT NULL,
  clave uuid NOT NULL,
  huella char(64) NOT NULL,
  respuesta jsonb,
  finalizada boolean NOT NULL DEFAULT false,
  creada_en timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (alcance, clave)
);
INSERT INTO habitaciones.schema_migrations (version) VALUES (3) ON CONFLICT DO NOTHING;
COMMIT;

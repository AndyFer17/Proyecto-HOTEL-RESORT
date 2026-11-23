BEGIN;
CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE SCHEMA IF NOT EXISTS habitaciones;
CREATE TABLE IF NOT EXISTS habitaciones.schema_migrations (
  version integer PRIMARY KEY,
  aplicada_en timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS habitaciones.habitaciones (
  habitacion_id uuid PRIMARY KEY,
  numero varchar(10) NOT NULL UNIQUE,
  tipo varchar(40) NOT NULL,
  capacidad integer NOT NULL CHECK (capacidad >= 1),
  tarifa_noche numeric(12,2) NOT NULL CHECK (tarifa_noche > 0),
  moneda char(3) NOT NULL DEFAULT 'PEN' CHECK (moneda = 'PEN'),
  activa boolean NOT NULL DEFAULT true
);
CREATE TABLE IF NOT EXISTS habitaciones.bloqueos (
  bloqueo_id uuid PRIMARY KEY,
  reserva_id uuid NOT NULL,
  habitacion_id uuid NOT NULL REFERENCES habitaciones.habitaciones (habitacion_id),
  desde date NOT NULL,
  hasta date NOT NULL,
  personas integer NOT NULL CHECK (personas >= 1),
  total numeric(12,2) NOT NULL CHECK (total > 0),
  estado varchar(12) NOT NULL
    CHECK (estado IN ('BLOQUEADO', 'CONFIRMADO', 'LIBERADO', 'EXPIRADO')),
  vence_en timestamptz NOT NULL,
  creado_en timestamptz NOT NULL DEFAULT now(),
  actualizado_en timestamptz NOT NULL DEFAULT now(),
  CHECK (hasta > desde),
  CONSTRAINT bloqueos_sin_solape EXCLUDE USING gist (
    habitacion_id WITH =,
    daterange(desde, hasta, '[)') WITH &&
  ) WHERE (estado IN ('BLOQUEADO', 'CONFIRMADO'))
);
CREATE UNIQUE INDEX IF NOT EXISTS bloqueos_una_activa_por_reserva
  ON habitaciones.bloqueos (reserva_id)
  WHERE estado IN ('BLOQUEADO', 'CONFIRMADO');
CREATE TABLE IF NOT EXISTS habitaciones.solicitudes_idempotentes (
  clave uuid PRIMARY KEY,
  huella char(64) NOT NULL,
  estado_http integer NOT NULL,
  respuesta jsonb NOT NULL,
  creada_en timestamptz NOT NULL DEFAULT now()
);
INSERT INTO habitaciones.schema_migrations (version) VALUES (1) ON CONFLICT DO NOTHING;
COMMIT;
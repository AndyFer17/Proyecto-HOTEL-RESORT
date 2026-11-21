BEGIN;
CREATE SCHEMA IF NOT EXISTS reservas;
CREATE TABLE IF NOT EXISTS reservas.schema_migrations (
  version integer PRIMARY KEY,
  aplicada_en timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS reservas.reservas (
  reserva_id uuid PRIMARY KEY,
  huesped_id uuid NOT NULL,
  habitacion_id uuid NOT NULL,
  desde date NOT NULL,
  hasta date NOT NULL CHECK (hasta > desde),
  personas integer NOT NULL CHECK (personas BETWEEN 1 AND 20),
  estado text NOT NULL CHECK (estado IN ('PENDIENTE','CONFIRMADA','MODIFICANDO','CANCELANDO','CANCELADA','FALLIDA')),
  total numeric(12,2),
  moneda char(3) NOT NULL DEFAULT 'PEN' CHECK (moneda = 'PEN'),
  bloqueo_id uuid,
  cargo_id uuid,
  version integer NOT NULL DEFAULT 1,
  creado_en timestamptz NOT NULL DEFAULT now(),
  actualizado_en timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS reservas_huesped ON reservas.reservas (huesped_id);
CREATE TABLE IF NOT EXISTS reservas.operaciones (
  operacion_id uuid PRIMARY KEY,
  reserva_id uuid NOT NULL REFERENCES reservas.reservas(reserva_id),
  huesped_id uuid NOT NULL,
  accion text NOT NULL CHECK (accion IN ('CREAR','MODIFICAR','CANCELAR')),
  clave uuid NOT NULL,
  huella char(64) NOT NULL,
  entrada jsonb NOT NULL,
  contexto jsonb NOT NULL DEFAULT '{}',
  fase text NOT NULL,
  estado text NOT NULL DEFAULT 'PENDIENTE' CHECK (estado IN ('PENDIENTE','COMPLETA','FALLIDA')),
  respuesta_http integer,
  respuesta jsonb,
  intentos integer NOT NULL DEFAULT 0,
  proximo_intento timestamptz NOT NULL DEFAULT now(),
  lease_owner uuid,
  lease_hasta timestamptz,
  ultimo_error text,
  creado_en timestamptz NOT NULL DEFAULT now(),
  actualizado_en timestamptz NOT NULL DEFAULT now(),
  UNIQUE(huesped_id, accion, clave)
);
CREATE UNIQUE INDEX IF NOT EXISTS una_operacion_activa_por_reserva
  ON reservas.operaciones (reserva_id) WHERE estado = 'PENDIENTE';
CREATE INDEX IF NOT EXISTS operaciones_recuperacion
  ON reservas.operaciones (proximo_intento) WHERE estado = 'PENDIENTE';
CREATE TABLE IF NOT EXISTS reservas.outbox (
  evento_id uuid PRIMARY KEY,
  reserva_id uuid NOT NULL REFERENCES reservas.reservas(reserva_id),
  tipo text NOT NULL CHECK (tipo = 'ReservaConfirmada'),
  payload jsonb NOT NULL,
  enviado boolean NOT NULL DEFAULT false,
  intentos integer NOT NULL DEFAULT 0,
  proximo_intento timestamptz NOT NULL DEFAULT now(),
  ultimo_error text,
  creado_en timestamptz NOT NULL DEFAULT now(),
  UNIQUE(reserva_id,tipo)
);
INSERT INTO reservas.schema_migrations(version) VALUES(1) ON CONFLICT DO NOTHING;
COMMIT;

BEGIN;
CREATE SCHEMA IF NOT EXISTS pagos;
CREATE TABLE IF NOT EXISTS pagos.schema_migrations (
  version integer PRIMARY KEY,
  aplicada_en timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS pagos.cuentas (
  reserva_id uuid PRIMARY KEY,
  operacion_id uuid,
  creada_en timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS pagos.cargos (
  cargo_id uuid PRIMARY KEY,
  reserva_id uuid NOT NULL REFERENCES pagos.cuentas(reserva_id),
  origen varchar(30) NOT NULL CHECK (origen IN ('HABITACION','RESTAURANTE','SPA_ACTIVIDADES')),
  origen_id uuid NOT NULL,
  concepto varchar(200) NOT NULL,
  monto numeric(12,2) NOT NULL CHECK (monto > 0),
  moneda char(3) NOT NULL DEFAULT 'PEN' CHECK (moneda = 'PEN'),
  estado varchar(10) NOT NULL DEFAULT 'ACTIVO' CHECK (estado IN ('ACTIVO','ANULADO')),
  creado_en timestamptz NOT NULL DEFAULT now(),
  actualizado_en timestamptz NOT NULL DEFAULT now(),
  UNIQUE (origen, origen_id)
);
CREATE INDEX IF NOT EXISTS cargos_reserva_idx ON pagos.cargos(reserva_id);
CREATE TABLE IF NOT EXISTS pagos.detalle_cargo (
  detalle_id uuid PRIMARY KEY,
  cargo_id uuid NOT NULL REFERENCES pagos.cargos(cargo_id),
  concepto varchar(200) NOT NULL,
  cantidad integer NOT NULL CHECK (cantidad > 0),
  precio_unitario numeric(12,2) NOT NULL CHECK (precio_unitario > 0)
);
CREATE TABLE IF NOT EXISTS pagos.pagos (
  pago_id uuid PRIMARY KEY,
  reserva_id uuid NOT NULL REFERENCES pagos.cuentas(reserva_id),
  huesped_id uuid NOT NULL,
  monto numeric(12,2) NOT NULL CHECK (monto > 0),
  moneda char(3) NOT NULL DEFAULT 'PEN' CHECK (moneda = 'PEN'),
  metodo varchar(15) NOT NULL CHECK (metodo = 'SIMULADO'),
  estado varchar(15) NOT NULL CHECK (estado IN ('APROBADO','RECHAZADO')),
  referencia_externa varchar(100) NOT NULL UNIQUE,
  creado_en timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS pagos_reserva_idx ON pagos.pagos(reserva_id);
CREATE TABLE IF NOT EXISTS pagos.solicitudes_idempotentes (
  ambito varchar(160) NOT NULL,
  clave uuid NOT NULL,
  huella char(64) NOT NULL,
  estado_http integer,
  respuesta jsonb,
  creada_en timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (ambito, clave)
);
CREATE TABLE IF NOT EXISTS pagos.notificaciones (
  notificacion_id uuid PRIMARY KEY,
  evento_id uuid NOT NULL UNIQUE,
  reserva_id uuid NOT NULL,
  tipo varchar(30) NOT NULL CHECK (tipo IN ('ReservaConfirmada','PagoConfirmado')),
  canal varchar(15) NOT NULL DEFAULT 'SIMULADO' CHECK (canal = 'SIMULADO'),
  estado varchar(12) NOT NULL DEFAULT 'PENDIENTE' CHECK (estado IN ('PENDIENTE','ENVIADA','FALLIDA')),
  intentos integer NOT NULL DEFAULT 0 CHECK (intentos >= 0),
  proximo_intento_en timestamptz NOT NULL DEFAULT now(),
  bloqueada_hasta timestamptz,
  referencia_entrega varchar(100),
  trace_id uuid NOT NULL,
  creada_en timestamptz NOT NULL DEFAULT now(),
  enviada_en timestamptz
);
CREATE INDEX IF NOT EXISTS notificaciones_pendientes_idx
  ON pagos.notificaciones(proximo_intento_en) WHERE estado = 'PENDIENTE';
CREATE TABLE IF NOT EXISTS pagos.entregas_simuladas (
  evento_id uuid PRIMARY KEY,
  referencia varchar(100) NOT NULL UNIQUE,
  creada_en timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS pagos.auditoria (
  auditoria_id uuid PRIMARY KEY,
  reserva_id uuid NOT NULL,
  accion varchar(40) NOT NULL,
  recurso_id uuid,
  actor varchar(80) NOT NULL,
  trace_id uuid NOT NULL,
  detalle jsonb NOT NULL DEFAULT '{}'::jsonb,
  creada_en timestamptz NOT NULL DEFAULT now()
);
INSERT INTO pagos.schema_migrations(version) VALUES (1) ON CONFLICT DO NOTHING;
COMMIT;

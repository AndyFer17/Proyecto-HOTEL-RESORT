BEGIN;
CREATE SCHEMA IF NOT EXISTS clientes;
CREATE TABLE IF NOT EXISTS clientes.schema_migrations (
  version integer PRIMARY KEY,
  aplicada_en timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS clientes.huespedes (
  cliente_id uuid PRIMARY KEY,
  nombre varchar(120) NOT NULL CHECK (length(trim(nombre)) >= 2),
  email varchar(254) NOT NULL UNIQUE CHECK (email = lower(trim(email))),
  telefono varchar(25),
  password_hash text NOT NULL,
  rol varchar(20) NOT NULL DEFAULT 'HUESPED' CHECK (rol = 'HUESPED'),
  creado_en timestamptz NOT NULL DEFAULT now()
);
INSERT INTO clientes.schema_migrations (version) VALUES (1) ON CONFLICT DO NOTHING;
COMMIT;

BEGIN;
INSERT INTO habitaciones.habitaciones
  (habitacion_id, numero, tipo, capacidad, tarifa_noche) VALUES
  ('11111111-1111-4111-8111-111111111101', '101', 'Estandar', 2, 280.00),
  ('11111111-1111-4111-8111-111111111102', '102', 'Estandar', 2, 280.00),
  ('11111111-1111-4111-8111-111111111201', '201', 'Doble Superior', 3, 420.00),
  ('11111111-1111-4111-8111-111111111202', '202', 'Familiar', 4, 540.00),
  ('11111111-1111-4111-8111-111111111301', '301', 'Suite Vista al Mar', 2, 660.00),
  ('11111111-1111-4111-8111-111111111302', '302', 'Suite Presidencial', 4, 980.00)
ON CONFLICT DO NOTHING;
INSERT INTO habitaciones.schema_migrations (version) VALUES (2) ON CONFLICT DO NOTHING;
COMMIT;
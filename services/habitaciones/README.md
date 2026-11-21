# Servicio Habitaciones

Inventario independiente y funcional del Hotel Resort Bahía Azul. Puerto 3002; esquema `habitaciones` en su propia base PostgreSQL. Determina disponibilidad y protege inventario. El ciclo de vida de la estadía pertenece a Reservas.

## Interfaces

Contrato completo: [openapi.json](openapi.json).

| Método y ruta                                                                          | Acceso    | Resultado                                              |
| -------------------------------------------------------------------------------------- | --------- | ------------------------------------------------------ |
| GET `/api/v1/habitaciones/disponibilidad?desde=YYYY-MM-DD&hasta=YYYY-MM-DD&personas=2` | Público   | Habitaciones en servicio sin ocupación solapada        |
| GET `/api/v1/habitaciones/{id}`                                                        | Público   | Categoría, capacidad, tarifa y estado operativo        |
| POST `/api/v1/interno/bloqueos`                                                        | Servicio  | Bloqueo temporal y total calculado                     |
| PUT `/api/v1/interno/bloqueos/{id}/confirmacion`                                       | Servicio  | Inventario confirmado                                  |
| PATCH `/api/v1/interno/bloqueos/{id}`                                                  | Servicio  | Cambio atómico de fechas y ocupantes                   |
| DELETE `/api/v1/interno/bloqueos/{id}`                                                 | Servicio  | Liberación de inventario                               |
| PATCH `/api/v1/interno/habitaciones/{id}/estado`                                       | Servicio  | Estado operativo EN_SERVICIO, LIMPIEZA o MANTENIMIENTO |
| GET `/health/live`, `/health/ready`                                                    | Operación | Proceso y persistencia                                 |

Las mutaciones internas requieren Bearer `SERVICE_TOKEN` e `Idempotency-Key` UUID. El JWT de huésped no habilita estas operaciones y el Gateway las bloquea al exterior. El token permanece en el backend.

## Reglas y concurrencia

- Fechas reales y no pasadas según America/Lima; salida posterior; máximo 30 noches y capacidad compatible.
- Rangos semiabiertos `[desde,hasta)`: una salida permite otra entrada el mismo día.
- Tarifa y cálculo de noches en servidor, `numeric(12,2)`, moneda PEN y cadenas decimales JSON; no se aceptan totales del navegador.
- Bloqueos BLOQUEADO, CONFIRMADO, LIBERADO o EXPIRADO. TTL predeterminado 600 segundos, configurable entre 30 y 3600.
- Extensión `btree_gist` y restricción EXCLUDE impiden solapamientos de inventario activo incluso con peticiones simultáneas.
- Una estadía no mantiene dos bloqueos activos. Los temporales vencidos no ocupan disponibilidad y se expiran al necesitar inventario.
- Una fila única por operación y clave serializa reintentos; otro contenido con la misma clave devuelve 409. El efecto y su respuesta se confirman en una transacción.
- PATCH de fechas toma locks y recalcula el total. Un conflicto conserva el rango original. Reservas coordina el cargo con un bloqueo durable de cuenta para evitar pagos concurrentes.
- El estado operativo se diferencia de la ocupación. No se retira de servicio una habitación con inventario comprometido. El alta de personal/RBAC administrativo no forma parte de la demo de huésped.

## Configuración y persistencia

`HABITACIONES_DATABASE_URL`, `SERVICE_TOKEN`, `HABITACIONES_PORT` (3002), `BLOQUEO_TTL_SECONDS` (600). El setup genera credenciales de aplicación distintas de las de migración; la API no usa el propietario de la base.

Ejecutar `pnpm setup:dev` y `docker compose up --build --wait` desde la raíz. Para ejecución fuera de Compose consultar el README principal. `pnpm db:migrate:habitaciones` aplica migraciones con el propietario y prepara permisos del rol de aplicación.

Las migraciones 001–004 crean inventario, semillas, operaciones idempotentes y estado operativo. `public.soa_migrations` conserva el checksum de cada archivo aplicado; se agregan nuevas migraciones para cambiar el esquema.

Las seis habitaciones semilla tienen precios PEN 280, 280, 420, 540, 660 y 980 por noche. Son datos académicos reproducibles.

## Verificación

`pnpm test` incluye las pruebas del servicio y el flujo HTTP de los cuatro servicios. Sin URL de prueba utiliza PGlite con btree_gist; con `TEST_HABITACIONES_DATABASE_URL` utiliza PostgreSQL real. Se cubren concurrencia, claves repetidas, bloqueos vencidos, cambios fallidos y estado operativo. Consultar los resultados de CI para el commit concreto.

# Pagos y Notificaciones

Servicio académico funcional de cuenta consolidada, cargos, pagos simulados y avisos. Puerto predeterminado **3004**, persistencia propia en el esquema **pagos**. El contrato completo está en [openapi.json](openapi.json).

## Política de la demostración

La reserva confirmada genera un cargo de alojamiento. El huésped paga posteriormente el saldo total, calculado por el servidor. Una cuenta con pago aprobado no admite modificación o cancelación automática: devuelve `409 CUENTA_PAGADA`. Los reembolsos requieren una política y un adaptador que no forman parte de esta demostración.

El método `SIMULADO` recibe únicamente `tok_aprobado` o `tok_rechazado`. No hay cobros bancarios ni correos/SMS reales y no se aceptan datos de tarjeta. El recurso de pago devuelve **201** tanto en estado `APROBADO` como `RECHAZADO`; el rechazo no descuenta saldo. Un pago aprobado encola `PagoConfirmado` en la misma transacción local.

El arranque exige `ALLOW_SIMULATED_PROVIDERS=true` explícito. El servicio **rechaza `NODE_ENV=production`**, incluso con esa bandera. Integrar una pasarela real exigiría autorización/captura/reverso, conciliación, autenticación de callbacks y recuperación de resultados inciertos, sin tratar el simulador como un proveedor real.

## Configuración

| Variable                     | Uso                                                     |
| ---------------------------- | ------------------------------------------------------- |
| `PAGOS_DATABASE_URL`         | Conexión del rol de ejecución, sin DDL                  |
| `PAGOS_PORT`                 | Puerto, predeterminado 3004                             |
| `HOST`                       | Interfaz, predeterminado 127.0.0.1                      |
| `RESERVAS_URL`               | URL interna de Reservas para verificar titular y estado |
| `SERVICE_TOKEN`              | Identidad interna, al menos 32 caracteres aleatorios    |
| `JWT_PUBLIC_KEY_BASE64`      | Clave pública RS256; este servicio no recibe la privada |
| `JWT_ISSUER`, `JWT_AUDIENCE` | Emisor y audiencia, `resort-clientes` / `resort-api`    |
| `ALLOW_SIMULATED_PROVIDERS`  | Debe ser `true` explícitamente en desarrollo o pruebas  |
| `NOTIFICATION_POLL_MS`       | Intervalo del worker, predeterminado 1000 ms            |

La migración exporta `migrate(db)` y puede ejecutarse con `node --env-file=.env services/pagos-notificaciones/src/migrate.js` mediante credenciales de migración. El despliegue conjunto utiliza el wrapper de migraciones del repositorio y separa el rol propietario del rol de ejecución.

## APIs

Las rutas públicas requieren JWT RS256 del huésped y verificación de titular mediante `GET /api/v1/interno/reservas/{id}/titular` de Reservas. No se accede a sus tablas.

- `GET /api/v1/cuentas/{reservaId}`: cargos activos/anulados, total, pagado, saldo y PEN.
- `POST /api/v1/pagos`: `{reservaId,monto:"660.00",metodo:"SIMULADO",tokenPago:"tok_aprobado"}`; requiere `Idempotency-Key` UUID. Solo reserva `CONFIRMADA` y monto exactamente igual al saldo.
- `GET /api/v1/notificaciones/{id}`: canal simulado, estado, intentos y fecha de entrega local.
- `GET /health/live`, `GET /health/ready`.

Las rutas internas requieren Bearer `SERVICE_TOKEN`; toda mutación exige `Idempotency-Key` UUID:

- `POST /api/v1/interno/cargos`: `{reservaId,origen:"HABITACION",origenId,concepto,monto:"660.00",moneda:"PEN"}`. Admite reserva PENDIENTE o CONFIRMADA. Otros orígenes previstos: RESTAURANTE y SPA_ACTIVIDADES.
- `PUT /api/v1/interno/cuentas/{reservaId}/operacion`: `{operacionId}` para bloquear pagos mientras Reservas modifica o cancela.
- `PATCH /api/v1/interno/cargos/{id}`: `{monto,concepto,operacionId}`, bajo el bloqueo de esa operación.
- `DELETE /api/v1/interno/cargos/{id}`: anulación lógica; `X-Operacion-Id` obligatorio si existe bloqueo.
- `DELETE /api/v1/interno/cuentas/{reservaId}/operacion/{operacionId}`: liberar únicamente la operación propia.
- `POST /api/v1/interno/notificaciones`: `{reservaId,eventoId,tipo:"ReservaConfirmada"}`; también admite `PagoConfirmado`.

## Persistencia y concurrencia

Cada cuenta tiene una fila bloqueada con `FOR UPDATE` al calcular saldos o efectuar mutaciones. Pago, modificación y anulación comparten ese bloqueo; un guard de operación durable impide pagos mientras una saga remota está en progreso. El guard no caduca automáticamente: Reservas debe recuperar la operación y liberarlo, evitando que expire mientras aún cambia inventario o cargos.

La idempotencia persiste ámbito, UUID, huella SHA-256 y respuesta en la misma transacción del efecto local. La clave se separa por huésped y tipo de operación; para un resultado persistido, contenido distinto devuelve 409. Un JWT válido del mismo huésped permite repetir su resultado aun si Reservas está temporalmente fuera de servicio, sin consultar ni revelar el ámbito de otro huésped. Los pagos RECHAZADOS también son resultados persistidos. Los errores de validación o reglas sin efecto local revierten la transacción y no vinculan la clave a un cuerpo, por lo que pueden corregirse y reenviarse. `tokenPago` nunca se almacena en claro: únicamente participa en la huella de la solicitud del simulador.

Importes `numeric(12,2)` y cadenas decimales JSON; cálculos en centavos `BigInt`, sin coma flotante. El total máximo por cuenta es 9999999999.99 PEN. La unicidad `(origen,origenId)` evita duplicar cargos aunque llegue otra clave. Cargo, DetalleCargo, Pago, Notificación y auditoría son persistentes; la anulación conserva el registro.

## Avisos recuperables

`eventoId` es único. El worker reclama un aviso con `FOR UPDATE SKIP LOCKED` y una lease de 30 segundos; un proceso nuevo recupera leases vencidas. Un fallo mantiene el aviso y programa backoff exponencial de hasta 300 segundos. Tras cinco intentos queda `FALLIDA` para inspección; no modifica el estado de la reserva ni del pago.

El adaptador simulado guarda una recepción local por evento, evitando duplicar entregas si el proceso cae entre enviar y registrar el resultado. `ENVIADA` significa entrega al simulador local, no un email real. Un proveedor real tendría que aceptar la misma identidad idempotente del evento.

`createNotificationWorker({db,sender?,logger?})` devuelve una función invocable por pruebas; `app.locals.processNotifications()` utiliza el worker del servidor. Un `sender` alternativo debe respetar el identificador del evento y aplicar timeout antes de terminar la lease.

## Seguridad y validación

JSON estricto de hasta 16 KB, UUID, montos positivos con dos decimales, rechazo de campos extra, Helmet, rate limiting, errores uniformes y logs de correlación. El JWT valida firma, algoritmo, emisor, audiencia, expiración y rol; la identidad de servicio se compara en tiempo constante. La validación del titular usa un cliente HTTP con timeout. Los logs y auditoría no incluyen tokens, claves ni tarjetas.

Las pruebas verifican acceso propio, rechazo de JWT/servicio incorrectos, exactitud monetaria, idempotencia, pagos concurrentes, exclusión de pago frente a cancelación/modificación, historial de anulación, deduplicación de eventos, recuperación de worker y agotamiento de reintentos. Se ejecutan con PGlite aislado o `TEST_PAGOS_DATABASE_URL` para PostgreSQL real; la existencia del archivo de prueba no sustituye al resultado de ejecución de CI.

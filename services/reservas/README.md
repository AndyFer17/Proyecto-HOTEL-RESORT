# Servicio Reservas

Implementación HTTP y PostgreSQL del ciclo de vida de reservas. Es dueño de sus reservas, operaciones idempotentes y outbox. Coordina Habitaciones y Pagos exclusivamente por HTTP; no consulta sus tablas. No hay frontend ni roles de empleados en este servicio.

## Política de esta versión

**Cobro al final de la estadía.** Crear una reserva confirma inventario y registra un cargo pendiente; nunca llama al endpoint de pago. La pasarela académica pertenece a Pagos. Una cuenta con un pago aprobado no admite modificación ni cancelación automática: devuelve 409 porque no se ha definido una política de reembolsos.

## Configuración y ejecución

Node.js 24 y pnpm 11.25.0. Variables de entorno:

| Variable                      | Uso                                                              |
| ----------------------------- | ---------------------------------------------------------------- |
| `RESERVAS_DATABASE_URL`       | Conexión a la base propia, obligatoria                           |
| `RESERVAS_PORT`               | Puerto, 3003 por defecto                                         |
| `HOST`                        | 127.0.0.1 por defecto                                            |
| `HABITACIONES_URL`            | URL base de Habitaciones                                         |
| `PAGOS_URL`                   | URL base de Pagos/Notificaciones                                 |
| `CLIENTES_URL`                | URL de Clientes para la configuración conjunta                   |
| `SERVICE_TOKEN`               | Identidad interna compartida, mínimo 32 caracteres               |
| `JWT_PUBLIC_KEY_BASE64`       | Clave pública RS256 emitida por Clientes, nunca su clave privada |
| `JWT_ISSUER` / `JWT_AUDIENCE` | `resort-clientes` / `resort-api` por defecto                     |
| `DEPENDENCY_TIMEOUT_MS`       | Timeout por intento HTTP, 3000 ms por defecto                    |

Ejecutar migraciones con el usuario propietario antes de iniciar el proceso. El despliegue conjunto utiliza `scripts/migrate-service.mjs reservas` para separar propietario y usuario de ejecución; la CLI directa está disponible para un entorno de desarrollo preparado:

```sh
node --env-file=.env services/reservas/src/migrate.js
node --env-file=.env services/reservas/src/server.js
```

El servidor inicia el worker de recuperación y outbox. La función `createApp({db,tokens,config,logger,clock,call})` es síncrona; las pruebas pueden inyectar dependencias HTTP. `app.locals.coordinator` expone `start()`, `stop()`, `tick()`, `process(operacionId)` y `dispatch()`. Crear la aplicación por sí solo no inicia temporizadores.

## API

Contrato completo: [openapi.json](openapi.json).

| Método y ruta                               | Autorización                            | Resultado                                        |
| ------------------------------------------- | --------------------------------------- | ------------------------------------------------ |
| `POST /api/v1/reservas`                     | JWT de huésped e `Idempotency-Key` UUID | 201 confirmada; 202 en recuperación              |
| `GET /api/v1/reservas/{id}`                 | JWT y propietario                       | Estado de la reserva; 404 para una reserva ajena |
| `PATCH /api/v1/reservas/{id}`               | JWT, propietario e `Idempotency-Key`    | 200 modificada; 202 en recuperación              |
| `DELETE /api/v1/reservas/{id}`              | JWT, propietario e `Idempotency-Key`    | 204 cancelada; 202 en recuperación               |
| `GET /api/v1/interno/reservas/{id}/titular` | Bearer de servicio                      | `{reservaId,huespedId,estado}`                   |
| `GET /health/live`                          | Público                                 | Proceso activo                                   |
| `GET /health/ready`                         | Público                                 | Tablas propias disponibles                       |

Crear recibe únicamente:

```json
{
  "habitacionId": "11111111-1111-4111-8111-111111111301",
  "desde": "2027-01-10",
  "hasta": "2027-01-12",
  "personas": 2
}
```

El huésped siempre procede del `sub` del JWT verificado. Se rechazan `huespedId`, precio, estado y cualquier otro campo adicional. Las fechas deben existir, no estar en el pasado según `America/Lima` y abarcar de 1 a 30 noches. Habitaciones valida capacidad e inventario y calcula el importe como cadena decimal en PEN.

PATCH acepta uno o más de `desde`, `hasta`, `personas`. No cambia habitación ni huésped. DELETE no admite cuerpo.

Las claves se guardan por huésped y operación, con huella canónica del recurso y cuerpo. Para una operación registrada, repetir una solicitud devuelve su resultado persistido; reutilizar la misma clave con otro cuerpo o reserva devuelve 409. Una clave de otro huésped no comparte resultado. Los rechazos de validación o estado que ocurren antes de registrar la operación no vinculan la clave. Las operaciones paralelas de modificación/cancelación sobre una misma reserva se excluyen en PostgreSQL; dos reintentos simultáneos con la misma clave comparten la operación existente.

Un 202 significa **operación persistida, todavía sin terminar**. Incluye `operacionId`, `reservaId`, `estado` y `fase`. Consultar la reserva o repetir la solicitud con la misma clave para conocer el resultado. El proceso HTTP espera como máximo cinco segundos por la coordinación inicial; el trabajo sigue recuperable desde la base tras una caída del proceso. No se devuelve 201, 200 o 204 de éxito mientras queden pasos obligatorios pendientes.

## Saga y fallos

Las fases, el contexto remoto, la respuesta y la planificación del próximo intento se guardan en `reservas.operaciones`. Un lease con propietario único por ejecución evita que dos workers avancen la misma operación a la vez. Cada paso HTTP usa una clave UUID derivada de la operación y fase; un timeout no se interpreta como ausencia de efectos. No se mantiene una transacción SQL abierta durante llamadas HTTP.

- **Creación:** bloqueo temporal → confirmación de inventario → creación de cargo → confirmación local y evento outbox en una transacción. Un rechazo definitivo antes de completar el cargo libera inventario antes de cerrar la operación fallida. Si liberar también falla, la compensación permanece pendiente.
- **Modificación:** guard durable de la cuenta → cambio atómico del bloqueo confirmado → ajuste del cargo → desbloqueo de cuenta → confirmación local. Un conflicto de inventario conserva las fechas originales. Si el inventario cambió y el ajuste del cargo queda incierto, la reserva permanece `MODIFICANDO` y la cuenta bloqueada hasta recuperar; no se intenta una restauración insegura que pudiera perder el intervalo original.
- **Cancelación:** guard de cuenta → anulación de cargo → liberación de inventario → desbloqueo de cuenta → `CANCELADA`. Nunca se libera inventario antes de anular el cargo. El guard impide que un pago concurrente se intercale en el cambio.
- **Avisos:** el evento `ReservaConfirmada` se guarda junto con la confirmación. El worker entrega el evento a la cola durable de Pagos usando `eventoId` como clave; un fallo de aviso no cancela una reserva confirmada. El envío externo corresponde a Pagos.

Los estados visibles son `PENDIENTE`, `CONFIRMADA`, `MODIFICANDO`, `CANCELANDO`, `CANCELADA`, `FALLIDA`. Los fallos temporales conservan el estado de la operación y se reintentan con espera creciente, hasta 60 segundos entre intentos. Los rechazos inesperados después de cambiar inventario conservan guard y fase para revisión/recuperación; no se declaran resueltos ni se libera la cuenta de forma automática.

El proceso debe mantenerse activo para que el worker reintente. Reiniciarlo recupera las operaciones guardadas, una vez vencido el lease si el proceso anterior terminó abruptamente. La base conserva operaciones y eventos; no hay un job de borrado de estas evidencias ni una consola administrativa de reparación.

## Pruebas

```sh
node --test --test-concurrency=1 services/reservas/test/*.test.js
```

La suite usa PostgreSQL embebido PGlite aislado y dependencias HTTP controladas. Comprueba autorización, propiedad, validación, persistencia/idempotencia por huésped, rechazo y compensación, recuperación con otro coordinador, outbox, modificación con conflicto, ajuste pendiente, cuenta pagada y cancelación recuperable. Las dos pruebas de reintentos simultáneos con la misma clave usan `TEST_RESERVAS_DATABASE_URL` cuando está definida; sincronizan las lecturas iniciales para comprobar la contención real de filas de PostgreSQL. Esta variable debe apuntar a una base exclusiva de pruebas. Sin ella, se ejecutan con PGlite. La suite no sustituye la comprobación conjunta de los cuatro servidores por HTTP.

import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AppError } from '../../shared/errors.js';
import { callService } from '../../shared/client.js';

// Each remote step has a stable, distinct key across retries and process restarts.
export function stepKey(operationId, phase) {
  const hex = createHash('sha256')
    .update(`${operationId}:${phase}`)
    .digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

const money = z.string().regex(/^\d{1,10}\.\d{2}$/);
const holdResult = z.object({
  bloqueoId: z.string().uuid(),
  total: money,
  moneda: z.literal('PEN'),
});
const chargeResult = z.object({ cargoId: z.string().uuid() });

function validate(schema, value) {
  const result = schema.safeParse(value);
  if (!result.success)
    throw new AppError(
      503,
      'RESPUESTA_DEPENDENCIA_INVALIDA',
      'La dependencia devolvio una respuesta no valida.',
    );
  return result.data;
}
function business(error) {
  return (
    error instanceof AppError && [400, 404, 409, 422].includes(error.status)
  );
}
function failure(error) {
  return { status: error.status, codigo: error.code, mensaje: error.message };
}

export function createCoordinator(
  repository,
  config,
  { call = callService, logger = console } = {},
) {
  let running = false;
  let timer;
  const active = new Set();

  async function remote(
    op,
    service,
    path,
    { method = 'POST', body, headers } = {},
  ) {
    return call(
      service === 'habitaciones' ? config.HABITACIONES_URL : config.PAGOS_URL,
      path,
      {
        method,
        body,
        headers,
        key: stepKey(op.operacion_id, op.fase),
        traceId: op.contexto.traceId,
        token: config.SERVICE_TOKEN,
        timeoutMs: config.DEPENDENCY_TIMEOUT_MS ?? 3000,
      },
    );
  }

  async function run(id) {
    let op = await repository.claim(id, randomUUID());
    if (!op) return;
    try {
      for (let step = 0; step < 12; step += 1) {
        const c = op.contexto;
        const p = op.entrada;
        if (op.fase === 'BLOQUEAR') {
          try {
            const { body } = await remote(
              op,
              'habitaciones',
              '/api/v1/interno/bloqueos',
              {
                body: {
                  reservaId: op.reserva_id,
                  habitacionId: p.habitacionId,
                  desde: p.desde,
                  hasta: p.hasta,
                  personas: p.personas,
                },
              },
            );
            const hold = validate(holdResult, body);
            op = await repository.advance(op, 'CONFIRMAR_INVENTARIO', {
              ...c,
              ...hold,
            });
          } catch (error) {
            if (!business(error)) throw error;
            await repository.fail(op, failure(error));
            return;
          }
        } else if (op.fase === 'CONFIRMAR_INVENTARIO') {
          try {
            await remote(
              op,
              'habitaciones',
              `/api/v1/interno/bloqueos/${c.bloqueoId}/confirmacion`,
              { method: 'PUT' },
            );
            op = await repository.advance(op, 'CREAR_CARGO', c);
          } catch (error) {
            if (!business(error)) throw error;
            op = await repository.advance(op, 'COMPENSAR_INVENTARIO', {
              ...c,
              failure: failure(error),
            });
          }
        } else if (op.fase === 'CREAR_CARGO') {
          try {
            const { body } = await remote(
              op,
              'pagos',
              '/api/v1/interno/cargos',
              {
                body: {
                  reservaId: op.reserva_id,
                  origen: 'HABITACION',
                  origenId: op.reserva_id,
                  concepto: `Alojamiento ${p.desde} a ${p.hasta}`,
                  monto: c.total,
                  moneda: 'PEN',
                },
              },
            );
            const cargo = validate(chargeResult, body);
            op = await repository.advance(op, 'FINALIZAR', { ...c, ...cargo });
          } catch (error) {
            if (!business(error)) throw error;
            op = await repository.advance(op, 'COMPENSAR_INVENTARIO', {
              ...c,
              failure: failure(error),
            });
          }
        } else if (op.fase === 'COMPENSAR_INVENTARIO') {
          try {
            await remote(
              op,
              'habitaciones',
              `/api/v1/interno/bloqueos/${c.bloqueoId}`,
              { method: 'DELETE' },
            );
          } catch (error) {
            if (error.status !== 404) throw error;
          }
          await repository.fail(op, c.failure);
          return;
        } else if (op.fase === 'BLOQUEAR_CUENTA') {
          try {
            await remote(
              op,
              'pagos',
              `/api/v1/interno/cuentas/${op.reserva_id}/operacion`,
              { method: 'PUT', body: { operacionId: op.operacion_id } },
            );
            op = await repository.advance(
              op,
              op.accion === 'MODIFICAR'
                ? 'MODIFICAR_INVENTARIO'
                : 'ANULAR_CARGO',
              c,
            );
          } catch (error) {
            if (!business(error)) throw error;
            await repository.fail(op, failure(error));
            return;
          }
        } else if (op.fase === 'MODIFICAR_INVENTARIO') {
          try {
            const { body } = await remote(
              op,
              'habitaciones',
              `/api/v1/interno/bloqueos/${p.original.bloqueoId}`,
              {
                method: 'PATCH',
                body: { desde: p.desde, hasta: p.hasta, personas: p.personas },
              },
            );
            const hold = validate(holdResult, body);
            op = await repository.advance(op, 'MODIFICAR_CARGO', {
              ...c,
              total: hold.total,
            });
          } catch (error) {
            if (!business(error)) throw error;
            // Habitaciones changes dates atomically: a rejection preserves the old range.
            op = await repository.advance(op, 'DESBLOQUEAR_RECHAZO', {
              ...c,
              failure: failure(error),
            });
          }
        } else if (op.fase === 'MODIFICAR_CARGO') {
          // A durable account guard excludes concurrent payment. Never report success or
          // attempt an unsafe rollback of inventory if the adjustment outcome is unknown.
          await remote(
            op,
            'pagos',
            `/api/v1/interno/cargos/${p.original.cargoId}`,
            {
              method: 'PATCH',
              body: {
                monto: c.total,
                concepto: `Alojamiento ${p.desde} a ${p.hasta}`,
                operacionId: op.operacion_id,
              },
            },
          );
          op = await repository.advance(op, 'DESBLOQUEAR_CUENTA', c);
        } else if (op.fase === 'ANULAR_CARGO') {
          await remote(
            op,
            'pagos',
            `/api/v1/interno/cargos/${p.original.cargoId}`,
            {
              method: 'DELETE',
              headers: { 'X-Operacion-Id': op.operacion_id },
            },
          );
          op = await repository.advance(op, 'LIBERAR_INVENTARIO', c);
        } else if (op.fase === 'LIBERAR_INVENTARIO') {
          await remote(
            op,
            'habitaciones',
            `/api/v1/interno/bloqueos/${p.original.bloqueoId}`,
            { method: 'DELETE' },
          );
          op = await repository.advance(op, 'DESBLOQUEAR_CUENTA', c);
        } else if (
          op.fase === 'DESBLOQUEAR_CUENTA' ||
          op.fase === 'DESBLOQUEAR_RECHAZO'
        ) {
          await remote(
            op,
            'pagos',
            `/api/v1/interno/cuentas/${op.reserva_id}/operacion/${op.operacion_id}`,
            { method: 'DELETE' },
          );
          if (op.fase === 'DESBLOQUEAR_RECHAZO') {
            await repository.fail(op, c.failure);
            return;
          }
          op = await repository.advance(op, 'FINALIZAR', c);
        } else if (op.fase === 'FINALIZAR') {
          await repository.finish(op);
          return;
        } else {
          throw new AppError(
            503,
            'FASE_DESCONOCIDA',
            'La operacion requiere revision.',
          );
        }
      }
      await repository.defer(op, 'CONTINUACION_PENDIENTE');
    } catch (error) {
      await repository.defer(
        op,
        error instanceof AppError ? error.code : 'RECUPERACION_PENDIENTE',
      );
      logger.error(
        JSON.stringify({
          servicio: 'reservas',
          codigo: 'RECUPERACION_PENDIENTE',
          operacionId: id,
        }),
      );
    }
  }

  function process(id) {
    const promise = run(id);
    active.add(promise);
    promise.finally(() => active.delete(promise)).catch(() => {});
    return promise;
  }

  async function dispatch() {
    for (const event of await repository.events()) {
      try {
        await call(config.PAGOS_URL, '/api/v1/interno/notificaciones', {
          method: 'POST',
          body: event.payload,
          key: event.evento_id,
          traceId: event.evento_id,
          token: config.SERVICE_TOKEN,
          timeoutMs: config.DEPENDENCY_TIMEOUT_MS ?? 3000,
        });
        await repository.eventSent(event.evento_id);
      } catch (error) {
        await repository.eventFailed(
          event.evento_id,
          error instanceof AppError ? error.code : 'NOTIFICACION_PENDIENTE',
        );
      }
    }
  }
  async function tick() {
    if (running) return;
    running = true;
    try {
      for (const id of await repository.due()) await process(id);
      await dispatch();
    } catch {
      logger.error(
        JSON.stringify({
          servicio: 'reservas',
          codigo: 'WORKER_NO_DISPONIBLE',
        }),
      );
    } finally {
      running = false;
    }
  }
  return {
    process,
    tick,
    dispatch,
    start(intervalMs = 1000) {
      if (!timer)
        timer = setInterval(() => {
          void tick();
        }, intervalMs).unref();
      void tick();
    },
    async stop() {
      clearInterval(timer);
      timer = undefined;
      while (running) await new Promise((resolve) => setTimeout(resolve, 20));
      await Promise.allSettled([...active]);
    },
  };
}
